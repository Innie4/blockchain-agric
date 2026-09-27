import { createHash } from "node:crypto";
import {
  BinaryReader,
  type DecodedParticipantAccount,
  type DecodedProductAccount,
  statusFromOrdinal,
  roleFromOrdinal,
  STATUS_BY_ORDINAL,
  VERIFICATION_RESULT_BY_ORDINAL,
  eventDiscriminator,
} from "./layout.js";
import type {
  OwnershipTransferredEvent,
  ParticipantRegisteredChainEvent,
  ProductRegisteredEvent,
  ProductStatusUpdatedEvent,
  ProgramEvent,
  VerificationRecordedEvent,
} from "./chainClient.js";

/**
 * Decodes Anchor's `emit!` payloads out of a confirmed transaction's logs.
 *
 * Anchor 0.30 emits events as base64 `Program data: <base64>` log lines, where
 * the payload is `8 byte event discriminator || borsl-encoded event struct`.
 * Nothing is guessed from log text beyond the `Program data:` prefix, so a
 * program log line cannot be mistaken for an event.
 */
const EVENT_LOG_PREFIX = "Program data: ";

const EVENT_NAMES = [
  "ProductRegistered",
  "OwnershipTransferred",
  "ProductStatusUpdated",
  "VerificationRecorded",
  "ParticipantRegisteredEvent",
] as const;

const DISCRIMINATORS = new Map<string, string>(
  EVENT_NAMES.map((name) => [eventDiscriminator(name).toString("hex"), name])
);

export function decodeEventPayload(payload: Buffer): ProgramEvent | null {
  if (payload.length < 8) return null;
  const name = DISCRIMINATORS.get(payload.subarray(0, 8).toString("hex"));
  if (name === undefined) return null;
  const reader = new BinaryReader(payload.subarray(8));
  switch (name) {
    case "ProductRegistered":
      return readProductRegistered(reader);
    case "OwnershipTransferred":
      return readOwnershipTransferred(reader);
    case "ProductStatusUpdated":
      return readStatusUpdated(reader);
    case "VerificationRecorded":
      return readVerificationRecorded(reader);
    case "ParticipantRegisteredEvent":
      return readParticipantRegistered(reader);
    default:
      return null;
  }
}

function readProductRegistered(reader: BinaryReader): ProductRegisteredEvent {
  return {
    name: "ProductRegistered",
    productId: reader.string(),
    product: reader.publicKey().toBase58(),
    registrant: reader.publicKey().toBase58(),
    owner: reader.publicKey().toBase58(),
    status: statusFromOrdinal(reader.u8()),
    registeredAt: reader.i64(),
    offChainDataHash: reader.fixed(32).toString("hex"),
    signature: "",
    slot: 0,
  };
}

function readOwnershipTransferred(reader: BinaryReader): OwnershipTransferredEvent {
  return {
    name: "OwnershipTransferred",
    productId: reader.string(),
    product: reader.publicKey().toBase58(),
    from: reader.publicKey().toBase58(),
    to: reader.publicKey().toBase58(),
    transferId: reader.fixed(16).toString("hex"),
    transferCount: reader.u32(),
    occurredAt: reader.i64(),
    signature: "",
    slot: 0,
  };
}

function readStatusUpdated(reader: BinaryReader): ProductStatusUpdatedEvent {
  return {
    name: "ProductStatusUpdated",
    productId: reader.string(),
    product: reader.publicKey().toBase58(),
    actor: reader.publicKey().toBase58(),
    previousStatus: statusFromOrdinal(reader.u8()),
    newStatus: statusFromOrdinal(reader.u8()),
    occurredAt: reader.i64(),
    signature: "",
    slot: 0,
  };
}

function readVerificationRecorded(reader: BinaryReader): VerificationRecordedEvent {
  // Field order is the declaration order of `VerificationRecorded` in
  // `state.rs`: the identifier and the keys come before the result.
  const productId = reader.string();
  const product = reader.publicKey().toBase58();
  const verifier = reader.publicKey().toBase58();
  const ordinal = reader.u8();
  const result = VERIFICATION_RESULT_BY_ORDINAL[ordinal];
  if (result === undefined) {
    throw new Error(`Unknown on-chain verification result ordinal ${ordinal}.`);
  }
  return {
    name: "VerificationRecorded",
    productId,
    product,
    verifier,
    result,
    verificationHash: reader.fixed(32).toString("hex"),
    occurredAt: reader.i64(),
    signature: "",
    slot: 0,
  };
}

function readParticipantRegistered(
  reader: BinaryReader
): ParticipantRegisteredChainEvent {
  return {
    name: "ParticipantRegisteredEvent",
    participant: reader.publicKey().toBase58(),
    role: roleFromOrdinal(reader.u8()),
    profileHash: reader.fixed(32).toString("hex"),
    registeredAt: reader.i64(),
    signature: "",
    slot: 0,
  };
}

/** Pulls every recognised program event out of a transaction's logs. */
export function parseProgramEvents(
  logs: readonly string[],
  signature: string,
  slot: number
): ProgramEvent[] {
  const events: ProgramEvent[] = [];
  for (const line of logs) {
    const index = line.indexOf(EVENT_LOG_PREFIX);
    if (index === -1) continue;
    const encoded = line.slice(index + EVENT_LOG_PREFIX.length).trim();
    if (encoded.length === 0) continue;
    let payload: Buffer;
    try {
      payload = Buffer.from(encoded, "base64");
    } catch {
      continue;
    }
    const event = decodeEventPayload(payload);
    if (event !== null) {
      events.push({ ...event, signature, slot });
    }
  }
  return events;
}

/** Discriminator for a named event, exported for tests. */
export function eventDiscriminatorHex(name: string): string {
  return createHash("sha256")
    .update(`event:${name}`, "utf8")
    .digest()
    .subarray(0, 8)
    .toString("hex");
}

export type { DecodedProductAccount, DecodedParticipantAccount };
export { STATUS_BY_ORDINAL };
