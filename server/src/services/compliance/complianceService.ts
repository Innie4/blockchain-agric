import PDFDocument from "pdfkit";
import { z } from "zod";
import { AppError, ERROR_CODES } from "../../lib/errors.js";
import { newId } from "../../lib/crypto.js";
import { childLogger } from "../../lib/logger.js";
import { PRODUCT_STATUSES, statusLabel } from "../../lib/statusMachine.js";
import { VERIFICATION_RESULTS } from "../../models/verificationEvent.js";
import {
  ComplianceReportModel,
  ProductMetadataModel,
  ReconciliationTaskModel,
  TransferModel,
  UserModel,
  VerificationEventModel,
  type ComplianceFilters,
} from "../../models/index.js";

const log = childLogger({ layer: "compliance" });

export const reportRequestSchema = z.object({
  title: z.string().trim().min(3, "Give the report a title.").max(200),
  dateFrom: z
    .string()
    .trim()
    .refine((value) => value.length === 0 || !Number.isNaN(Date.parse(value)), "Enter a valid start date.")
    .optional()
    .or(z.literal("")),
  dateTo: z
    .string()
    .trim()
    .refine((value) => value.length === 0 || !Number.isNaN(Date.parse(value)), "Enter a valid end date.")
    .optional()
    .or(z.literal("")),
  cropTypes: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  statuses: z.array(z.enum(PRODUCT_STATUSES as unknown as [string, ...string[]])).max(20).default([]),
  participants: z.array(z.string().trim().min(32).max(44)).max(200).default([]),
  verificationResults: z
    .array(z.enum(VERIFICATION_RESULTS as unknown as [string, ...string[]]))
    .max(10)
    .default([]),
  productIds: z.array(z.string().trim().min(1).max(32)).max(500).default([]),
});

export type ReportRequest = z.infer<typeof reportRequestSchema>;

export interface ComplianceOverview {
  metrics: Array<{ label: string; value: string; hint?: string; tone?: "neutral" | "warning" | "danger" | "success" }>;
  statusCounts: Array<{ status: string; label: string; count: number }>;
  cropTypeCounts: Array<{ cropType: string; count: number }>;
  recentVerifications: Array<{
    verificationId: string;
    productId: string;
    result: string;
    requester: string;
    requesterRole: string;
    requestChannel: string;
    createdAt: string;
  }>;
  anomalies: Array<{
    taskId: string;
    kind: string;
    productId: string;
    detail: string;
    transactionSignature: string;
    createdAt: string;
  }>;
  transferActivity: Array<{ productId: string; count: number; lastTransferAt: string | null }>;
}

