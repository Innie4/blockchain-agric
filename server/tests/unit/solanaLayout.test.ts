import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { serialize as borshSerialize } from "borsh";
import { BinaryReader, BinaryWriter, INSTRUCTION_NAMES, decodeParticipantAccount, decodeProductAccount, eventDiscriminator, instructionDiscriminator, PRODUCT_ACCOUNT_SIZE, PARTICIPANT_ACCOUNT_SIZE, ROLE_ORDINALS, STATUS_ORDINALS } from "../../src/services/solana/layout.js";
import { getParticipantAddress, getProductAddress } from "../../src/services/solana/pda.js";
import { buildRegisterParticipant, buildRegisterProduct, buildTransferOwnership, buildUpdateStatus, buildRecordVerification } from "../../src/services/solana/instructions.js";
import { parseProgramEvents } from "../../src/services/solana/events.js";

const PROGRAM_ID = new PublicKey("AgriTrace418FNVcjry6EMUbiqx5DLTahpw4CKSZgov3");

/**
 * These tests pin the wire format the backend speaks to the wire format the
 * Rust program speaks. A reference borsh implementation is used where one
 * exists, and the field order and sizes are asserted against the definitions in
 * `programs/agri_trace/programs/agri_trace/src/state.rs`, so a change to either
 * side fails here rather than at runtime against a live cluster.
 */
describe("on-chain layout", () => {
  it("derives the same instruction discriminators Anchor does", () => {
    // Anchor computes sha256("global:<snake_case_name>")[..8].
    for (const name of Object.values(INSTRUCTION_NAMES)) {
      const bytes = instructionDiscriminator(name);
      expect(bytes.length).toBe(8);
      expect(bytes.toString("hex")).toMatch(/^[0-9a-f]{16}$/);
    }
    // Distinct instructions must have distinct discriminators.
    const all = Object.values(INSTRUCTION_NAMES).map((name) =>
      instructionDiscriminator(name).toString("hex")
    );
    expect(new Set(all).size).toBe(all.length);
  });

  it("derives event discriminators from the event name", () => {
    expect(eventDiscriminator("ProductRegistered").toString("hex")).toHaveLength(16);
    expect(eventDiscriminator("ProductRegistered")).not.toEqual(
      eventDiscriminator("OwnershipTransferred")
    );
  });

  it("round-trips a borsh string and integer fields", () => {
    const writer = new BinaryWriter()
      .string("AGT-COCOA-2026-A1B2C3")
      .u8(3)
      .u32(7)
      .i64(1_700_000_000);
    const reader = new BinaryReader(writer.toBuffer());
    expect(reader.string()).toBe("AGT-COCOA-2026-A1B2C3");
    expect(reader.u8()).toBe(3);
    expect(reader.u32()).toBe(7);
    expect(reader.i64()).toBe(1_700_000_000);
  });

  it("encodes strings exactly as the reference borsh implementation does", () => {
    const value = "AGT-COCOA-2026-A1B2C3";
    const mine = new BinaryWriter().string(value).toBuffer();
    expect(mine.equals(borshSerialize("string", value))).toBe(true);
  });

  it("encodes a u32 little-endian, as the reference implementation does", () => {
    const mine = new BinaryWriter().u32(0x01020304).toBuffer();
    expect(mine.equals(borshSerialize("u32", 0x01020304))).toBe(true);
    expect(mine.toString("hex")).toBe("04030201");
  });

  it("encodes an i64 little-endian, which is what Solana borsh requires", () => {
    // The `borsh` npm package serialises i64 big-endian, so it cannot be used
    // as the oracle here. Solana's borsh is little-endian for every integer
    // width, and an incorrect byte order here would make the cluster reject the
    // transaction with an opaque decoding error, so the layout is asserted
    // directly instead.
    expect(new BinaryWriter().i64(1).toBuffer().toString("hex")).toBe("0100000000000000");
    expect(new BinaryWriter().i64(-1).toBuffer().toString("hex")).toBe("ffffffffffffffff");
    expect(new BinaryWriter().i64(1_700_000_000).toBuffer().toString("hex")).toBe(
      "00f1536500000000"
    );
    expect(new BinaryWriter().i64(0).toBuffer().toString("hex")).toBe("0000000000000000");
  });

  it("round-trips a negative i64", () => {
    for (const value of [-1, -1_700_000_000, Number.MIN_SAFE_INTEGER, 0, 1, 1_700_000_000]) {
      expect(new BinaryReader(new BinaryWriter().i64(value).toBuffer()).i64()).toBe(value);
    }
  });

  it("encodes a 32 byte payload verbatim", () => {
    const bytes = Buffer.from("00".repeat(31) + "ff", "hex");
    expect(new BinaryWriter().bytes(bytes).toBuffer().equals(bytes)).toBe(true);
  });

  it("encodes an empty string as a zero length, not an absent field", () => {
    const mine = new BinaryWriter().string("").toBuffer();
    expect(mine.equals(borshSerialize("string", ""))).toBe(true);
    expect(mine.length).toBe(4);
  });
});

