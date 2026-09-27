import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PublicKey, Transaction } from "@solana/web3.js";

import { encodeBase58 } from "./base58";
import {
  BorshReader,
  INSTRUCTION_NAMES,
  ROLE_NAMES,
  STATUS_NAMES,
  STATUS_ON_RECEIPT,
  encodeOwnershipTransferredEvent,
  encodeParticipantRegisteredEvent,
  encodeProductAccount,
  encodeProductRegisteredEvent,
  encodeProductStatusUpdatedEvent,
  encodeParticipantAccount,
  encodeVerificationRecordedEvent,
  instructionDiscriminator,
  type ProductAccountFields,
} from "./borsh";
import { deriveParticipantAddress, deriveProductAddress } from "./pda";

/**
 * A local stand-in for a Solana JSON-RPC node, and the in-memory ledger behind
 * it.
 *
 * WHAT IS REAL HERE
 * - The API is started unmodified and pointed at this endpoint through
 *   `SOLANA_RPC_URL`. It performs real borsh encoding, real signature
 *   verification, real blockhash handling and real confirmation polling.
 * - The transactions submitted to this endpoint are the exact bytes the wallet
 *   signed. Nothing about them is rewritten: the mock decodes them with
 *   `@solana/web3.js`'s own `Transaction.from` and reports the signature the
 *   wallet produced.
 * - The account data written here is decoded by the API's real
 *   `decodeProductAccount` / `decodeParticipantAccount`, and the log lines are
 *   decoded by its real `parseProgramEvents`. If this file and
 *   `server/src/services/solana/*` ever disagree about a byte, the flow that
 *   reads that record fails.
 *
 * WHAT IS SUBSTITUTED
 * - The validator, the fee payer, the signature *verification* on submission and
 *   the notion of time. The mock trusts that a submitted transaction was signed,
 *   because the API has already checked the fee payer, the program id and the
 *   signature set against the caller before anything reaches this endpoint.
 * - Account rent, balances and compute metering. Nothing in these flows depends
 *   on them, so they are constants.
 *
 * This is a test transport, not a mock inside the application: `server/src` is
 * untouched and still does the work.
 */

/** The ledgers' mutable state, so a test can start from an empty chain. */
interface ProductLedgerEntry extends ProductAccountFields {
  address: string;
}

interface ParticipantLedgerEntry {
  address: string;
  wallet: string;
  role: string;
  profileHash: Buffer;
  registeredAt: number;
}

interface RecordedTransaction {
  signature: string;
  slot: number;
  blockTime: number;
  logs: string[];
  accountKeys: string[];
  instructionData: string[];
}

interface Ledger {
  /** Account address to raw account data, exactly as `getAccountInfo` would hold it. */
  accounts: Map<string, Buffer>;
  products: Map<string, ProductLedgerEntry>;
  participantsByAddress: Map<string, ParticipantLedgerEntry>;
  transactions: Map<string, RecordedTransaction>;
  /** Signature order, newest last. */
  submissionOrder: string[];
}

export interface MockLedgerProduct {
  productId: string;
  address: string;
  status: string;
  owner: string;
  transferCount: number;
}

export interface MockLedgerParticipant {
  wallet: string;
  address: string;
  role: string;
}

/** A read-only view of the mock cluster, for assertions and for debugging. */
export interface MockLedgerSnapshot {
  products: MockLedgerProduct[];
  participants: MockLedgerParticipant[];
  transactions: number;
}

export interface MockRpcOptions {
  readonly programId: string;
  readonly host?: string;
  readonly port: number;
}

export interface MockRpcHandle {
  readonly url: string;
  /** Throws away every account and transaction, as if the validator restarted. */
  reset(): void;
  snapshot(): MockLedgerSnapshot;
  close(): Promise<void>;
}

const LAMPORTS_PER_BYTE_PER_EPOCH = 3480;
const RENT_EXEMPTION_LAMPORTS_PER_YEAR = 1_000_000;

function emptyLedger(): Ledger {
  return {
    accounts: new Map(),
    products: new Map(),
    participantsByAddress: new Map(),
    transactions: new Map(),
    submissionOrder: [],
  };
}

class MockSolanaNode {
  private ledger: Ledger = emptyLedger();

  private slot = 1_000;

  private blockhashCounter = 0;

  private readonly programId: PublicKey;

  constructor(programId: string) {
    this.programId = new PublicKey(programId);
  }

  reset(): void {
    this.ledger = emptyLedger();
    this.slot = 1_000;
    this.blockhashCounter = 0;
  }

