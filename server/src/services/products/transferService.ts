import { z } from "zod";
import { AppError, ERROR_CODES } from "../../lib/errors.js";
import { assertProductId, generateTransferId, newId, toPublicKey } from "../../lib/crypto.js";
import { childLogger } from "../../lib/logger.js";
import { evaluateTransfer, type ProductStatus } from "../../lib/statusMachine.js";
import { isTransferRecipientRole } from "../../lib/roles.js";
import {
  ProductMetadataModel,
  TransferModel,
  UserModel,
  NotificationModel,
} from "../../models/index.js";
import { buildTransferOwnership } from "../solana/instructions.js";
import { getProductAddress } from "../solana/pda.js";
import { getChainClient } from "../solana/chainClientRegistry.js";
import {
  prepareAction,
  recordReconciliationFailure,
  submitAction,
  type PreparedChainAction,
} from "../orchestration/chainFlow.js";

const log = childLogger({ layer: "transfers" });

export const prepareTransferSchema = z.object({
  toWallet: z.string().trim().min(32, "Enter the recipient's wallet address.").max(44),
  note: z.string().trim().max(1000).default(""),
});

export type PrepareTransferInput = z.infer<typeof prepareTransferSchema>;

export interface TransferView {
  transferId: string;
  productId: string;
  fromWallet: string;
  toWallet: string;
  toRole: string;
  fromRole: string;
  status: string;
  transactionSignature: string | null;
  previousStatus: string;
  resultingStatus: string | null;
  note: string;
  failureReason: string | null;
  createdAt: string;
  submittedAt: string | null;
  confirmedAt: string | null;
  acknowledgedAt: string | null;
  cropType?: string;
  quantity?: number;
  unit?: string;
}

interface TransferRecordLike {
  transferId: string;
  productId: string;
  fromWallet: string;
  toWallet: string;
  toRole: string;
  fromRole: string;
  status: string;
  transactionSignature?: string | null;
  previousStatus: string;
  resultingStatus?: string | null;
  note: string;
  failureReason?: string | null;
  createdAt: Date;
  submittedAt?: Date | null;
  confirmedAt?: Date | null;
  acknowledgedAt?: Date | null;
}

/** A lean MongoDB document omits unset fields, so absent and null both occur. */
function isoOrNull(value: Date | null | undefined): string | null {
  return value == null ? null : value.toISOString();
}

export function toTransferView(
  record: TransferRecordLike,
  product?: { cropType: string; quantity: number; unit: string } | null
): TransferView {
  return {
    transferId: record.transferId,
    productId: record.productId,
    fromWallet: record.fromWallet,
    toWallet: record.toWallet,
    toRole: record.toRole,
    fromRole: record.fromRole,
    status: record.status,
    transactionSignature: record.transactionSignature ?? null,
    previousStatus: record.previousStatus,
    resultingStatus: record.resultingStatus ?? null,
    note: record.note,
    failureReason: record.failureReason ?? null,
    createdAt: record.createdAt.toISOString(),
    submittedAt: isoOrNull(record.submittedAt),
    confirmedAt: isoOrNull(record.confirmedAt),
    acknowledgedAt: isoOrNull(record.acknowledgedAt),
    ...(product === undefined || product === null
      ? {}
      : { cropType: product.cropType, quantity: product.quantity, unit: product.unit }),
  };
}

export interface PreparedTransfer {
  transfer: TransferView;
  prepared: PreparedChainAction;
}

/**
 * Stage one of a transfer: check every rule the program will enforce, then
 * hand back an unsigned transaction.
 *
 * The checks are duplicated on-chain deliberately. Here they exist so the
 * participant is told what is wrong in plain language before being asked to
 * sign, not to replace the program's own enforcement.
 */