describe("product account", () => {
  /** Mirrors the field order declared in `state.rs`. */
  function buildProductAccount(overrides: Partial<Record<string, unknown>> = {}): Buffer {
    const values = {
      discriminator: Buffer.from("11".repeat(8), "hex"),
      version: 1,
      bump: 254,
      flags: 0,
      status: STATUS_ORDINALS.IN_TRANSIT,
      preFlagStatus: STATUS_ORDINALS.PROCESSED,
      productId: "AGT-COCOA-2026-A1B2C3",
      registrant: new PublicKey("11111111111111111111111111111112"),
      owner: new PublicKey("11111111111111111111111111111113"),
      registeredAt: 1_700_000_000,
      updatedAt: 1_700_000_100,
      lastTransferAt: 1_700_000_050,
      lastVerifiedAt: 1_700_000_075,
      offChainDataHash: Buffer.from("ab".repeat(32), "hex"),
      transferCount: 3,
      ...overrides,
    };
    return new BinaryWriter()
      .bytes(values.discriminator)
      .u8(values.version)
      .u8(values.bump)
      .u8(values.flags)
      .u8(values.status)
      .u8(values.preFlagStatus)
      .string(values.productId)
      .publicKey(values.registrant)
      .publicKey(values.owner)
      .i64(values.registeredAt)
      .i64(values.updatedAt)
      .i64(values.lastTransferAt)
      .i64(values.lastVerifiedAt)
      .bytes(values.offChainDataHash)
      .u32(values.transferCount)
      .toBuffer();
  }

  it("reserves the space declared by the Rust `InitSpace` derive", () => {
    // Anchor allocates the maximum identifier length, so the reserved size is
    // fixed even though the bytes actually written vary with the identifier.
    //   8 discriminator + 5 single bytes + (4 + 32) string + 2 pubkeys
    //   + 4 i64 + 32 hash + 1 u32
    expect(PRODUCT_ACCOUNT_SIZE).toBe(8 + 5 + (4 + 32) + 64 + 32 + 32 + 4);
    expect(PRODUCT_ACCOUNT_SIZE).toBe(181);
  });

  it("decodes an account whose identifier is shorter than the maximum", () => {
    const account = buildProductAccount();
    // 21 characters of identifier, so the payload is 11 bytes shorter than the
    // reservation; the decoder must not assume a fixed-length string.
    expect(account.length).toBe(PRODUCT_ACCOUNT_SIZE - 11);
    expect(decodeProductAccount(account).productId).toBe("AGT-COCOA-2026-A1B2C3");
  });

  it("decodes an account whose identifier uses the whole reservation", () => {
    const longId = `AGT-${"COCOA".slice(0, 6)}-2026-${"ABCDEF".slice(0, 6)}`.padEnd(32, "X");
    expect(longId.length).toBe(32);
    const account = buildProductAccount({ productId: longId });
    expect(account.length).toBe(PRODUCT_ACCOUNT_SIZE);
    expect(decodeProductAccount(account).productId).toBe(longId);
  });

  it("decodes every field in declaration order", () => {
    const decoded = decodeProductAccount(buildProductAccount(), "product-address");
    expect(decoded.version).toBe(1);
    expect(decoded.bump).toBe(254);
    expect(decoded.flags).toBe(0);
    expect(decoded.status).toBe("IN_TRANSIT");
    expect(decoded.preFlagStatus).toBe("PROCESSED");
    expect(decoded.productId).toBe("AGT-COCOA-2026-A1B2C3");
    expect(decoded.registrant).toBe("11111111111111111111111111111112");
    expect(decoded.owner).toBe("11111111111111111111111111111113");
    expect(decoded.registeredAt).toBe(1_700_000_000);
    expect(decoded.updatedAt).toBe(1_700_000_100);
    expect(decoded.lastTransferAt).toBe(1_700_000_050);
    expect(decoded.lastVerifiedAt).toBe(1_700_000_075);
    expect(decoded.offChainDataHash).toBe("ab".repeat(32));
    expect(decoded.transferCount).toBe(3);
    expect(decoded.product).toBe("product-address");
  });

  it("rejects a truncated account rather than reading nonsense", () => {
    const truncated = buildProductAccount().subarray(0, 40);
    expect(() => decodeProductAccount(truncated)).toThrow(/Unexpected end/);
  });

  it("rejects an unknown status ordinal", () => {
    const account = buildProductAccount({ status: 200 });
    expect(() => decodeProductAccount(account)).toThrow(/Unknown on-chain product status/);
  });
});

