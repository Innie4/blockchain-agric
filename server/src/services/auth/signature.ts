import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { AppError, ERROR_CODES } from "../../lib/errors.js";

/**
 * Wallet signature verification.
 *
 * A wallet's public key in a request body is a claim, not proof. Proof is a
 * detached Ed25519 signature over bytes the server generated. This module
 * verifies those bytes and nothing else, so a caller cannot present a signature
 * captured for a different challenge.
 */

export interface SignInChallenge {
  nonce: string;
  message: string;
  expiresAt: Date;
}

/**
 * Builds the exact bytes a participant signs. The domain string prevents a
 * signature produced for another dApp, or for a Solana message of the same
 * shape, from being replayed here.
 */
export function buildSignInMessage(input: {
  domain: string;
  walletAddress: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}): SignInChallenge {
  const message = [
    `${input.domain} sign-in request`,
    "",
    `Wallet: ${input.walletAddress}`,
    `Nonce: ${input.nonce}`,
    `Issued at: ${input.issuedAt.toISOString()}`,
    `Expires at: ${input.expiresAt.toISOString()}`,
    "",
    "Signing this message proves control of this wallet. It does not authorise",
    "any transfer or spend of funds.",
  ].join("\n");

  return { nonce: input.nonce, message, expiresAt: input.expiresAt };
}

/**
 * Verifies a detached Ed25519 signature over `message`.
 *
 * Returns `true` only when the signature is 64 bytes, decodes cleanly, and
 * verifies against the claimed address. Every failure mode returns `false` so a
 * caller cannot distinguish a malformed signature from a wrong one.
 */
export function verifyWalletSignature(input: {
  walletAddress: string;
  message: string;
  signature: string;
}): boolean {
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = decodeBase64(input.signature);
  } catch {
    return false;
  }
  if (signatureBytes.length !== nacl.sign.signatureLength) return false;

  let publicKeyBytes: Uint8Array;
  try {
    publicKeyBytes = new PublicKey(input.walletAddress.trim()).toBytes();
  } catch {
    return false;
  }
  if (publicKeyBytes.length !== nacl.sign.publicKeyLength) return false;

  try {
    return nacl.sign.detached.verify(
      new Uint8Array(Buffer.from(input.message, "utf8")),
      signatureBytes,
      publicKeyBytes
    );
  } catch {
    return false;
  }
}

export function signatureIsWellFormed(signature: string): boolean {
  try {
    return decodeBase64(signature).length === nacl.sign.signatureLength;
  } catch {
    return false;
  }
}

export function assertValidSignature(input: {
  walletAddress: string;
  message: string;
  signature: string;
}): void {
  if (!signatureIsWellFormed(input.signature)) {
    throw new AppError(ERROR_CODES.AUTH_SIGNATURE_INVALID, {
      message:
        "The signature returned by the wallet was not a valid Ed25519 signature. Reject the request in your wallet and try again.",
    });
  }
  if (!verifyWalletSignature(input)) {
    throw new AppError(ERROR_CODES.AUTH_SIGNATURE_INVALID, {
      message:
        "The signature could not be verified against this wallet address. Make sure you signed with the same wallet you are connecting.",
    });
  }
}

function decodeBase64(value: string): Uint8Array {
  const cleaned = value.trim();
  if (cleaned.length === 0) return new Uint8Array(0);
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(cleaned)) {
    throw new Error("Not base64.");
  }
  const normalised = cleaned.replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(Buffer.from(normalised, "base64"));
}
