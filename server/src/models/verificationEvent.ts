import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

export const VERIFICATION_RESULTS = [
  "VERIFIED",
  "MISMATCH",
  "NOT_FOUND",
  "INCOMPLETE",
] as const;

export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

/**
 * One verification attempt. Every public lookup writes a record here, which is
 * what lets a regulator see who checked a batch, when, and what the outcome
 * was — including attempts that found a mismatch.
 */
const verificationEventSchema = new Schema(
  {
    verificationId: { type: String, required: true, unique: true, immutable: true },
    productId: { type: String, required: true, index: true },
    requestedByWallet: { type: String, default: null },
    /** `PUBLIC` when no wallet was connected, otherwise the wallet address. */
    requester: { type: String, required: true },
    requesterRole: { type: String, default: "PUBLIC" },
    requestChannel: {
      type: String,
      enum: ["SEARCH", "DIRECT_URL", "QR_SCAN", "DASHBOARD", "REGULATOR_REVIEW"],
      required: true,
      default: "SEARCH",
    },
    verificationResult: {
      type: String,
      enum: VERIFICATION_RESULTS as unknown as string[],
      required: true,
    },
    /** Hash recomputed from the stored off-chain record. */
    calculatedHash: { type: String, default: null },
    /** Hash read from the on-chain product account. */
    onChainHash: { type: String, default: null },
    /** Hash recorded when the batch was registered off-chain. */
    storedHash: { type: String, default: null },
    mismatchDetails: {
      type: Schema.Types.Mixed,
      default: null,
    },
    onChainTxHash: { type: String, default: null },
    /** On-chain attestation written by a regulator, when one exists. */
    attestationTxHash: { type: String, default: null },
    chainReachable: { type: Boolean, required: true, default: true },
    recordPresent: { type: Boolean, required: true, default: false },
    durationMs: { type: Number, required: true, default: 0, min: 0 },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true, versionKey: false, collection: "verificationEvents" }
);

verificationEventSchema.index({ productId: 1, createdAt: -1 });
verificationEventSchema.index({ verificationResult: 1, createdAt: -1 });
verificationEventSchema.index({ requester: 1, createdAt: -1 });
verificationEventSchema.index({ createdAt: -1 });
verificationEventSchema.index({ verificationResult: 1, productId: 1 });

export type VerificationEventDocument = InferSchemaType<typeof verificationEventSchema> & {
  _id: unknown;
};

export const VerificationEventModel: Model<VerificationEventDocument> =
  (models.VerificationEvent as Model<VerificationEventDocument>) ??
  model<VerificationEventDocument>("VerificationEvent", verificationEventSchema);