/** Everything the regulator dashboard shows, computed from stored records. */
export async function buildOverview(): Promise<ComplianceOverview> {
  const [
    totalProducts,
    confirmedProducts,
    mismatchProducts,
    pendingProducts,
    flaggedProducts,
    statusRows,
    cropRows,
    recentVerifications,
    reconciliationTasks,
    transferRows,
  ] = await Promise.all([
    ProductMetadataModel.countDocuments({ chainState: "CONFIRMED" }),
    ProductMetadataModel.countDocuments({ chainState: "CONFIRMED" }),
    ProductMetadataModel.countDocuments({ lastVerificationResult: "MISMATCH" }),
    ProductMetadataModel.countDocuments({
      chainState: { $in: ["AWAITING_SIGNATURE", "SUBMITTED", "NOT_STARTED"] },
    }),
    ProductMetadataModel.countDocuments({ status: "FLAGGED" }),
    ProductMetadataModel.aggregate<{ _id: string; count: number }>([
      { $match: { chainState: "CONFIRMED" } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    ProductMetadataModel.aggregate<{ _id: string; count: number }>([
      { $match: { chainState: "CONFIRMED" } },
      { $group: { _id: "$cropType", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 12 },
    ]),
    VerificationEventModel.find({})
      .sort({ createdAt: -1 })
      .limit(15)
      .lean(),
    ReconciliationTaskModel.find({ status: "PENDING" })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),
    TransferModel.aggregate<{ _id: string; count: number; last: Date }>([
      { $match: { status: "COMPLETED" } },
      { $group: { _id: "$productId", count: { $sum: 1 }, last: { $max: "$confirmedAt" } } },
      { $sort: { last: -1 } },
      { $limit: 10 },
    ]),
  ]);

  const statusCounts = PRODUCT_STATUSES.map((status) => ({
    status,
    label: statusLabel(status),
    count: statusRows.find((row) => row._id === status)?.count ?? 0,
  })).filter((row) => row.count > 0 || row.status !== "SOLD");

  const mismatches = mismatchProducts;

  return {
    metrics: [
      {
        label: "Registered batches",
        value: String(confirmedProducts),
        hint: "Confirmed on the blockchain",
      },
      {
        label: "Verification mismatches",
        value: String(mismatches),
        tone: mismatches > 0 ? "danger" : "success",
        hint: mismatches > 0 ? "Needs review" : "No record has been altered",
      },
      {
        label: "Awaiting registration",
        value: String(pendingProducts),
        tone: pendingProducts > 0 ? "warning" : "neutral",
        hint: "Prepared or submitted but not confirmed",
      },
      {
        label: "Withheld batches",
        value: String(flaggedProducts),
        tone: flaggedProducts > 0 ? "warning" : "neutral",
        hint: "Flagged by a regulator",
      },
      {
        label: "Unfinished chain writes",
        value: String(reconciliationTasks.length),
        tone: reconciliationTasks.length > 0 ? "danger" : "success",
        hint: "Confirmed on-chain but not written here",
      },
      {
        label: "All batches tracked",
        value: String(totalProducts),
        hint: "Including those still being registered",
      },
    ],
    statusCounts,
    cropTypeCounts: cropRows.map((row) => ({ cropType: row._id, count: row.count })),
    recentVerifications: recentVerifications.map((entry) => ({
      verificationId: entry.verificationId,
      productId: entry.productId,
      result: entry.verificationResult,
      requester: entry.requester,
      requesterRole: entry.requesterRole,
      requestChannel: entry.requestChannel,
      createdAt: entry.createdAt.toISOString(),
    })),
    anomalies: reconciliationTasks.map((task) => ({
      taskId: task.taskId,
      kind: task.action,
      productId: task.productId,
      detail:
        task.lastError ??
        "A confirmed blockchain transaction could not be written to the database.",
      transactionSignature: task.transactionSignature,
      createdAt: task.createdAt.toISOString(),
    })),
    transferActivity: transferRows.map((row) => ({
      productId: row._id,
      count: row.count,
      lastTransferAt: row.last === undefined || row.last === null ? null : row.last.toISOString(),
    })),
  };
}

interface ReportProductRow {
  productId: string;
  cropType: string;
  quantity: number;
  unit: string;
  status: string;
  ownerWallet: string;
  registeredByWallet: string;
  registeredAt?: Date | null;
  lastVerificationResult: string;
  verificationCount: number;
  mismatchCount: number;
  transferCount: number;
  onChainTxHash?: string | null;
  dataHash: string;
  chainState: string;
}

export interface ComplianceReportView {
  reportId: string;
  title: string;
  generatedBy: string;
  generatedByName: string;
  filters: ComplianceFilters;
  generatedAt: string;
  summary: {
    productCount: number;
    verifiedCount: number;
    mismatchCount: number;
    notFoundCount: number;
    incompleteCount: number;
    byStatus: Record<string, number>;
    byCropType: Record<string, number>;
    transferCount: number;
    anomalyCount: number;
  };
  anomalies: Array<{
    productId: string;
    kind: string;
    detail: string;
    detectedAt: string;
  }>;
  includedProducts: Array<{
    productId: string;
    cropType: string;
    quantity: number;
    unit: string;
    status: string;
    statusLabel: string;
    ownerWallet: string;
    registeredByWallet: string;
    registeredAt: string | null;
    lastVerificationResult: string;
    verificationCount: number;
    mismatchCount: number;
    transferCount: number;
    onChainTxHash: string | null;
    dataHash: string;
  }>;
  exportMetadata: {
    formats: string[];
    lastExportedAt: string | null;
    lastExportedFormat: string | null;
    downloadCount: number;
  };
}

function toQuery(filters: ComplianceFilters, chainState: string[]): Record<string, unknown> {
  const query: Record<string, unknown> = { chainState: { $in: chainState } };
  const createdAt: Record<string, Date> = {};
  if (filters.dateFrom !== undefined && filters.dateFrom.length > 0) {
    createdAt["$gte"] = new Date(filters.dateFrom);
  }
  if (filters.dateTo !== undefined && filters.dateTo.length > 0) {
    createdAt["$lte"] = new Date(filters.dateTo);
  }
  if (Object.keys(createdAt).length > 0) query["createdAt"] = createdAt;
  if (filters.cropTypes !== undefined && filters.cropTypes.length > 0) {
    query["cropType"] = { $in: filters.cropTypes };
  }
  if (filters.statuses !== undefined && filters.statuses.length > 0) {
    query["status"] = { $in: filters.statuses };
  }
  if (filters.participants !== undefined && filters.participants.length > 0) {
    query["$or"] = [
      { ownerWallet: { $in: filters.participants } },
      { registeredByWallet: { $in: filters.participants } },
    ];
  }
  if (
    filters.verificationResults !== undefined &&
    filters.verificationResults.length > 0
  ) {
    query["lastVerificationResult"] = { $in: filters.verificationResults };
  }
  if (filters.productIds !== undefined && filters.productIds.length > 0) {
    query["productId"] = { $in: filters.productIds };
  }
  return query;
}

/** Builds a report from real records, including anything anomalous. */
export async function generateReport(input: {
  title: string;
  generatedBy: string;
  generatedByName: string;
  request: ReportRequest;
}): Promise<ComplianceReportView> {
  const filters: ComplianceFilters = {
    dateFrom: input.request.dateFrom,
    dateTo: input.request.dateTo,
    cropTypes: input.request.cropTypes,
    statuses: input.request.statuses,
    participants: input.request.participants,
    verificationResults: input.request.verificationResults,
    productIds: input.request.productIds,
  };

  const products = await ProductMetadataModel.find(
    toQuery(filters, ["CONFIRMED", "NEEDS_RECONCILIATION"])
  )
    .sort({ createdAt: -1 })
    .limit(2_000)
    .lean();

  const productIds = products.map((product) => product.productId);
  const [verificationRows, transferRows] = await Promise.all([
    productIds.length === 0
      ? Promise.resolve([])
      : VerificationEventModel.aggregate<{ _id: string; total: number; mismatches: number }>([
          { $match: { productId: { $in: productIds } } },
          {
            $group: {
              _id: "$productId",
              total: { $sum: 1 },
              mismatches: {
                $sum: { $cond: [{ $eq: ["$verificationResult", "MISMATCH"] }, 1, 0] },
              },
            },
          },
        ]),
    productIds.length === 0
      ? Promise.resolve([])
      : TransferModel.aggregate<{ _id: string; count: number }>([
          { $match: { productId: { $in: productIds }, status: "COMPLETED" } },
          { $group: { _id: "$productId", count: { $sum: 1 } } },
        ]),
  ]);
  const verificationByProduct = new Map(verificationRows.map((row) => [row._id, row]));
  const transferByProduct = new Map(transferRows.map((row) => [row._id, row.count]));

  const rows: ReportProductRow[] = products.map((product) => ({
    productId: product.productId,
    cropType: product.cropType,
    quantity: product.quantity,
    unit: product.unit,
    status: product.status,
    ownerWallet: product.ownerWallet,
    registeredByWallet: product.registeredByWallet,
    registeredAt: product.onChainRegisteredAt ?? null,
    lastVerificationResult: product.lastVerificationResult,
    verificationCount: verificationByProduct.get(product.productId)?.total ?? 0,
    mismatchCount: verificationByProduct.get(product.productId)?.mismatches ?? 0,
    transferCount: transferByProduct.get(product.productId) ?? 0,
    onChainTxHash: product.onChainTxHash ?? null,
    dataHash: product.dataHash,
    chainState: product.chainState,
  }));

  const byStatus: Record<string, number> = {};
  const byCropType: Record<string, number> = {};
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    byCropType[row.cropType] = (byCropType[row.cropType] ?? 0) + 1;
  }

  const anomalies: ComplianceReportView["anomalies"] = [];
  for (const row of rows) {
    if (row.mismatchCount > 0) {
      anomalies.push({
        productId: row.productId,
        kind: "HASH_MISMATCH",
        detail: `${row.mismatchCount} verification${row.mismatchCount === 1 ? "" : "s"} found that the stored details did not match the blockchain record.`,
        detectedAt: new Date().toISOString(),
      });
    }
    if (row.chainState === "NEEDS_RECONCILIATION") {
      anomalies.push({
        productId: row.productId,
        kind: "RECONCILIATION_REQUIRED",
        detail:
          "A blockchain transaction for this batch was confirmed but could not be written to the database.",
        detectedAt: new Date().toISOString(),
      });
    }
  }

  const summary = {
    productCount: rows.length,
    verifiedCount: rows.filter((row) => row.lastVerificationResult === "VERIFIED").length,
    mismatchCount: rows.filter((row) => row.lastVerificationResult === "MISMATCH").length,
    notFoundCount: rows.filter((row) => row.lastVerificationResult === "NOT_FOUND").length,
    incompleteCount: rows.filter((row) => row.lastVerificationResult === "INCOMPLETE").length,
    byStatus,
    byCropType,
    transferCount: rows.reduce((total, row) => total + row.transferCount, 0),
    anomalyCount: anomalies.length,
  };

  const reportId = newId();
  const created = await ComplianceReportModel.create({
    reportId,
    title: input.title,
    generatedBy: input.generatedBy,
    generatedByName: input.generatedByName,
    filters,
    includedProducts: rows.map((row) => ({
      productId: row.productId,
      cropType: row.cropType,
      quantity: row.quantity,
      unit: row.unit,
      status: row.status,
      ownerWallet: row.ownerWallet,
      registeredByWallet: row.registeredByWallet,
      registeredAt: row.registeredAt,
      lastVerificationResult: row.lastVerificationResult,
      verificationCount: row.verificationCount,
      mismatchCount: row.mismatchCount,
      transferCount: row.transferCount,
      onChainTxHash: row.onChainTxHash,
      dataHash: row.dataHash,
    })),
    summary,
    anomalies,
    generatedAt: new Date(),
    exportMetadata: { formats: [], lastExportedAt: null, lastExportedFormat: null, downloadCount: 0 },
  });

  log.info(
    { reportId, productCount: summary.productCount, anomalyCount: summary.anomalyCount },
    "generated compliance report"
  );
  return toView(created.toObject());
}

export async function listReports(input: {
  page: number;
  pageSize: number;
  generatedBy?: string | undefined;
}): Promise<{ reports: ComplianceReportView[]; total: number }> {
  const filter = input.generatedBy === undefined ? {} : { generatedBy: input.generatedBy };
  const [reports, total] = await Promise.all([
    ComplianceReportModel.find(filter)
      .sort({ generatedAt: -1 })
      .skip((input.page - 1) * input.pageSize)
      .limit(input.pageSize)
      .lean(),
    ComplianceReportModel.countDocuments(filter),
  ]);
  return { reports: reports.map((report) => toView(report)), total };
}

export async function readReport(reportId: string): Promise<ComplianceReportView> {
  const report = await ComplianceReportModel.findOne({ reportId }).lean();
  if (report === null) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      message: "No compliance report exists with that identifier.",
    });
  }
  return toView(report);
}