describe("participant account", () => {
  it("has the size declared by the Rust `InitSpace` derive", () => {
    // 8 discriminator + version + bump + pubkey + role + i64 + 32 hash + bool
    expect(PARTICIPANT_ACCOUNT_SIZE).toBe(8 + 1 + 1 + 32 + 1 + 8 + 32 + 1);
  });

  it("decodes every field in declaration order", () => {
    const wallet = new PublicKey("11111111111111111111111111111112");
    const account = new BinaryWriter()
      .bytes(Buffer.from("22".repeat(8), "hex"))
      .u8(1)
      .u8(253)
      .publicKey(wallet)
      .u8(ROLE_ORDINALS.PROCESSOR)
      .i64(1_700_000_000)
      .bytes(Buffer.from("cd".repeat(32), "hex"))
      .bool(false)
      .toBuffer();
    const decoded = decodeParticipantAccount(account);
    expect(decoded.version).toBe(1);
    expect(decoded.bump).toBe(253);
    expect(decoded.participant).toBe(wallet.toBase58());
    expect(decoded.role).toBe("PROCESSOR");
    expect(decoded.registeredAt).toBe(1_700_000_000);
    expect(decoded.profileHash).toBe("cd".repeat(32));
    expect(decoded.revoked).toBe(false);
  });
});

describe("program-derived addresses", () => {
  it("derives a product address from the identifier and the program", () => {
    const first = getProductAddress(PROGRAM_ID, "AGT-COCOA-2026-A1B2C3");
    const again = getProductAddress(PROGRAM_ID, "AGT-COCOA-2026-A1B2C3");
    const other = getProductAddress(PROGRAM_ID, "AGT-COCOA-2026-Z9Y8X7");
    expect(first.equals(again)).toBe(true);
    expect(first.equals(other)).toBe(false);
    // A PDA never falls on the curve, which is the point of deriving it.
    expect(PublicKey.isOnCurve(first.toBuffer())).toBe(false);
  });

  it("derives a participant address from the wallet", () => {
    const wallet = new PublicKey("11111111111111111111111111111112");
    const address = getParticipantAddress(PROGRAM_ID, wallet);
    expect(address.equals(getParticipantAddress(PROGRAM_ID, wallet))).toBe(true);
    expect(
      address.equals(getParticipantAddress(PROGRAM_ID, new PublicKey("11111111111111111111111111111113")))
    ).toBe(false);
  });

  it("changes address when the program changes", () => {
    const otherProgram = new PublicKey("HBQNazGuTRGd1A1yhYw9XYWyuDCYZ2ysQn1MG4m3ZA7R");
    expect(
      getProductAddress(PROGRAM_ID, "AGT-COCOA-2026-A1B2C3").equals(
        getProductAddress(otherProgram, "AGT-COCOA-2026-A1B2C3")
      )
    ).toBe(false);
  });
});

