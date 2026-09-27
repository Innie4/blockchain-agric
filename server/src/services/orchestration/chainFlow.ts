import { Transaction, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { env } from "../../config/env.js";
import { normaliseDatabaseError } from "../../config/database.js";
import { AppError, ERROR_CODES } from "../../lib/errors.js";
import { childLogger } from "../../lib/logger.js";
import { newId, toPublicKey } from "../../lib/crypto.js";
import {
  NotificationModel,
  ReconciliationTaskModel,
  UserModel,
  type ReconciliationAction,
} from "../../models/index.js";
import { normaliseBlockchainError } from "../solana/errorMapping.js";
import type { BuiltTransaction, ProgramEvent, SubmittedTransaction } from "../solana/chainClient.js";
import { getChainClient } from "../solana/chainClientRegistry.js";

const log = childLogger({ layer: "orchestration" });

/**
 * The application layer's contract with the chain.
 *
 * Every blockchain action follows the same shape:
 *
 *   1. build an unsigned transaction against a live blockhash,
 *   2. hand it to the participant's wallet to sign,
 *   3. submit the signed bytes,
 *   4. wait for real confirmation,
 *   5. re-read the on-chain account and compare it with what was intended,
 *   6. only then write the off-chain record as confirmed.
 *
 * Step 6 is the one most systems get wrong. If the write fails after the chain
 * has accepted the transaction, the record is marked for reconciliation rather
 * than being reported as a success.
 */

export interface PreparedChainAction {
  phase: "PREPARED";
  /** Base64 wire form for the wallet to sign. */
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  /** Deterministic address the transaction will act on. */
  targetAddress: string;
  /** What the participant should expect to happen, for the signing prompt. */
  description: string;
  /** Roughly how long the participant has to sign before it must be rebuilt. */
  validForSeconds: number;
}

export interface ConfirmedChainAction {
  phase: "CONFIRMED";
  signature: string;
  slot: number;
  targetAddress: string;
  events: ProgramEvent[];
}

export interface SubmitInput {
  signedTransaction: string;
  /** The wallet that must have signed; a mismatch is rejected before submitting. */
  expectedSigner: string;
  description: string;
  targetAddress: string;
  productId?: string;
}

export interface PreparedInput {
  instructions: TransactionInstruction[];
  feePayer: string;
  description: string;
  targetAddress: string;
}

const EXPECTED_TX_LIFETIME_SECONDS = 90;

/** Step 1: build an unsigned transaction the participant's wallet can sign. */
export async function prepareAction(input: PreparedInput): Promise<PreparedChainAction> {
  const chain = getChainClient();
  const feePayer = toPublicKey(input.feePayer, "walletAddress");
  const built: BuiltTransaction = await chain.buildTransaction({
    instructions: input.instructions,
    feePayer,
  });
  return {
    phase: "PREPARED",
    transaction: built.base64,
    blockhash: built.blockhash,
    lastValidBlockHeight: built.lastValidBlockHeight,
    targetAddress: input.targetAddress,
    description: input.description,
    validForSeconds: EXPECTED_TX_LIFETIME_SECONDS,
  };
}

/**
 * Steps 3 and 4: submit wallet-signed bytes and wait for genuine confirmation.
 *
 * The transaction is checked before submission so an obviously wrong payload is
 * rejected with a clear message rather than a cluster error, and so the
 * participant is never asked to sign a transaction the server did not build.
 */
export async function submitAction(input: SubmitInput): Promise<ConfirmedChainAction> {
  const chain = getChainClient();
  const expectedSigner = toPublicKey(input.expectedSigner, "walletAddress");
  const decoded = decodeTransaction(input.signedTransaction);
  if (!decoded.feePayer?.equals(expectedSigner)) {
    throw new AppError(ERROR_CODES.FORBIDDEN, {
      message:
        "The transaction you signed charges its fee to a different wallet. Sign the transaction the application gave you.",
    });
  }
  if (decoded.instructions.length === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
      message:
        "The transaction you signed does not contain any instructions. Sign the transaction the application gave you.",
    });
  }
  for (const instruction of decoded.instructions) {
    if (!instruction.programId.equals(chain.programId)) {
      throw new AppError(ERROR_CODES.FORBIDDEN, {
        message:
          "The transaction you signed calls a program other than the supply chain program. Sign the transaction the application gave you.",
        details: { programId: instruction.programId.toBase58() },
      });
    }
  }
  const missingSigners = decoded.instructions
    .flatMap((instruction) => instruction.keys)
    .filter((key) => key.isSigner)
    .filter((key) => !key.pubkey.equals(expectedSigner))
    .map((key) => key.pubkey.toBase58());
  if (missingSigners.length > 0) {
    throw new AppError(ERROR_CODES.FORBIDDEN, {
      message:
        "The transaction you signed expects another wallet to sign it, which the application did not request. Sign the transaction the application gave you.",
      details: { unexpectedSigners: missingSigners },
    });
  }

  // The only signer the application ever asks for is the fee payer, checked
  // above, so a complete signature set is exactly that one valid signature.
  if (!decoded.verifySignatures()) {
    throw new AppError(ERROR_CODES.FORBIDDEN, {
      message:
        "The transaction you signed is not signed by the wallet it charges its fee to. Sign the transaction the application gave you.",
    });
  }

  let signature: string;
  let confirmed: SubmittedTransaction;
  try {
    ({ signature } = await chain.sendSignedTransaction(
      input.signedTransaction,
      input.description
    ));
    confirmed = await chain.confirmTransaction(signature);
  } catch (error) {
    // Any `ChainClient` may report a transport or program failure in its own
    // shape, so the shared taxonomy is applied here rather than trusted to
    // every implementation.
    throw normaliseBlockchainError(error, input.description);
  }
  if (confirmed.err !== null && confirmed.err !== undefined) {
    throw chainFailure(confirmed, input.description);
  }

  const events = await chain.fetchTransactionEvents(signature);
  if (env.LOG_LEVEL === "debug" || env.LOG_LEVEL === "trace") {
    log.debug({ signature, eventCount: events.length }, "read program events");
  }

  return {
    phase: "CONFIRMED",
    signature,
    slot: confirmed.slot,
    targetAddress: input.targetAddress,
    events,
  };
}