/** Records that a report was exported, so usage is visible to a regulator. */
export async function recordExport(reportId: string, format: string): Promise<void> {
  const report = await ComplianceReportModel.findOne({ reportId });
  if (report === null) return;
  const metadata = report.exportMetadata ?? {
    formats: [] as string[],
    lastExportedAt: null as Date | null,
    lastExportedFormat: null as string | null,
    downloadCount: 0,
  };
  metadata.lastExportedAt = new Date();
  metadata.lastExportedFormat = format;
  metadata.downloadCount += 1;
  if (!metadata.formats.includes(format)) {
    metadata.formats.push(format);
  }
  report.set("exportMetadata", metadata);
  await report.save();
}

export function csvFor(report: ComplianceReportView): string {
  const header = [
    "productId",
    "cropType",
    "quantity",
    "unit",
    "status",
    "statusLabel",
    "currentOwner",
    "registeredBy",
    "registeredAt",
    "lastVerificationResult",
    "verificationCount",
    "mismatchCount",
    "transferCount",
    "dataHash",
    "onChainTxHash",
  ];
  const lines = [header.join(",")];
  for (const product of report.includedProducts) {
    lines.push(
      [
        product.productId,
        product.cropType,
        String(product.quantity),
        product.unit,
        product.status,
        product.statusLabel,
        product.ownerWallet,
        product.registeredByWallet,
        product.registeredAt ?? "",
        product.lastVerificationResult,
        String(product.verificationCount),
        String(product.mismatchCount),
        String(product.transferCount),
        product.dataHash,
        product.onChainTxHash ?? "",
      ]
        .map(csvCell)
        .join(",")
    );
  }
  if (report.anomalies.length > 0) {
    lines.push("");
    lines.push("anomalies");
    lines.push("productId,kind,detail,detectedAt");
    for (const anomaly of report.anomalies) {
      lines.push(
        [anomaly.productId, anomaly.kind, anomaly.detail, anomaly.detectedAt]
          .map(csvCell)
          .join(",")
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Renders the report as a PDF using a local library, so no third-party service
 * and no credential is involved.
 */
export function pdfFor(report: ComplianceReportView): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: "A4",
      margin: 45,
      info: {
        Title: report.title,
        Author: report.generatedByName.length > 0 ? report.generatedByName : report.generatedBy,
        Subject: "Agricultural supply chain compliance report",
      },
    });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);

    document.font("Helvetica-Bold").fontSize(18).text(report.title);
    document.moveDown(0.3);
    document
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#55594E")
      .text(`Generated ${new Date(report.generatedAt).toISOString()}`)
      .text(
        `Regulator: ${report.generatedByName.length > 0 ? `${report.generatedByName} (${report.generatedBy})` : report.generatedBy}`
      )
      .text(`Report identifier: ${report.reportId}`)
      .moveDown();

    document.font("Helvetica-Bold").fontSize(12).fillColor("#23261F").text("Selected criteria");
    document.moveDown(0.2);
    document.font("Helvetica").fontSize(10).fillColor("#23261F");
    for (const line of describeFilters(report)) {
      document.text(`• ${line}`);
    }
    document.moveDown();

    document.font("Helvetica-Bold").fontSize(12).text("Summary");
    document.moveDown(0.2);
    document.font("Helvetica").fontSize(10);
    document.text(`Batches in report: ${report.summary.productCount}`);
    document.text(`Last check verified: ${report.summary.verifiedCount}`);
    document.text(`Last check found a mismatch: ${report.summary.mismatchCount}`);
    document.text(`Ownership transfers recorded: ${report.summary.transferCount}`);
    document.text(`Anomalies flagged: ${report.summary.anomalyCount}`);
    document.moveDown();

    if (Object.keys(report.summary.byStatus).length > 0) {
      document.font("Helvetica-Bold").fontSize(12).text("Batches by stage");
      document.moveDown(0.2);
      document.font("Helvetica").fontSize(10);
      for (const [status, count] of Object.entries(report.summary.byStatus)) {
        document.text(`${statusLabel(status as never) }: ${count}`);
      }
      document.moveDown();
    }

    if (report.anomalies.length > 0) {
      document.font("Helvetica-Bold").fontSize(12).text("Anomalies");
      document.moveDown(0.2);
      document.font("Helvetica").fontSize(10);
      for (const anomaly of report.anomalies) {
        document
          .fillColor("#9B2C2C")
          .text(`${anomaly.productId} — ${anomaly.kind}`)
          .fillColor("#23261F")
          .text(anomaly.detail, { indent: 12 });
      }
      document.moveDown();
    }

    document
      .font("Helvetica-Bold")
      .fontSize(12)
      .text(`Batches (${report.includedProducts.length})`);
    document.moveDown(0.2);

    if (report.includedProducts.length === 0) {
      document.font("Helvetica").fontSize(10).text("No batches matched the selected criteria.");
    }

    for (const product of report.includedProducts) {
      if (document.y > 720) document.addPage();
      document.font("Helvetica-Bold").fontSize(10).fillColor("#23261F");
      document.text(
        `${product.productId} — ${product.cropType}, ${product.quantity} ${product.unit}`
      );
      document.font("Helvetica").fontSize(9).fillColor("#55594E");
      document.text(
        `Stage: ${product.statusLabel} · Current owner: ${product.ownerWallet} · Last check: ${product.lastVerificationResult}`,
        { indent: 12 }
      );
      document.text(
        `Registration transaction: ${product.onChainTxHash ?? "not recorded"}`,
        { indent: 12 }
      );
      document.text(`Anchored fingerprint: ${product.dataHash}`, { indent: 12 });
      document.moveDown(0.5);
    }

    document.end();
  });
}

