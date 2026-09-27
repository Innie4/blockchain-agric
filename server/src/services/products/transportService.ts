import { z } from "zod";
import { AppError, ERROR_CODES } from "../../lib/errors.js";
import { assertProductId, newId, toPublicKey } from "../../lib/crypto.js";
import { childLogger } from "../../lib/logger.js";
import { hashCanonicalPayload, normaliseMultilineText, normaliseText } from "../hashing/canonical.js";
import { isFlagged, isTerminal, type ProductStatus } from "../../lib/statusMachine.js";
import { ProductMetadataModel, TransportLogModel } from "../../models/index.js";
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

const log = childLogger({ layer: "transport" });

export const transportEventSchema = z
  .object({
    origin: z.string().trim().min(2, "Name where the batch left from.").max(300),
    destination: z.string().trim().min(2, "Name where the batch is going.").max(300),
    routeDetails: z.string().trim().max(4000).default(""),
    vehicleDescription: z.string().trim().max(300).default(""),
    departedAt: z
      .string()
      .trim()
      .refine((value) => !Number.isNaN(Date.parse(value)), "Enter a valid departure time."),
    expectedArrivalAt: z
      .string()
      .trim()
      .refine((value) => !Number.isNaN(Date.parse(value)), "Enter a valid arrival time.")
      .optional()
      .or(z.literal("")),
    deliveryStatus: z
      .enum(["SCHEDULED", "IN_TRANSIT", "DELIVERED", "DELAYED", "CANCELLED"])
      .default("IN_TRANSIT"),
  })
  .refine(
    (value) => value.destination.trim().toLowerCase() !== value.origin.trim().toLowerCase(),
    { message: "The destination must differ from the origin.", path: ["destination"] }
  );

export type TransportEventInput = z.infer<typeof transportEventSchema>;

export interface TransportLogView {
  logId: string;
  productId: string;
  transporterWallet: string;
  transporterName: string;
  origin: string;
  destination: string;
  routeDetails: string;
  vehicleDescription: string;
  departedAt: string;
  expectedArrivalAt: string | null;
  deliveredAt: string | null;
  deliveryStatus: string;
  dataHash: string;
  onChainTxHash: string | null;
  supportingDocuments: StoredMedia[];
  createdAt: string;
}

export interface PreparedTransport {
  log: TransportLogView;
  prepared: PreparedChainAction;
}

/**
 * Records a transport event.
 *
 * The source project explicitly treats automated sensor capture as future
 * work, so no GPS coordinates or telemetry readings are recorded or simulated
 * here. A transporter states where the batch went and when.
 */
export async function prepareTransportEvent(input: {
  productId: string;
  transporterWallet: string;
  transporterName: string;
  payload: TransportEventInput;
  documents: Array<{ buffer: Buffer; originalName: string; mimeType: string }>;
}): Promise<PreparedTransport> {
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
  if (product.ownerWallet !== input.transporterWallet) {
    throw new AppError(ERROR_CODES.FORBIDDEN, {
      message:
        "Only the wallet that currently holds this batch can record a transport event for it.",
      details: { productId },
    });
  }
  const currentStatus = product.status as ProductStatus;
  if (isFlagged(currentStatus)) {
    throw new AppError(ERROR_CODES.PRODUCT_STATE_INVALID, {
      message: "A regulator has withheld this batch, so its movement cannot be recorded.",
    });
  }
  if (isTerminal(currentStatus)) {
    throw new AppError(ERROR_CODES.PRODUCT_STATE_INVALID, {
      message: "This batch has already been sold, so its movement cannot be recorded.",
    });
  }

  const documents = await storeAll(
    input.documents,
    "DOCUMENT",
    input.transporterWallet,
    productId
  );
  const departedAt = new Date(input.payload.departedAt);
  const expectedArrivalAt =
    input.payload.expectedArrivalAt === undefined || input.payload.expectedArrivalAt.length === 0
      ? null
      : new Date(input.payload.expectedArrivalAt);
  if (
    expectedArrivalAt !== null &&
    expectedArrivalAt.getTime() < departedAt.getTime()
  ) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
      message: "The expected arrival cannot be earlier than the departure time.",
      details: [{ path: "expectedArrivalAt", message: "Arrival precedes departure." }],
    });
  }

  const newStatus = input.payload.deliveryStatus === "DELIVERED" ? "AT_RETAILER" : "IN_TRANSIT";
  const dataHash = hashCanonicalPayload({
    fields: [
      ["productId", productId],
      ["transporterWallet", input.transporterWallet],
      ["origin", normaliseText(input.payload.origin)],
      ["destination", normaliseText(input.payload.destination)],
      ["routeDetails", normaliseMultilineText(input.payload.routeDetails)],
      ["vehicleDescription", normaliseText(input.payload.vehicleDescription)],
      ["departedAt", departedAt.toISOString()],
      [
        "expectedArrivalAt",
        expectedArrivalAt === null ? "" : expectedArrivalAt.toISOString(),
      ],
      ["deliveryStatus", input.payload.deliveryStatus],
      ["documentHashes", documents.map((file) => file.contentHash)],
    ],
  });

  const logId = newId();
  await TransportLogModel.create({
    logId,
    productId,
    transporterWallet: input.transporterWallet,
    transporterName: input.transporterName,
    origin: input.payload.origin,
    destination: input.payload.destination,
    routeDetails: input.payload.routeDetails,
    vehicleDescription: input.payload.vehicleDescription,
    departedAt,
    expectedArrivalAt,
    deliveredAt: input.payload.deliveryStatus === "DELIVERED" ? new Date() : null,
    deliveryStatus: input.payload.deliveryStatus,
    supportingDocuments: documents.map(toReference),
    dataHash,
  });

  // Recording movement that does not change the batch's stage needs no
  // instruction, so the entry is stored without asking for a signature.
  if (newStatus === currentStatus) {
    log.info({ logId, productId, deliveryStatus: input.payload.deliveryStatus }, "recorded transport event without a status change");
    return {
      log: await readLog(logId),
      prepared: noChainAction(product.onChainAddress ?? ""),
    };
  }

  const instruction = buildUpdateStatus(
    chain.programId,
    toPublicKey(input.transporterWallet, "walletAddress"),
    productId,
    newStatus,
    Math.floor(departedAt.getTime() / 1000)
  );
  const prepared = await prepareAction({
    instructions: [instruction],
    feePayer: input.transporterWallet,
    description: `Record transport of batch ${productId} to ${input.payload.destination}`,
    targetAddress: getProductAddress(chain.programId, productId).toBase58(),
  });

  return { log: await readLog(logId), prepared };
}

