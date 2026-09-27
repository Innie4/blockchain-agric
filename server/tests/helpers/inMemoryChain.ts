import { createHash } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { TransactionInstruction } from "@solana/web3.js";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { BinaryWriter, INSTRUCTION_NAMES, instructionDiscriminator, ROLE_ORDINALS, STATUS_ORDINALS, VERIFICATION_RESULT_ORDINALS, type DecodedParticipantAccount, type DecodedProductAccount } from "../../src/services/solana/layout.js";
import { getParticipantAddress, getProductAddress } from "../../src/services/solana/pda.js";
import { parseProgramEvents } from "../../src/services/solana/events.js";
import type { BuildTransactionInput, BuiltTransaction, ChainClient, ChainHealth, ProgramEvent, SendResult, SubmittedTransaction } from "../../src/services/solana/chainClient.js";

/**
 * An in-process stand-in for the Solana cluster.
 *
 * This is a test double, not a mock in the production path: nothing in `src/`
 * uses it, and the harness installs it explicitly. It exists because the suite
 * has to exercise the full two-phase signing flow without a validator, and
 * because a double that re-derives PDAs, re-encodes event payloads and enforces
 * the same business rules catches wiring mistakes a canned response would hide.
 * The byte layout it produces is checked against the Rust definitions in
 * `tests/unit/solanaLayout.test.ts`.
 */

export interface LedgerProduct {
  productId: string;
  address: string;
  registrant: string;
  owner: string;
  status: number;
  preFlagStatus: number;
  registeredAt: number;
  updatedAt: number;
  lastTransferAt: number;
  lastVerifiedAt: number;
  offChainDataHash: string;
  transferCount: number;
  version: number;
  bump: number;
  flags: number;
}

export interface LedgerParticipant {
  participant: string;
  role: number;
  registeredAt: number;
  profileHash: string;
  revoked: boolean;
  version: number;
  bump: number;
}

