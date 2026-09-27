import { z } from "zod";
import { env } from "../../config/env.js";

import { AppError, ERROR_CODES } from "../../lib/errors.js";
import { assertProductId, newId, suggestProductId, toPublicKey } from "../../lib/crypto.js";
import { childLogger } from "../../lib/logger.js";
import { computeRegistrationHash } from "../hashing/canonical.js";
import { buildRegisterProduct } from "../solana/instructions.js";
import { getProductAddress } from "../solana/pda.js";
import { getChainClient } from "../solana/chainClientRegistry.js";
import { normaliseBlockchainError } from "../solana/errorMapping.js";
import { ProductMetadataModel, NotificationModel } from "../../models/index.js";
import { deleteMedia, storeUpload, type MediaCategory, type StoredMedia } from "../files/mediaStore.js";
import {
  prepareAction,
  recordReconciliationFailure,
  submitAction,
  wrapDatabaseFailure,
  type PreparedChainAction,
} from "../orchestration/chainFlow.js";

const log = childLogger({ layer: "products" });

export const productRegistrationSchema = z.object({
  productId: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .transform((value) => value.toUpperCase())
    .optional(),
  cropType: z.string().trim().min(2, "Name the crop or product.").max(120),
  quantity: z.coerce
    .number()
    .positive("Enter a quantity greater than zero.")
    .max(1_000_000_000),
  unit: z
    .string()
    .trim()
    .min(1, "Choose a unit.")
    .max(32)
    .transform((value) => value.toLowerCase()),
  harvestDate: z
    .string()
    .trim()
    .refine((value) => !Number.isNaN(Date.parse(value)), "Enter a valid harvest date.")
    .transform((value) => new Date(value)),
  farmLocation: z
    .string()
    .trim()
    .min(3, "Describe where the batch was grown.")
    .max(400),
  description: z
    .string()
    .trim()
    .min(10, "Describe the batch in at least ten characters.")
    .max(4000),
  additionalNotes: z.string().trim().max(4000).default(""),
});

export type ProductRegistrationInput = z.infer<typeof productRegistrationSchema>;

export interface RegistrationDraft {
  productId: string;
  dataHash: string;
  chainState: "AWAITING_SIGNATURE";
  prepared: PreparedChainAction;
  product: ProductSummary;
}

