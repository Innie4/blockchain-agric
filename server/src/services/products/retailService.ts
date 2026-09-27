import { z } from "zod";
import { AppError, ERROR_CODES } from "../../lib/errors.js";
import { assertProductId, newId } from "../../lib/crypto.js";
import { childLogger } from "../../lib/logger.js";
import { isFlagged, isTerminal, type ProductStatus } from "../../lib/statusMachine.js";
import { ProductMetadataModel, NotificationModel } from "../../models/index.js";
import { buildUpdateStatus } from "../solana/instructions.js";
import { getProductAddress } from "../solana/pda.js";
import { getChainClient } from "../solana/chainClientRegistry.js";
import { toPublicKey } from "../../lib/crypto.js";
import {
  prepareAction,
  recordReconciliationFailure,
  submitAction,
  type PreparedChainAction,
} from "../orchestration/chainFlow.js";
import { toProductSummary, type ProductSummary } from "./registrationService.js";

const log = childLogger({ layer: "retail" });

export const statusUpdateSchema = z.object({
  status: z.enum(["AT_RETAILER", "LISTED", "SOLD", "PROCESSED", "IN_TRANSIT", "IN_PROCESSING"]),
  occurredAt: z
    .string()
    .trim()
    .refine((value) => !Number.isNaN(Date.parse(value)), "Enter a valid date and time."),
});

export const saleUpdateSchema = z.object({
  listed: z.boolean(),
  askingPrice: z.coerce
    .number()
    .min(0, "Enter a price of zero or more.")
    .max(1_000_000_000)
    .nullable()
    .default(null),
  currency: z
    .string()
    .trim()
    .length(3, "Use a three letter currency code, for example NGN.")
    .toUpperCase()
    .default("NGN"),
  note: z.string().trim().max(1000).default(""),
});

export interface PreparedStatusUpdate {
  prepared: PreparedChainAction;
  product: ProductSummary;
}

