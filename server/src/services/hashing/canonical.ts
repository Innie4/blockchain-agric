import { sha256Hex } from "../../lib/crypto.js";
import { AppError, ERROR_CODES } from "../../lib/errors.js";
import { PRODUCT_ID_MAX_LENGTH } from "../../lib/crypto.js";

/**
 * Canonical serialisation.
 *
 * The hash anchored on-chain must be reproducible years later by anyone
 * verifying a product, so it cannot be `JSON.stringify` output whose key order
 * depends on insertion order. This module produces a fixed, line-oriented byte
 * stream instead:
 *
 *   version line, then one `field:value` line per field, in a declared order,
 *   with values normalised, joined by `\n` and terminated by `\n`.
 *
 * A field that is absent is written as `field:` (empty value) so that adding
 * and removing a field never produce the same bytes.
 */

/**
 * The exact set of facts a registration anchors on-chain. Only immutable
 * registration data belongs here: if mutable state were included, every
 * legitimate change would look like tampering.
 *
 * In particular the current owner is deliberately absent. Ownership passes along
 * the supply chain, so anchoring it would mean the fingerprint could never be
 * reproduced after the first transfer, and every batch that had changed hands
 * would be reported as altered. The registrant is already covered by
 * `registeredByWallet`, and who holds the batch now is answered by the on-chain
 * transfer history and the product's own ownership field instead.
 *
 * Changing this list changes the anchored bytes, so the version below must be
 * bumped: an older anchor can then be recognised as a different scheme rather
 * than being silently mis-compared against the new one.
 */
export const CANONICAL_HASH_VERSION = "v2";

export type CanonicalFieldValue = string | number | boolean | null | string[];

export interface CanonicalPayload {
  /** Fields are emitted in this exact order. Never reorder without bumping the version. */
  fields: ReadonlyArray<readonly [string, CanonicalFieldValue]>;
}

function normaliseValue(value: CanonicalFieldValue): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
        message: "A numeric field could not be canonicalised because it is not a finite number.",
      });
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normaliseValue(entry)).join(",");
  }
  return escapeControlCharacters(value);
}

/**
 * Keeps every field on one line without losing content.
 *
 * A description may legitimately contain line breaks, and a farmer writing one
 * must not be told the system is broken. Carriage returns are dropped and the
 * backslash, newline and tab characters are escaped, so the encoding is
 * unambiguous and round-trips: a value can never be mistaken for a field
 * boundary.
 */
function escapeControlCharacters(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

/** Reverses `escapeControlCharacters`, used to prove the encoding round-trips. */
export function unescapeControlCharacters(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      output += character;
      continue;
    }
    const next = value[index + 1];
    if (next === "n") {
      output += "\n";
    } else if (next === "t") {
      output += "\t";
    } else if (next === "\\") {
      output += "\\";
    } else {
      output += character;
    }
    index += 1;
  }
  return output;
}

/** Normalises a free-text field: NFC, collapsed internal whitespace, trimmed. */
export function normaliseText(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Normalises a free-text field while preserving the author's line structure. */
export function normaliseMultilineText(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .trim();
}

/** Normalises a date to a UTC instant with millisecond precision. */
export function normaliseInstant(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
      message: "A date field could not be canonicalised because it is not a valid date.",
    });
  }
  return date.toISOString();
}

/** Normalises a calendar date (no time component) to `YYYY-MM-DD` in UTC. */
export function normaliseCalendarDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
      message: "A date field could not be canonicalised because it is not a valid date.",
    });
  }
  return date.toISOString().slice(0, 10);
}

/** Normalises a quantity to a plain decimal string with no exponent or padding. */
export function normaliseQuantity(value: number): string {
  if (!Number.isFinite(value)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
      message: "A quantity could not be canonicalised because it is not a finite number.",
    });
  }
  // Two decimal places is the most any agricultural unit needs.
  return value.toFixed(2);
}