export interface ProductSummary {
  productId: string;
  cropType: string;
  quantity: number;
  unit: string;
  harvestDate: string;
  farmLocation: string;
  description: string;
  additionalNotes: string;
  status: string;
  chainState: string;
  ownerWallet: string;
  registeredByWallet: string;
  registrantRole: string;
  dataHash: string;
  onChainDataHash: string | null;
  onChainTxHash: string | null;
  onChainAddress: string | null;
  onChainRegisteredAt: string | null;
  onChainTransferCount: number;
  images: Array<{
    mediaId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    contentHash: string;
    kind: string;
    caption: string;
  }>;
  certificates: Array<{
    mediaId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    contentHash: string;
    kind: string;
    caption: string;
  }>;
  retail: Record<string, unknown>;
  lastVerificationResult: string;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProductRecordLike {
  productId: string;
  cropType: string;
  quantity: number;
  unit: string;
  harvestDate: Date;
  farmLocation: string;
  description: string;
  additionalNotes: string;
  status: string;
  chainState: string;
  ownerWallet: string;
  registeredByWallet: string;
  registrantRole: string;
  dataHash: string;
  onChainDataHash: string | null;
  onChainTxHash: string | null;
  onChainAddress: string | null;
  onChainRegisteredAt: Date | null;
  onChainTransferCount: number;
  images: unknown[];
  certificates: unknown[];
  retail: Record<string, unknown>;
  lastVerificationResult: string;
  lastVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toProductSummary(record: ProductRecordLike): ProductSummary {
  return {
    productId: record.productId,
    cropType: record.cropType,
    quantity: record.quantity,
    unit: record.unit,
    harvestDate: record.harvestDate.toISOString(),
    farmLocation: record.farmLocation,
    description: record.description,
    additionalNotes: record.additionalNotes,
    status: record.status,
    chainState: record.chainState,
    ownerWallet: record.ownerWallet,
    registeredByWallet: record.registeredByWallet,
    registrantRole: record.registrantRole,
    dataHash: record.dataHash,
    onChainDataHash: record.onChainDataHash,
    onChainTxHash: record.onChainTxHash,
    onChainAddress: record.onChainAddress,
    onChainRegisteredAt:
      record.onChainRegisteredAt === null ? null : record.onChainRegisteredAt.toISOString(),
    onChainTransferCount: record.onChainTransferCount,
    images: record.images as ProductSummary["images"],
    certificates: record.certificates as ProductSummary["certificates"],
    retail: record.retail,
    lastVerificationResult: record.lastVerificationResult,
    lastVerifiedAt:
      record.lastVerifiedAt === null ? null : record.lastVerifiedAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export interface PrepareRegistrationInput {
  input: ProductRegistrationInput;
  walletAddress: string;
  role: string;
  images: Array<{ buffer: Buffer; originalName: string; mimeType: string }>;
  certificates: Array<{ buffer: Buffer; originalName: string; mimeType: string }>;
  existingCertificateHashes: readonly string[];
}

/**
 * Stage one of registration: validate, store the supporting files, hash the
 * canonical payload, and hand back an unsigned transaction.
 *
 * Nothing is reported as registered here. The off-chain record is created in
 * `AWAITING_SIGNATURE` so a participant who closes their wallet can see exactly
 * what happened and retry.
 */
export async function prepareRegistration(
  payload: PrepareRegistrationInput
): Promise<RegistrationDraft> {
  const chain = getChainClient();
  const productId = await resolveProductId(payload);

  const existing = await ProductMetadataModel.findOne({ productId }).lean();
  if (existing !== null) {
    if (existing.chainState === "CONFIRMED") {
      throw new AppError(ERROR_CODES.PRODUCT_ALREADY_EXISTS, {
        message: `Product ${productId} is already registered.`,
        details: { productId },
      });
    }
    // A previous attempt never reached the chain, so the identifier is free
    // again. Its orphaned uploads are removed so they cannot be fetched later.
    await discardDraftMedia(existing.images, existing.certificates);
    await ProductMetadataModel.deleteOne({ productId }).catch(() => undefined);
  }

  let onChain;
  try {
    onChain = await chain.fetchProduct(productId);
  } catch (error) {
    throw normaliseBlockchainError(error, `checking for an existing ${productId} on-chain`);
  }
  if (onChain !== null) {
    throw new AppError(ERROR_CODES.PRODUCT_ALREADY_EXISTS, {
      message: `Product ${productId} is already registered on-chain.`,
      details: { productId, onChainAddress: onChain.product },
    });
  }

  const storedImages: StoredMedia[] = [];
  const storedCertificates: StoredMedia[] = [];
  try {
    for (const file of payload.images) {
      storedImages.push(
        await storeOne(file, "IMAGE", payload.walletAddress, productId)
      );
    }
    for (const file of payload.certificates) {
      storedCertificates.push(
        await storeOne(file, "DOCUMENT", payload.walletAddress, productId)
      );
    }
  } catch (error) {
    throw wrapDatabaseFailure(error, "storing registration media");
  }

  const registeredAt = new Date();
  const certificateHashes = [
    ...payload.existingCertificateHashes,
    ...storedCertificates.map((file) => file.contentHash),
  ];
  const dataHash = computeRegistrationHash({
    productId,
    cropType: payload.input.cropType,
    quantity: payload.input.quantity,
    unit: payload.input.unit,
    harvestDate: payload.input.harvestDate,
    farmLocation: payload.input.farmLocation,
    description: payload.input.description,
    additionalNotes: payload.input.additionalNotes,
    registeredByWallet: payload.walletAddress,
    imageHashes: storedImages.map((file) => file.contentHash),
    certificateHashes,
    registeredAt,
  });

  const address = getProductAddress(chain.programId, productId);
  const instruction = buildRegisterProduct(
    chain.programId,
    toPublicKey(payload.walletAddress, "walletAddress"),
    productId,
    Buffer.from(dataHash, "hex")
  );

  const prepared = await prepareAction({
    instructions: [instruction],
    feePayer: payload.walletAddress,
    description: `Register agricultural batch ${productId} on Solana ${env.SOLANA_NETWORK}`,
    targetAddress: address.toBase58(),
  });

  try {
    const created = await ProductMetadataModel.create({
      productId,
      ownerWallet: payload.walletAddress,
      registeredByWallet: payload.walletAddress,
      registrantRole: payload.role,
      cropType: payload.input.cropType,
      quantity: payload.input.quantity,
      unit: payload.input.unit,
      harvestDate: payload.input.harvestDate,
      farmLocation: payload.input.farmLocation,
      description: payload.input.description,
      additionalNotes: payload.input.additionalNotes,
      images: storedImages.map(toReference),
      certificates: storedCertificates.map(toReference),
      anchoredImageHashes: storedImages.map((file) => file.contentHash),
      anchoredCertificateHashes: certificateHashes,
      dataHash,
      registrationHashTimestamp: registeredAt,
      onChainAddress: address.toBase58(),
      status: "REGISTERED",
      chainState: "AWAITING_SIGNATURE",
      preparedAt: new Date(),
      lastVerificationResult: "PENDING",
    });
    log.info(
      { productId, dataHash, walletAddress: payload.walletAddress },
      "prepared product registration"
    );
    return {
      productId,
      dataHash,
      chainState: "AWAITING_SIGNATURE",
      prepared,
      product: toProductSummary(created.toObject() as unknown as ProductRecordLike),
    };
  } catch (error) {
    throw wrapDatabaseFailure(error, "creating the product record");
  }
}

async function storeOne(
  file: { buffer: Buffer; originalName: string; mimeType: string },
  kind: MediaCategory,
  walletAddress: string,
  productId: string
): Promise<StoredMedia> {
  return storeUpload({
    buffer: file.buffer,
    originalName: file.originalName,
    mimeType: file.mimeType,
    uploadedByWallet: walletAddress,
    productId,
    kind,
  });
}

function toReference(media: StoredMedia) {
  return {
    mediaId: media.mediaId,
    fileName: media.fileName,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    contentHash: media.contentHash,
    kind: media.kind,
    caption: "",
  };
}

async function resolveProductId(
  payload: PrepareRegistrationInput
): Promise<string> {
  if (payload.input.productId !== undefined && payload.input.productId.length > 0) {
    return assertProductId(payload.input.productId);
  }
  return suggestProductId(payload.input.cropType, payload.input.harvestDate);
}

async function discardDraftMedia(
  images: ReadonlyArray<{ mediaId?: string }> | undefined,
  certificates: ReadonlyArray<{ mediaId?: string }> | undefined
): Promise<void> {
  const ids = [...(images ?? []), ...(certificates ?? [])]
    .map((entry) => entry?.mediaId)
    .filter((id): id is string => typeof id === "string");
  for (const id of ids) {
    await deleteMedia(id).catch(() => undefined);
  }
}

export interface SubmitRegistrationInput {
  productId: string;
  signedTransaction: string;
  walletAddress: string;
}

export interface RegistrationConfirmation {
  product: ProductSummary;
  signature: string;
  slot: number;
  verificationUrl: string;
  qrPayload: string;
}

/**
 * Stage two of registration: submit the signed transaction, wait for real
 * confirmation, re-read the on-chain account, and only then mark the record
 * confirmed.
 */
export async function submitRegistration(
  payload: SubmitRegistrationInput
): Promise<RegistrationConfirmation> {
  const chain = getChainClient();
  const record = await ProductMetadataModel.findOne({ productId: payload.productId });
  if (record === null) {
    throw new AppError(ERROR_CODES.PRODUCT_NOT_FOUND, {
      message: `No product ${payload.productId} is waiting to be registered. Prepare the registration again.`,
      details: { productId: payload.productId, recovery: "reprepare" },
    });
  }
  if (record.chainState === "CONFIRMED") {
    return {
      product: toProductSummary(record.toObject() as unknown as ProductRecordLike),
      signature: record.onChainTxHash ?? "",
      slot: 0,
      verificationUrl: verificationUrlFor(record.productId),
      qrPayload: verificationUrlFor(record.productId),
    };
  }
  if (record.registeredByWallet !== payload.walletAddress) {
    throw new AppError(ERROR_CODES.FORBIDDEN, {
      message: "Only the wallet that prepared this registration may submit it.",
    });
  }

  record.chainState = "SUBMITTED";
  record.pendingSignature = null;
  await record.save();

  const address = getProductAddress(chain.programId, payload.productId);
  const confirmed = await submitAction({
    signedTransaction: payload.signedTransaction,
    expectedSigner: payload.walletAddress,
    description: `Register agricultural batch ${payload.productId}`,
    targetAddress: address.toBase58(),
    productId: payload.productId,
  });

  // Step 5: confirm the chain actually holds what we intended.
  const onChain = await chain.fetchProduct(payload.productId);
  if (onChain === null) {
    throw new AppError(ERROR_CODES.BLOCKCHAIN_ACCOUNT_NOT_FOUND, {
      message:
        "The transaction confirmed but the on-chain record for this batch cannot be read. This has been flagged for an administrator.",
      details: { productId: payload.productId, signature: confirmed.signature },
    });
  }
  if (onChain.offChainDataHash !== record.dataHash) {
    throw new AppError(ERROR_CODES.HASH_MISMATCH, {
      message:
        "The transaction confirmed but the hash stored on-chain does not match the record that was submitted. This has been flagged for an administrator.",
      details: {
        productId: payload.productId,
        signature: confirmed.signature,
        onChainHash: onChain.offChainDataHash,
        recordHash: record.dataHash,
      },
    });
  }
  if (onChain.registrant !== record.registeredByWallet) {
    throw new AppError(ERROR_CODES.HASH_MISMATCH, {
      message:
        "The transaction confirmed but the on-chain registrant does not match the wallet that submitted it. This has been flagged for an administrator.",
      details: {
        productId: payload.productId,
        signature: confirmed.signature,
        onChainRegistrant: onChain.registrant,
        recordRegistrant: record.registeredByWallet,
      },
    });
  }

  // Step 6: the write that the reconciliation path exists to protect.
  try {
    record.onChainTxHash = confirmed.signature;
    record.onChainDataHash = onChain.offChainDataHash;
    record.onChainAddress = address.toBase58();
    record.onChainRegisteredAt = new Date(onChain.registeredAt * 1000);
    record.onChainTransferCount = onChain.transferCount;
    record.status = onChain.status;
    record.chainState = "CONFIRMED";
    record.chainError = null;
    record.pendingSignature = confirmed.signature;
    record.lastVerificationResult = "VERIFIED";
    record.lastVerifiedAt = new Date();
    await record.save();

    await NotificationModel.create({
      notificationId: newId(),
      recipientWallet: record.registeredByWallet,
      kind: "PRODUCT_REGISTERED",
      title: `Batch ${record.productId} registered on-chain`,
      body: `Your batch ${record.productId} (${record.quantity} ${record.unit} of ${record.cropType}) is registered on Solana ${env.SOLANA_NETWORK}. Transaction ${confirmed.signature}.`,
      productId: record.productId,
      linkPath: `/app/products/${record.productId}`,
    });

    log.info(
      { productId: record.productId, signature: confirmed.signature, slot: confirmed.slot },
      "product registration confirmed"
    );
  } catch (error) {
    await ProductMetadataModel.updateOne(
      { productId: payload.productId },
      { $set: { chainState: "NEEDS_RECONCILIATION" } }
    ).catch(() => undefined);
    await recordReconciliationFailure({
      intent: {
        action: "COMPLETE_PRODUCT_REGISTRATION",
        productId: payload.productId,
        transactionSignature: confirmed.signature,
        intent: {
          productId: payload.productId,
          dataHash: record.dataHash,
          ownerWallet: record.ownerWallet,
          registeredByWallet: record.registeredByWallet,
          onChainRegisteredAt: new Date(onChain.registeredAt * 1000).toISOString(),
          status: onChain.status,
        },
      },
      error,
    });
    throw new AppError(ERROR_CODES.RECONCILIATION_REQUIRED, {
      message:
        "The batch was registered on the blockchain but the record could not be finalised here. An administrator has been notified; do not register the batch again.",
      details: { productId: payload.productId, signature: confirmed.signature },
      cause: error,
    });
  }

  return {
    product: toProductSummary(record.toObject() as unknown as ProductRecordLike),
    signature: confirmed.signature,
    slot: confirmed.slot,
    verificationUrl: verificationUrlFor(record.productId),
    qrPayload: verificationUrlFor(record.productId),
  };
}

/** Abandons a prepared registration so the identifier becomes available again. */
export async function cancelRegistration(input: {
  productId: string;
  walletAddress: string;
}): Promise<void> {
  const record = await ProductMetadataModel.findOne({ productId: input.productId });
  if (record === null) return;
  if (record.registeredByWallet !== input.walletAddress) {
    throw new AppError(ERROR_CODES.FORBIDDEN, {
      message: "Only the wallet that prepared this registration may cancel it.",
    });
  }
  if (record.chainState === "CONFIRMED") {
    throw new AppError(ERROR_CODES.PRODUCT_STATE_INVALID, {
      message: "This batch is already registered on-chain and cannot be cancelled.",
    });
  }
  record.chainState = "CANCELLED";
  record.chainError = "Cancelled by the participant before signing.";
  await record.save();
}

export function verificationUrlFor(productId: string): string {
  return `${env.CLIENT_URL.replace(/\/$/, "")}/verify/${productId}`;
}

export function qrPayloadFor(productId: string): string {
  return verificationUrlFor(productId);
}

/** Deterministic address for a product, for links and diagnostics. */
export function productAddress(productId: string): string {
  return getProductAddress(getChainClient().programId, productId).toBase58();
}
