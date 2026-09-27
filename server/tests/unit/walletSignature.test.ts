import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../../src/lib/errors.js";
import {
  assertValidSignature,
  buildSignInMessage,
  signatureIsWellFormed,
  verifyWalletSignature,
} from "../../src/services/auth/signature.js";
import { expectAppError } from "../helpers/appError.js";

/** Must match `SIGN_IN_DOMAIN` in services/auth/cookies.ts. */
const DOMAIN = "agri-trace";

const ISSUED_AT = new Date("2026-05-04T10:15:00.000Z");
const EXPIRES_AT = new Date("2026-05-04T10:20:00.000Z");
const NONCE = "f3c1a9d7b25e46819d0c7a3f5e81b4620";

interface TestSigner {
  secretKey: Uint8Array;
  address: string;
}

function createSigner(): TestSigner {
  const keypair = nacl.sign.keyPair();
  return {
    secretKey: keypair.secretKey,
    address: new PublicKey(Buffer.from(keypair.publicKey)).toBase58(),
  };
}

function sign(message: string, secretKey: Uint8Array): string {
  return Buffer.from(
    nacl.sign.detached(new Uint8Array(Buffer.from(message, "utf8")), secretKey)
  ).toString("base64");
}

function challenge(nonce = NONCE) {
  return buildSignInMessage({
    domain: DOMAIN,
    walletAddress: signer.address,
    nonce,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  });
}

const signer = createSigner();
const other = createSigner();

describe("buildSignInMessage", () => {
  it("includes the wallet address, the nonce, both timestamps and the domain", () => {
    const message = challenge().message;
    expect(message).toContain(signer.address);
    expect(message).toContain(NONCE);
    expect(message).toContain(ISSUED_AT.toISOString());
    expect(message).toContain(EXPIRES_AT.toISOString());
    expect(message).toContain(DOMAIN);
  });

  it("never reveals a seed phrase or private key", () => {
    const message = challenge().message;
    expect(message).not.toMatch(/seed|private key|mnemonic/i);
    expect(message).not.toContain(Buffer.from(signer.secretKey).toString("base64"));
    expect(message).not.toContain(Buffer.from(signer.secretKey).toString("hex"));
    expect(message).not.toContain(Buffer.from(signer.secretKey.subarray(0, 32)).toString("base64"));
  });

  it("returns the nonce and expiry it was given so the caller can store them", () => {
    const built = challenge();
    expect(built.nonce).toBe(NONCE);
    expect(built.expiresAt).toBe(EXPIRES_AT);
  });

  it("produces different bytes for two nonces, so one signature cannot serve both challenges", () => {
    const first = challenge("nonce-one").message;
    const second = challenge("nonce-two").message;
    expect(first).not.toBe(second);
    expect(first).toContain("nonce-one");
    expect(second).toContain("nonce-two");
  });

  it("is deterministic for the same inputs, so a client can re-derive what it signed", () => {
    expect(challenge().message).toBe(challenge().message);
  });
});