interface ProductLike {
  productId: string;
  status: string;
  chainState: string;
  ownerWallet: string;
  registeredByWallet: string;
  registrantRole: string;
  cropType: string;
  quantity: number;
  unit: string;
  harvestDate: Date;
  farmLocation: string;
  description: string;
  additionalNotes: string;
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

async function loadOwnedProduct(
  productId: string,
  walletAddress: string,
  action: string
): Promise<{ product: InstanceType<typeof ProductMetadataModel>; productId: string }> {
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
  if (product.ownerWallet !== walletAddress) {
    throw new AppError(ERROR_CODES.FORBIDDEN, {
      message: `Only the wallet that currently holds this batch can ${action} it.`,
      details: { productId },
    });
  }
  return { product, productId };
}

/**
 * Stage one of a manual status change. Ownership is checked against the
 * database here and enforced again by the program, so a stale record cannot let
 * a non-owner through.
 */
export async function prepareStatusUpdate(input: {
  productId: string;
  actorWallet: string;
  actorRole: string;
  status: z.infer<typeof statusUpdateSchema>["status"];
  occurredAt: string;
}): Promise<PreparedStatusUpdate> {
  const productId = assertProductId(input.productId);
  const chain = getChainClient();
  const { product } = await loadOwnedProduct(productId, input.actorWallet, "change the stage of");

  const current = product.status as ProductStatus;
  if (isFlagged(current)) {
    throw new AppError(ERROR_CODES.PRODUCT_STATE_INVALID, {
      message: "A regulator has withheld this batch, so its stage cannot be changed.",
    });
  }
  if (isTerminal(current)) {
    throw new AppError(ERROR_CODES.PRODUCT_STATE_INVALID, {
      message: "This batch has already been sold, so its stage cannot be changed.",
    });
  }
  if (current === input.status) {
    throw new AppError(ERROR_CODES.PRODUCT_STATE_INVALID, {
      message: `This batch is already recorded as ${input.status.replace(/_/g, " ").toLowerCase()}.`,
    });
  }

  const instruction = buildUpdateStatus(
    chain.programId,
    toPublicKey(input.actorWallet, "walletAddress"),
    productId,
    input.status,
    Math.floor(new Date(input.occurredAt).getTime() / 1000)
  );
  const prepared = await prepareAction({
    instructions: [instruction],
    feePayer: input.actorWallet,
    description: `Move batch ${productId} to ${input.status.replace(/_/g, " ").toLowerCase()}`,
    targetAddress: getProductAddress(chain.programId, productId).toBase58(),
  });
  return {
    prepared,
    product: toProductSummary(product.toObject() as unknown as ProductLike),
  };
}

export async function submitStatusUpdate(input: {
  productId: string;
  signedTransaction: string;
  actorWallet: string;
  actorRole: string;
}): Promise<ProductSummary> {
  const productId = assertProductId(input.productId);
  const chain = getChainClient();
  const { product } = await loadOwnedProduct(productId, input.actorWallet, "change the stage of");

  const confirmed = await submitAction({
    signedTransaction: input.signedTransaction,
    expectedSigner: input.actorWallet,
    description: `Update batch ${productId} status`,
    targetAddress: getProductAddress(chain.programId, productId).toBase58(),
    productId,
  });

  const onChain = await chain.fetchProduct(productId);
  if (onChain === null) {
    throw new AppError(ERROR_CODES.BLOCKCHAIN_ACCOUNT_NOT_FOUND, {
      message:
        "The transaction confirmed but the on-chain batch record cannot be read. An administrator has been notified.",
      details: { productId, signature: confirmed.signature },
    });
  }

  try {
    const previous = product.status;
    product.status = onChain.status;
    await product.save();
    if (onChain.status === "FLAGGED" && previous !== "FLAGGED") {
      await NotificationModel.create({
        notificationId: newId(),
        recipientWallet: product.ownerWallet,
        kind: "PRODUCT_FLAGGED",
        title: `Batch ${productId} was flagged by a regulator`,
        body: "A regulator has withheld this batch pending review. It cannot progress until it is released.",
        productId,
        linkPath: `/app/products/${productId}`,
      });
    }
  } catch (error) {
    await ProductMetadataModel.updateOne(
      { productId },
      { $set: { status: onChain.status, chainState: "NEEDS_RECONCILIATION" } }
    ).catch(() => undefined);
    await recordReconciliationFailure({
      intent: {
        action: "COMPLETE_STATUS_UPDATE",
        productId,
        transactionSignature: confirmed.signature,
        intent: { status: onChain.status },
      },
      error,
    });
    throw new AppError(ERROR_CODES.RECONCILIATION_REQUIRED, {
      message:
        "The change was recorded on the blockchain but could not be finalised here. An administrator has been notified.",
      details: { productId, signature: confirmed.signature },
      cause: error,
    });
  }

  log.info({ productId, status: onChain.status, signature: confirmed.signature }, "status update confirmed");
  return toProductSummary(product.toObject() as unknown as ProductLike);
}

/**
 * Retailer listing state. Listing is a business decision recorded off-chain
 * because the source project asks for product listing and traceability, not a
 * marketplace; the `LISTED` stage itself is still anchored on-chain when the
 * retailer moves the batch into that state.
 */
export async function updateSaleState(input: {
  productId: string;
  retailerWallet: string;
  payload: z.infer<typeof saleUpdateSchema>;
}): Promise<ProductSummary> {
  const productId = assertProductId(input.productId);
  const { product } = await loadOwnedProduct(productId, input.retailerWallet, "list for sale");

  const current = product.status as ProductStatus;
  if (isFlagged(current)) {
    throw new AppError(ERROR_CODES.PRODUCT_STATE_INVALID, {
      message: "A regulator has withheld this batch, so it cannot be listed for sale.",
    });
  }
  if (isTerminal(current)) {
    throw new AppError(ERROR_CODES.PRODUCT_STATE_INVALID, {
      message: "This batch has already been sold.",
    });
  }
  if (input.payload.listed && input.payload.askingPrice === null) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
      message: "Enter an asking price before listing this batch for sale.",
      details: [{ path: "askingPrice", message: "A price is required to list a batch." }],
    });
  }

  product.retail = {
    ...product.retail,
    listed: input.payload.listed,
    listedAt: input.payload.listed ? new Date() : null,
    askingPrice: input.payload.listed ? input.payload.askingPrice : null,
    currency: input.payload.currency,
    note: input.payload.note,
    soldAt: null,
  };
  await product.save();
  log.info({ productId, listed: input.payload.listed }, "updated retail listing state");
  return toProductSummary(product.toObject() as unknown as ProductLike);
}
