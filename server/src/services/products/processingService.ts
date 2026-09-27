import { z } from "zod";
import { AppError, ERROR_CODES } from "../../lib/errors.js";
import { assertProductId, newId, toPublicKey } from "../../lib/crypto.js";
import { childLogger } from "../../lib/logger.js";
import { hashCanonicalPayload, normaliseMultilineText, normaliseText } from "../hashing/canonical.js";
import { canAdvance, isFlagged, isTerminal, statusLabel, type ProductStatus } from "../../lib/statusMachine.js";
import { ProcessingLogModel, ProductMetadataModel, NotificationModel } from "../../models/index.js";
import { buildUpdateStatus } from "../solana/instructions.js";
import { getProductAddress } from "../solana/pda.js";
import { getChainClient } from "../solana/chainClientRegistry.js";
import { storeUpload, type MediaCategory, type StoredMedia } from "../files/mediaStore.js";
import {
  prepareAction,
  recordReconciliationFailure,
  submitAction,
  type PreparedChainAction,
} from "../orchestration/chainFlow.js";

const log = childLogger({ layer: "processing" });

export const processingEventSchema = z.object({
  activity: z
    .string()
    .trim()
    .min(2, "Name the activity, for example sorting or drying.")
    .max(200),
  activityDescription: z
    .string()
    .trim()
    .min(10, "Describe what was done in at least ten characters.")
    .max(4000),
  occurredAt: z
    .string()
    .trim()
    .refine((value) => !Number.isNaN(Date.parse(value)), "Enter a valid date and time."),
  newStatus: z
    .enum(["IN_PROCESSING", "PROCESSED"])
    .optional()
    .describe("The batch status after this activity."),
});

export type ProcessingEventInput = z.infer<typeof processingEventSchema>;

export interface ProcessingLogView {
  logId: string;
  productId: string;
  processorWallet: string;
  processorName: string;
  activity: string;
  activityDescription: string;
  occurredAt: string;
  statusBefore: string;
  statusAfter: string;
  dataHash: string;
  onChainTxHash: string | null;
  supportingImages: StoredMedia[];
  supportingDocuments: StoredMedia[];
  createdAt: string;
}

export interface PreparedProcessing {
  log: ProcessingLogView;
  prepared: PreparedChainAction;
}

/**
 * Records a processing event. The lifecycle change is written on-chain; the
 * narrative, images and documents stay off-chain, and the log carries its own
 * SHA-256 so its contents are equally tamper-evident.
 */
