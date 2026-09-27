import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/**
 * Transfer states. A transfer is recorded as `PREPARED` before the participant
 * signs, and only becomes `COMPLETED` after the cluster confirms and the
 * on-chain owner has been re-read.
 */
export const TRANSFER_STATUSES = [
  "PREPARED",
  "SUBMITTED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "NEEDS_RECONCILIATION",
] as const;

export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

const transferSchema = new Schema(
  {
    transferId: { type: String, required: true, unique: true, immutable: true },
    /** 16 byte correlation identifier, hex, matching the on-chain event. */
    onChainTransferRef: { type: String, required: true, immutable: true },
    productId: { type: String, required: true, index: true },
    fromWallet: { type: String, required: true },
    toWallet: { type: String, required: true },
    toRole: { type: String, required: true },
    fromRole: { type: String, required: true },
    status: {
      type: String,
      enum: TRANSFER_STATUSES as unknown as string[],
      required: true,
      default: "PREPARED",
    },
    transactionSignature: { type: String, default: null },
    /** Product status before and after the transfer, for the timeline. */
    previousStatus: { type: String, required: true },
    resultingStatus: { type: String, default: null },
    note: { type: String, default: "", maxlength: 1000 },
    failureReason: { type: String, default: null },
    createdAt: { type: Date, required: true, default: () => new Date() },
    submittedAt: { type: Date, default: null },
    confirmedAt: { type: Date, default: null },
    /** Whether the recipient has acknowledged receipt in the application. */
    acknowledgedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: "transfers" }
);

transferSchema.index({ fromWallet: 1, status: 1, createdAt: -1 });
transferSchema.index({ toWallet: 1, status: 1, createdAt: -1 });
transferSchema.index({ status: 1, createdAt: -1 });
transferSchema.index({ transactionSignature: 1 });

export type TransferDocument = InferSchemaType<typeof transferSchema> & { _id: unknown };

export const TransferModel: Model<TransferDocument> =
  (models.Transfer as Model<TransferDocument>) ??
  model<TransferDocument>("Transfer", transferSchema);