  snapshot(): MockLedgerSnapshot {
    return {
      products: [...this.ledger.products.values()].map((entry) => ({
        productId: entry.productId,
        address: entry.address,
        status: entry.status,
        owner: new PublicKey(entry.owner).toBase58(),
        transferCount: entry.transferCount,
      })),
      participants: [...this.ledger.participantsByAddress.values()].map((entry) => ({
        wallet: entry.wallet,
        address: entry.address,
        role: entry.role,
      })),
      transactions: this.ledger.transactions.size,
    };
  }

  /* ---------------------------------------------------------------- *
   * JSON-RPC dispatch
   * ---------------------------------------------------------------- */

  handle(method: string, params: readonly unknown[]): unknown {
    switch (method) {
      case "getHealth":
        return "ok";
      case "getVersion":
        return { "solana-core": "2.1.0", "feature-set": 1 };
      case "getGenesisHash":
        return this.latestBlockhash();
      case "getSlot":
      case "getBlockHeight":
        return this.slot;
      case "getBlockTime":
        return Math.floor(Date.now() / 1000) - 1;
      case "getEpochInfo":
        return {
          epoch: 0,
          slotIndex: this.slot,
          slotsInEpoch: 432_000,
          absoluteSlot: this.slot,
        };
      case "getLatestBlockhash":
        return { context: this.context(), value: this.latestBlockhashValue() };
      case "isBlockhashValid":
        return true;
      case "getMinimumBalanceForRentExemption":
        return this.rentExemption(params);
      case "getBalance":
        return { context: this.context(), value: this.rentExemption([10_000_000]) };
      case "getFeeForMessage":
        return { context: this.context(), value: 5_000 };
      case "getRecentPrioritizationFees":
        return [];
      case "getAccountInfo":
        return { context: this.context(), value: this.accountInfo(params) };
      case "getMultipleAccounts":
        return {
          context: this.context(),
          value: params.flatMap((entry) => {
            const address = readAddress(entry);
            return address === null ? [] : [this.accountValue(address)];
          }),
        };
      case "getSignatureStatuses":
        return { context: this.context(), value: this.signatureStatuses(params) };
      case "getSignaturesForAddress":
        return this.signaturesForAddress(params);
      case "getParsedTransaction":
      case "getTransaction":
        return this.parsedTransaction(params);
      case "sendTransaction":
        return this.sendTransaction(params);
      default:
        throw new Error(`The mock Solana node does not implement "${method}".`);
    }
  }

  private context(): { slot: number } {
    return { slot: this.slot };
  }

  private latestBlockhash(): string {
    return this.latestBlockhashValue().blockhash;
  }

  private latestBlockhashValue(): { blockhash: string; lastValidBlockHeight: number } {
    this.blockhashCounter += 1;
    const digest = createHash("sha256")
      .update(`mock-blockhash:${this.blockhashCounter}`, "utf8")
      .digest();
    return {
      blockhash: encodeBase58(digest),
      // Real blockhashes stay valid for roughly 150 slots. The API only stores
      // this for the participant's information and for the expiry timer.
      lastValidBlockHeight: this.slot + 150,
    };
  }

  private rentExemption(params: readonly unknown[]): number {
    const requested = readNumber(params[0]) ?? 0;
    return (
      LAMPORTS_PER_BYTE_PER_EPOCH * requested +
      RENT_EXEMPTION_LAMPORTS_PER_YEAR * 2
    );
  }

  private accountValue(address: string): Record<string, unknown> | null {
    const data = this.ledger.accounts.get(address);
    if (data === undefined) return null;
    return {
      executable: false,
      owner: this.programId.toBase58(),
      lamports: 1_000_000,
      data: [data.toString("base64"), "base64"],
      rentEpoch: 0,
    };
  }

  private accountInfo(params: readonly unknown[]): Record<string, unknown> | null {
    const address = readAddress(params[0]);
    if (address === null) throw new Error("getAccountInfo needs a base58 address.");
    return this.accountValue(address);
  }

  private signatureStatuses(params: readonly unknown[]): Array<Record<string, unknown> | null> {
    const signatures = Array.isArray(params[0]) ? (params[0] as unknown[]) : [];
    return signatures.map((entry) => {
      const signature = typeof entry === "string" ? entry : "";
      const recorded = this.ledger.transactions.get(signature);
      if (recorded === undefined) return null;
      return {
        slot: recorded.slot,
        confirmations: null,
        err: null,
        // Reported straight away: a real cluster reaches `finalized` in about a
        // second, and polling it here would only add seconds to every test
        // without testing anything the API does not already do.
        confirmationStatus: "finalized",
      };
    });
  }