export async function prepareProcessingEvent(input: {
  productId: string;
  processorWallet: string;
  processorName: string;
  payload: ProcessingEventInput;
  images: Array<{ buffer: Buffer; originalName: string; mimeType: string }>;
  documents: Array<{ buffer: Buffer; originalName: string; mimeType: string }>;
}): Promise<PreparedProcessing> {
  const productId = assertProductId(input.productId);
  const chain = getChainClient();

  const product = await ProductMetadataModel.findOne({ productId });
  if (product === null) {
    throw new AppError(ERROR_CODES.PRODUCT_NOT_FOUND, { details: { productId } });
  }
  if (product.chainState !== "CONFIRMED") {
    throw new AppError(ERROR_CODES.PRODUCT_STATE_INVALID, {
      message: "This batch is not fully registered on the blockchain yet.",
      details: { productId, chainState: product.chainState },
    });
  }
  if (product.ownerWallet !== input.processorWallet) {
    throw new AppError(ERROR_CODES.FORBIDDEN, {
      message:
        "Only the wallet that currently holds this batch can record a processing event for it.",
      details: { productId },
    });
  }

  const currentStatus = product.status as ProductStatus;
  if (isFlagged(currentStatus)) {
    throw new AppError(ERROR_CODES.PRODUCT_STATE_INVALID, {
      message:
        "A regulator has withheld this batch. Processing cannot be recorded until it is released.",
    });
  }
  if (isTerminal(currentStatus)) {
    throw new AppError(ERROR_CODES.PRODUCT_STATE_INVALID, {
      message: "This batch has already been sold, so no further processing can be recorded.",
    });
  }

  const newStatus = input.payload.newStatus ?? "IN_PROCESSING";
  if (newStatus === currentStatus) {
    // Recording an event that does not move the batch is legitimate, but it
    // needs no on-chain instruction, so only the off-chain log is written.
    const logOnly = await writeLogOnly({
      productId,
      processorWallet: input.processorWallet,
      processorName: input.processorName,
      payload: input.payload,
      statusBefore: currentStatus,
      statusAfter: currentStatus,
      images: input.images,
      documents: input.documents,
    });
    return {
      log: logOnly,
      prepared: {
        phase: "PREPARED",
        transaction: "",
        blockhash: "",
        lastValidBlockHeight: 0,
        targetAddress: product.onChainAddress ?? "",
        description: "No blockchain change is needed for this entry.",
        validForSeconds: 0,
      },
    };
  }
  if (!canAdvance(currentStatus, newStatus)) {
    throw new AppError(ERROR_CODES.PRODUCT_STATE_INVALID, {
      message: `A batch that is ${statusLabel(currentStatus).toLowerCase()} cannot be moved to ${statusLabel(newStatus).toLowerCase()}.`,
      details: { productId, currentStatus, newStatus },
    });
  }

  const storedImages = await storeAll(input.images, "IMAGE", input.processorWallet, productId);
  const storedDocuments = await storeAll(input.documents, "DOCUMENT", input.processorWallet, productId);
  const occurredAt = new Date(input.payload.occurredAt);
  const dataHash = hashCanonicalPayload({
    fields: [
      ["productId", productId],
      ["processorWallet", input.processorWallet],
      ["activity", normaliseText(input.payload.activity)],
      ["activityDescription", normaliseMultilineText(input.payload.activityDescription)],
      ["occurredAt", occurredAt.toISOString()],
      ["statusBefore", currentStatus],
      ["statusAfter", newStatus],
      ["imageHashes", storedImages.map((file) => file.contentHash)],
      ["documentHashes", storedDocuments.map((file) => file.contentHash)],
    ],
  });

  const logId = newId();
  await ProcessingLogModel.create({
    logId,
    productId,
    processorWallet: input.processorWallet,
    processorName: input.processorName,
    activity: input.payload.activity,
    activityDescription: input.payload.activityDescription,
    occurredAt,
    statusBefore: currentStatus,
    statusAfter: newStatus,
    supportingImages: storedImages.map(toReference),
    supportingDocuments: storedDocuments.map(toReference),
    dataHash,
  });

  const instruction = buildUpdateStatus(
    chain.programId,
    toPublicKey(input.processorWallet, "walletAddress"),
    productId,
    newStatus,
    Math.floor(occurredAt.getTime() / 1000)
  );
  const prepared = await prepareAction({
    instructions: [instruction],
    feePayer: input.processorWallet,
    description: `Record processing on batch ${productId}: ${input.payload.activity}`,
    targetAddress: getProductAddress(chain.programId, productId).toBase58(),
  });

  log.info({ logId, productId, newStatus }, "prepared processing event");
  return {
    log: await readLog(logId),
    prepared,
  };
}

async function writeLogOnly(input: {
  productId: string;
  processorWallet: string;
  processorName: string;
  payload: ProcessingEventInput;
  statusBefore: ProductStatus;
  statusAfter: ProductStatus;
  images: Array<{ buffer: Buffer; originalName: string; mimeType: string }>;
  documents: Array<{ buffer: Buffer; originalName: string; mimeType: string }>;
}): Promise<ProcessingLogView> {
  const storedImages = await storeAll(input.images, "IMAGE", input.processorWallet, input.productId);
  const storedDocuments = await storeAll(
    input.documents,
    "DOCUMENT",
    input.processorWallet,
    input.productId
  );
  const occurredAt = new Date(input.payload.occurredAt);
  const dataHash = hashCanonicalPayload({
    fields: [
      ["productId", input.productId],
      ["processorWallet", input.processorWallet],
      ["activity", normaliseText(input.payload.activity)],
      ["activityDescription", normaliseMultilineText(input.payload.activityDescription)],
      ["occurredAt", occurredAt.toISOString()],
      ["statusBefore", input.statusBefore],
      ["statusAfter", input.statusAfter],
      ["imageHashes", storedImages.map((file) => file.contentHash)],
      ["documentHashes", storedDocuments.map((file) => file.contentHash)],
    ],
  });
  const logId = newId();
  await ProcessingLogModel.create({
    logId,
    productId: input.productId,
    processorWallet: input.processorWallet,
    processorName: input.processorName,
    activity: input.payload.activity,
    activityDescription: input.payload.activityDescription,
    occurredAt,
    statusBefore: input.statusBefore,
    statusAfter: input.statusAfter,
    supportingImages: storedImages.map(toReference),
    supportingDocuments: storedDocuments.map(toReference),
    dataHash,
  });
  return readLog(logId);
}

