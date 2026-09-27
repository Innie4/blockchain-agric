import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { AppError, ERROR_CODES } from "./errors.js";

/**
 * Batch identifiers follow `AGT-<CROP>-<YEAR>-<CODE>` where CROP is 3 to 6
 * uppercase letters or digits, YEAR is a four digit year and CODE is six
 * uppercase letters or digits. The shape is deliberately fixed so an
 * identifier fits a fixed-width on-chain field, survives a printed QR code
 * unchanged, and can be validated on-chain as printable ASCII.
 */
export const PRODUCT_ID_PATTERN = /^AGT-[A-Z0-9]{3,6}-\d{4}-[A-Z0-9]{6}$/;

export const PRODUCT_ID_MAX_LENGTH = 32;

const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidProductId(value: string): boolean {
  return (
    value.length <= PRODUCT_ID_MAX_LENGTH && PRODUCT_ID_PATTERN.test(value)
  );
}

export function assertProductId(value: string): string {
  const normalised = value.trim().toUpperCase();
  if (!isValidProductId(normalised)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
      message:
        "A product identifier looks like AGT-COCOA-2026-A1B2C3: the prefix AGT, a crop code of 3 to 6 letters or digits, a four digit year, and a six character batch code.",
      details: [{ path: "productId", message: "Unrecognised product identifier format." }],
    });
  }
  return normalised;
}

/**
 * Builds a candidate identifier for a farmer registering a new batch. The
 * random component keeps collisions negligible without needing a database
 * round trip; the on-chain account address remains the real uniqueness check.
 */
export function suggestProductId(cropType: string, harvestDate: Date): string {
  const crop = cropType
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6)
    .padEnd(3, "X");
  const year = String(harvestDate.getUTCFullYear());
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(6);
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += alphabet[(bytes[index] as number) % alphabet.length];
  }
  return `AGT-${crop}-${year}-${code}`;
}

export function normaliseWallet(value: string, field = "walletAddress"): string {
  const trimmed = value.trim();
  if (!WALLET_PATTERN.test(trimmed)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
      message: "That does not look like a Solana wallet address.",
      details: [{ path: field, message: "Invalid Solana wallet address." }],
    });
  }
  return trimmed;
}

export function isValidWallet(value: string): boolean {
  return WALLET_PATTERN.test(value.trim());
}

/** Narrows arbitrary text to a PublicKey or reports a validation failure. */
export function toPublicKey(value: string, field: string): PublicKey {
  try {
    return new PublicKey(value.trim());
  } catch (cause) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
      message: `"${field}" is not a valid Solana address.`,
      details: [{ path: field, message: "Invalid Solana address." }],
      cause,
    });
  }
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256")
    .update(typeof input === "string" ? Buffer.from(input, "utf8") : input)
    .digest("hex");
}

export function sha256Bytes(input: string | Uint8Array): Buffer {
  return createHash("sha256")
    .update(typeof input === "string" ? Buffer.from(input, "utf8") : input)
    .digest();
}

/**
 * The keyed digest stored against a session token.
 *
 * Sessions already use a random 32 byte token of which only a digest is stored,
 * so a database disclosure alone cannot forge a cookie. Binding the digest to
 * the deployment secret adds the operational property that matters during an
 * incident: changing `SESSION_SECRET` invalidates every existing session
 * immediately, without a migration or a row update.
 */
export function sessionTokenDigest(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token, "utf8").digest("hex");
}

/** Opaque 32 byte session identifier, returned to the client once. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function generateCsrfToken(): string {
  return randomBytes(24).toString("base64url");
}

export function generateTransferId(): Buffer {
  return randomBytes(16);
}

/** Constant-time comparison for secrets of possibly different lengths. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) {
    // Still perform a comparison so the timing does not reveal the length.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

export function newId(): string {
  return randomUUID();
}

/**
 * Reads a string out of an untyped value.
 *
 * Documents that arrive from MongoDB or from a parsed request are `unknown` at
 * the type level. Coercing one with `String(value)` would produce the literal
 * text `[object Object]` if it were ever not a string, and that text would then
 * be written into a record and shown to a participant. Anything that is not a
 * string is replaced with the fallback instead.
 */
export function stringOr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