function describeFilters(report: ComplianceReportView): string[] {
  const lines: string[] = [];
  const filters = report.filters;
  if (filters.dateFrom !== undefined && filters.dateFrom.length > 0) {
    lines.push(`Registered on or after ${filters.dateFrom}`);
  }
  if (filters.dateTo !== undefined && filters.dateTo.length > 0) {
    lines.push(`Registered on or before ${filters.dateTo}`);
  }
  if (filters.cropTypes !== undefined && filters.cropTypes.length > 0) {
    lines.push(`Crop types: ${filters.cropTypes.join(", ")}`);
  }
  if (filters.statuses !== undefined && filters.statuses.length > 0) {
    lines.push(`Stages: ${filters.statuses.join(", ")}`);
  }
  if (filters.participants !== undefined && filters.participants.length > 0) {
    lines.push(`Participants: ${filters.participants.length} wallet address(es)`);
  }
  if (
    filters.verificationResults !== undefined &&
    filters.verificationResults.length > 0
  ) {
    lines.push(`Verification results: ${filters.verificationResults.join(", ")}`);
  }
  if (filters.productIds !== undefined && filters.productIds.length > 0) {
    lines.push(`Specific batches: ${filters.productIds.length} identifier(s)`);
  }
  if (lines.length === 0) lines.push("No filters applied; every confirmed batch is included.");
  return lines;
}