export async function submitProcessingEvent(input: {
  logId: string;
  signedTransaction: string;
  processorWallet: string;
}): Promise<ProcessingLogView> {
  const chain = getChainClient();
  const record = await ProcessingLogModel.findOne({ logId: input.logId });
  if (record === null) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { message: "This processing entry no longer exists." });
  }
  if (record.onChainTxHash !== null) {
    return readLog(input.logId);
  }
  if (record.processorWallet !== input.processorWallet) {
    throw new AppError(ERROR_CODES.FORBIDDEN, {
      message: "Only the processor who prepared this entry may submit it.",
    });
  }
  if (input.signedTransaction.trim().length === 0) {
    return readLog(input.logId);
  }

  const product = await ProductMetadataModel.findOne({ productId: record.productId });
  if (product === null) {
    throw new AppError(ERROR_CODES.PRODUCT_NOT_FOUND, {
      details: { productId: record.productId },
    });
  }

  const confirmed = await submitAction({
    signedTransaction: input.signedTransaction,
    expectedSigner: input.processorWallet,
    description: `Record processing on batch ${record.productId}`,
    targetAddress: getProductAddress(chain.programId, record.productId).toBase58(),
    productId: record.productId,
  });

  const onChain = await chain.fetchProduct(record.productId);
  if (onChain === null) {
    throw new AppError(ERROR_CODES.BLOCKCHAIN_ACCOUNT_NOT_FOUND, {
      message:
        "The transaction confirmed but the on-chain batch record cannot be read. An administrator has been notified.",
      details: { logId: record.logId, signature: confirmed.signature },
    });
  }

  try {
    record.onChainTxHash = confirmed.signature;
    await record.save();
    product.status = onChain.status;
    await product.save();
    if (product.ownerWallet !== record.processorWallet) {
      await NotificationModel.create({
        notificationId: newId(),
        recipientWallet: product.ownerWallet,
        kind: "SYSTEM",
        title: `Batch ${record.productId} progressed`,
        body: `${record.activity} was recorded on the blockchain. The batch is now ${onChain.status.replace(/_/g, " ").toLowerCase()}.`,
        productId: record.productId,
        linkPath: `/app/products/${record.productId}/processing`,
      });
    }
  } catch (error) {
    await ProcessingLogModel.updateOne(
      { logId: record.logId },
      { $set: { onChainTxHash: confirmed.signature } }
    ).catch(() => undefined);
    await recordReconciliationFailure({
      intent: {
        action: "COMPLETE_PROCESSING_LOG",
        productId: record.productId,
        transactionSignature: confirmed.signature,
        intent: { logId: record.logId, statusAfter: record.statusAfter },
      },
      error,
    });
    throw new AppError(ERROR_CODES.RECONCILIATION_REQUIRED, {
      message:
        "The processing event was recorded on the blockchain but could not be finalised here. An administrator has been notified.",
      details: { logId: record.logId, signature: confirmed.signature },
      cause: error,
    });
  }

  log.info({ logId: record.logId, signature: confirmed.signature }, "processing event confirmed");
  return readLog(input.logId);
}

export async function listProcessingLogs(productId: string): Promise<ProcessingLogView[]> {
  const logs = await ProcessingLogModel.find({ productId }).sort({ occurredAt: 1 }).lean();
  return logs.map((entry) => toView(entry));
}

export async function readLog(logId: string): Promise<ProcessingLogView> {
  const entry = await ProcessingLogModel.findOne({ logId }).lean();
  if (entry === null) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { message: "This processing entry no longer exists." });
  }
  return toView(entry);
}

function toView(entry: {
  logId: string;
  productId: string;
  processorWallet: string;
  processorName: string;
  activity: string;
  activityDescription: string;
  occurredAt: Date;
  statusBefore: string;
  statusAfter: string;
  dataHash: string;
  onChainTxHash?: string | null;
  supportingImages: ReadonlyArray<unknown>;
  supportingDocuments: ReadonlyArray<unknown>;
  createdAt: Date;
}): ProcessingLogView {
  return {
    logId: entry.logId,
    productId: entry.productId,
    processorWallet: entry.processorWallet,
    processorName: entry.processorName,
    activity: entry.activity,
    activityDescription: entry.activityDescription,
    occurredAt: entry.occurredAt.toISOString(),
    statusBefore: entry.statusBefore,
    statusAfter: entry.statusAfter,
    dataHash: entry.dataHash,
    onChainTxHash: entry.onChainTxHash ?? null,
    supportingImages: entry.supportingImages as StoredMedia[],
    supportingDocuments: entry.supportingDocuments as StoredMedia[],
    createdAt: entry.createdAt.toISOString(),
  };
}

async function storeAll(
  files: Array<{ buffer: Buffer; originalName: string; mimeType: string }>,
  kind: MediaCategory,
  wallet: string,
  productId: string
): Promise<StoredMedia[]> {
  const stored: StoredMedia[] = [];
  for (const file of files) {
    stored.push(
      await storeUpload({
        buffer: file.buffer,
        originalName: file.originalName,
        mimeType: file.mimeType,
        uploadedByWallet: wallet,
        productId,
        kind,
      })
    );
  }
  return stored;
}

function toReference(media: StoredMedia) {
  return {
    mediaId: media.mediaId,
    fileName: media.fileName,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    contentHash: media.contentHash,
  };
}