function noChainAction(targetAddress: string): PreparedChainAction {
  return {
    phase: "PREPARED",
    transaction: "",
    blockhash: "",
    lastValidBlockHeight: 0,
    targetAddress,
    description: "This entry records a detail and does not change the batch's stage.",
    validForSeconds: 0,
  };
}

export async function submitTransportEvent(input: {
  logId: string;
  signedTransaction: string;
  transporterWallet: string;
}): Promise<TransportLogView> {
  const chain = getChainClient();
  const record = await TransportLogModel.findOne({ logId: input.logId });
  if (record === null) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      message: "This transport entry no longer exists.",
    });
  }
  if (record.onChainTxHash !== null) {
    return readLog(input.logId);
  }
  if (record.transporterWallet !== input.transporterWallet) {
    throw new AppError(ERROR_CODES.FORBIDDEN, {
      message: "Only the transporter who prepared this entry may submit it.",
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
    expectedSigner: input.transporterWallet,
    description: `Record transport of batch ${record.productId}`,
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
  } catch (error) {
    await TransportLogModel.updateOne(
      { logId: record.logId },
      { $set: { onChainTxHash: confirmed.signature } }
    ).catch(() => undefined);
    await recordReconciliationFailure({
      intent: {
        action: "COMPLETE_TRANSPORT_LOG",
        productId: record.productId,
        transactionSignature: confirmed.signature,
        intent: { logId: record.logId, deliveryStatus: record.deliveryStatus },
      },
      error,
    });
    throw new AppError(ERROR_CODES.RECONCILIATION_REQUIRED, {
      message:
        "The transport event was recorded on the blockchain but could not be finalised here. An administrator has been notified.",
      details: { logId: record.logId, signature: confirmed.signature },
      cause: error,
    });
  }

  log.info({ logId: record.logId, signature: confirmed.signature }, "transport event confirmed");
  return readLog(input.logId);
}

export async function listTransportLogs(productId: string): Promise<TransportLogView[]> {
  const entries = await TransportLogModel.find({ productId }).sort({ departedAt: 1 }).lean();
  return entries.map(toView);
}

export async function readLog(logId: string): Promise<TransportLogView> {
  const entry = await TransportLogModel.findOne({ logId }).lean();
  if (entry === null) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { message: "This transport entry no longer exists." });
  }
  return toView(entry);
}

/** A lean MongoDB document omits unset fields, so absent and null both occur. */
function isoOrNull(value: Date | null | undefined): string | null {
  return value == null ? null : value.toISOString();
}

function toView(entry: {
  logId: string;
  productId: string;
  transporterWallet: string;
  transporterName: string;
  origin: string;
  destination: string;
  routeDetails: string;
  vehicleDescription: string;
  departedAt: Date;
  expectedArrivalAt?: Date | null;
  deliveredAt?: Date | null;
  deliveryStatus: string;
  dataHash: string;
  onChainTxHash?: string | null;
  supportingDocuments: ReadonlyArray<unknown>;
  createdAt: Date;
}): TransportLogView {
  return {
    logId: entry.logId,
    productId: entry.productId,
    transporterWallet: entry.transporterWallet,
    transporterName: entry.transporterName,
    origin: entry.origin,
    destination: entry.destination,
    routeDetails: entry.routeDetails,
    vehicleDescription: entry.vehicleDescription,
    departedAt: entry.departedAt.toISOString(),
    expectedArrivalAt: isoOrNull(entry.expectedArrivalAt),
    deliveredAt: isoOrNull(entry.deliveredAt),
    deliveryStatus: entry.deliveryStatus,
    dataHash: entry.dataHash,
    onChainTxHash: entry.onChainTxHash ?? null,
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
