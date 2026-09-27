import { statusLabel, type ProductStatus } from "../../lib/statusMachine.js";
import type { ParticipantRoleValue } from "../../lib/roles.js";
import {
  ComplianceReportModel,
  ProductMetadataModel,
  ProcessingLogModel,
  TransferModel,
  TransportLogModel,
  VerificationEventModel,
} from "../../models/index.js";

export interface DashboardMetric {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
}

export interface DashboardSection {
  title: string;
  kind: "table" | "list";
  /** Column headers for a table section; omitted for a list section. */
  columns?: string[];
  items: Array<Record<string, string | number | null>>;
  emptyMessage: string;
  emptyAction?: { label: string; to: string };
}

export interface DashboardQuickAction {
  label: string;
  to: string;
  description: string;
}

export interface DashboardPayload {
  role: ParticipantRoleValue;
  /** Plain-language summary of what this screen is for. */
  introduction: string;
  metrics: DashboardMetric[];
  sections: DashboardSection[];
  quickActions: DashboardQuickAction[];
  /** Set when the wallet has no on-chain participant registration yet. */
  onChainRegistrationRequired: boolean;
}

const short = (wallet: string): string => `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;

/**
 * Builds the dashboard for the signed-in role from stored records only. Every
 * number here is a count of something that exists; nothing is illustrative.
 */
export async function buildDashboard(input: {
  walletAddress: string;
  role: ParticipantRoleValue;
  fullName: string;
  onChainRegistered: boolean;
}): Promise<DashboardPayload> {
  const onChainRegistrationRequired =
    input.role !== "CONSUMER" && !input.onChainRegistered;
  void input.fullName;

  switch (input.role) {
    case "FARMER":
      return farmerDashboard(input, onChainRegistrationRequired);
    case "PROCESSOR":
      return processorDashboard(input, onChainRegistrationRequired);
    case "TRANSPORTER":
      return transporterDashboard(input, onChainRegistrationRequired);
    case "RETAILER":
      return retailerDashboard(input, onChainRegistrationRequired);
    case "REGULATOR":
      return regulatorDashboard(input, onChainRegistrationRequired);
    case "CONSUMER":
    default:
      return consumerDashboard(input);
  }
}

type Context = { walletAddress: string; fullName: string };

async function farmerDashboard(
  input: Context,
  onChainRegistrationRequired: boolean
): Promise<DashboardPayload> {
  const wallet = input.walletAddress;
  const [registered, owned, pendingIn, pendingOut, recent, mismatches] = await Promise.all([
    ProductMetadataModel.countDocuments({ registeredByWallet: wallet }),
    ProductMetadataModel.countDocuments({ ownerWallet: wallet, chainState: "CONFIRMED" }),
    TransferModel.countDocuments({ toWallet: wallet, status: "COMPLETED", acknowledgedAt: null }),
    TransferModel.countDocuments({ fromWallet: wallet, status: "PREPARED" }),
    ProductMetadataModel.find({ registeredByWallet: wallet })
      .sort({ createdAt: -1 })
      .limit(6)
      .lean(),
    VerificationEventModel.countDocuments({
      productId: { $in: (await productIds(wallet, "registeredByWallet")) },
      verificationResult: "MISMATCH",
    }),
  ]);

  return {
    role: "FARMER",
    introduction:
      "Batches you have registered, batches you still hold, and transfers waiting on someone.",
    onChainRegistrationRequired,
    metrics: [
      { label: "Batches registered", value: String(registered), hint: "All time" },
      { label: "Batches you still hold", value: String(owned), hint: "Confirmed on-chain" },
      { label: "Transfers to acknowledge", value: String(pendingIn), tone: pendingIn > 0 ? "info" : "neutral" },
      { label: "Transfers you prepared", value: String(pendingOut), tone: pendingOut > 0 ? "warning" : "neutral" },
      {
        label: "Records found altered",
        value: String(mismatches),
        tone: mismatches > 0 ? "danger" : "success",
        hint: mismatches > 0 ? "Worth reporting" : "None",
      },
    ],
    sections: [
      {
        title: "Recently registered",
        kind: "table",
        columns: ["Batch", "Product", "Quantity", "Stage", "Registered", "Check"],
        items: recent.map((product) => ({
          batch: product.productId,
          product: product.cropType,
          quantity: `${product.quantity} ${product.unit}`,
          stage: statusLabel(product.status as ProductStatus),
          registered: product.createdAt.toISOString().slice(0, 10),
          check:
            product.chainState === "CONFIRMED"
              ? "On the blockchain"
              : "Not yet confirmed",
        })),
        emptyMessage: "You have not registered any batches yet.",
        emptyAction: { label: "Register a batch", to: "/app/products/register" },
      },
    ],
    quickActions: [
      { label: "Register a new batch", to: "/app/products/register", description: "Record a batch you have harvested." },
      { label: "Review incoming transfers", to: "/app/transfers/pending", description: "Confirm batches sent to you." },
      { label: "View all your batches", to: "/app/products", description: "Search and filter your records." },
    ],
  };
}

async function processorDashboard(
  input: Context,
  onChainRegistrationRequired: boolean
): Promise<DashboardPayload> {
  const wallet = input.walletAddress;
  const [received, inProcessing, processed, pending, events, transportEvents] =
    await Promise.all([
      ProductMetadataModel.countDocuments({ ownerWallet: wallet, chainState: "CONFIRMED" }),
      ProductMetadataModel.countDocuments({ ownerWallet: wallet, status: "IN_PROCESSING" }),
      ProductMetadataModel.countDocuments({ ownerWallet: wallet, status: "PROCESSED" }),
      TransferModel.countDocuments({ toWallet: wallet, status: "COMPLETED", acknowledgedAt: null }),
      ProcessingLogModel.find({ processorWallet: wallet })
        .sort({ occurredAt: -1 })
        .limit(6)
        .lean(),
      ProductMetadataModel.countDocuments({ ownerWallet: wallet, status: "IN_TRANSIT" }),
    ]);

  return {
    role: "PROCESSOR",
    introduction:
      "Batches a farmer has sent you, the processing recorded against them, and batches on their way onward.",
    onChainRegistrationRequired,
    metrics: [
      { label: "Batches you hold", value: String(received), hint: "Confirmed on-chain" },
      { label: "In processing", value: String(inProcessing), tone: inProcessing > 0 ? "info" : "neutral" },
      { label: "Processing finished", value: String(processed) },
      { label: "Awaiting your acknowledgement", value: String(pending), tone: pending > 0 ? "info" : "neutral" },
      { label: "Already sent onward", value: String(transportEvents) },
    ],
    sections: [
      {
        title: "Recent processing",
        kind: "table",
        columns: ["Batch", "Activity", "When", "Stage change", "On-chain"],
        items: events.map((entry) => ({
          batch: entry.productId,
          activity: entry.activity,
          when: entry.occurredAt.toISOString().slice(0, 16).replace("T", " "),
          stageChange: `${label(entry.statusBefore)} → ${label(entry.statusAfter)}`,
          chain: entry.onChainTxHash === null ? "Off-chain only" : "On-chain",
        })),
        emptyMessage: "No processing has been recorded yet.",
      },
    ],
    quickActions: [
      { label: "Batches you hold", to: "/app/products?scope=mine", description: "Open a batch to record processing." },
      { label: "Acknowledge incoming batches", to: "/app/transfers/pending", description: "Confirm receipt from farmers." },
    ],
  };
}

async function transporterDashboard(
  input: Context,
  onChainRegistrationRequired: boolean
): Promise<DashboardPayload> {
  const wallet = input.walletAddress;
  const [carrying, pending, events, awaiting] = await Promise.all([
    ProductMetadataModel.countDocuments({ ownerWallet: wallet, status: "IN_TRANSIT" }),
    TransferModel.countDocuments({ toWallet: wallet, status: "COMPLETED", acknowledgedAt: null }),
    TransportLogModel.find({ transporterWallet: wallet })
      .sort({ departedAt: -1 })
      .limit(6)
        .lean(),
    ProductMetadataModel.countDocuments({ ownerWallet: wallet, status: "AT_RETAILER" }),
  ]);

  return {
    role: "TRANSPORTER",
    introduction:
      "Batches currently in your care and the journeys you have recorded for them.",
    onChainRegistrationRequired,
    metrics: [
      { label: "Batches in transit", value: String(carrying), tone: carrying > 0 ? "info" : "neutral" },
      { label: "Awaiting your acknowledgement", value: String(pending), tone: pending > 0 ? "info" : "neutral" },
      { label: "Delivered to a retailer", value: String(awaiting) },
      { label: "Journeys recorded", value: String(events.length) },
    ],
    sections: [
      {
        title: "Recent journeys",
        kind: "table",
        columns: ["Batch", "From", "To", "Departed", "Status", "On-chain"],
        items: events.map((entry) => ({
          batch: entry.productId,
          from: entry.origin,
          to: entry.destination,
          departed: entry.departedAt.toISOString().slice(0, 10),
          status: entry.deliveryStatus.toLowerCase().replace(/_/g, " "),
          chain: entry.onChainTxHash === null ? "Off-chain only" : "On-chain",
        })),
        emptyMessage: "No journeys have been recorded yet.",
      },
    ],
    quickActions: [
      { label: "Batches in your care", to: "/app/products?scope=mine", description: "Record where a batch has gone." },
      { label: "Acknowledge incoming batches", to: "/app/transfers/pending", description: "Confirm what has been sent to you." },
    ],
  };
}

async function retailerDashboard(
  input: Context,
  onChainRegistrationRequired: boolean
): Promise<DashboardPayload> {
  const wallet = input.walletAddress;
  const [received, listed, sold, flagged, batches] = await Promise.all([
    ProductMetadataModel.countDocuments({ ownerWallet: wallet, chainState: "CONFIRMED" }),
    ProductMetadataModel.countDocuments({ ownerWallet: wallet, "retail.listed": true }),
    ProductMetadataModel.countDocuments({ ownerWallet: wallet, status: "SOLD" }),
    ProductMetadataModel.countDocuments({ ownerWallet: wallet, status: "FLAGGED" }),
    ProductMetadataModel.find({ ownerWallet: wallet })
      .sort({ updatedAt: -1 })
      .limit(6)
      .lean(),
  ]);

  return {
    role: "RETAILER",
    introduction:
      "Batches delivered to you, which of them are listed, and how each one last checked out.",
    onChainRegistrationRequired,
    metrics: [
      { label: "Batches you hold", value: String(received) },
      { label: "Listed for sale", value: String(listed), tone: listed > 0 ? "success" : "neutral" },
      { label: "Sold", value: String(sold) },
      {
        label: "Withheld by a regulator",
        value: String(flagged),
        tone: flagged > 0 ? "danger" : "success",
      },
    ],
    sections: [
      {
        title: "Your batches",
        kind: "table",
        columns: ["Batch", "Product", "Quantity", "Stage", "Listed", "Last check"],
        items: batches.map((product) => ({
          batch: product.productId,
          product: product.cropType,
          quantity: `${product.quantity} ${product.unit}`,
          stage: statusLabel(product.status as ProductStatus),
          listed: product.retail?.listed === true ? "Yes" : "No",
          check: product.lastVerificationResult.replace(/_/g, " ").toLowerCase(),
        })),
        emptyMessage: "No batches have been delivered to you yet.",
      },
    ],
    quickActions: [
      { label: "Batches you hold", to: "/app/products?scope=mine", description: "Check a batch and set its listing." },
      { label: "Acknowledge deliveries", to: "/app/transfers/pending", description: "Confirm what has reached you." },
    ],
  };
}

async function regulatorDashboard(
  input: Context,
  onChainRegistrationRequired: boolean
): Promise<DashboardPayload> {
  const [reviewed, verified, mismatches, reports, recentChecks, byStatus] = await Promise.all([
    VerificationEventModel.countDocuments({ requesterRole: "REGULATOR" }),
    VerificationEventModel.countDocuments({ verificationResult: "VERIFIED" }),
    VerificationEventModel.countDocuments({ verificationResult: "MISMATCH" }),
    ComplianceReportModel.countDocuments({ generatedBy: input.walletAddress }),
    VerificationEventModel.find({})
      .sort({ createdAt: -1 })
      .limit(8)
      .lean(),
    ProductMetadataModel.aggregate<{ _id: string; count: number }>([
      { $match: { chainState: "CONFIRMED" } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);

  return {
    role: "REGULATOR",
    introduction:
      "Batches under review, records whose stored details no longer match the blockchain, and the reports you have produced.",
    onChainRegistrationRequired,
    metrics: [
      { label: "Batches you have reviewed", value: String(reviewed) },
      { label: "Checks that passed", value: String(verified), tone: "success" },
      {
        label: "Records found altered",
        value: String(mismatches),
        tone: mismatches > 0 ? "danger" : "success",
        hint: mismatches > 0 ? "Needs investigation" : "None recorded",
      },
      { label: "Reports you generated", value: String(reports) },
    ],
    sections: [
      {
        title: "Recent checks across the network",
        kind: "table",
        columns: ["Batch", "Result", "Checked by", "Channel", "When"],
        items: recentChecks.map((entry) => ({
          batch: entry.productId,
          result: entry.verificationResult.replace(/_/g, " ").toLowerCase(),
          checkedBy:
            entry.requester === "PUBLIC" ? "Public" : short(entry.requester),
          channel: entry.requestChannel.toLowerCase().replace(/_/g, " "),
          when: entry.createdAt.toISOString().slice(0, 16).replace("T", " "),
        })),
        emptyMessage: "No verification has been performed yet.",
      },
      {
        title: "Batches by stage",
        kind: "list",
        items: byStatus.map((row) => ({
          stage: label(row._id),
          count: row.count,
        })),
        emptyMessage: "No batches are registered yet.",
      },
    ],
    quickActions: [
      { label: "Open the compliance dashboard", to: "/app/compliance", description: "Suspicious records and anomalies." },
      { label: "Generate a report", to: "/app/compliance/reports/new", description: "Filter the registry and export." },
      { label: "Search the registry", to: "/search", description: "Check any batch by identifier." },
    ],
  };
}

function consumerDashboard(_input: Context): DashboardPayload {
  return {
    role: "CONSUMER",
    introduction:
      "You do not need an account to check a batch. Enter the identifier printed on the packaging, or scan its QR code.",
    onChainRegistrationRequired: false,
    metrics: [],
    sections: [],
    quickActions: [
      { label: "Check a batch", to: "/verify", description: "Enter or scan a product identifier." },
      { label: "Search the registry", to: "/search", description: "Find a batch by product or location." },
    ],
  };
}

function label(status: string): string {
  return statusLabel(status as ProductStatus);
}

async function productIds(
  wallet: string,
  field: "ownerWallet" | "registeredByWallet"
): Promise<string[]> {
  const records = await ProductMetadataModel.find({ [field]: wallet })
    .select({ productId: 1 })
    .lean();
  return records.map((record) => record.productId);
}
