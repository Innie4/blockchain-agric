import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";
import { PRODUCT_STATUSES } from "../lib/statusMachine.js";

/**
 * How far the blockchain side of a product record has progressed. The client
 * renders a distinct state for each of these, and `NEEDS_RECONCILIATION` is
 * never presented as success.
 */
export const CHAIN_STATES = [
  /** Nothing has been prepared yet. */
  "NOT_STARTED",
  /** An unsigned transaction has been built and is awaiting a wallet signature. */
  "AWAITING_SIGNATURE",
  /** Wallet-signed bytes have been submitted to the cluster. */
  "SUBMITTED",
  /** The cluster has confirmed and the off-chain record is final. */
  "CONFIRMED",
  /** The participant declined or the transaction failed; retry is possible. */
  "FAILED",
  /** The participant abandoned the prepared transaction. */
  "CANCELLED",
  /** The chain succeeded but the database write did not. */
  "NEEDS_RECONCILIATION",
] as const;

export type ChainState = (typeof CHAIN_STATES)[number];

const mediaReferenceSchema = new Schema(
  {
    mediaId: { type: String, required: true },
    fileName: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    /** SHA-256 of the stored bytes, used for integrity checks. */
    contentHash: { type: String, required: true },
    kind: { type: String, enum: ["IMAGE", "DOCUMENT"], required: true },
    caption: { type: String, trim: true, maxlength: 300, default: "" },
    uploadedAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false }
);

const productMetadataSchema = new Schema(
  {
    productId: { type: String, required: true, unique: true, immutable: true },
    ownerWallet: { type: String, required: true },
    registeredByWallet: { type: String, required: true },
    registrantRole: { type: String, required: true },

    cropType: { type: String, required: true, trim: true, maxlength: 120 },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, required: true, trim: true, lowercase: true, maxlength: 32 },
    harvestDate: { type: Date, required: true },
    farmLocation: { type: String, required: true, trim: true, maxlength: 400 },
    description: { type: String, required: true, maxlength: 4000 },
    additionalNotes: { type: String, default: "", maxlength: 4000 },

    images: { type: [mediaReferenceSchema], default: [] },
    certificates: { type: [mediaReferenceSchema], default: [] },

    /**
     * The exact media digests mixed into `dataHash` when the batch was
     * registered. Verification must recompute the anchored hash from this list
     * and not from the live arrays, because certificates are legitimately added
     * long after registration and must not retroactively invalidate the anchor.
     */
    anchoredImageHashes: { type: [String], default: [] },
    anchoredCertificateHashes: { type: [String], default: [] },

    /** SHA-256 of the canonical off-chain registration payload. */
    dataHash: { type: String, required: true },
    /**
     * The exact instant mixed into the canonical payload when `dataHash` was
     * computed. Verification must reuse this value rather than `createdAt`,
     * which is stamped a moment later and would never reproduce the digest.
     */
    registrationHashTimestamp: { type: Date, required: true },
    /** The same digest, hex, as stored in the on-chain product account. */
    onChainDataHash: { type: String, default: null },
    onChainTxHash: { type: String, default: null },
    /** Deterministic program-derived address, recomputed rather than trusted. */
    onChainAddress: { type: String, default: null },
    onChainRegisteredAt: { type: Date, default: null },
    onChainTransferCount: { type: Number, default: 0, min: 0 },

    status: {
      type: String,
      enum: PRODUCT_STATUSES as unknown as string[],
      required: true,
      default: "REGISTERED",
    },
    /** Status held before a regulator flagged the batch. */
    preFlagStatus: {
      type: String,
      enum: PRODUCT_STATUSES as unknown as string[],
      default: "REGISTERED",
    },
    chainState: {
      type: String,
      enum: CHAIN_STATES as unknown as string[],
      required: true,
      default: "NOT_STARTED",
    },
    chainError: { type: String, default: null },
    /** Signature of the transaction currently being prepared, if any. */
    pendingSignature: { type: String, default: null },
    preparedAt: { type: Date, default: null },

    retail: {
      listed: { type: Boolean, default: false },
      listedAt: { type: Date, default: null },
      askingPrice: { type: Number, default: null, min: 0 },
      currency: { type: String, default: "NGN", maxlength: 8 },
      soldAt: { type: Date, default: null },
      note: { type: String, default: "", maxlength: 1000 },
    },

    /** Latest outcome of a public verification against the anchored hash. */
    lastVerificationResult: {
      type: String,
      enum: ["VERIFIED", "MISMATCH", "NOT_FOUND", "INCOMPLETE", "PENDING"],
      default: "PENDING",
    },
    lastVerifiedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: "products" }
);

productMetadataSchema.index({ ownerWallet: 1, status: 1 });
productMetadataSchema.index({ status: 1, createdAt: -1 });
productMetadataSchema.index({ dataHash: 1 });
productMetadataSchema.index({ onChainTxHash: 1 });
productMetadataSchema.index({ cropType: 1, harvestDate: -1 });
productMetadataSchema.index({ chainState: 1, updatedAt: -1 });
productMetadataSchema.index({ lastVerificationResult: 1, updatedAt: -1 });
productMetadataSchema.index({ productId: "text", cropType: "text", farmLocation: "text" });

export type ProductMetadataDocument = InferSchemaType<typeof productMetadataSchema> & {
  _id: unknown;
};

export const ProductMetadataModel: Model<ProductMetadataDocument> =
  (models.ProductMetadata as Model<ProductMetadataDocument>) ??
  model<ProductMetadataDocument>("ProductMetadata", productMetadataSchema);