  private signaturesForAddress(params: readonly unknown[]): Array<Record<string, unknown>> {
    const address = readAddress(params[0]);
    const config = (params[1] ?? {}) as { limit?: unknown };
    const limit = readNumber(config.limit) ?? 1_000;
    if (address === null) return [];

    return this.ledger.submissionOrder
      .slice()
      .reverse()
      .map((signature) => this.ledger.transactions.get(signature))
      .filter((recorded): recorded is RecordedTransaction => recorded !== undefined)
      .filter((recorded) => recorded.accountKeys.includes(address))
      .slice(0, limit)
      .map((recorded) => ({
        signature: recorded.signature,
        slot: recorded.slot,
        err: null,
        memo: null,
        blockTime: recorded.blockTime,
        confirmationStatus: "finalized",
      }));
  }

  private parsedTransaction(params: readonly unknown[]): Record<string, unknown> | null {
    const signature = typeof params[0] === "string" ? params[0] : "";
    const recorded = this.ledger.transactions.get(signature);
    if (recorded === undefined) return null;
    return {
      slot: recorded.slot,
      blockTime: recorded.blockTime,
      version: 0,
      transaction: {
        signatures: [recorded.signature],
        message: {
          accountKeys: recorded.accountKeys.map((key) => ({
            pubkey: key,
            signer: false,
            writable: false,
          })),
          instructions: recorded.instructionData.map((data) => ({
            accounts: recorded.accountKeys,
            data,
            programId: this.programId.toBase58(),
          })),
          recentBlockhash: this.latestBlockhash(),
          addressTableLookups: null,
        },
      },
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [],
        postBalances: [],
        logMessages: recorded.logs,
      },
    };
  }

  /* ---------------------------------------------------------------- *
   * sendTransaction: the only method that changes anything
   * ---------------------------------------------------------------- */

  private sendTransaction(params: readonly unknown[]): string {
    const encoded = typeof params[0] === "string" ? params[0] : "";
    const transaction = Transaction.from(Buffer.from(encoded, "base64"));
    const signatureBytes = transaction.signature;
    if (signatureBytes === null) {
      throw new Error("The submitted transaction carries no signature.");
    }
    const signature = encodeBase58(new Uint8Array(signatureBytes));

    this.slot += 1;
    const blockTime = Math.floor(Date.now() / 1000);
    const logs: string[] = [];

    const accountKeys = transaction.instructions.flatMap((instruction) =>
      instruction.keys.map((key) => key.pubkey.toBase58())
    );
    const feePayer = transaction.feePayer?.toBase58();
    if (feePayer !== undefined) accountKeys.unshift(feePayer);

    logs.push(`Program ${this.programId.toBase58()} invoke [1]`);

    for (const instruction of transaction.instructions) {
      if (!instruction.programId.equals(this.programId)) {
        // A transaction may legitimately carry a system-program transfer; this
        // suite never builds one, so anything else is a bug worth surfacing.
        logs.push(`Program ${instruction.programId.toBase58()} invoke [1]`);
        logs.push(`Program ${instruction.programId.toBase58()} success`);
        continue;
      }
      this.applyInstruction(instruction.keys.map((key) => key.pubkey), instruction.data, logs);
    }

    logs.push(`Program ${this.programId.toBase58()} success`);

    this.ledger.transactions.set(signature, {
      signature,
      slot: this.slot,
      blockTime,
      logs,
      accountKeys,
      instructionData: transaction.instructions.map((instruction) =>
        instruction.data.toString("base64")
      ),
    });
    this.ledger.submissionOrder.push(signature);

    return signature;
  }

  private applyInstruction(
    keys: readonly PublicKey[],
    data: Buffer,
    logs: string[]
  ): void {
    const reader = new BorshReader(data);
    const discriminator = reader.fixed(8).toString("hex");

    if (discriminator === instructionDiscriminator(INSTRUCTION_NAMES.registerParticipant).toString("hex")) {
      this.registerParticipant(keys, reader, logs);
      return;
    }
    if (discriminator === instructionDiscriminator(INSTRUCTION_NAMES.registerProduct).toString("hex")) {
      this.registerProduct(keys, reader, logs);
      return;
    }
    if (discriminator === instructionDiscriminator(INSTRUCTION_NAMES.transferOwnership).toString("hex")) {
      this.transferOwnership(keys, reader, logs);
      return;
    }
    if (discriminator === instructionDiscriminator(INSTRUCTION_NAMES.updateStatus).toString("hex")) {
      this.updateStatus(keys, reader, logs);
      return;
    }
    if (discriminator === instructionDiscriminator(INSTRUCTION_NAMES.recordVerification).toString("hex")) {
      this.recordVerification(keys, reader, logs);
      return;
    }

    throw new Error(`The mock program does not implement the instruction ${discriminator}.`);
  }

  private logInstruction(logs: string[], name: string): void {
    logs.push(`Program log: Instruction: ${name}`);
  }

  private registerParticipant(
    keys: readonly PublicKey[],
    reader: BorshReader,
    logs: string[]
  ): void {
    this.logInstruction(logs, "RegisterParticipant");
    const wallet = (keys[0] as PublicKey).toBase58();
    const address = (keys[1] as PublicKey).toBase58();
    const roleOrdinal = reader.u8();
    const role = ROLE_NAMES[roleOrdinal];
    if (role === undefined) throw new Error(`Unknown participant role ordinal ${roleOrdinal}.`);
    const profileHash = reader.fixed(32);
    const registeredAt = Math.floor(Date.now() / 1000);
    const bump = deriveParticipantAddress(this.programId, keys[0] as PublicKey)[1];

    this.ledger.participantsByAddress.set(address, {
      address,
      wallet,
      role,
      profileHash,
      registeredAt,
    });
    this.ledger.accounts.set(
      address,
      encodeParticipantAccount({
        version: 1,
        bump,
        participant: (keys[0] as PublicKey).toBytes(),
        role,
        registeredAt,
        profileHash,
        revoked: false,
      })
    );

    logs.push(
      `Program data: ${encodeParticipantRegisteredEvent({
        participant: (keys[0] as PublicKey).toBytes(),
        role,
        profileHash,
        registeredAt,
      }).toString("base64")}`
    );
  }

  private registerProduct(
    keys: readonly PublicKey[],
    reader: BorshReader,
    logs: string[]
  ): void {
    this.logInstruction(logs, "RegisterProduct");
    const address = (keys[2] as PublicKey).toBase58();
    const productId = reader.string();
    const offChainDataHash = reader.fixed(32);
    const registeredAt = Math.floor(Date.now() / 1000);
    const bump = deriveProductAddress(this.programId, productId)[1];

    this.ledger.products.set(address, {
      address,
      version: 1,
      bump,
      flags: 0,
      status: "REGISTERED",
      preFlagStatus: "REGISTERED",
      productId,
      registrant: (keys[0] as PublicKey).toBytes(),
      owner: (keys[0] as PublicKey).toBytes(),
      registeredAt,
      updatedAt: registeredAt,
      lastTransferAt: 0,
      lastVerifiedAt: 0,
      offChainDataHash,
      transferCount: 0,
    });
    this.writeProduct(address);

    logs.push(
      `Program data: ${encodeProductRegisteredEvent({
        productId,
        product: (keys[2] as PublicKey).toBytes(),
        registrant: (keys[0] as PublicKey).toBytes(),
        owner: (keys[0] as PublicKey).toBytes(),
        status: "REGISTERED",
        registeredAt,
        offChainDataHash,
      }).toString("base64")}`
    );
  }

  private transferOwnership(
    keys: readonly PublicKey[],
    reader: BorshReader,
    logs: string[]
  ): void {
    this.logInstruction(logs, "TransferOwnership");
    const from = (keys[0] as PublicKey).toBase58();
    const productAddress = (keys[1] as PublicKey).toBase58();
    const recipientAddress = (keys[2] as PublicKey).toBase58();
    const transferId = reader.fixed(16);

    const product = this.ledger.products.get(productAddress);
    if (product === undefined) {
      throw new Error(`No batch account exists at ${productAddress} to transfer.`);
    }
    const recipient = this.ledger.participantsByAddress.get(recipientAddress);
    if (recipient === undefined) {
      throw new Error(
        `The recipient registry entry ${recipientAddress} does not exist, so ownership cannot pass.`,
      );
    }

    const previousOwner = new PublicKey(product.owner);
    const previousStatus = product.status;
    const occurredAt = Math.floor(Date.now() / 1000);

    product.owner = new PublicKey(recipient.wallet).toBytes();
    product.transferCount += 1;
    product.lastTransferAt = occurredAt;
    product.updatedAt = occurredAt;
    const nextStatus = STATUS_ON_RECEIPT[recipient.role];
    if (nextStatus !== undefined) product.status = nextStatus;
    this.writeProduct(productAddress);

    logs.push(
      `Program data: ${encodeOwnershipTransferredEvent({
        productId: product.productId,
        product: (keys[1] as PublicKey).toBytes(),
        from: previousOwner.toBytes(),
        to: new PublicKey(recipient.wallet).toBytes(),
        transferId,
        transferCount: product.transferCount,
        occurredAt,
      }).toString("base64")}`
    );

    void from;
    void previousStatus;
  }

  private updateStatus(keys: readonly PublicKey[], reader: BorshReader, logs: string[]): void {
    this.logInstruction(logs, "UpdateStatus");
    const actor = (keys[0] as PublicKey).toBase58();
    const productAddress = (keys[2] as PublicKey).toBase58();
    const statusOrdinal = reader.u8();
    const occurredAt = reader.i64();

    const product = this.ledger.products.get(productAddress);
    if (product === undefined) {
      throw new Error(`No batch account exists at ${productAddress} to update.`);
    }
    const nextStatus = STATUS_NAMES[statusOrdinal];
    if (nextStatus === undefined) throw new Error(`Unknown product status ordinal ${statusOrdinal}.`);

    const previousStatus = product.status;
    product.status = nextStatus;
    product.updatedAt = occurredAt;
    this.writeProduct(productAddress);

    logs.push(
      `Program data: ${encodeProductStatusUpdatedEvent({
        productId: product.productId,
        product: (keys[2] as PublicKey).toBytes(),
        actor: new PublicKey(actor).toBytes(),
        previousStatus,
        newStatus: nextStatus,
        occurredAt,
      }).toString("base64")}`
    );
  }

  private recordVerification(
    keys: readonly PublicKey[],
    reader: BorshReader,
    logs: string[]
  ): void {
    this.logInstruction(logs, "RecordVerification");
    const verifier = (keys[0] as PublicKey).toBase58();
    const productAddress = (keys[2] as PublicKey).toBase58();
    const resultOrdinal = reader.u8();
    const verificationHash = reader.fixed(32);
    const occurredAt = reader.i64();

    const product = this.ledger.products.get(productAddress);
    if (product === undefined) {
      throw new Error(`No batch account exists at ${productAddress} to attest to.`);
    }
    const result = RESULT_NAMES[resultOrdinal];
    if (result === undefined) {
      throw new Error(`Unknown verification result ordinal ${resultOrdinal}.`);
    }

    product.lastVerifiedAt = occurredAt;
    this.writeProduct(productAddress);

    logs.push(
      `Program data: ${encodeVerificationRecordedEvent({
        productId: product.productId,
        product: (keys[2] as PublicKey).toBytes(),
        verifier: new PublicKey(verifier).toBytes(),
        result,
        verificationHash,
        occurredAt,
      }).toString("base64")}`
    );
  }

  private writeProduct(address: string): void {
    const product = this.ledger.products.get(address);
    if (product === undefined) return;
    this.ledger.accounts.set(address, encodeProductAccount(product));
  }
}

