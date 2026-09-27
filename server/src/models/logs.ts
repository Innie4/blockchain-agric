import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

const supportingFileSchema = new Schema(
  {
    mediaId: { type: String, required: true },
    fileName: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    contentHash: { type: String, required: true },
  },
  { _id: false }
);

/**
 * A supporting certificate attached to a batch. The document lives in GridFS
 * and its SHA-256 is recorded here so substitution is detectable even though
 * the file itself is off-chain.
 */
const certificateSchema = new Schema(
  {
    certificateId: { type: String, required: true, unique: true, immutable: true },
    productId: { type: String, required: true },
    issuingBody: { type: String, required: true, trim: true, maxlength: 200 },
    certificateType: { type: String, required: true, trim: true, maxlength: 120 },
    referenceNumber: { type: String, trim: true, maxlength: 120, default: "" },
    issuedOn: { type: Date, default: null },
    expiresOn: { type: Date, default: null },
    document: { type: supportingFileSchema, required: true },
    /** SHA-256 of the stored document bytes. */
    dataHash: { type: String, required: true },
    uploadedByWallet: { type: String, required: true },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true, versionKey: false, collection: "certificates" }
);

certificateSchema.index({ productId: 1, createdAt: -1 });
certificateSchema.index({ dataHash: 1 });
certificateSchema.index({ issuingBody: 1, issuedOn: -1 });

export type CertificateDocument = InferSchemaType<typeof certificateSchema> & {
  _id: unknown;
};

export const CertificateModel: Model<CertificateDocument> =
  (models.Certificate as Model<CertificateDocument>) ??
  model<CertificateDocument>("Certificate", certificateSchema);

/**
 * A processing event. The lifecycle status change is recorded on-chain; the
 * narrative detail, images and documents stay off-chain and are anchored by
 * their own hashes.
 */
const processingLogSchema = new Schema(
  {
    logId: { type: String, required: true, unique: true, immutable: true },
    productId: { type: String, required: true },
    processorWallet: { type: String, required: true },
    processorName: { type: String, default: "" },
    activity: { type: String, required: true, trim: true, maxlength: 200 },
    activityDescription: { type: String, required: true, maxlength: 4000 },
    /** Real-world time the activity happened, validated against cluster time. */
    occurredAt: { type: Date, required: true },
    statusBefore: { type: String, required: true },
    statusAfter: { type: String, required: true },
    supportingImages: { type: [supportingFileSchema], default: [] },
    supportingDocuments: { type: [supportingFileSchema], default: [] },
    /** SHA-256 over the canonical log payload. */
    dataHash: { type: String, required: true },
    /** Set when a status change accompanied this log. */
    onChainTxHash: { type: String, default: null },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true, versionKey: false, collection: "processingLogs" }
);

processingLogSchema.index({ productId: 1, occurredAt: -1 });
processingLogSchema.index({ processorWallet: 1, createdAt: -1 });
processingLogSchema.index({ dataHash: 1 });
processingLogSchema.index({ statusAfter: 1, occurredAt: -1 });

export type ProcessingLogDocument = InferSchemaType<typeof processingLogSchema> & {
  _id: unknown;
};

export const ProcessingLogModel: Model<ProcessingLogDocument> =
  (models.ProcessingLog as Model<ProcessingLogDocument>) ??
  model<ProcessingLogDocument>("ProcessingLog", processingLogSchema);

/**
 * A transport event. Route and schedule detail is off-chain; the prompt's
 * source project leaves automated sensor capture as future work, so no GPS or
 * telemetry readings are recorded or simulated here.
 */
const transportLogSchema = new Schema(
  {
    logId: { type: String, required: true, unique: true, immutable: true },
    productId: { type: String, required: true },
    transporterWallet: { type: String, required: true },
    transporterName: { type: String, default: "" },
    origin: { type: String, required: true, trim: true, maxlength: 300 },
    destination: { type: String, required: true, trim: true, maxlength: 300 },
    routeDetails: { type: String, default: "", maxlength: 4000 },
    vehicleDescription: { type: String, default: "", maxlength: 300 },
    departedAt: { type: Date, required: true },
    expectedArrivalAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    deliveryStatus: {
      type: String,
      enum: ["SCHEDULED", "IN_TRANSIT", "DELIVERED", "DELAYED", "CANCELLED"],
      required: true,
      default: "IN_TRANSIT",
    },
    supportingDocuments: { type: [supportingFileSchema], default: [] },
    dataHash: { type: String, required: true },
    onChainTxHash: { type: String, default: null },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true, versionKey: false, collection: "transportLogs" }
);

transportLogSchema.index({ productId: 1, departedAt: -1 });
transportLogSchema.index({ transporterWallet: 1, createdAt: -1 });
transportLogSchema.index({ dataHash: 1 });
transportLogSchema.index({ deliveryStatus: 1, departedAt: -1 });

export type TransportLogDocument = InferSchemaType<typeof transportLogSchema> & {
  _id: unknown;
};

export const TransportLogModel: Model<TransportLogDocument> =
  (models.TransportLog as Model<TransportLogDocument>) ??
  model<TransportLogDocument>("TransportLog", transportLogSchema);