/** A lean MongoDB document omits unset fields, so absent and null both occur. */
function isoOrNull(value: Date | null | undefined): string | null {
  return value == null ? null : value.toISOString();
}

function toView(report: {
  reportId: string;
  title: string;
  generatedBy: string;
  generatedByName: string;
  filters: ComplianceFilters;
  summary?: {
    productCount: number;
    verifiedCount: number;
    mismatchCount: number;
    notFoundCount: number;
    incompleteCount: number;
    byStatus: Map<string, number> | Record<string, number>;
    byCropType: Map<string, number> | Record<string, number>;
    transferCount: number;
    anomalyCount: number;
  } | null;
  anomalies: Array<{ productId: string; kind: string; detail: string; detectedAt: Date }>;
  includedProducts: Array<{
    productId: string;
    cropType?: string;
    quantity?: number | null;
    unit?: string;
    status: string;
    ownerWallet?: string;
    registeredByWallet?: string;
    registeredAt?: Date | null;
    lastVerificationResult?: string | null;
    verificationCount?: number;
    mismatchCount?: number;
    transferCount?: number;
    onChainTxHash?: string | null;
    dataHash?: string | null;
  }>;
  generatedAt: Date;
  exportMetadata?: {
    formats: string[];
    lastExportedAt?: Date | null;
    lastExportedFormat?: string | null;
    downloadCount: number;
  } | null;
}): ComplianceReportView {
  const toObject = <T>(value: Map<string, T> | Record<string, T>): Record<string, T> =>
    value instanceof Map ? Object.fromEntries(value) : value;
  const summary = report.summary ?? {
    productCount: 0,
    verifiedCount: 0,
    mismatchCount: 0,
    notFoundCount: 0,
    incompleteCount: 0,
    byStatus: {},
    byCropType: {},
    transferCount: 0,
    anomalyCount: 0,
  };
  const exportMetadata = report.exportMetadata ?? {
    formats: [] as string[],
    lastExportedAt: null as Date | null,
    lastExportedFormat: null as string | null,
    downloadCount: 0,
  };
  return {
    reportId: report.reportId,
    title: report.title,
    generatedBy: report.generatedBy,
    generatedByName: report.generatedByName,
    filters: report.filters,
    generatedAt: report.generatedAt.toISOString(),
    summary: {
      productCount: summary.productCount,
      verifiedCount: summary.verifiedCount,
      mismatchCount: summary.mismatchCount,
      notFoundCount: summary.notFoundCount,
      incompleteCount: summary.incompleteCount,
      byStatus: toObject(summary.byStatus),
      byCropType: toObject(summary.byCropType),
      transferCount: summary.transferCount,
      anomalyCount: summary.anomalyCount,
    },
    anomalies: report.anomalies.map((anomaly) => ({
      productId: anomaly.productId,
      kind: anomaly.kind,
      detail: anomaly.detail,
      detectedAt: anomaly.detectedAt.toISOString(),
    })),
    includedProducts: report.includedProducts.map((product) => ({
      productId: product.productId,
      cropType: product.cropType ?? "",
      quantity: product.quantity ?? 0,
      unit: product.unit ?? "",
      status: product.status,
      statusLabel: statusLabel(product.status as never),
      ownerWallet: product.ownerWallet ?? "",
      registeredByWallet: product.registeredByWallet ?? "",
      registeredAt: isoOrNull(product.registeredAt),
      lastVerificationResult: product.lastVerificationResult ?? "PENDING",
      verificationCount: product.verificationCount ?? 0,
      mismatchCount: product.mismatchCount ?? 0,
      transferCount: product.transferCount ?? 0,
      onChainTxHash: product.onChainTxHash ?? null,
      dataHash: product.dataHash ?? "",
    })),
    exportMetadata: {
      formats: exportMetadata.formats,
      lastExportedAt: isoOrNull(exportMetadata.lastExportedAt),
      lastExportedFormat: exportMetadata.lastExportedFormat ?? null,
      downloadCount: exportMetadata.downloadCount,
    },
  };
}