/** Anchor derives discriminators as sha256 of a namespaced label. */
function accountDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`, "utf8").digest().subarray(0, 8);
}

function eventDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`event:${name}`, "utf8").digest().subarray(0, 8);
}

export const PRODUCT_DISCRIMINATOR = accountDiscriminator("ProductAccount");
export const PARTICIPANT_DISCRIMINATOR = accountDiscriminator("ParticipantAccount");

export interface ChainFailure {
  /** Anchor error code, e.g. 6001 for UnauthorizedOwner. */
  code: number;
  name: string;
}

export class SimulatedChainFailure extends Error {
  constructor(
    readonly code: number,
    readonly programErrorName: string,
    message: string
  ) {
    super(message);
    // Anchor reports its error variant as the error name, which is how the
    // production mapper recognises framework-level failures.
    this.name = programErrorName;
  }
}

export class InMemoryChainClient implements ChainClient {
  readonly programId: PublicKey;
  readonly network = "devnet";
  readonly commitment: "processed" | "confirmed" | "finalized" = "confirmed";

  private readonly products = new Map<string, LedgerProduct>();
  private readonly productIdByAddress = new Map<string, string>();
  private readonly participants = new Map<string, LedgerParticipant>();
  private readonly logBySignature = new Map<string, string[]>();
  private signatureCounter = 0;
  private slot = 1_000;
  private clockSeconds: number;

  /** Flipped by a test to exercise the unreachable-cluster path. */
  reachable = true;
  /** When set, the next `sendSignedTransaction` fails with this code. */
  failNextSend: ChainFailure | null = null;
  /** When true, `confirmTransaction` never reports success. */
  neverConfirms = false;
  /** Every transaction that reached `sendSignedTransaction`. */
  readonly submitted: Array<{ signature: string; description: string }> = [];
  /** Fee payer seen for each submission, so tests can assert who signed. */
  readonly submitters: string[] = [];

  constructor(programId: PublicKey, clockSeconds = 1_700_000_000) {
    this.programId = programId;
    this.clockSeconds = clockSeconds;
  }

  advanceClock(seconds: number): void {
    this.clockSeconds += seconds;
  }

  async health(): Promise<ChainHealth> {
    if (!this.reachable) {
      return {
        reachable: false,
        slot: null,
        commitment: this.commitment,
        problem: "The Solana network is not reachable right now.",
      };
    }
    return { reachable: true, slot: this.slot, commitment: this.commitment };
  }

  async fetchProduct(productId: string): Promise<DecodedProductAccount | null> {
    const record = this.products.get(productId);
    if (record === undefined) return null;
    return {
      version: record.version,
      bump: record.bump,
      flags: record.flags,
      status: STATUS_NAMES[record.status] as DecodedProductAccount["status"],
      preFlagStatus: STATUS_NAMES[record.preFlagStatus] as DecodedProductAccount["preFlagStatus"],
      productId: record.productId,
      registrant: record.registrant,
      owner: record.owner,
      registeredAt: record.registeredAt,
      updatedAt: record.updatedAt,
      lastTransferAt: record.lastTransferAt,
      lastVerifiedAt: record.lastVerifiedAt,
      offChainDataHash: record.offChainDataHash,
      transferCount: record.transferCount,
      product: record.address,
    };
  }

  async fetchParticipant(wallet: PublicKey): Promise<DecodedParticipantAccount | null> {
    const record = this.participants.get(wallet.toBase58());
    if (record === undefined) return null;
    const ordinal = record.role;
    return {
      version: record.version,
      bump: record.bump,
      participant: record.participant,
      role: ROLE_NAMES[ordinal] as DecodedParticipantAccount["role"],
      registeredAt: record.registeredAt,
      profileHash: record.profileHash,
      revoked: record.revoked,
    };
  }

  async buildTransaction(input: BuildTransactionInput): Promise<BuiltTransaction> {
    this.requireReachable();
    const blockhash = this.blockhash();
    const transaction = new Transaction({
      feePayer: input.feePayer,
      blockhash,
      lastValidBlockHeight: this.slot + 150,
    });
    for (const instruction of input.instructions) {
      transaction.add(instruction);
    }
    return {
      transaction,
      base64: transaction
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString("base64"),
      blockhash,
      lastValidBlockHeight: this.slot + 150,
    };
  }

  /**
   * Decodes the signed transaction and applies its instruction, so the same
   * business rules the Rust program enforces are exercised here.
   */
  async sendSignedTransaction(signedBase64: string, description: string): Promise<SendResult> {
    this.requireReachable();

    if (this.failNextSend !== null) {
      const failure = this.failNextSend;
      this.failNextSend = null;
      const error = new SimulatedChainFailure(failure.code, failure.name, failure.name);
      (error as unknown as { code: number }).code = failure.code;
      throw error;
    }

    const transaction = Transaction.from(Buffer.from(signedBase64, "base64"));
    this.submitters.push(transaction.feePayer?.toBase58() ?? "");
    this.submitted.push({ signature: "", description });

    const logs = this.apply(transaction);
    this.slot += 1;
    const signature = `sig${String(this.signatureCounter).padStart(6, "0")}`;
    this.signatureCounter += 1;
    const last = this.submitted[this.submitted.length - 1];
    if (last !== undefined) last.signature = signature;
    this.logBySignature.set(signature, [
      `Program ${this.programId.toBase58()} invoke [1]`,
      ...logs,
      `Program ${this.programId.toBase58()} success`,
    ]);
    return { signature };
  }

  async confirmTransaction(signature: string): Promise<SubmittedTransaction> {
    this.requireReachable();
    if (this.neverConfirms) {
      // The caller must time out; the test asserts it reports the timeout
      // rather than pretending the transaction succeeded.
      const error = new Error(
        "Transaction simulation failed: Timeout error while waiting for commitment"
      );
      (error as unknown as { code: number }).code = -32005;
      throw error;
    }
    if (!this.logBySignature.has(signature)) {
      const error = new Error(`Signature ${signature} not found`);
      (error as unknown as { code: number }).code = -32004;
      throw error;
    }
    return { signature, slot: this.slot, err: null, logs: this.logBySignature.get(signature) ?? [] };
  }

  async fetchTransactionEvents(signature: string): Promise<ProgramEvent[]> {
    return parseProgramEvents(this.logBySignature.get(signature) ?? [], signature, this.slot);
  }

  async fetchSignaturesForAddress(_address: PublicKey, limit: number): Promise<string[]> {
    this.requireReachable();
    const relevant: string[] = [];
    for (const [signature] of this.logBySignature) {
      relevant.push(signature);
    }
    return relevant.slice(-limit).reverse();
  }

  async clusterTime(): Promise<number> {
    return this.clockSeconds;
  }

  participantAddressFor(wallet: PublicKey): PublicKey {
    return getParticipantAddress(this.programId, wallet);
  }

  productAddressFor(productId: string): PublicKey {
    return getProductAddress(this.programId, productId);
  }

  // ----------------------------------------------------------- test controls

  /** Alters the off-chain view of a product, simulating a tampered record. */
  readonly ledger = this.products;

  /** Registers a participant without going through an instruction. */
  seedParticipant(wallet: PublicKey, role: number): void {
    this.participants.set(wallet.toBase58(), {
      participant: wallet.toBase58(),
      role,
      registeredAt: this.clockSeconds,
      profileHash: "0".repeat(64),
      revoked: false,
      version: 1,
      bump: 255,
    });
  }

  private requireReachable(): void {
    if (!this.reachable) {
      const error = new Error("fetch failed: ECONNREFUSED");
      (error as unknown as { code: number }).code = -32005;
      throw error;
    }
  }

  private blockhash(): string {
    // A blockhash is 32 base58-encoded bytes. Base58 cannot represent a
    // low-order zero byte, so the encoded value is always odd and the top byte
    // is never zero, which is what makes it decode back to exactly 32 bytes as
    // `Transaction` requires.
    const bytes = Buffer.alloc(32, 0xab);
    bytes.writeUInt32LE(this.slot * 2 + 1, 0);
    return base58Encode(bytes);
  }

  private apply(transaction: Transaction): string[] {
    const logs: string[] = [];
    for (const instruction of transaction.instructions) {
      if (!instruction.programId.equals(this.programId)) {
        throw new SimulatedChainFailure(
          0,
          "IncorrectProgramId",
          "Transaction failed: incorrect program id"
        );
      }
      const discriminator = instruction.data.subarray(0, 8);
      const name = INSTRUCTION_BY_DISCRIMINATOR.get(discriminator.toString("hex"));
      if (name === undefined) {
        throw new SimulatedChainFailure(0, "InstructionFallbackNotFound", "unknown instruction");
      }
      logs.push(...this.execute(name, instruction));
    }
    return logs;
  }

  private execute(name: string, instruction: TransactionInstruction): string[] {
    const data = instruction.data.subarray(8);
    const signer = instruction.keys.find((key) => key.isSigner)?.pubkey.toBase58() ?? "";

    if (name === INSTRUCTION_NAMES.registerParticipant) {
      const role = data.readUInt8(0);
      const profileHash = data.subarray(1, 33).toString("hex");
      const wallet = instruction.keys[0]?.pubkey;
      if (wallet === undefined) throw missingAccount();
      if (this.participants.has(wallet.toBase58())) {
        throw programFailure(6012, "ParticipantAlreadyRegistered", "already registered");
      }
      this.participants.set(wallet.toBase58(), {
        participant: wallet.toBase58(),
        role,
        registeredAt: this.clockSeconds,
        profileHash,
        revoked: false,
        version: 1,
        bump: 255,
      });
      return [
        emit("ParticipantRegisteredEvent", (writer) => {
          writer.publicKey(wallet);
          writer.u8(role);
          writer.bytes(Buffer.from(profileHash, "hex"));
          writer.i64(this.clockSeconds);
        }),
      ];
    }

    if (name === INSTRUCTION_NAMES.registerProduct) {
      const length = data.readUInt32LE(0);
      const productId = data.subarray(4, 4 + length).toString("utf8");
      const hash = data.subarray(4 + length, 36 + length).toString("hex");
      if (productId.length === 0 || productId.length > 32 || !isPrintableAscii(productId)) {
        throw programFailure(6004, "MalformedIdentifier", "malformed identifier");
      }
      if (this.products.has(productId)) {
        throw programFailure(6000, "DuplicateProduct", "duplicate product");
      }
      const registrant = instruction.keys[0]?.pubkey;
      if (registrant === undefined) throw missingAccount();
      const participant = this.participants.get(registrant.toBase58());
      if (participant === undefined) throw missingAccount();
      if (participant.role !== 0 && participant.role !== 4) {
        throw programFailure(6012, "RegistrantRoleNotAllowed", "role may not register");
      }
      const address = getProductAddress(this.programId, productId);
      this.products.set(productId, {
        productId,
        address: address.toBase58(),
        registrant: registrant.toBase58(),
        owner: registrant.toBase58(),
        status: STATUS_ORDINALS.REGISTERED,
        preFlagStatus: STATUS_ORDINALS.REGISTERED,
        registeredAt: this.clockSeconds,
        updatedAt: this.clockSeconds,
        lastTransferAt: 0,
        lastVerifiedAt: 0,
        offChainDataHash: hash,
        transferCount: 0,
        version: 1,
        bump: 255,
        flags: 0,
      });
      this.productIdByAddress.set(address.toBase58(), productId);
      return [
        emit("ProductRegistered", (writer) => {
          writer.string(productId);
          writer.publicKey(address);
          writer.publicKey(registrant);
          writer.publicKey(registrant);
          writer.u8(0);
          writer.i64(this.clockSeconds);
          writer.bytes(Buffer.from(hash, "hex"));
        }),
      ];
    }

    if (name === INSTRUCTION_NAMES.transferOwnership) {
      const productKey = instruction.keys[1]?.pubkey;
      const recipientKey = instruction.keys[2]?.pubkey;
      if (productKey === undefined || recipientKey === undefined) throw missingAccount();
      const productId = this.productIdByAddress.get(productKey.toBase58());
      const record = productId === undefined ? undefined : this.products.get(productId);
      if (record === undefined) throw missingAccount();
      if (record.owner !== signer) {
        throw programFailure(6001, "UnauthorizedOwner", "not the current owner");
      }
      if (record.status === STATUS_ORDINALS.FLAGGED) {
        throw programFailure(6007, "ProductFlagged", "product is flagged");
      }
      if (record.status === STATUS_ORDINALS.SOLD) {
        throw programFailure(6008, "ProductClosed", "product is closed");
      }
      // The instruction carries the recipient's registry account, which is the
      // program-derived address of their wallet, so the entry is found by
      // matching that derivation rather than by the wallet string itself.
      const recipient = [...this.participants.values()].find((candidate) =>
        getParticipantAddress(this.programId, new PublicKey(candidate.participant)).equals(
          recipientKey
        )
      );
      if (recipient === undefined) throw missingAccount();
      if (recipient.revoked) {
        throw programFailure(6002, "InvalidRecipient", "recipient revoked");
      }
      if (recipient.participant === record.owner) {
        throw programFailure(6002, "InvalidRecipient", "recipient is the current owner");
      }
      if (recipient.role !== 1 && recipient.role !== 2 && recipient.role !== 3) {
        throw programFailure(6005, "RecipientRoleNotAllowed", "role may not receive");
      }
      const transferId = data.subarray(0, 16);
      const previous = record.owner;
      record.owner = recipient.participant;
      record.transferCount += 1;
      record.lastTransferAt = this.clockSeconds;
      record.updatedAt = this.clockSeconds;
      record.status =
        recipient.role === 1
          ? STATUS_ORDINALS.IN_PROCESSING
          : recipient.role === 2
            ? STATUS_ORDINALS.IN_TRANSIT
            : STATUS_ORDINALS.AT_RETAILER;
      return [
        emit("OwnershipTransferred", (writer) => {
          writer.string(record.productId);
          writer.publicKey(productKey);
          writer.publicKey(new PublicKey(previous));
          writer.publicKey(recipientKey);
          writer.bytes(transferId);
          writer.u32(record.transferCount);
          writer.i64(this.clockSeconds);
        }),
      ];
    }

    if (name === INSTRUCTION_NAMES.updateStatus) {
      const newStatus = data.readUInt8(0);
      const occurredAt = Number(data.readBigInt64LE(1));
      const actorKey = instruction.keys[0]?.pubkey;
      const productKey = instruction.keys[2]?.pubkey;
      if (actorKey === undefined || productKey === undefined) throw missingAccount();
      const productId = this.productIdByAddress.get(productKey.toBase58());
      const record = productId === undefined ? undefined : this.products.get(productId);
      if (record === undefined) throw missingAccount();
      const actor = this.participants.get(actorKey.toBase58());
      if (actor === undefined) throw missingAccount();
      const isOwner = record.owner === signer;
      const isRegulator = actor.role === 4 && !actor.revoked;
      if (!isOwner && !isRegulator) {
        throw programFailure(6001, "UnauthorizedOwner", "not permitted");
      }
      if (occurredAt < record.registeredAt) {
        throw programFailure(6010, "InvalidTimestamp", "timestamp precedes registration");
      }
      if (occurredAt > this.clockSeconds + 86_400) {
        throw programFailure(6010, "InvalidTimestamp", "timestamp too far ahead");
      }

      const previous = record.status;
      if (previous === STATUS_ORDINALS.FLAGGED) {
        if (!isRegulator) throw programFailure(6006, "RegulatorOnly", "regulator only");
        if (newStatus === STATUS_ORDINALS.FLAGGED) {
          throw programFailure(6003, "InvalidStateTransition", "already flagged");
        }
        if (newStatus !== record.preFlagStatus && nextStatus(record.preFlagStatus) !== newStatus) {
          throw programFailure(6003, "InvalidStateTransition", "illegal transition");
        }
        record.preFlagStatus = newStatus;
      } else if (newStatus === STATUS_ORDINALS.FLAGGED) {
        if (!isRegulator) throw programFailure(6006, "RegulatorOnly", "regulator only");
        if (previous === STATUS_ORDINALS.SOLD) {
          throw programFailure(6008, "ProductClosed", "product is closed");
        }
        record.preFlagStatus = previous;
      } else {
        if (!isOwner) throw programFailure(6001, "UnauthorizedOwner", "not the current owner");
        if (previous === STATUS_ORDINALS.SOLD) {
          throw programFailure(6008, "ProductClosed", "product is closed");
        }
        if (nextStatus(previous) !== newStatus) {
          throw programFailure(6003, "InvalidStateTransition", "illegal transition");
        }
      }
      record.status = newStatus;
      record.updatedAt = this.clockSeconds;
      return [
        emit("ProductStatusUpdated", (writer) => {
          writer.string(record.productId);
          writer.publicKey(productKey);
          writer.publicKey(actorKey);
          writer.u8(previous);
          writer.u8(newStatus);
          writer.i64(this.clockSeconds);
        }),
      ];
    }

    if (name === INSTRUCTION_NAMES.recordVerification) {
      const result = data.readUInt8(0);
      const hash = data.subarray(1, 33).toString("hex");
      const occurredAt = Number(data.readBigInt64LE(33));
      const verifierKey = instruction.keys[0]?.pubkey;
      const productKey = instruction.keys[2]?.pubkey;
      if (verifierKey === undefined || productKey === undefined) throw missingAccount();
      const participant = this.participants.get(verifierKey.toBase58());
      if (participant === undefined) throw missingAccount();
      if (participant.role !== 4 || participant.revoked) {
        throw programFailure(6006, "RegulatorOnly", "regulator only");
      }
      const productId = this.productIdByAddress.get(productKey.toBase58());
      const record = productId === undefined ? undefined : this.products.get(productId);
      if (record === undefined) throw missingAccount();
      if (occurredAt < record.registeredAt) {
        throw programFailure(6010, "InvalidTimestamp", "timestamp precedes registration");
      }
      record.lastVerifiedAt = this.clockSeconds;
      return [
        emit("VerificationRecorded", (writer) => {
          writer.string(record.productId);
          writer.publicKey(productKey);
          writer.publicKey(verifierKey);
          writer.u8(result);
          writer.bytes(Buffer.from(hash, "hex"));
          writer.i64(this.clockSeconds);
        }),
      ];
    }

    throw new SimulatedChainFailure(0, "InstructionFallbackNotFound", `unhandled ${name}`);
  }

  productIdFor(address: string): string | undefined {
    return this.productIdByAddress.get(address);
  }
}

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Big-endian base58, the encoding Solana uses for blockhashes and addresses. */
function base58Encode(bytes: Uint8Array): string {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let encoded = "";
  while (value > 0n) {
    encoded = `${BASE58_ALPHABET[Number(value % 58n)]}${encoded}`;
    value /= 58n;
  }
  return encoded;
}

function nextStatus(status: number): number | null {
  const sequence = [
    STATUS_ORDINALS.REGISTERED,
    STATUS_ORDINALS.IN_PROCESSING,
    STATUS_ORDINALS.PROCESSED,
    STATUS_ORDINALS.IN_TRANSIT,
    STATUS_ORDINALS.AT_RETAILER,
    STATUS_ORDINALS.LISTED,
    STATUS_ORDINALS.SOLD,
  ];
  const index = sequence.indexOf(status);
  if (index === -1 || index === sequence.length - 1) return null;
  return sequence[index + 1] ?? null;
}

const STATUS_NAMES = [
  "REGISTERED",
  "IN_PROCESSING",
  "PROCESSED",
  "IN_TRANSIT",
  "AT_RETAILER",
  "LISTED",
  "SOLD",
  "FLAGGED",
] as const;

const ROLE_NAMES = ["FARMER", "PROCESSOR", "TRANSPORTER", "RETAILER", "REGULATOR"] as const;

const INSTRUCTION_BY_DISCRIMINATOR = new Map<string, string>(
  Object.values(INSTRUCTION_NAMES).map((name) => [
    instructionDiscriminator(name).toString("hex"),
    name,
  ])
);

function emit(
  eventName: string,
  write: (writer: BinaryWriter) => void
): string {
  const writer = new BinaryWriter().bytes(eventDiscriminator(eventName));
  write(writer);
  return `Program data: ${writer.toBuffer().toString("base64")}`;
}

function programFailure(code: number, name: string, message: string): SimulatedChainFailure {
  const error = new SimulatedChainFailure(code, name, `Transaction failed: ${message}`);
  return error;
}

function missingAccount(): SimulatedChainFailure {
  return new SimulatedChainFailure(3012, "AccountNotInitialized", "account does not exist");
}

function isPrintableAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return value.length > 0;
}

export { Keypair, PublicKey, SystemProgram, Transaction, MongoMemoryServer, ROLE_ORDINALS, VERIFICATION_RESULT_ORDINALS };
