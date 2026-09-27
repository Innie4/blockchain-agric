import { createHash } from "node:crypto";

/**
 * The wire formats the mock Solana transport has to produce and consume.
 *
 * These are an independent re-derivation of the layouts documented in
 * `server/src/services/solana/layout.ts` and `server/src/services/solana/events.ts`.
 * They are duplicated rather than imported on purpose: if the mock imported the
 * API's own encoder, a mistake in that encoder could not show up here, and the
 * whole point of the mock is to be a second, independent witness of the format.
 * Every value the mock writes is read back by the *API's* real decoder, so a
 * disagreement between the two fails the test that exercises it.
 */

const encoder = new TextEncoder();

/** Little-endian writer for the subset of borsh the program uses. */
export class BorshWriter {
  private readonly chunks: Buffer[] = [];

  u8(value: number): this {
    const buffer = Buffer.alloc(1);
    buffer.writeUInt8(value, 0);
    this.chunks.push(buffer);
    return this;
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

  /** A 4 byte length followed by the UTF-8 bytes. */
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

/** Little-endian reader, used to take a submitted transaction apart. */
export class BorshReader {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  private require(count: number): void {
    if (this.offset + count > this.buffer.length) {
      throw new Error(
        `Unexpected end of instruction data: needed ${count} byte(s) at offset ${this.offset} of ${this.buffer.length}.`,
      );
    }
  }

  u8(): number {
    this.require(1);
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
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

  string(): string {
    return this.fixed(this.u32()).toString("utf8");
  }

  get remaining(): number {
    return this.buffer.length - this.offset;
  }
}

/** Anchor's instruction discriminator: the first 8 bytes of `sha256("global:<name>")`. */
export function instructionDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`, "utf8").digest().subarray(0, 8);
}

/** Anchor's event discriminator: the first 8 bytes of `sha256("event:<Name>")`. */
export function eventDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`event:${name}`, "utf8").digest().subarray(0, 8);
}

/** Anchor's account discriminator: the first 8 bytes of `sha256("account:<Name>")`. */
export function accountDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`, "utf8").digest().subarray(0, 8);
}

/** The five instructions `server/src/services/solana/instructions.ts` builds. */
export const INSTRUCTION_NAMES = {
  registerParticipant: "register_participant",
  registerProduct: "register_product",
  transferOwnership: "transfer_ownership",
  updateStatus: "update_status",
  recordVerification: "record_verification",
} as const;

/** `ProductStatus` in `state.rs` declaration order, and its ordinals. */
export const STATUS_ORDINALS: Readonly<Record<string, number>> = {
  REGISTERED: 0,
  IN_PROCESSING: 1,
  PROCESSED: 2,
  IN_TRANSIT: 3,
  AT_RETAILER: 4,
  LISTED: 5,
  SOLD: 6,
  FLAGGED: 7,
};

export const STATUS_NAMES: readonly string[] = [
  "REGISTERED",
  "IN_PROCESSING",
  "PROCESSED",
  "IN_TRANSIT",
  "AT_RETAILER",
  "LISTED",
  "SOLD",
  "FLAGGED",
];

/** `ParticipantRole` in `state.rs` declaration order. */
export const ROLE_ORDINALS: Readonly<Record<string, number>> = {
  FARMER: 0,
  PROCESSOR: 1,
  TRANSPORTER: 2,
  RETAILER: 3,
  REGULATOR: 4,
};

export const ROLE_NAMES: readonly string[] = [
  "FARMER",
  "PROCESSOR",
  "TRANSPORTER",
  "RETAILER",
  "REGULATOR",
];

/** `VerificationResult` in `state.rs` declaration order. */
export const VERIFICATION_RESULT_NAMES: readonly string[] = [
  "VERIFIED",
  "MISMATCH",
  "NOT_FOUND",
  "INCOMPLETE",
];

/**
 * The stage a batch takes when ownership passes to a participant in a role.
 * Mirrors the `match recipient_role` arm of the program's transfer handler and
 * `STATUS_ON_RECEIPT` in `server/src/lib/statusMachine.ts`.
 */
export const STATUS_ON_RECEIPT: Readonly<Record<string, string>> = {
  PROCESSOR: "IN_PROCESSING",
  TRANSPORTER: "IN_TRANSIT",
  RETAILER: "AT_RETAILER",
};

/** The account the program opens for each batch, in `state.rs` field order. */
export const PRODUCT_ACCOUNT_SIZE = 181;

/** The account the program opens for each participant, in `state.rs` field order. */
export const PARTICIPANT_ACCOUNT_SIZE = 8 + 1 + 1 + 32 + 1 + 8 + 32 + 1;

export interface ProductAccountFields {
  version: number;
  bump: number;
  flags: number;
  status: string;
  preFlagStatus: string;
  productId: string;
  registrant: Uint8Array;
  owner: Uint8Array;
  registeredAt: number;
  updatedAt: number;
  lastTransferAt: number;
  lastVerifiedAt: number;
  offChainDataHash: Uint8Array;
  transferCount: number;
}

/**
 * Encodes a `ProductAccount` exactly as the program would, including the padding
 * to the account's reserved size. The API's `decodeProductAccount` reads fields
 * in order and ignores anything after them, so the padding is inert but keeps
 * the byte count honest.
 */
export function encodeProductAccount(fields: ProductAccountFields): Buffer {
  const status = STATUS_ORDINALS[fields.status];
  const preFlagStatus = STATUS_ORDINALS[fields.preFlagStatus];
  if (status === undefined || preFlagStatus === undefined) {
    throw new Error(`Unknown product status in "${fields.status}" / "${fields.preFlagStatus}".`);
  }

  const body = new BorshWriter()
    .u8(fields.version)
    .u8(fields.bump)
    .u8(fields.flags)
    .u8(status)
    .u8(preFlagStatus)
    .string(fields.productId)
    .bytes(fields.registrant)
    .bytes(fields.owner)
    .i64(fields.registeredAt)
    .i64(fields.updatedAt)
    .i64(fields.lastTransferAt)
    .i64(fields.lastVerifiedAt)
    .bytes(fields.offChainDataHash)
    .u32(fields.transferCount)
    .toBuffer();

  const total = Math.max(PRODUCT_ACCOUNT_SIZE, 8 + body.length);
  return Buffer.concat([
    accountDiscriminator("ProductAccount"),
    body,
    Buffer.alloc(total - 8 - body.length),
  ]);
}

export interface ParticipantAccountFields {
  version: number;
  bump: number;
  participant: Uint8Array;
  role: string;
  registeredAt: number;
  profileHash: Uint8Array;
  revoked: boolean;
}

/** Encodes a `ParticipantAccount` as the program would. */
export function encodeParticipantAccount(fields: ParticipantAccountFields): Buffer {
  const role = ROLE_ORDINALS[fields.role];
  if (role === undefined) throw new Error(`Unknown participant role "${fields.role}".`);

  return Buffer.concat([
    accountDiscriminator("ParticipantAccount"),
    new BorshWriter()
      .u8(fields.version)
      .u8(fields.bump)
      .bytes(fields.participant)
      .u8(role)
      .i64(fields.registeredAt)
      .bytes(fields.profileHash)
      .u8(fields.revoked ? 1 : 0)
      .toBuffer(),
    Buffer.alloc(Math.max(0, PARTICIPANT_ACCOUNT_SIZE - 8 - 1 - 1 - 32 - 1 - 8 - 32 - 1)),
  ]);
}

/* ------------------------------------------------------------------ *
 * Anchor `emit!` payloads
 *
 * Anchor 0.30 writes each event as a base64 `Program data: <base64>` log line
 * whose payload is `8 byte event discriminator || borsh-encoded event struct`.
 * The field order below is the declaration order of each event in `state.rs`,
 * which is what the API's `events.ts` readers assume.
 * ------------------------------------------------------------------ */

export function encodeProductRegisteredEvent(event: {
  productId: string;
  product: Uint8Array;
  registrant: Uint8Array;
  owner: Uint8Array;
  status: string;
  registeredAt: number;
  offChainDataHash: Uint8Array;
}): Buffer {
  const status = STATUS_ORDINALS[event.status];
  if (status === undefined) throw new Error(`Unknown product status "${event.status}".`);
  return Buffer.concat([
    eventDiscriminator("ProductRegistered"),
    new BorshWriter()
      .string(event.productId)
      .bytes(event.product)
      .bytes(event.registrant)
      .bytes(event.owner)
      .u8(status)
      .i64(event.registeredAt)
      .bytes(event.offChainDataHash)
      .toBuffer(),
  ]);
}

export function encodeOwnershipTransferredEvent(event: {
  productId: string;
  product: Uint8Array;
  from: Uint8Array;
  to: Uint8Array;
  transferId: Uint8Array;
  transferCount: number;
  occurredAt: number;
}): Buffer {
  return Buffer.concat([
    eventDiscriminator("OwnershipTransferred"),
    new BorshWriter()
      .string(event.productId)
      .bytes(event.product)
      .bytes(event.from)
      .bytes(event.to)
      .bytes(event.transferId)
      .u32(event.transferCount)
      .i64(event.occurredAt)
      .toBuffer(),
  ]);
}

export function encodeProductStatusUpdatedEvent(event: {
  productId: string;
  product: Uint8Array;
  actor: Uint8Array;
  previousStatus: string;
  newStatus: string;
  occurredAt: number;
}): Buffer {
  const previous = STATUS_ORDINALS[event.previousStatus];
  const next = STATUS_ORDINALS[event.newStatus];
  if (previous === undefined || next === undefined) {
    throw new Error(`Unknown status in "${event.previousStatus}" / "${event.newStatus}".`);
  }
  return Buffer.concat([
    eventDiscriminator("ProductStatusUpdated"),
    new BorshWriter()
      .string(event.productId)
      .bytes(event.product)
      .bytes(event.actor)
      .u8(previous)
      .u8(next)
      .i64(event.occurredAt)
      .toBuffer(),
  ]);
}

export function encodeVerificationRecordedEvent(event: {
  productId: string;
  product: Uint8Array;
  verifier: Uint8Array;
  result: string;
  verificationHash: Uint8Array;
  occurredAt: number;
}): Buffer {
  const result = VERIFICATION_RESULT_NAMES.indexOf(event.result);
  if (result === -1) throw new Error(`Unknown verification result "${event.result}".`);
  return Buffer.concat([
    eventDiscriminator("VerificationRecorded"),
    new BorshWriter()
      .string(event.productId)
      .bytes(event.product)
      .bytes(event.verifier)
      .u8(result)
      .bytes(event.verificationHash)
      .i64(event.occurredAt)
      .toBuffer(),
  ]);
}

export function encodeParticipantRegisteredEvent(event: {
  participant: Uint8Array;
  role: string;
  profileHash: Uint8Array;
  registeredAt: number;
}): Buffer {
  const role = ROLE_ORDINALS[event.role];
  if (role === undefined) throw new Error(`Unknown participant role "${event.role}".`);
  return Buffer.concat([
    eventDiscriminator("ParticipantRegisteredEvent"),
    new BorshWriter()
      .bytes(event.participant)
      .u8(role)
      .bytes(event.profileHash)
      .i64(event.registeredAt)
      .toBuffer(),
  ]);
}