/** Renders a payload to its canonical UTF-8 byte string. */
export function canonicalise(payload: CanonicalPayload): string {
  const lines: string[] = [`version:${CANONICAL_HASH_VERSION}`];
  const seen = new Set<string>();
  for (const [field, value] of payload.fields) {
    if (seen.has(field)) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, {
        message: `Canonical payload declares the field "${field}" more than once.`,
      });
    }
    seen.add(field);
    if (field.length === 0 || /[\n:]/.test(field)) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, {
        message: `Canonical field name "${field}" must be non-empty and contain no colon or newline.`,
      });
    }
    lines.push(`${field}:${normaliseValue(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** SHA-256 of the canonical serialisation, lowercase hex. */
export function hashCanonicalPayload(payload: CanonicalPayload): string {
  return sha256Hex(Buffer.from(canonicalise(payload), "utf8"));
}

/**
 * The exact set of facts a registration anchors on-chain. Only immutable
 * registration data belongs here: if mutable state such as the current status
 * were included, every legitimate status change would look like tampering.
 */
export interface RegistrationFacts {
  productId: string;
  cropType: string;
  quantity: number;
  unit: string;
  harvestDate: Date | string;
  farmLocation: string;
  description: string;
  additionalNotes: string;
  registeredByWallet: string;
  /** SHA-256 of each stored image, in the order they were attached. */
  imageHashes: readonly string[];
  /** SHA-256 of each stored certificate document, in the order they were attached. */
  certificateHashes: readonly string[];
  registeredAt: Date | string;
}

export function registrationFields(facts: RegistrationFacts): CanonicalPayload {
  return {
    fields: [
      ["productId", facts.productId],
      ["cropType", normaliseText(facts.cropType).toUpperCase()],
      ["quantity", normaliseQuantity(facts.quantity)],
      ["unit", normaliseText(facts.unit).toLowerCase()],
      ["harvestDate", normaliseCalendarDate(facts.harvestDate)],
      ["farmLocation", normaliseText(facts.farmLocation)],
      ["description", normaliseMultilineText(facts.description)],
      ["additionalNotes", normaliseMultilineText(facts.additionalNotes)],
      ["registeredByWallet", facts.registeredByWallet],
      ["imageHashes", [...facts.imageHashes]],
      ["certificateHashes", [...facts.certificateHashes]],
      ["registeredAt", normaliseInstant(facts.registeredAt)],
    ],
  };
}

/** The hash the program stores for a product account. */
export function computeRegistrationHash(facts: RegistrationFacts): string {
  return hashCanonicalPayload(registrationFields(facts));
}

/**
 * The hash a participant profile anchors. Kept separate from the registration
 * hash so a profile edit never invalidates a product's anchored payload.
 */
export function computeProfileHash(input: {
  walletAddress: string;
  fullName: string;
  role: string;
  contactEmail: string;
  contactPhone: string;
  organisation: string;
}): string {
  return hashCanonicalPayload({
    fields: [
      ["walletAddress", input.walletAddress],
      ["fullName", normaliseText(input.fullName)],
      ["role", input.role],
      ["contactEmail", normaliseText(input.contactEmail).toLowerCase()],
      ["contactPhone", normaliseText(input.contactPhone)],
      ["organisation", normaliseText(input.organisation)],
    ],
  });
}

export interface HashComparison {
  match: boolean;
  expected: string;
  actual: string;
}

/** Compares two hex digests and explains a mismatch without leaking secrets. */
export function compareHashes(expected: string, actual: string): HashComparison {
  const normalisedExpected = expected.trim().toLowerCase();
  const normalisedActual = actual.trim().toLowerCase();
  return {
    match: normalisedExpected === normalisedActual,
    expected: normalisedExpected,
    actual: normalisedActual,
  };
}

/** Rejects a hash that is not 64 lowercase hex characters. */
export function assertHashShape(value: string, field: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
      message: `"${field}" must be a 64 character lowercase SHA-256 hex digest.`,
      details: [{ path: field, message: "Expected a SHA-256 hex digest." }],
    });
  }
  return value;
}

export { PRODUCT_ID_MAX_LENGTH };