export async function prepareTransfer(input: {
  productId: string;
  signerWallet: string;
  signerRole: string;
  payload: PrepareTransferInput;
}): Promise<PreparedTransfer> {
  const productId = assertProductId(input.productId);
  const chain = getChainClient();

  const product = await ProductMetadataModel.findOne({ productId });
  if (product === null) {
    throw new AppError(ERROR_CODES.PRODUCT_NOT_FOUND, { details: { productId } });
  }
  if (product.chainState !== "CONFIRMED") {
    throw new AppError(ERROR_CODES.PRODUCT_STATE_INVALID, {
      message:
        "This batch is not fully registered on the blockchain yet, so it cannot be transferred.",
      details: { productId, chainState: product.chainState },
    });
  }

  const recipient = await UserModel.findOne({ walletAddress: input.payload.toWallet }).lean();
  const recipientRegistered =
    recipient !== null && recipient.status === "ACTIVE" && recipient.onChainRegistered;
  const recipientRole =
    recipient !== null && isTransferRecipientRole(recipient.role)
      ? (recipient.role)
      : null;

  const eligibility = evaluateTransfer({
    currentStatus: product.status as ProductStatus,
    currentOwnerWallet: product.ownerWallet,
    signerWallet: input.signerWallet,
    recipientWallet: input.payload.toWallet,
    recipientRole,
    recipientRegistered,
  });
  if (!eligibility.eligible) {
    throw new AppError(
      recipientRegistered ? ERROR_CODES.TRANSFER_NOT_ALLOWED : ERROR_CODES.RECIPIENT_NOT_REGISTERED,
      {
        message: eligibility.reason ?? "This product cannot be transferred as requested.",
        details: { productId, recipient: input.payload.toWallet },
      }
    );
  }

  const transferRef = generateTransferId();
  const transferId = newId();
  const resultingStatus = eligibility.resultingStatus ?? product.status;

  const record = await TransferModel.create({
    transferId,
    onChainTransferRef: transferRef.toString("hex"),
    productId,
    fromWallet: product.ownerWallet,
    toWallet: input.payload.toWallet,
    toRole: recipientRole as string,
    fromRole: input.signerRole,
    status: "PREPARED",
    previousStatus: product.status,
    resultingStatus,
    note: input.payload.note,
  });

  try {
    const instruction = buildTransferOwnership(
      chain.programId,
      toPublicKey(product.ownerWallet, "walletAddress"),
      productId,
      toPublicKey(input.payload.toWallet, "toWallet"),
      transferRef
    );
    const prepared = await prepareAction({
      instructions: [instruction],
      feePayer: input.signerWallet,
      description: `Transfer batch ${productId} to ${shorten(input.payload.toWallet)}`,
      targetAddress: getProductAddress(chain.programId, productId).toBase58(),
    });
    log.info({ transferId, productId }, "prepared ownership transfer");
    return {
      transfer: toTransferView(record.toObject()),
      prepared,
    };
  } catch (error) {
    await TransferModel.deleteOne({ transferId }).catch(() => undefined);
    throw error;
  }
}

export interface SubmitTransferInput {
  transferId: string;
  signedTransaction: string;
  signerWallet: string;
}

