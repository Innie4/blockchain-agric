import { AppError, ERROR_CODES } from "../../lib/errors.js";
import { assertProductId, normaliseWallet } from "../../lib/crypto.js";
import { statusLabel } from "../../lib/statusMachine.js";
import {
  CertificateModel,
  NotificationModel,
  ProcessingLogModel,
  ProductMetadataModel,
  TransferModel,
  TransportLogModel,
  UserModel,
  VerificationEventModel,
} from "../../models/index.js";
import { getChainClient } from "../solana/chainClientRegistry.js";
import { buildPublicView, type PublicProductView } from "../verification/verificationService.js";
import { toProductSummary, type ProductSummary } from "./registrationService.js";

export interface ProductListQuery {
  search?: string | undefined;
  status?: string | undefined;
  cropType?: string | undefined;
  owner?: string | undefined;
  scope?: "mine" | "all" | undefined;
  chainState?: string | undefined;
  page: number;
  pageSize: number;
}

/**
 * A page of results. The rows are named for what they are rather than for the
 * envelope, so a reader of the API sees `products` rather than `items`.
 */
export interface Page<T> {
  rows: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

interface ProductLike {
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

/** A lean MongoDB document omits unset fields, so absent and null both occur. */
function isoOrNull(value: Date | null | undefined): string | null {
  return value == null ? null : value.toISOString();
}

/** Escapes a user-supplied string before it reaches a MongoDB `$regex`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Lists products with filters. A consumer never reaches this route, and every
 * other caller is either shown their own batches or the whole registry, which
 * is public information by design.
 */
export async function listProducts(
  query: ProductListQuery,
  requester: { walletAddress: string; role: string }
): Promise<Page<ProductSummary>> {
  const filter: Record<string, unknown> = {};

  if (query.scope === "mine") {
    filter["$or"] = [{ ownerWallet: requester.walletAddress }, { registeredByWallet: requester.walletAddress }];
  }
  if (query.status !== undefined && query.status.length > 0) {
    filter["status"] = query.status;
  }
  if (query.cropType !== undefined && query.cropType.length > 0) {
    filter["cropType"] = new RegExp(`^${escapeRegExp(query.cropType)}$`, "i");
  }
  if (query.owner !== undefined && query.owner.length > 0) {
    filter["ownerWallet"] = normaliseWallet(query.owner, "owner");
  }
  if (query.chainState !== undefined && query.chainState.length > 0) {
    filter["chainState"] = query.chainState;
  }
  if (query.search !== undefined && query.search.trim().length > 0) {
    const term = escapeRegExp(query.search.trim());
    filter["$and"] = (filter["$and"]) ?? [];
    (filter["$and"] as unknown[]).push({
      $or: [
        { productId: new RegExp(term, "i") },
        { cropType: new RegExp(term, "i") },
        { farmLocation: new RegExp(term, "i") },
        { description: new RegExp(term, "i") },
      ],
    });
  }

  const [records, total] = await Promise.all([
    ProductMetadataModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .lean(),
    ProductMetadataModel.countDocuments(filter),
  ]);

  return {
    rows: records.map((record) => toProductSummary(record as unknown as ProductLike)),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    },
  };
}

/** Loads a product for a participant who must be entitled to see it. */
export async function loadProductForParticipant(
  productId: string,
  requester: { walletAddress: string; role: string }
): Promise<ProductSummary> {
  const id = assertProductId(productId);
  const record = await ProductMetadataModel.findOne({ productId: id }).lean();
  if (record === null) {
    throw new AppError(ERROR_CODES.PRODUCT_NOT_FOUND, { details: { productId: id } });
  }
  void requester;
  return toProductSummary(record as unknown as ProductLike);
}

/** The public, consumer-facing view of a batch. */
export async function loadPublicProduct(productId: string): Promise<PublicProductView> {
  const id = assertProductId(productId);
  const record = await ProductMetadataModel.findOne({ productId: id }).lean();
  if (record === null) {
    throw new AppError(ERROR_CODES.PRODUCT_NOT_FOUND, { details: { productId: id } });
  }
  return buildPublicView(record, id);
}

export interface SearchResult {
  productId: string;
  cropType: string;
  quantity: number;
  unit: string;
  farmLocation: string;
  status: string;
  statusLabel: string;
  lastVerificationResult: string;
  registeredAt: string | null;
}

/**
 * Public search. Only non-identifying summary fields are returned, so a search
 * never discloses who owns a batch or who registered it.
 */
export async function searchPublicProducts(input: {
  term: string;
  limit: number;
}): Promise<SearchResult[]> {
  const term = input.term.trim();
  if (term.length === 0) return [];
  const safe = escapeRegExp(term);
  const records = await ProductMetadataModel.find({
    chainState: "CONFIRMED",
    $or: [
      { productId: new RegExp(safe, "i") },
      { cropType: new RegExp(safe, "i") },
      { farmLocation: new RegExp(safe, "i") },
    ],
  })
    .select({
      productId: 1,
      cropType: 1,
      quantity: 1,
      unit: 1,
      farmLocation: 1,
      status: 1,
      lastVerificationResult: 1,
      onChainRegisteredAt: 1,
    })
    .sort({ createdAt: -1 })
    .limit(input.limit)
    .lean();

  return records.map((record) => ({
    productId: record.productId,
    cropType: record.cropType,
    quantity: record.quantity,
    unit: record.unit,
    farmLocation: record.farmLocation,
    status: record.status,
    statusLabel: statusLabel(record.status as never),
    lastVerificationResult: record.lastVerificationResult,
    registeredAt: isoOrNull(record.onChainRegisteredAt),
  }));
}

export interface ProductHistory {
  productId: string;
  status: string;
  statusLabel: string;
  chainState: string;
  onChainAddress: string | null;
  onChainTxHash: string | null;
  dataHash: string;
  onChainDataHash: string | null;
  integrity: {
    status: "MATCH" | "MISMATCH" | "UNKNOWN";
    detail: string;
  };
  provenance: Awaited<ReturnType<typeof buildPublicView>>["provenance"];
  counts: {
    transfers: number;
    processingEvents: number;
    transportEvents: number;
    certificates: number;
    verifications: number;
  };
}

export async function loadHistory(productId: string): Promise<ProductHistory> {
  const id = assertProductId(productId);
  const record = await ProductMetadataModel.findOne({ productId: id }).lean();
  if (record === null) {
    throw new AppError(ERROR_CODES.PRODUCT_NOT_FOUND, { details: { productId: id } });
  }

  const [transfers, processing, transport, certificates, verifications] = await Promise.all([
    TransferModel.countDocuments({ productId: id }),
    ProcessingLogModel.countDocuments({ productId: id }),
    TransportLogModel.countDocuments({ productId: id }),
    CertificateModel.countDocuments({ productId: id }),
    VerificationEventModel.countDocuments({ productId: id }),
  ]);

  let onChain = null;
  try {
    onChain = await getChainClient().fetchProduct(id);
  } catch {
    onChain = null;
  }

  const storedHash = record.onChainDataHash ?? record.dataHash;
  let integrity: ProductHistory["integrity"];
  if (onChain === null) {
    integrity = {
      status: "UNKNOWN",
      detail:
        "The blockchain record for this batch could not be read, so its fingerprint cannot be compared.",
    };
  } else if (onChain.offChainDataHash === storedHash) {
    integrity = {
      status: "MATCH",
      detail: "The fingerprint stored here matches the one anchored on the blockchain.",
    };
  } else {
    integrity = {
      status: "MISMATCH",
      detail:
        "The fingerprint stored here does not match the one anchored on the blockchain. Treat this batch as unverified.",
    };
  }

  const publicView = await buildPublicView(record, id);

  return {
    productId: id,
    status: record.status,
    statusLabel: statusLabel(record.status as never),
    chainState: record.chainState,
    onChainAddress: record.onChainAddress ?? null,
    onChainTxHash: record.onChainTxHash ?? null,
    dataHash: record.dataHash,
    onChainDataHash: record.onChainDataHash ?? null,
    integrity,
    provenance: publicView.provenance,
    counts: {
      transfers,
      processingEvents: processing,
      transportEvents: transport,
      certificates,
      verifications,
    },
  };
}

export interface ActivityEntry {
  id: string;
  kind: string;
  title: string;
  detail: string;
  productId: string | null;
  occurredAt: string;
  outcome: string;
}

/**
 * A participant's own history: what they registered, transferred, processed,
 * carried, listed and checked. Every entry comes from a stored record.
 */
export async function listActivity(input: {
  walletAddress: string;
  page: number;
  pageSize: number;
}): Promise<Page<ActivityEntry>> {
  const [registrations, transfersSent, transfersReceived, processing, transport, verifications] =
    await Promise.all([
      ProductMetadataModel.find({ registeredByWallet: input.walletAddress })
        .select({ productId: 1, cropType: 1, quantity: 1, unit: 1, createdAt: 1, onChainTxHash: 1, chainState: 1 })
        .lean(),
      TransferModel.find({ fromWallet: input.walletAddress }).lean(),
      TransferModel.find({ toWallet: input.walletAddress }).lean(),
      ProcessingLogModel.find({ processorWallet: input.walletAddress }).lean(),
      TransportLogModel.find({ transporterWallet: input.walletAddress }).lean(),
      VerificationEventModel.find({ requestedByWallet: input.walletAddress })
        .sort({ createdAt: -1 })
        .limit(200)
        .lean(),
    ]);

  const entries: ActivityEntry[] = [];

  for (const product of registrations) {
    entries.push({
      id: `register:${product.productId}`,
      kind: "REGISTERED",
      title: `Registered batch ${product.productId}`,
      detail: `${product.cropType}, ${product.quantity} ${product.unit}`,
      productId: product.productId,
      occurredAt: product.createdAt.toISOString(),
      outcome: product.chainState === "CONFIRMED" ? "ON_CHAIN" : "PENDING",
    });
  }
  for (const transfer of transfersSent) {
    entries.push({
      id: `transfer-sent:${transfer.transferId}`,
      kind: "TRANSFER_SENT",
      title: `Transferred ${transfer.productId}`,
      detail: `Sent to a ${transfer.toRole.toLowerCase()}`,
      productId: transfer.productId,
      occurredAt: (transfer.confirmedAt ?? transfer.createdAt).toISOString(),
      outcome: transfer.status,
    });
  }
  for (const transfer of transfersReceived) {
    entries.push({
      id: `transfer-received:${transfer.transferId}`,
      kind: "TRANSFER_RECEIVED",
      title: `Received ${transfer.productId}`,
      detail: `From a ${transfer.fromRole.toLowerCase()}`,
      productId: transfer.productId,
      occurredAt: (transfer.confirmedAt ?? transfer.createdAt).toISOString(),
      outcome: transfer.status,
    });
  }
  for (const log of processing) {
    entries.push({
      id: `processing:${log.logId}`,
      kind: "PROCESSING",
      title: log.activity,
      detail: `${log.productId}: ${log.statusBefore.replace(/_/g, " ").toLowerCase()} to ${log.statusAfter.replace(/_/g, " ").toLowerCase()}`,
      productId: log.productId,
      occurredAt: log.occurredAt.toISOString(),
      outcome: log.onChainTxHash === null ? "OFF_CHAIN" : "ON_CHAIN",
    });
  }
  for (const log of transport) {
    entries.push({
      id: `transport:${log.logId}`,
      kind: "TRANSPORT",
      title: `Carried ${log.productId}`,
      detail: `${log.origin} to ${log.destination} (${log.deliveryStatus.toLowerCase().replace(/_/g, " ")})`,
      productId: log.productId,
      occurredAt: log.departedAt.toISOString(),
      outcome: log.deliveryStatus,
    });
  }
  for (const verification of verifications) {
    entries.push({
      id: `verify:${verification.verificationId}`,
      kind: "VERIFICATION",
      title: `Checked ${verification.productId}`,
      detail: verification.verificationResult.replace(/_/g, " ").toLowerCase(),
      productId: verification.productId,
      occurredAt: verification.createdAt.toISOString(),
      outcome: verification.verificationResult,
    });
  }

  entries.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const start = (input.page - 1) * input.pageSize;
  return {
    rows: entries.slice(start, start + input.pageSize),
    pagination: {
      page: input.page,
      pageSize: input.pageSize,
      total: entries.length,
      totalPages: Math.max(1, Math.ceil(entries.length / input.pageSize)),
    },
  };
}

export async function listNotifications(input: {
  walletAddress: string;
  unreadOnly: boolean;
  limit: number;
}): Promise<{
  notifications: Array<{
    notificationId: string;
    kind: string;
    title: string;
    body: string;
    productId: string | null;
    linkPath: string | null;
    readAt: string | null;
    createdAt: string;
  }>;
  unreadCount: number;
}> {
  const filter: Record<string, unknown> = { recipientWallet: input.walletAddress };
  if (input.unreadOnly) filter["readAt"] = null;
  const [records, unreadCount] = await Promise.all([
    NotificationModel.find(filter).sort({ createdAt: -1 }).limit(input.limit).lean(),
    NotificationModel.countDocuments({ recipientWallet: input.walletAddress, readAt: null }),
  ]);
  return {
    notifications: records.map((record) => ({
      notificationId: record.notificationId,
      kind: String(record.kind),
      title: record.title,
      body: record.body,
      productId: record.productId ?? null,
      linkPath: record.linkPath ?? null,
      readAt: isoOrNull(record.readAt),
      createdAt: record.createdAt.toISOString(),
    })),
    unreadCount,
  };
}

export async function markNotificationRead(input: {
  notificationId: string;
  walletAddress: string;
}): Promise<void> {
  const result = await NotificationModel.updateOne(
    { notificationId: input.notificationId, recipientWallet: input.walletAddress },
    { $set: { readAt: new Date() } }
  );
  if ((result.matchedCount ?? 0) === 0) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      message: "That notification does not exist.",
    });
  }
}

/** Participant profile for the settings and profile screens. */
export async function readProfile(walletAddress: string) {
  const user = await UserModel.findOne({ walletAddress }).lean();
  if (user === null) {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, {
      message: "Your participant record could not be found.",
    });
  }
  return user;
}