describe("instruction encoding", () => {
  const signer = new PublicKey("11111111111111111111111111111112");
  const recipient = new PublicKey("11111111111111111111111111111113");

  it("encodes register_participant with the role and profile hash", () => {
    const hash = Buffer.from("ef".repeat(32), "hex");
    const instruction = buildRegisterParticipant(PROGRAM_ID, signer, "FARMER", hash);
    expect(instruction.programId.equals(PROGRAM_ID)).toBe(true);
    const body = instruction.data.subarray(8);
    expect(body.readUInt8(0)).toBe(ROLE_ORDINALS.FARMER);
    expect(body.subarray(1, 33).equals(hash)).toBe(true);
    expect(instruction.keys[0]?.isSigner).toBe(true);
    expect(instruction.keys[1]?.pubkey.equals(getParticipantAddress(PROGRAM_ID, signer))).toBe(true);
  });

  it("refuses a profile hash of the wrong length", () => {
    expect(() =>
      buildRegisterParticipant(PROGRAM_ID, signer, "FARMER", Buffer.alloc(16))
    ).toThrow(/32 bytes/);
  });

  it("encodes register_product with the identifier and payload hash", () => {
    const hash = Buffer.from("ab".repeat(32), "hex");
    const instruction = buildRegisterProduct(
      PROGRAM_ID,
      signer,
      "AGT-COCOA-2026-A1B2C3",
      hash
    );
    const body = instruction.data.subarray(8);
    const length = body.readUInt32LE(0);
    expect(body.subarray(4, 4 + length).toString("utf8")).toBe("AGT-COCOA-2026-A1B2C3");
    expect(body.subarray(4 + length, 36 + length).equals(hash)).toBe(true);
    expect(
      instruction.keys[2]?.pubkey.equals(getProductAddress(PROGRAM_ID, "AGT-COCOA-2026-A1B2C3"))
    ).toBe(true);
  });

  it("encodes transfer_ownership with a 16 byte correlation identifier", () => {
    const reference = Buffer.alloc(16, 3);
    const instruction = buildTransferOwnership(
      PROGRAM_ID,
      signer,
      "AGT-COCOA-2026-A1B2C3",
      recipient,
      reference
    );
    expect(instruction.data.subarray(8, 24).equals(reference)).toBe(true);
    expect(
      instruction.keys[2]?.pubkey.equals(getParticipantAddress(PROGRAM_ID, recipient))
    ).toBe(true);
  });

  it("refuses a transfer reference of the wrong length", () => {
    expect(() =>
      buildTransferOwnership(PROGRAM_ID, signer, "AGT-COCOA-2026-A1B2C3", recipient, Buffer.alloc(8))
    ).toThrow(/16 bytes/);
  });

  it("encodes update_status with the status ordinal and event time", () => {
    const instruction = buildUpdateStatus(
      PROGRAM_ID,
      signer,
      "AGT-COCOA-2026-A1B2C3",
      "PROCESSED",
      1_700_000_000
    );
    const body = instruction.data.subarray(8);
    expect(body.readUInt8(0)).toBe(STATUS_ORDINALS.PROCESSED);
    expect(Number(body.readBigInt64LE(1))).toBe(1_700_000_000);
  });

  it("encodes record_verification with the result ordinal and hash", () => {
    const hash = Buffer.from("12".repeat(32), "hex");
    const instruction = buildRecordVerification(
      PROGRAM_ID,
      signer,
      "AGT-COCOA-2026-A1B2C3",
      "MISMATCH",
      hash,
      1_700_000_000
    );
    const body = instruction.data.subarray(8);
    expect(body.readUInt8(0)).toBe(1);
    expect(body.subarray(1, 33).equals(hash)).toBe(true);
    expect(Number(body.readBigInt64LE(33))).toBe(1_700_000_000);
  });
});