/** Stage two: submit, confirm, re-read the owner, then move the product. */
export async function submitTransfer(
  input: SubmitTransferInput
): Promise<TransferView> {
  const chain = getChainClient();
  const record = await TransferModel.findOne({ transferId: input.transferId });
  if (record === null) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      message: "This transfer no longer exists. Prepare it again.",
    });
  }
  if (record.status === "COMPLETED") {
    return toTransferView(record.toObject());
  }
  if (record.fromWallet !== input.signerWallet) {
    throw new AppError(ERROR_CODES.FORBIDDEN, {
      message: "Only the wallet that prepared this transfer may submit it.",
    });
  }

  const product = await ProductMetadataModel.findOne({ productId: record.productId });
  if (product === null) {
    throw new AppError(ERROR_CODES.PRODUCT_NOT_FOUND, {
      details: { productId: record.productId },
    });
  }

  record.status = "SUBMITTED";
  record.submittedAt = new Date();
  await record.save();

  const address = getProductAddress(chain.programId, record.productId);
  const confirmed = await submitAction({
    signedTransaction: input.signedTransaction,
    expectedSigner: record.fromWallet,
    description: `Transfer batch ${record.productId}`,
    targetAddress: address.toBase58(),
    productId: record.productId,
  });

  // Re-read the chain rather than trusting the submission.
  const onChain = await chain.fetchProduct(record.productId);
  if (onChain === null) {
    throw new AppError(ERROR_CODES.BLOCKCHAIN_ACCOUNT_NOT_FOUND, {
      message:
        "The transfer confirmed but the on-chain batch record cannot be read. An administrator has been notified.",
      details: { transferId: record.transferId, signature: confirmed.signature },
    });
  }
  if (onChain.owner !== record.toWallet) {
    await markFailed(record, "The on-chain owner does not match the requested recipient.");
    throw new AppError(ERROR_CODES.HASH_MISMATCH, {
      message:
        "The transfer confirmed but the on-chain owner is not the wallet you chose. Do not retry until a regulator has reviewed it.",
      details: {
        transferId: record.transferId,
        signature: confirmed.signature,
        onChainOwner: onChain.owner,
        requestedOwner: record.toWallet,
      },
    });
  }
  if (onChain.transferCount < 1) {
    throw new AppError(ERROR_CODES.HASH_MISMATCH, {
      message:
        "The transfer confirmed but the on-chain record does not show a completed transfer. An administrator has been notified.",
      details: { transferId: record.transferId, signature: confirmed.signature },
    });
  }

  try {
    record.status = "COMPLETED";
    record.transactionSignature = confirmed.signature;
    record.confirmedAt = new Date();
    record.resultingStatus = onChain.status;
    record.failureReason = null;
    await record.save();

    const previousOwner = product.ownerWallet;
    product.ownerWallet = onChain.owner;
    product.status = onChain.status;
    product.onChainTransferCount = onChain.transferCount;
    await product.save();

    await NotificationModel.create([
      {
        notificationId: newId(),
        recipientWallet: record.toWallet,
        kind: "TRANSFER_RECEIVED",
        title: `You now own batch ${record.productId}`,
        body: `Ownership of ${record.productId} was transferred to you by ${shorten(previousOwner)}. The batch is now ${onChain.status.replace(/_/g, " ").toLowerCase()}.`,
        productId: record.productId,
        linkPath: `/app/products/${record.productId}`,
      },
      {
        notificationId: newId(),
        recipientWallet: previousOwner,
        kind: "TRANSFER_SENT",
        title: `Batch ${record.productId} transferred`,
        body: `You transferred ${record.productId} to ${shorten(record.toWallet)}. Transaction ${confirmed.signature}.`,
        productId: record.productId,
        linkPath: `/app/transfers/${record.transferId}`,
      },
    ]);

    log.info(
      { transferId: record.transferId, signature: confirmed.signature },
      "ownership transfer confirmed"
    );
  } catch (error) {
    await TransferModel.updateOne(
      { transferId: record.transferId },
      { $set: { status: "NEEDS_RECONCILIATION" } }
    ).catch(() => undefined);
    await recordReconciliationFailure({
      intent: {
        action: "COMPLETE_TRANSFER",
        productId: record.productId,
        transactionSignature: confirmed.signature,
        intent: {
          transferId: record.transferId,
          toWallet: record.toWallet,
          toRole: record.toRole,
          resultingStatus: onChain.status,
          transferCount: onChain.transferCount,
        },
      },
      error,
    });
    throw new AppError(ERROR_CODES.RECONCILIATION_REQUIRED, {
      message:
        "The transfer was recorded on the blockchain but could not be finalised here. An administrator has been notified; do not send the batch again.",
      details: { transferId: record.transferId, signature: confirmed.signature },
      cause: error,
    });
  }

  return toTransferView(record.toObject());
}

async function markFailed(
  record: { status: string; failureReason?: string | null; save: () => Promise<unknown> },
  reason: string
): Promise<void> {
  record.status = "FAILED";
  record.failureReason = reason;
  await record.save();
}

/** A recipient confirms they hold the batch, closing the loop in the UI. */
export async function acknowledgeTransfer(input: {
  transferId: string;
  walletAddress: string;
}): Promise<TransferView> {
  const record = await TransferModel.findOne({ transferId: input.transferId });
  if (record === null) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      message: "This transfer no longer exists.",
    });
  }
  if (record.toWallet !== input.walletAddress) {
    throw new AppError(ERROR_CODES.FORBIDDEN, {
      message: "Only the receiving wallet can confirm receipt of this transfer.",
    });
  }
  if (record.status !== "COMPLETED") {
    throw new AppError(ERROR_CODES.TRANSFER_NOT_ALLOWED, {
      message: "This transfer has not completed on the blockchain yet.",
      details: { status: record.status },
    });
  }
  if (record.acknowledgedAt === null) {
    record.acknowledgedAt = new Date();
    await record.save();
  }
  return toTransferView(record.toObject());
}

export async function cancelTransfer(input: {
  transferId: string;
  walletAddress: string;
}): Promise<TransferView> {
  const record = await TransferModel.findOne({ transferId: input.transferId });
  if (record === null) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { message: "This transfer no longer exists." });
  }
  if (record.fromWallet !== input.walletAddress) {
    throw new AppError(ERROR_CODES.FORBIDDEN, {
      message: "Only the sending wallet can cancel this transfer.",
    });
  }
  if (record.status !== "PREPARED") {
    throw new AppError(ERROR_CODES.TRANSFER_NOT_ALLOWED, {
      message: "Only a transfer that has not been signed can be cancelled.",
      details: { status: record.status },
    });
  }
  record.status = "CANCELLED";
  record.failureReason = "Cancelled by the sender before signing.";
  await record.save();
  return toTransferView(record.toObject());
}

function shorten(wallet: string): string {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}
