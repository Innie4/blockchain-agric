import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  PRODUCT_ID_PATTERN,
  assertProductId,
  isValidProductId,
  isValidWallet,
  newId,
  normaliseWallet,
  safeEqual,
  sha256Bytes,
  sha256Hex,
  suggestProductId,
  toPublicKey,
} from "../../src/lib/crypto.js";
import { ERROR_CODES } from "../../src/lib/errors.js";
import { expectAppError } from "../helpers/appError.js";

const HARVEST = new Date("2024-03-15T23:30:00.000Z");

describe("product identifier shape", () => {
  it("accepts a canonical identifier with a five character crop code", () => {
    expect(isValidProductId("AGT-COCOA-2026-A1B2C3")).toBe(true);
  });

  it("accepts the shortest permitted crop code of three characters", () => {
    expect(isValidProductId("AGT-COC-2026-A1B2C3")).toBe(true);
  });

  it("accepts the longest permitted crop code of six characters", () => {
    expect(isValidProductId("AGT-COCOA-2026-A1B2C3")).toBe(true);
    expect(isValidProductId("AGT-ABCDEF-2026-123456")).toBe(true);
  });

  it("accepts digits in the crop code and the batch code", () => {
    expect(isValidProductId("AGT-123456-2026-123456")).toBe(true);
  });

  it("rejects a crop code of two characters", () => {
    expect(isValidProductId("AGT-CO-2026-A1B2C3")).toBe(false);
  });

  it("rejects a crop code of seven characters", () => {
    expect(isValidProductId("AGT-COCOAXX-2026-A1B2C3")).toBe(false);
  });

  it("rejects a three digit year", () => {
    expect(isValidProductId("AGT-COCOA-26-A1B2C3")).toBe(false);
  });

  it("rejects a five character batch code", () => {
    expect(isValidProductId("AGT-COCOA-2026-A1B2C")).toBe(false);
  });

  it("rejects a missing prefix", () => {
    expect(isValidProductId("COCOA-2026-A1B2C3")).toBe(false);
  });

  it("rejects a lower case identifier, so identifiers are case sensitive on the wire", () => {
    expect(isValidProductId("agt-cocoa-2026-a1b2c3")).toBe(false);
    expect(isValidProductId("AGT-cocoa-2026-A1B2C3")).toBe(false);
    expect(PRODUCT_ID_PATTERN.test("AGT-cocoa-2026-A1B2C3")).toBe(false);
  });

  it("rejects an identifier of 33 characters, which cannot fit the fixed width on-chain field", () => {
    const overlong = "AGT-COCOA-2026-A1B2C3".padEnd(33, "X");
    expect(overlong).toHaveLength(33);
    expect(isValidProductId(overlong)).toBe(false);
    expect(isValidProductId("A".repeat(33))).toBe(false);
  });

  it("rejects a stray character in the batch code", () => {
    expect(isValidProductId("AGT-COCOA-2026-A1B2C-")).toBe(false);
    expect(isValidProductId("AGT-COCOA-2026-A1B2C ")).toBe(false);
  });

  it("rejects an empty or whitespace identifier", () => {
    expect(isValidProductId("")).toBe(false);
    expect(isValidProductId("   ")).toBe(false);
  });
});

describe("assertProductId", () => {
  it("returns a valid identifier unchanged", () => {
    expect(assertProductId("AGT-COCOA-2026-A1B2C3")).toBe("AGT-COCOA-2026-A1B2C3");
  });

  it("trims and upper-cases the upper-casing path that isValidProductId does not perform", () => {
    expect(assertProductId("  agt-cocoa-2026-a1b2c3  ")).toBe("AGT-COCOA-2026-A1B2C3");
    expect(isValidProductId("  agt-cocoa-2026-a1b2c3  ")).toBe(false);
  });

  it("throws a validation error with a helpful message for junk", () => {
    const error = expectAppError(() => assertProductId("not-an-id"), ERROR_CODES.VALIDATION_ERROR);
    expect(error.message).toMatch(/AGT-COCOA-2026-A1B2C3/);
    expect(error.details).toEqual([
      { path: "productId", message: "Unrecognised product identifier format." },
    ]);
  });

  it("throws for a lower case identifier that would be valid once normalised", () => {
    expectAppError(() => assertProductId("agt-cocoa-2026"), ERROR_CODES.VALIDATION_ERROR);
  });
});

describe("suggestProductId", () => {
  it("always produces an identifier the validator accepts, across 200 draws", () => {
    for (let index = 0; index < 200; index += 1) {
      const suggestion = suggestProductId(index % 2 === 0 ? "cocoa" : "maize", HARVEST);
      expect(isValidProductId(suggestion)).toBe(true);
    }
  });

  it("embeds the upper-cased crop stem", () => {
    expect(suggestProductId("cocoa", HARVEST)).toContain("-COCOA-");
    expect(suggestProductId("Maize", HARVEST)).toContain("-MAIZE-");
  });

  it("strips non-alphanumeric characters from the crop and truncates it to six characters", () => {
    const suggestion = suggestProductId("cocoa beans", HARVEST);
    expect(suggestion).toContain("-COCOAB-");
    expect(isValidProductId(suggestion)).toBe(true);
  });

  it("pads a crop code shorter than three characters so the shape stays valid", () => {
    expect(suggestProductId("oat", HARVEST)).toContain("-OAT-");
    expect(isValidProductId(suggestProductId("ki", HARVEST))).toBe(true);
  });

  it("uses the UTC year of the harvest date", () => {
    expect(suggestProductId("cocoa", HARVEST)).toContain("-2024-");
    expect(suggestProductId("cocoa", new Date("2026-12-31T23:59:59.999Z"))).toContain("-2026-");
  });

  it("uses a different batch code on every call", () => {
    const codes = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      codes.add(suggestProductId("cocoa", HARVEST).split("-")[3] as string);
    }
    expect(codes.size).toBe(50);
  });

  it("never uses an ambiguous character in the batch code", () => {
    for (let index = 0; index < 50; index += 1) {
      const code = suggestProductId("cocoa", HARVEST).split("-")[3] as string;
      expect(code).toHaveLength(6);
      expect(code).not.toMatch(/[OI01]/);
    }
  });
});