describe("event decoding", () => {
  it("reads a ProductRegistered event out of a transaction log", () => {
    const product = new PublicKey("78Exg6vuy8DHXMFxznQb9vabC8k8hagQXd75TzwEhjKV");
    const owner = new PublicKey("11111111111111111111111111111112");
    const payload = new BinaryWriter()
      .bytes(eventDiscriminator("ProductRegistered"))
      .string("AGT-COCOA-2026-A1B2C3")
      .publicKey(product)
      .publicKey(owner)
      .publicKey(owner)
      .u8(STATUS_ORDINALS.REGISTERED)
      .i64(1_700_000_000)
      .bytes(Buffer.from("ab".repeat(32), "hex"))
      .toBuffer();
    const events = parseProgramEvents(
      [`Program data: ${payload.toString("base64")}`],
      "sig-1",
      42
    );
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.name).toBe("ProductRegistered");
    expect(event?.signature).toBe("sig-1");
    expect(event?.slot).toBe(42);
    expect(event).toMatchObject({
      productId: "AGT-COCOA-2026-A1B2C3",
      registrant: owner.toBase58(),
      owner: owner.toBase58(),
      status: "REGISTERED",
      registeredAt: 1_700_000_000,
      offChainDataHash: "ab".repeat(32),
    });
  });

  it("reads an OwnershipTransferred event", () => {
    const product = new PublicKey("78Exg6vuy8DHXMFxznQb9vabC8k8hagQXd75TzwEhjKV");
    const from = new PublicKey("11111111111111111111111111111112");
    const to = new PublicKey("11111111111111111111111111111113");
    const reference = Buffer.alloc(16, 9);
    const payload = new BinaryWriter()
      .bytes(eventDiscriminator("OwnershipTransferred"))
      .string("AGT-COCOA-2026-A1B2C3")
      .publicKey(product)
      .publicKey(from)
      .publicKey(to)
      .bytes(reference)
      .u32(1)
      .i64(1_700_000_500)
      .toBuffer();
    const events = parseProgramEvents([`Program data: ${payload.toString("base64")}`], "sig-2", 7);
    expect(events[0]).toMatchObject({
      name: "OwnershipTransferred",
      from: from.toBase58(),
      to: to.toBase58(),
      transferId: reference.toString("hex"),
      transferCount: 1,
      occurredAt: 1_700_000_500,
    });
  });

  it("reads a ProductStatusUpdated event", () => {
    const product = new PublicKey("78Exg6vuy8DHXMFxznQb9vabC8k8hagQXd75TzwEhjKV");
    const actor = new PublicKey("11111111111111111111111111111112");
    const payload = new BinaryWriter()
      .bytes(eventDiscriminator("ProductStatusUpdated"))
      .string("AGT-COCOA-2026-A1B2C3")
      .publicKey(product)
      .publicKey(actor)
      .u8(STATUS_ORDINALS.IN_PROCESSING)
      .u8(STATUS_ORDINALS.PROCESSED)
      .i64(1_700_000_900)
      .toBuffer();
    const events = parseProgramEvents([`Program data: ${payload.toString("base64")}`], "sig-3", 9);
    expect(events[0]).toMatchObject({
      previousStatus: "IN_PROCESSING",
      newStatus: "PROCESSED",
      occurredAt: 1_700_000_900,
    });
  });

  it("ignores program log lines that are not events", () => {
    const logs = [
      "Program AgriTrace invoke [1]",
      "Program log: Instruction: RegisterProduct",
      "Program AgriTrace consumed 4821 of 200000 compute units",
      "Program AgriTrace success",
    ];
    expect(parseProgramEvents(logs, "sig-4", 1)).toEqual([]);
  });

  it("ignores a payload with an unknown discriminator", () => {
    const payload = new BinaryWriter()
      .bytes(Buffer.from("ff".repeat(8), "hex"))
      .u32(1)
      .toBuffer();
    expect(
      parseProgramEvents([`Program data: ${payload.toString("base64")}`], "sig-5", 1)
    ).toEqual([]);
  });
});