describe("verifyWalletSignature", () => {
  it("returns true for a detached signature over the exact message bytes", () => {
    const message = challenge().message;
    expect(
      verifyWalletSignature({
        walletAddress: signer.address,
        message,
        signature: sign(message, signer.secretKey),
      })
    ).toBe(true);
  });

  it("returns false for a signature made over a different message", () => {
    expect(
      verifyWalletSignature({
        walletAddress: signer.address,
        message: challenge().message,
        signature: sign("a completely different message", signer.secretKey),
      })
    ).toBe(false);
  });

  it("returns false for a valid signature made by a different key", () => {
    const message = challenge().message;
    expect(
      verifyWalletSignature({
        walletAddress: signer.address,
        message,
        signature: sign(message, other.secretKey),
      })
    ).toBe(false);
  });

  it("returns false for a signature that is not 64 bytes", () => {
    const message = challenge().message;
    for (const length of [0, 32, 63, 65, 128]) {
      const signature = Buffer.alloc(length, 7).toString("base64");
      expect(
        verifyWalletSignature({ walletAddress: signer.address, message, signature })
      ).toBe(false);
    }
  });

  it("returns false for a signature that is not base64", () => {
    expect(
      verifyWalletSignature({
        walletAddress: signer.address,
        message: challenge().message,
        signature: "%%% not base64 %%%",
      })
    ).toBe(false);
  });

  it("returns false for an empty signature", () => {
    expect(
      verifyWalletSignature({
        walletAddress: signer.address,
        message: challenge().message,
        signature: "",
      })
    ).toBe(false);
    expect(
      verifyWalletSignature({
        walletAddress: signer.address,
        message: challenge().message,
        signature: "   ",
      })
    ).toBe(false);
  });

  it("returns false for a wallet address that is not a public key", () => {
    const message = challenge().message;
    const signature = sign(message, signer.secretKey);
    expect(verifyWalletSignature({ walletAddress: "not-a-public-key", message, signature })).toBe(
      false
    );
    expect(verifyWalletSignature({ walletAddress: "", message, signature })).toBe(false);
    expect(verifyWalletSignature({ walletAddress: "a".repeat(44), message, signature })).toBe(
      false
    );
  });

  it("accepts a signature in the base64url alphabet, as some wallets return", () => {
    const message = challenge().message;
    const signature = sign(message, signer.secretKey);
    const base64url = signature.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(signature).not.toBe(base64url);
    expect(verifyWalletSignature({ walletAddress: signer.address, message, signature: base64url })).toBe(
      true
    );
  });

  it("tolerates whitespace around a signature pasted from a wallet prompt", () => {
    const message = challenge().message;
    const signature = sign(message, signer.secretKey);
    expect(
      verifyWalletSignature({ walletAddress: signer.address, message, signature: `\n${signature}  ` })
    ).toBe(true);
  });
});

describe("signatureIsWellFormed", () => {
  it("accepts a real 64 byte base64 signature", () => {
    const signature = sign(challenge().message, signer.secretKey);
    expect(Buffer.from(signature, "base64")).toHaveLength(nacl.sign.signatureLength);
    expect(signatureIsWellFormed(signature)).toBe(true);
  });

  it("rejects a signature of the wrong length", () => {
    expect(signatureIsWellFormed(Buffer.alloc(63, 1).toString("base64"))).toBe(false);
    expect(signatureIsWellFormed(Buffer.alloc(65, 1).toString("base64"))).toBe(false);
  });

  it("rejects a value that is not base64", () => {
    expect(signatureIsWellFormed("not base64!")).toBe(false);
  });

  it("rejects an empty signature", () => {
    expect(signatureIsWellFormed("")).toBe(false);
  });
});

describe("assertValidSignature", () => {
  it("does not throw for a correct signature", () => {
    const message = challenge().message;
    expect(() =>
      assertValidSignature({
        walletAddress: signer.address,
        message,
        signature: sign(message, signer.secretKey),
      })
    ).not.toThrow();
  });

  it("throws AUTH_SIGNATURE_INVALID for a well-formed signature from the wrong key", () => {
    const message = challenge().message;
    const error = expectAppError(
      () =>
        assertValidSignature({
          walletAddress: signer.address,
          message,
          signature: sign(message, other.secretKey),
        }),
      ERROR_CODES.AUTH_SIGNATURE_INVALID
    );
    expect(error.message).toMatch(/could not be verified against this wallet address/);
  });

  it("throws AUTH_SIGNATURE_INVALID for a malformed signature", () => {
    const error = expectAppError(
      () =>
        assertValidSignature({
          walletAddress: signer.address,
          message: challenge().message,
          signature: "too-short",
        }),
      ERROR_CODES.AUTH_SIGNATURE_INVALID
    );
    expect(error.message).toMatch(/not a valid Ed25519 signature/);
  });

  it("throws AUTH_SIGNATURE_INVALID for a signature over a different challenge", () => {
    const signature = sign(challenge("nonce-one").message, signer.secretKey);
    expectAppError(
      () =>
        assertValidSignature({
          walletAddress: signer.address,
          message: challenge("nonce-two").message,
          signature,
        }),
      ERROR_CODES.AUTH_SIGNATURE_INVALID
    );
  });
});

describe("replay resistance", () => {
  it("refuses a signature captured for one challenge when the other challenge is presented", () => {
    const first = challenge("11111111-1111-4111-8111-111111111111");
    const second = challenge("22222222-2222-4222-8222-222222222222");
    const signature = sign(first.message, signer.secretKey);
    expect(verifyWalletSignature({ walletAddress: signer.address, message: first.message, signature })).toBe(true);
    expect(
      verifyWalletSignature({ walletAddress: signer.address, message: second.message, signature })
    ).toBe(false);
  });
});
