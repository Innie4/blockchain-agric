import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import type { Role } from "../../lib/roles.js";
import type { ProductStatus } from "../../lib/statusMachine.js";

/**
 * A minimal, explicit borsh reader and writer for the on-chain types in
 * `programs/agri_trace/.../state.rs`.
 *
 * The backend does not depend on the generated Anchor client. That keeps the
 * deployed program's wire format in one auditable place, and it means the API
 * can be started before `anchor build` artifacts exist. The test-suite checks
 * this encoder against an independent borsh implementation so the two cannot
 * silently disagree with the Rust definitions.
 */

const encoder = new TextEncoder();

export class BinaryWriter {
  private chunks: Buffer[] = [];

  u8(value: number): this {
    const buffer = Buffer.alloc(1);
    buffer.writeUInt8(value, 0);
    this.chunks.push(buffer);
    return this;
  }

  bool(value: boolean): this {
    return this.u8(value ? 1 : 0);
  }

  u32(value: number): this {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value, 0);
    this.chunks.push(buffer);
    return this;
  }

  i64(value: number | bigint): this {
    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64LE(BigInt(value), 0);
    this.chunks.push(buffer);
    return this;
  }

  bytes(value: Uint8Array): this {
    this.chunks.push(Buffer.from(value));
    return this;
  }

  publicKey(value: PublicKey): this {
    return this.bytes(value.toBuffer());
  }

  /** Writes a borsh string: 4 byte little-endian length, then UTF-8 bytes. */
  string(value: string): this {
    const encoded = Buffer.from(encoder.encode(value));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(encoded.length, 0);
    this.chunks.push(length, encoded);
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export class BinaryReader {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  private require(count: number): void {
    if (this.offset + count > this.buffer.length) {
      throw new Error(
        `Unexpected end of account data: needed ${count} byte(s) at offset ${this.offset} of ${this.buffer.length}.`
      );
    }
  }

  u8(): number {
    this.require(1);
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u32(): number {
    this.require(4);
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  i64(): number {
    this.require(8);
    const value = this.buffer.readBigInt64LE(this.offset);
    this.offset += 8;
    return Number(value);
  }

  fixed(length: number): Buffer {
    this.require(length);
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return Buffer.from(value);
  }

  publicKey(): PublicKey {
    return new PublicKey(this.fixed(32));
  }

  string(): string {
    const length = this.u32();
    return this.fixed(length).toString("utf8");
  }

  get remaining(): number {
    return this.buffer.length - this.offset;
  }
}

/** Anchor's instruction discriminator: first 8 bytes of sha256("global:<name>"). */
export function instructionDiscriminator(name: string): Buffer {
  return createHash("sha256")
    .update(`global:${name}`, "utf8")
    .digest()
    .subarray(0, 8);
}

/** Anchor's event discriminator: first 8 bytes of sha256("event:<Name>"). */
export function eventDiscriminator(name: string): Buffer {
  return createHash("sha256")
    .update(`event:${name}`, "utf8")
    .digest()
    .subarray(0, 8);
}

export const INSTRUCTION_NAMES = {
  registerParticipant: "register_participant",
  registerProduct: "register_product",
  transferOwnership: "transfer_ownership",
  updateStatus: "update_status",
  recordVerification: "record_verification",
} as const;

export type InstructionName =
  (typeof INSTRUCTION_NAMES)[keyof typeof INSTRUCTION_NAMES];

export const STATUS_ORDINALS: Record<ProductStatus, number> = {
  REGISTERED: 0,
  IN_PROCESSING: 1,
  PROCESSED: 2,
  IN_TRANSIT: 3,
  AT_RETAILER: 4,
  LISTED: 5,
  SOLD: 6,
  FLAGGED: 7,
};

/** Ordinal for a status, rejecting a value that is not part of the enum. */
export function statusOrdinal(status: ProductStatus): number {
  const ordinal = STATUS_ORDINALS[status];
  if (ordinal === undefined) {
    throw new Error(`Unknown on-chain product status "${status}".`);
  }
  return ordinal;
}

export const STATUS_BY_ORDINAL: readonly ProductStatus[] = [
  "REGISTERED",
  "IN_PROCESSING",
  "PROCESSED",
  "IN_TRANSIT",
  "AT_RETAILER",
  "LISTED",
  "SOLD",
  "FLAGGED",
];

export const ROLE_ORDINALS: Record<Role, number> = {
  FARMER: 0,
  PROCESSOR: 1,
  TRANSPORTER: 2,
  RETAILER: 3,
  REGULATOR: 4,
};

export const VERIFICATION_RESULTS = ["VERIFIED", "MISMATCH", "NOT_FOUND", "INCOMPLETE"] as const;

export type VerificationResultName = (typeof VERIFICATION_RESULTS)[number];

/** Ordinal for a verification result, rejecting a value outside the enum. */
export const VERIFICATION_RESULT_ORDINALS: Record<VerificationResultName, number> = {
  VERIFIED: 0,
  MISMATCH: 1,
  NOT_FOUND: 2,
  INCOMPLETE: 3,
};

/** Indexed by ordinal, matching the Rust enum's declaration order. */
export const VERIFICATION_RESULT_BY_ORDINAL: readonly VerificationResultName[] = [
  "VERIFIED",
  "MISMATCH",
  "NOT_FOUND",
  "INCOMPLETE",
];

/** Ordinal for a verification result, rejecting a value outside the enum. */
export function verificationResultOrdinal(result: VerificationResultName): number {
  const ordinal = VERIFICATION_RESULT_ORDINALS[result];
  if (ordinal === undefined) {
    throw new Error(`Unknown on-chain verification result "${result}".`);
  }
  return ordinal;
}

export function statusFromOrdinal(ordinal: number): ProductStatus {
  const value = STATUS_BY_ORDINAL[ordinal];
  if (value === undefined) {
    throw new Error(`Unknown on-chain product status ordinal ${ordinal}.`);
  }
  return value;
}

export function roleFromOrdinal(ordinal: number): Role {
  const entry = (Object.keys(ROLE_ORDINALS) as Role[]).find(
    (role) => ROLE_ORDINALS[role] === ordinal
  );
  if (entry === undefined) {
    throw new Error(`Unknown on-chain participant role ordinal ${ordinal}.`);
  }
  return entry;
}

/** Field order of `ProductAccount` in the Rust definition. */
export interface DecodedProductAccount {
  version: number;
  bump: number;
  flags: number;
  status: ProductStatus;
  preFlagStatus: ProductStatus;
  productId: string;
  registrant: string;
  owner: string;
  registeredAt: number;
  updatedAt: number;
  lastTransferAt: number;
  lastVerifiedAt: number;
  offChainDataHash: string;
  transferCount: number;
  /** Deterministic program-derived address of this account. */
  product: string;
}

/** Bytes the account occupies: 8 discriminator + the struct fields. */
export const PRODUCT_ACCOUNT_SIZE = 181;
export const PARTICIPANT_ACCOUNT_SIZE = 8 + 1 + 1 + 32 + 1 + 8 + 32 + 1;

export function decodeProductAccount(data: Buffer, address?: string): DecodedProductAccount {
  const reader = new BinaryReader(data);
  reader.fixed(8); // account discriminator
  const version = reader.u8();
  const bump = reader.u8();
  const flags = reader.u8();
  const status = statusFromOrdinal(reader.u8());
  const preFlagStatus = statusFromOrdinal(reader.u8());
  const productId = reader.string();
  const registrant = reader.publicKey().toBase58();
  const owner = reader.publicKey().toBase58();
  const registeredAt = reader.i64();
  const updatedAt = reader.i64();
  const lastTransferAt = reader.i64();
  const lastVerifiedAt = reader.i64();
  const offChainDataHash = reader.fixed(32).toString("hex");
  const transferCount = reader.u32();
  return {
    version,
    bump,
    flags,
    status,
    preFlagStatus,
    productId,
    registrant,
    owner,
    registeredAt,
    updatedAt,
    lastTransferAt,
    lastVerifiedAt,
    offChainDataHash,
    transferCount,
    product: address ?? "",
  };
}

export interface DecodedParticipantAccount {
  version: number;
  bump: number;
  participant: string;
  role: Role;
  registeredAt: number;
  profileHash: string;
  revoked: boolean;
}

export function decodeParticipantAccount(
  data: Buffer
): DecodedParticipantAccount {
  const reader = new BinaryReader(data);
  reader.fixed(8);
  const version = reader.u8();
  const bump = reader.u8();
  const participant = reader.publicKey().toBase58();
  const role = roleFromOrdinal(reader.u8());
  const registeredAt = reader.i64();
  const profileHash = reader.fixed(32).toString("hex");
  const revoked = reader.bool();
  return { version, bump, participant, role, registeredAt, profileHash, revoked };
}

/** True when the buffer carries this program's account discriminator. */
export function hasProgramDiscriminator(
  data: Buffer,
  expected: Buffer
): boolean {
  return data.length >= 8 && data.subarray(0, 8).equals(expected);
}