/** Turns an on-chain failure into the participant-facing error for it. */
export function chainFailure(
  confirmed: SubmittedTransaction,
  description: string
): AppError {
  const error = normaliseBlockchainError(
    {
      err: confirmed.err,
      logs: confirmed.logs,
      message: `Transaction failed: ${description}`,
    },
    description
  );
  return new AppError(error.code, {
    message: error.message,
    details: {
      ...(typeof error.details === "object" && error.details !== null
        ? error.details
        : {}),
      signature: confirmed.signature,
      logs: tailLogs(confirmed.logs),
    },
    cause: error,
  });
}

function tailLogs(logs: readonly string[]): string[] {
  return logs.slice(-8);
}

export interface ReconciliationIntent {
  action: ReconciliationAction;
  productId: string;
  transactionSignature: string;
  intent: Record<string, unknown>;
}

/**
 * Records the case where the cluster accepted a transaction but the database
 * write did not land. The record is the recovery path: it holds the signature
 * and the intended write, so an operator can finish the job without asking the
 * participant to sign again.
 */
export async function recordReconciliationFailure(input: {
  intent: ReconciliationIntent;
  error: unknown;
}): Promise<void> {
  const intentHash = hashIntent(input.intent.intent);
  try {
    await ReconciliationTaskModel.create({
      taskId: newId(),
      action: input.intent.action,
      status: "PENDING",
      productId: input.intent.productId,
      transactionSignature: input.intent.transactionSignature,
      intentHash,
      intent: input.intent.intent,
      attempts: 0,
      lastError: describeError(input.error),
    });
    log.error(
      {
        productId: input.intent.productId,
        signature: input.intent.transactionSignature,
        action: input.intent.action,
        problem: describeError(input.error),
      },
      "on-chain transaction confirmed but the database write failed; reconciliation required"
    );
  } catch (error) {
    log.error(
      { problem: describeError(error) },
      "could not record the reconciliation task; recover the signature from the logs"
    );
  }
}

/** Raises an in-application notice for every active regulator. */
export async function notifyRegulators(input: {
  kind:
    | "RECONCILIATION_REQUIRED"
    | "VERIFICATION_MISMATCH"
    | "PRODUCT_FLAGGED"
    | "SYSTEM";
  title: string;
  body: string;
  productId?: string | null;
  linkPath?: string | null;
}): Promise<void> {
  if (!env.RECONCILIATION_ENABLED && input.kind === "RECONCILIATION_REQUIRED") return;
  try {
    const regulators = await UserModel.find({
      role: "REGULATOR",
      status: "ACTIVE",
      onChainRegistered: true,
    })
      .select({ walletAddress: 1 })
      .lean();
    if (regulators.length === 0) return;
    await NotificationModel.insertMany(
      regulators.map((regulator) => ({
        notificationId: newId(),
        recipientWallet: regulator.walletAddress,
        kind: input.kind,
        title: input.title,
        body: input.body,
        productId: input.productId ?? null,
        linkPath: input.linkPath ?? "/app/compliance",
      }))
    );
  } catch (error) {
    log.warn({ problem: describeError(error) }, "could not raise regulator notice");
  }
}

export function hashIntent(intent: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(intent).sort()) {
    ordered[key] = intent[key];
  }
  return createHash("sha256").update(JSON.stringify(ordered), "utf8").digest("hex");
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  return String(error);
}

/**
 * Fails clearly when a prepared transaction is replayed after its blockhash
 * expired. The only safe recovery is to prepare a fresh one, so the error says
 * exactly that.
 */
export function staleTransactionError(signature: string | null): AppError {
  return new AppError(ERROR_CODES.BLOCKCHAIN_TRANSACTION_FAILED, {
    message:
      "The prepared transaction expired before it was signed. Prepare it again and sign the new one.",
    details: { signature, recovery: "reprepare" },
  });
}

export function wrapDatabaseFailure(error: unknown, context: string): AppError {
  return normaliseDatabaseError(error, context);
}

function decodeTransaction(signedBase64: string): Transaction {
  try {
    return Transaction.from(Buffer.from(signedBase64.trim(), "base64"));
  } catch (cause) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
      message:
        "The signed transaction could not be read. Sign the transaction the application gave you and submit it again.",
      details: [{ path: "signedTransaction", message: "Unreadable transaction." }],
      cause,
    });
  }
}

export type { ProgramEvent, PublicKey };