const RESULT_NAMES = ["VERIFIED", "MISMATCH", "NOT_FOUND", "INCOMPLETE"] as const;

function readAddress(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "pubkey" in value) {
    const pubkey = (value as { pubkey: unknown }).pubkey;
    return typeof pubkey === "string" ? pubkey : null;
  }
  return null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "object" && value !== null && "value" in value) {
    const inner = (value as { value: unknown }).value;
    if (typeof inner === "number" && Number.isFinite(inner)) return inner;
  }
  return null;
}

interface JsonRpcRequest {
  id: number | string | null;
  method: string;
  params?: unknown[];
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Starts the mock node. Resolves once it is accepting connections. */
export async function startMockRpc(options: MockRpcOptions): Promise<MockRpcHandle> {
  const node = new MockSolanaNode(options.programId);
  const host = options.host ?? "127.0.0.1";

  const server: Server = createServer((req, res) => {
    void handleRequest(node, req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return {
    url: `http://${host}:${options.port}`,
    reset: () => {
      node.reset();
    },
    snapshot: () => node.snapshot(),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

async function handleRequest(
  node: MockSolanaNode,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("The mock Solana node only speaks JSON-RPC over POST.\n");
    return;
  }

  const body = await readBody(req);
  let payload: JsonRpcRequest | JsonRpcRequest[];
  try {
    payload = JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[];
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "The request body is not valid JSON." }));
    return;
  }

  const requests = Array.isArray(payload) ? payload : [payload];
  const responses = requests.map((request) => runOne(node, request));

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(Array.isArray(payload) ? responses : responses[0]));
}

function runOne(node: MockSolanaNode, request: JsonRpcRequest): JsonRpcResponse {
  try {
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: node.handle(request.method, request.params ?? []),
    };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}