/** Participants a transfer may target, for the recipient picker. */
export async function listTransferCandidates(input: {
  role?: string | undefined;
  search?: string | undefined;
  limit: number;
  excludeWallet: string;
}): Promise<
  Array<{
    walletAddress: string;
    fullName: string;
    role: string;
    organisation: string;
    state: string;
  }>
> {
  const query: Record<string, unknown> = {
    status: "ACTIVE",
    onChainRegistered: true,
    walletAddress: { $ne: input.excludeWallet },
    role: { $in: ["PROCESSOR", "TRANSPORTER", "RETAILER"] },
  };
  if (input.role !== undefined && input.role.length > 0) {
    query["role"] = input.role;
  }
  if (input.search !== undefined && input.search.length > 0) {
    const safe = input.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query["$or"] = [
      { fullName: new RegExp(safe, "i") },
      { organisation: new RegExp(safe, "i") },
      { walletAddress: new RegExp(safe, "i") },
    ];
  }
  const users = await UserModel.find(query)
    .select({ walletAddress: 1, fullName: 1, role: 1, organisation: 1, "contactInfo.state": 1 })
    .sort({ fullName: 1 })
    .limit(input.limit)
    .lean();
  return users.map((user) => ({
    walletAddress: user.walletAddress,
    fullName: user.fullName,
    role: user.role,
    organisation: user.organisation,
    state: (user.contactInfo as { state?: string } | undefined)?.state ?? "",
  }));
}