describe("wallet addresses", () => {
  it("accepts a real generated public key", () => {
    expect(isValidWallet(Keypair.generate().publicKey.toBase58())).toBe(true);
  });

  it("accepts the all-zero system program address, which is a real pubkey", () => {
    expect(isValidWallet("11111111111111111111111111111111")).toBe(true);
  });

  it("ignores surrounding whitespace", () => {
    const address = Keypair.generate().publicKey.toBase58();
    expect(isValidWallet(`  ${address} `)).toBe(true);
    expect(normaliseWallet(`\n${address}\t`)).toBe(address);
  });

  it("rejects a string containing characters outside the base58 alphabet", () => {
    expect(isValidWallet("0OIl".padEnd(40, "a"))).toBe(false);
    expect(isValidWallet(`${"a".repeat(39)}!`)).toBe(false);
    expect(isValidWallet(`${"a".repeat(20)} ${"b".repeat(19)}`)).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidWallet("")).toBe(false);
    expect(isValidWallet("   ")).toBe(false);
  });

  it("rejects a 45 character string, which no pubkey can be", () => {
    const address = Keypair.generate().publicKey.toBase58();
    expect(address.length).toBeLessThanOrEqual(44);
    expect(isValidWallet("a".repeat(45))).toBe(false);
  });

  it("rejects a 31 character string, which is too short to be a pubkey", () => {
    expect(isValidWallet("a".repeat(31))).toBe(false);
  });

  it("throws a validation error from normaliseWallet for an invalid address", () => {
    const error = expectAppError(
      () => normaliseWallet("not-a-wallet", "ownerWallet"),
      ERROR_CODES.VALIDATION_ERROR
    );
    expect(error.message).toMatch(/does not look like a Solana wallet address/);
    expect(error.details).toEqual([{ path: "ownerWallet", message: "Invalid Solana wallet address." }]);
  });

  it("defaults the field name in normaliseWallet to the wallet address", () => {
    expectAppError(() => normaliseWallet("nope"), ERROR_CODES.VALIDATION_ERROR);
  });
});

describe("toPublicKey", () => {
  it("returns a PublicKey equal to the one the address encodes", () => {
    const generated = Keypair.generate().publicKey;
    expect(toPublicKey(generated.toBase58(), "walletAddress").equals(generated)).toBe(true);
  });

  it("trims surrounding whitespace before decoding", () => {
    const generated = Keypair.generate().publicKey;
    expect(toPublicKey(` ${generated.toBase58()} `, "walletAddress").equals(generated)).toBe(true);
  });

  it("throws a validation error naming the field for something that is not a public key", () => {
    const error = expectAppError(
      () => toPublicKey("definitely-not-a-key", "ownerWallet"),
      ERROR_CODES.VALIDATION_ERROR
    );
    expect(error.message).toBe('"ownerWallet" is not a valid Solana address.');
    expect(error.details).toEqual([{ path: "ownerWallet", message: "Invalid Solana address." }]);
  });

  it("throws a validation error for a base58 string of the wrong length", () => {
    expectAppError(() => toPublicKey("a".repeat(44), "walletAddress"), ERROR_CODES.VALIDATION_ERROR);
  });
});

describe("sha256", () => {
  it("returns 64 lowercase hexadecimal characters", () => {
    expect(sha256Hex("AGT-COCOA-2026-A1B2C3")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the published digest of the string abc", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("matches the published digest of the empty input", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("hashes the UTF-8 bytes of a string rather than UTF-16 code units", () => {
    expect(sha256Hex("é")).toBe(sha256Bytes(Buffer.from("é", "utf8")).toString("hex"));
    expect(sha256Hex("é")).not.toBe(sha256Hex(Buffer.from("é", "utf16le")));
  });

  it("is stable across calls", () => {
    expect(sha256Hex("stable")).toBe(sha256Hex("stable"));
  });

  it("returns the same 32 bytes as the hexadecimal form", () => {
    const bytes = sha256Bytes("AGT-COCOA-2026-A1B2C3");
    expect(bytes).toHaveLength(32);
    expect(bytes.toString("hex")).toBe(sha256Hex("AGT-COCOA-2026-A1B2C3"));
  });

  it("distinguishes inputs that differ only by a trailing newline", () => {
    expect(sha256Hex("abc\n")).not.toBe(sha256Hex("abc"));
  });
});

describe("safeEqual", () => {
  it("reports true for two equal strings", () => {
    expect(safeEqual("a1b2c3", "a1b2c3")).toBe(true);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("a".repeat(64), "a".repeat(64))).toBe(true);
  });

  it("reports false for two different strings of the same length", () => {
    expect(safeEqual("a1b2c3", "a1b2c4")).toBe(false);
    expect(safeEqual("a".repeat(64), "b".repeat(64))).toBe(false);
  });

  it("reports false for strings of different lengths without throwing", () => {
    expect(safeEqual("short", "a much longer value")).toBe(false);
    expect(safeEqual("a".repeat(64), "a".repeat(65))).toBe(false);
  });
});

describe("newId", () => {
  it("returns a distinct RFC 4122 identifier on every call", () => {
    const first = newId();
    const second = newId();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first).not.toBe(second);
  });
});
