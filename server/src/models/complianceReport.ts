import mongoose, { Schema, model, type InferSchemaType, type Model } from "mongoose";
import { VERIFICATION_RESULTS } from "./verificationEvent.js";
import { PRODUCT_STATUSES } from "../lib/statusMachine.js";

export interface ComplianceFilters {
  dateFrom?: string;
  dateTo?: string;
  cropTypes?: string[];
  statuses?: string[];
  participants?: string[];
  verificationResults?: string[];
  productIds?: string[];
}

const includedProductSchema = new Schema(
  {
    productId: { type: String, required: true },
    cropType: { type: String, default: "" },
    quantity: { type: Number, default: null },
    unit: { type: String, default: "" },
    status: { type: String, default: "" },
    ownerWallet: { type: String, default: "" },
    registeredByWallet: { type: String, default: "" },
    registeredAt: { type: Date, default: null },
    lastVerificationResult: { type: String, default: null },
    verificationCount: { type: Number, default: 0 },
    mismatchCount: { type: Number, default: 0 },
    transferCount: { type: Number, default: 0 },
    onChainTxHash: { type: String, default: null },
    dataHash: { type: String, default: null },
  },
  { _id: false }
);

const anomalySchema = new Schema(
  {
    productId: { type: String, required: true },
    kind: {
      type: String,
      enum: ["HASH_MISMATCH", "CHAIN_STATE_PENDING", "RECONCILIATION_REQUIRED", "UNREGISTERED_OWNER"],
      required: true,
    },
    detail: { type: String, required: true },
    detectedAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false }
);

const complianceReportSchema = new Schema(
  {
    reportId: { type: String, required: true, unique: true, immutable: true },
    title: { type: String, required: true, maxlength: 200 },
    generatedBy: { type: String, required: true },
    generatedByName: { type: String, default: "" },
    filters: { type: Schema.Types.Mixed, required: true },
    includedProducts: { type: [includedProductSchema], default: [] },
    summary: {
      productCount: { type: Number, default: 0 },
      verifiedCount: { type: Number, default: 0 },
      mismatchCount: { type: Number, default: 0 },
      notFoundCount: { type: Number, default: 0 },
      incompleteCount: { type: Number, default: 0 },
      byStatus: { type: Map, of: Number, default: {} },
      byCropType: { type: Map, of: Number, default: {} },
      transferCount: { type: Number, default: 0 },
      anomalyCount: { type: Number, default: 0 },
    },
    anomalies: { type: [anomalySchema], default: [] },
    generatedAt: { type: Date, required: true, default: () => new Date() },
    exportMetadata: {
      formats: { type: [String], default: [] },
      lastExportedAt: { type: Date, default: null },
      lastExportedFormat: { type: String, default: null },
      downloadCount: { type: Number, default: 0 },
    },
  },
  { timestamps: true, versionKey: false, collection: "complianceReports" }
);

complianceReportSchema.index({ generatedBy: 1, generatedAt: -1 });
complianceReportSchema.index({ generatedAt: -1 });
complianceReportSchema.index({ "includedProducts.productId": 1 });

export type ComplianceReportDocument = InferSchemaType<typeof complianceReportSchema> & {
  _id: unknown;
};

export const ComplianceReportModel: Model<ComplianceReportDocument> =
  (mongoose.models.ComplianceReport as Model<ComplianceReportDocument>) ??
  model<ComplianceReportDocument>("ComplianceReport", complianceReportSchema);

export { VERIFICATION_RESULTS, PRODUCT_STATUSES };
