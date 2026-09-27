import type { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { ProductStatus } from "../../lib/statusMachine.js";
import type {
  DecodedParticipantAccount,
  DecodedProductAccount,
  VerificationResultName,
} from "./layout.js";

/**
 * The boundary between the application layer and Solana.
 *
 * The server holds no private key, so a transaction always follows the same
 * three steps: the API assembles and returns an unsigned transaction, the
 * participant's wallet signs it, and the API submits the signed bytes,
 * confirms them, reads the resulting account and events, and only then marks
 * the off-chain record confirmed.
 *
 * `Web3ChainClient` is the production implementation. The interface exists so
 * the application layer can be exercised by tests without a cluster; nothing in
 * `src/` ever substitutes a canned response for a chain call.
 */

export interface BuildTransactionInput {
  instructions: TransactionInstruction[];
  feePayer: PublicKey;
}

export interface BuiltTransaction {
  /** Serialised with `requireAllSignatures: false, verifySignatures: false`. */
  transaction: Transaction;
  /** Base64 wire form the wallet signs. */
  base64: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface SubmittedTransaction {
  signature: string;
  slot: number;
  err: unknown;
  logs: string[];
}

export interface ProgramEventBase {
  name: string;
  signature: string;
  slot: number;
}

export interface ProductRegisteredEvent extends ProgramEventBase {
  name: "ProductRegistered";
  productId: string;
  product: string;
  registrant: string;
  owner: string;
  status: ProductStatus;
  registeredAt: number;
  offChainDataHash: string;
}

export interface OwnershipTransferredEvent extends ProgramEventBase {
  name: "OwnershipTransferred";
  productId: string;
  product: string;
  from: string;
  to: string;
  transferId: string;
  transferCount: number;
  occurredAt: number;
}

export interface ProductStatusUpdatedEvent extends ProgramEventBase {
  name: "ProductStatusUpdated";
  productId: string;
  product: string;
  actor: string;
  previousStatus: ProductStatus;
  newStatus: ProductStatus;
  occurredAt: number;
}

export interface VerificationRecordedEvent extends ProgramEventBase {
  name: "VerificationRecorded";
  productId: string;
  product: string;
  verifier: string;
  result: VerificationResultName;
  verificationHash: string;
  occurredAt: number;
}

export interface ParticipantRegisteredChainEvent extends ProgramEventBase {
  name: "ParticipantRegisteredEvent";
  participant: string;
  role: string;
  profileHash: string;
  registeredAt: number;
}

export type ProgramEvent =
  | ProductRegisteredEvent
  | OwnershipTransferredEvent
  | ProductStatusUpdatedEvent
  | VerificationRecordedEvent
  | ParticipantRegisteredChainEvent;

export interface ChainHealth {
  reachable: boolean;
  slot: number | null;
  commitment: string;
  /** Present when `reachable` is false. */
  problem?: string;
}

export interface SendResult {
  signature: string;
}

export interface ChainClient {
  readonly programId: PublicKey;
  readonly network: string;
  readonly commitment: "processed" | "confirmed" | "finalized";

  health(): Promise<ChainHealth>;

  /** Fetches and decodes a product account, or null when it does not exist. */
  fetchProduct(productId: string): Promise<DecodedProductAccount | null>;

  /** Fetches and decodes a participant registry entry, or null when absent. */
  fetchParticipant(
    wallet: PublicKey
  ): Promise<DecodedParticipantAccount | null>;

  /** Assembles an unsigned transaction with a live blockhash. */
  buildTransaction(input: BuildTransactionInput): Promise<BuiltTransaction>;

  /** Submits wallet-signed bytes and returns the signature. */
  sendSignedTransaction(signedBase64: string, description: string): Promise<SendResult>;

  /** Waits for a signature to reach the configured commitment. */
  confirmTransaction(signature: string): Promise<SubmittedTransaction>;

  /** Reads the program events emitted by a confirmed transaction. */
  fetchTransactionEvents(signature: string): Promise<ProgramEvent[]>;

  /** Every signature that emitted an event for an address, newest first. */
  fetchSignaturesForAddress(address: PublicKey, limit: number): Promise<string[]>;

  /** Current cluster time in seconds, used to timestamp off-chain events. */
  clusterTime(): Promise<number>;

  /** Base58 address of the participant registry account for a wallet. */
  participantAddressFor(wallet: PublicKey): PublicKey;
}
