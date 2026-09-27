/**
 * The wire contract between this client and the API.
 *
 * Every type here mirrors something the server actually returns. Where the
 * server and the brief differ, the server wins: `PublicProduct` follows
 * `verificationService.ts` rather than the richer authenticated `Product`,
 * because a public verification deliberately publishes less.
 *
 * This module has no imports on purpose. It is the vocabulary the rest of the
 * application shares, so it must not depend on anything that can fail to load.
 */

/* ------------------------------------------------------------------ *
 * Roles, statuses and other closed vocabularies
 * ------------------------------------------------------------------ */

/** `CONSUMER` is deliberately not an on-chain registry role. */
export const ROLES = [
  "FARMER",
  "PROCESSOR",
  "TRANSPORTER",
  "RETAILER",
  "REGULATOR",
  "CONSUMER",
] as const;

export type Role = (typeof ROLES)[number];

/** Roles that may hold a slot in the on-chain participant registry. */
export const ON_CHAIN_ROLES = [
  "FARMER",
  "PROCESSOR",
  "TRANSPORTER",
  "RETAILER",
  "REGULATOR",
] as const satisfies readonly Role[];

export type OnChainRole = (typeof ON_CHAIN_ROLES)[number];

/** Roles permitted to take ownership of a batch. Mirrors the program. */
export const TRANSFER_RECIPIENT_ROLES = [
  "PROCESSOR",
  "TRANSPORTER",
  "RETAILER",
] as const satisfies readonly Role[];

export const ROLE_LABELS: Record<Role, string> = {
  FARMER: "Farmer",
  PROCESSOR: "Processor",
  TRANSPORTER: "Transporter",
  RETAILER: "Retailer",
  REGULATOR: "Regulator",
  CONSUMER: "Consumer",
};

export const PRODUCT_STATUSES = [
  "REGISTERED",
  "IN_PROCESSING",
  "PROCESSED",
  "IN_TRANSIT",
  "AT_RETAILER",
  "LISTED",
  "SOLD",
  "FLAGGED",
] as const;

export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const STATUS_LABELS: Record<ProductStatus, string> = {
  REGISTERED: "Registered",
  IN_PROCESSING: "In processing",
  PROCESSED: "Processed",
  IN_TRANSIT: "In transit",
  AT_RETAILER: "At retailer",
  LISTED: "Listed for sale",
  SOLD: "Sold",
  FLAGGED: "Flagged by regulator",
};

/** How far the blockchain side of a record has progressed. */
export const CHAIN_STATES = [
  "NOT_STARTED",
  "AWAITING_SIGNATURE",
  "SUBMITTED",
  "CONFIRMED",
  "FAILED",
  "CANCELLED",
  "NEEDS_RECONCILIATION",
] as const;

export type ChainState = (typeof CHAIN_STATES)[number];

export const CHAIN_STATE_LABELS: Record<ChainState, string> = {
  NOT_STARTED: "Not yet written to the blockchain",
  AWAITING_SIGNATURE: "Waiting for a wallet signature",
  SUBMITTED: "Submitted to Solana",
  CONFIRMED: "Confirmed on Solana",
  FAILED: "The blockchain write failed",
  CANCELLED: "Cancelled before signing",
  NEEDS_RECONCILIATION: "On-chain write confirmed; the record still needs finishing",
};

export const TRANSFER_STATUSES = [
  "PREPARED",
  "SUBMITTED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "NEEDS_RECONCILIATION",
] as const;

export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const TRANSFER_STATUS_LABELS: Record<TransferStatus, string> = {
  PREPARED: "Awaiting signature",
  SUBMITTED: "Submitted to Solana",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  NEEDS_RECONCILIATION: "Needs reconciliation",
};

export const DELIVERY_STATUSES = [
  "SCHEDULED",
  "IN_TRANSIT",
  "DELIVERED",
  "DELAYED",
  "CANCELLED",
] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  SCHEDULED: "Scheduled",
  IN_TRANSIT: "In transit",
  DELIVERED: "Delivered",
  DELAYED: "Delayed",
  CANCELLED: "Cancelled",
};

export const VERIFICATION_RESULTS = [
  "VERIFIED",
  "MISMATCH",
  "NOT_FOUND",
  "INCOMPLETE",
] as const;

export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

export const VERIFICATION_RESULT_LABELS: Record<VerificationResult, string> = {
  VERIFIED: "Verified",
  MISMATCH: "Details do not match",
  NOT_FOUND: "No record found",
  INCOMPLETE: "Not yet fully registered",
};

export const MEDIA_KINDS = ["IMAGE", "DOCUMENT"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const PROVENANCE_KINDS = [
  "REGISTERED",
  "TRANSFER",
  "PROCESSING",
  "TRANSPORT",
  "STATUS",
  "VERIFICATION",
  "RETAIL",
] as const;

export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];

export const PROVENANCE_KIND_LABELS: Record<ProvenanceKind, string> = {
  REGISTERED: "Registration",
  TRANSFER: "Transfer of ownership",
  PROCESSING: "Processing",
  TRANSPORT: "Transport",
  STATUS: "Status change",
  VERIFICATION: "Verification",
  RETAIL: "Retail",
};

export const REQUEST_CHANNELS = [
  "SEARCH",
  "DIRECT_URL",
  "QR_SCAN",
  "DASHBOARD",
  "REGULATOR_REVIEW",
] as const;

export type RequestChannel = (typeof REQUEST_CHANNELS)[number];

/**
 * How a reader reached a batch's page, which is the only part of the recorded
 * channel the browser can know. The server decides the rest from the session, so
 * a check cannot be mislabelled by the client that made it.
 */
export const READER_SOURCES = ["search", "qr", "direct"] as const;

export type ReaderSource = (typeof READER_SOURCES)[number];

export const RECONCILIATION_ACTIONS = [
  "COMPLETE_PRODUCT_REGISTRATION",
  "COMPLETE_TRANSFER",
  "COMPLETE_STATUS_UPDATE",
  "COMPLETE_PROCESSING_LOG",
  "COMPLETE_TRANSPORT_LOG",
  "COMPLETE_CERTIFICATE",
] as const;

export type ReconciliationAction = (typeof RECONCILIATION_ACTIONS)[number];

export const RECONCILIATION_ACTION_LABELS: Record<ReconciliationAction, string> = {
  COMPLETE_PRODUCT_REGISTRATION: "Finish product registration",
  COMPLETE_TRANSFER: "Finish transfer",
  COMPLETE_STATUS_UPDATE: "Finish status update",
  COMPLETE_PROCESSING_LOG: "Finish processing record",
  COMPLETE_TRANSPORT_LOG: "Finish transport record",
  COMPLETE_CERTIFICATE: "Finish certificate attachment",
};

export const NOTIFICATION_KINDS = [
  "TRANSFER_RECEIVED",
  "TRANSFER_SENT",
  "PRODUCT_REGISTERED",
  "PRODUCT_FLAGGED",
  "PRODUCT_RELEASED",
  "VERIFICATION_MISMATCH",
  "RECONCILIATION_REQUIRED",
  "SYSTEM",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const PERMISSIONS = [
  "product:register",
  "product:read:any",
  "product:read:own",
  "product:update-status",
  "product:record-processing",
  "product:record-transport",
  "product:list-for-sale",
  "transfer:create",
  "transfer:review",
  "certificate:attach",
  "verification:log",
  "compliance:read",
  "compliance:report-generate",
  "profile:manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const REPORT_EXPORT_FORMATS = ["pdf", "csv"] as const;
export type ReportExportFormat = (typeof REPORT_EXPORT_FORMATS)[number];

/* ------------------------------------------------------------------ *
 * Envelopes
 * ------------------------------------------------------------------ */

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  message?: string;
}

export interface ErrorEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

/** One rejected field, as produced by the server's validation layer. */
export interface FieldIssue {
  path: string;
  message: string;
}

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

export interface ContactInfo {
  email: string;
  phone: string;
  address: string;
  state: string;
}

export type UserStatus = "ACTIVE" | "SUSPENDED" | "WITHDRAWN";

export interface User {
  userId: string;
  walletAddress: string;
  fullName: string;
  role: Role;
  contactInfo: ContactInfo;
  organisation: string;
  status: UserStatus;
  onChainRegistered: boolean;
  onChainRegistrationTx: string | null;
  profileHash: string | null;
  /** ISO 8601. */
  registrationDate: string;
  /** ISO 8601. */
  lastSeen: string;
}

export interface ParticipantSummary {
  walletAddress: string;
  fullName: string;
  role: Role;
  organisation: string;
  state: string;
}

export interface ParticipantListResponse {
  participants: ParticipantSummary[];
}

/** A sign-in challenge. `message` is what the wallet must sign, verbatim. */
export interface AuthChallenge {
  nonce: string;
  message: string;
  /** ISO 8601. */
  expiresAt: string;
  /** ISO 8601. The wallet must not be asked to sign before this instant. */
  notBefore: string;
}

export interface VerifiedSignIn {
  walletAddress: string;
  user: User;
  isNewParticipant: boolean;
  needsRoleSelection: boolean;
  needsOnChainRegistration: boolean;
}

export interface SessionState {
  authenticated: boolean;
  user: User | null;
  permissions: string[];
}

export interface LogoutResult {
  signedOut: boolean;
}

export interface UpdateProfileInput {
  fullName?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  state?: string;
  organisation?: string;
}

export interface HealthReport {
  status: string;
  runtime: Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * The two-phase blockchain flow
 * ------------------------------------------------------------------ */

/**
 * Phase one. The server has built an unsigned transaction against a live
 * blockhash and the participant must now sign it. The blockhash expires, so
 * `validForSeconds` is the real deadline, not a courtesy.
 */
export interface Prepared {
  phase: "PREPARED";
  /** Base64 wire form, exactly as the wallet should be given it. */
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  /** The deterministic address the transaction acts on. */
  targetAddress: string;
  /** What the participant should expect to happen, shown in the signing prompt. */
  description: string;
  validForSeconds: number;
}

/** One decoded anchor event emitted by the on-chain program. */
export interface ProgramEvent {
  name: string;
  data: Record<string, unknown>;
}

/** Phase two. The cluster confirmed and the record has been re-read. */
export interface Confirmed {
  phase: "CONFIRMED";
  signature: string;
  slot: number;
  targetAddress: string;
  events: ProgramEvent[];
}

/* ------------------------------------------------------------------ *
 * Products
 * ------------------------------------------------------------------ */

export interface MediaRef {
  mediaId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** SHA-256 of the stored bytes, so substitution is detectable. */
  contentHash: string;
  kind: MediaKind;
  caption: string;
}

export interface RetailDetails {
  listed: boolean;
  listedAt: string | null;
  askingPrice: number | null;
  currency: string;
  soldAt: string | null;
  note: string;
}

export interface Product {
  productId: string;
  cropType: string;
  quantity: number;
  unit: string;
  /** ISO 8601. */
  harvestDate: string;
  farmLocation: string;
  description: string;
  additionalNotes: string;
  status: ProductStatus;
  chainState: ChainState;
  ownerWallet: string;
  registeredByWallet: string;
  registrantRole: Role;
  /** SHA-256 of the canonical off-chain payload. */
  dataHash: string;
  onChainDataHash: string | null;
  onChainTxHash: string | null;
  onChainAddress: string | null;
  onChainRegisteredAt: string | null;
  onChainTransferCount: number;
  images: MediaRef[];
  certificates: MediaRef[];
  retail: RetailDetails;
  lastVerificationResult: VerificationResult;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a public verification publishes. It is deliberately narrower than
 * `Product`: no owner wallet, no contact details, no document bytes.
 */
export interface PublicProduct {
  productId: string;
  cropType: string;
  quantity: number;
  unit: string;
  harvestDate: string;
  /** Farm location as recorded. Precise coordinates are not published. */
  origin: string;
  description: string;
  additionalNotes: string;
  status: ProductStatus;
  statusLabel: string;
  registeredAt: string | null;
  currentOwnerCategory: string | null;
  registrantCategory: string;
  dataHash: string | null;
  onChainAddress: string | null;
  onChainTxHash: string | null;
  onChainRegisteredAt: string | null;
  images: Array<{ mediaId: string; caption: string }>;
  certificates: PublicCertificateSummary[];
  provenance: ProvenanceEvent[];
  verificationHistory: PublicVerificationRecord[];
  verificationCount: number;
  lastVerificationResult: VerificationResult;
}

export interface PublicCertificateSummary {
  certificateId: string;
  issuingBody: string;
  certificateType: string;
  referenceNumber: string;
  issuedOn: string | null;
  expiresOn: string | null;
  dataHash: string;
}

export interface PublicVerificationRecord {
  verificationId: string;
  result: VerificationResult;
  requester: string;
  requestedAt: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ProductListResponse {
  products: Product[];
  pagination: Pagination;
}

/**
 * The authenticated view of one batch.
 *
 * The permission booleans are decided by the server, which knows the session's
 * wallet and role. The interface renders what it is told rather than repeating
 * the rules, so the two can never drift apart.
 */
export interface ProductDetailResponse {
  product: Product;
  verificationUrl: string;
  isOwner: boolean;
  isRegistrant: boolean;
  canTransfer: boolean;
  canRecordProcessing: boolean;
  canRecordTransport: boolean;
  canListForSale: boolean;
}

/** Whether the stored fingerprint still matches the one on the blockchain. */
export type IntegrityStatus = "MATCH" | "MISMATCH" | "UNKNOWN";

export interface HistoryIntegrity {
  status: IntegrityStatus;
  detail: string;
}

export interface HistoryCounts {
  transfers: number;
  processingEvents: number;
  transportEvents: number;
  certificates: number;
  verifications: number;
}

export interface ProductHistoryResponse {
  productId: string;
  status: ProductStatus;
  statusLabel: string;
  chainState: ChainState;
  onChainAddress: string | null;
  onChainTxHash: string | null;
  dataHash: string;
  onChainDataHash: string | null;
  integrity: HistoryIntegrity;
  provenance: ProvenanceEvent[];
  counts: HistoryCounts;
}

export interface ProvenanceEvent {
  sequence: number;
  kind: ProvenanceKind;
  title: string;
  detail: string;
  /** ISO 8601. */
  occurredAt: string;
  actorWallet: string | null;
  actorRole: string | null;
  status: string | null;
  transactionSignature: string | null;
  dataHash: string | null;
  flagged: boolean;
}

export interface CancelRegistrationResult {
  productId: string;
  chainState: ChainState;
}

export interface ProductRegistrationAccepted {
  productId: string;
  /** Hash of the payload the server has stored off-chain, ready to anchor. */
  dataHash: string;
  chainState: ChainState;
  prepared: Prepared;
  product: Product;
}

export interface ProductRegistrationConfirmed {
  product: Product;
  signature: string;
  slot: number;
  verificationUrl: string;
  qrPayload: string;
}

export interface SaleUpdateInput {
  listed: boolean;
  /** `null` clears the price. */
  askingPrice?: number | null;
  currency?: string;
  note?: string;
}

export interface UpdateStatusInput {
  status: ProductStatus;
  occurredAt: string;
}

/* ------------------------------------------------------------------ *
 * Verification
 * ------------------------------------------------------------------ */

export interface MismatchDetail {
  reason: string;
  explanation: string;
  expected: string;
  actual: string;
  field?: string;
}

export interface Verification {
  result: VerificationResult;
  productId: string;
  /** A single sentence a consumer can act on. */
  headline: string;
  /** The longer explanation behind the headline. */
  explanation: string;
  chainReachable: boolean;
  recordPresent: boolean;
  dataHash: {
    onChain: string | null;
    stored: string | null;
    computed: string | null;
  };
  mismatch: MismatchDetail | null;
  verificationId: string;
  verifiedAt: string;
  durationMs: number;
}

export interface VerificationResponse {
  verification: Verification;
  product: PublicProduct | null;
}

export interface LogVerificationResult {
  verificationId: string;
}

export interface SearchResult {
  productId: string;
  cropType: string;
  quantity: number;
  unit: string;
  farmLocation: string;
  status: ProductStatus;
  statusLabel: string;
  lastVerificationResult: VerificationResult;
}

export interface SearchResponse {
  results: SearchResult[];
}

/* ------------------------------------------------------------------ *
 * Transfers
 * ------------------------------------------------------------------ */

export interface Transfer {
  transferId: string;
  onChainTransferRef: string;
  productId: string;
  fromWallet: string;
  toWallet: string;
  toRole: Role;
  fromRole: Role;
  status: TransferStatus;
  transactionSignature: string | null;
  previousStatus: ProductStatus;
  resultingStatus: ProductStatus | null;
  note: string;
  failureReason: string | null;
  createdAt: string;
  submittedAt: string | null;
  confirmedAt: string | null;
  acknowledgedAt: string | null;
  /** The batch's product, when the server joined it in for the list. */
  cropType?: string;
  quantity?: number;
  unit?: string;
}

export interface TransferListResponse {
  transfers: Transfer[];
  pagination: Pagination;
}

export interface TransferAccepted {
  transfer: Transfer;
  prepared: Prepared;
}

/**
 * The server returns a completed record as the payload itself, not wrapped in a
 * `transfer` field. These types mirror that shape exactly: a wrapper here would
 * make the client read `undefined` from a write that actually succeeded, and
 * report a confirmed transaction as a failure.
 */
export type TransferConfirmed = Transfer;

/* ------------------------------------------------------------------ *
 * Processing and transport logs
 * ------------------------------------------------------------------ */

export interface SupportingFile {
  mediaId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
}

export interface ProcessingLog {
  logId: string;
  productId: string;
  processorWallet: string;
  processorName: string;
  activity: string;
  activityDescription: string;
  occurredAt: string;
  statusBefore: ProductStatus;
  statusAfter: ProductStatus;
  supportingImages: SupportingFile[];
  supportingDocuments: SupportingFile[];
  dataHash: string;
  onChainTxHash: string | null;
  createdAt: string;
}

export interface TransportLog {
  logId: string;
  productId: string;
  transporterWallet: string;
  transporterName: string;
  origin: string;
  destination: string;
  routeDetails: string;
  vehicleDescription: string;
  departedAt: string;
  expectedArrivalAt: string | null;
  deliveredAt: string | null;
  deliveryStatus: DeliveryStatus;
  supportingDocuments: SupportingFile[];
  dataHash: string;
  onChainTxHash: string | null;
  createdAt: string;
}

export interface ProcessingLogAccepted {
  log: ProcessingLog;
  prepared: Prepared;
}

/** The server returns the confirmed log itself, not wrapped. See TransferConfirmed. */
export type ProcessingLogConfirmed = ProcessingLog;

export interface TransportLogAccepted {
  log: TransportLog;
  prepared: Prepared;
}

/** The server returns the confirmed log itself, not wrapped. See TransferConfirmed. */
export type TransportLogConfirmed = TransportLog;

export interface ProcessingLogListResponse {
  logs: ProcessingLog[];
}

export interface TransportLogListResponse {
  logs: TransportLog[];
}

/* ------------------------------------------------------------------ *
 * Certificates and media
 * ------------------------------------------------------------------ */

export interface Certificate {
  certificateId: string;
  productId: string;
  issuingBody: string;
  certificateType: string;
  referenceNumber: string;
  issuedOn: string | null;
  expiresOn: string | null;
  document: SupportingFile;
  dataHash: string;
  uploadedByWallet: string;
  createdAt: string;
}

export interface CertificateListResponse {
  certificates: Certificate[];
}

export interface MediaAttachment {
  mediaId: string;
  productId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  kind: MediaKind;
  caption: string;
  uploadedByWallet: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ *
 * Compliance, dashboard, notifications, activity
 * ------------------------------------------------------------------ */

export interface ComplianceMetric {
  key: string;
  label: string;
  value: number | string;
  hint?: string;
  tone?: MetricTone;
}

export type MetricTone = "neutral" | "success" | "warning" | "danger" | "info";

export type StatusCounts = Partial<Record<ProductStatus, number>>;

export interface PublicVerificationEvent {
  verificationId: string;
  productId: string;
  requester: string;
  requesterRole: string;
  result: VerificationResult;
  occurredAt: string;
}

export type AnomalyKind =
  | "HASH_MISMATCH"
  | "CHAIN_STATE_PENDING"
  | "RECONCILIATION_REQUIRED"
  | "UNREGISTERED_OWNER";

export const ANOMALY_KIND_LABELS: Record<AnomalyKind, string> = {
  HASH_MISMATCH: "Stored details do not match the blockchain record",
  CHAIN_STATE_PENDING: "Blockchain write has not completed",
  RECONCILIATION_REQUIRED: "On-chain write confirmed but the record is unfinished",
  UNREGISTERED_OWNER: "Owner is not a registered on-chain participant",
};

export interface ComplianceAnomaly {
  productId: string;
  kind: AnomalyKind;
  detail: string;
  detectedAt: string;
}

/** One entry in the regulator's review queue, as the overview returns it. */
export interface ComplianceReviewVerification {
  verificationId: string;
  productId: string;
  result: VerificationResult;
  requester: string;
  requesterRole: string;
  requestChannel: RequestChannel;
  createdAt: string;
}

/**
 * An unfinished blockchain write, as the overview returns it. This is the
 * regulation-side view: it carries the on-chain signature and the task that has
 * to finish the record, which the report-level `ComplianceAnomaly` does not.
 */
export interface ComplianceOutstandingAction {
  taskId: string;
  kind: AnomalyKind | string;
  productId: string;
  detail: string;
  transactionSignature: string;
  createdAt: string;
}

export interface ComplianceTransferActivity {
  productId: string;
  count: number;
  lastTransferAt: string | null;
}

export interface ComplianceOverview {
  metrics: ComplianceMetric[];
  statusCounts: Array<{ status: ProductStatus; label: string; count: number }>;
  cropTypeCounts: Array<{ cropType: string; count: number }>;
  recentVerifications: ComplianceReviewVerification[];
  anomalies: ComplianceOutstandingAction[];
  transferActivity: ComplianceTransferActivity[];
}

/**
 * One row of the regulator's review queue. It carries the same facts as the
 * overview's `recentVerifications` plus what the check actually observed, so a
 * finding can be judged without opening the batch.
 */
export interface ComplianceVerificationRecord {
  verificationId: string;
  productId: string;
  result: VerificationResult;
  requester: string;
  requesterRole: string;
  requestChannel: RequestChannel;
  /** False when the chain could not be read, so the result is not conclusive. */
  chainReachable: boolean;
  /** False when the stored record was missing at the moment of the check. */
  recordPresent: boolean;
  /** What differed, when the result is a mismatch. */
  mismatchDetails: MismatchDetail | null;
  createdAt: string;
}

export interface ComplianceVerificationListResponse {
  verifications: ComplianceVerificationRecord[];
  pagination: Pagination;
}

/** A regulator's conclusion about one batch, to be anchored on the chain. */
export interface AttestationInput {
  productId: string;
  result: VerificationResult;
  /** ISO 8601. When the check being recorded took place. */
  occurredAt: string;
}

export interface AttestationPrepared {
  prepared: Prepared;
  productId: string;
  result: VerificationResult;
  /** The stage the on-chain account reported when it was read. */
  statusLabel: string;
}

export interface AttestationConfirmed {
  signature: string;
  productId: string;
  slot: number;
}

export interface ReportFilterInput {
  title: string;
  dateFrom?: string;
  dateTo?: string;
  cropTypes?: string[];
  statuses?: ProductStatus[];
  participants?: string[];
  verificationResults?: VerificationResult[];
  /** Specific batches to include, as their identifiers. */
  productIds?: string[];
}

export interface ReportProductRow {
  productId: string;
  cropType: string;
  quantity: number | null;
  unit: string;
  status: ProductStatus;
  ownerWallet: string;
  registeredByWallet: string;
  registeredAt: string | null;
  lastVerificationResult: VerificationResult | null;
  verificationCount: number;
  mismatchCount: number;
  transferCount: number;
  onChainTxHash: string | null;
  dataHash: string | null;
}

export interface ReportSummary {
  productCount: number;
  verifiedCount: number;
  mismatchCount: number;
  notFoundCount: number;
  incompleteCount: number;
  byStatus: Partial<Record<ProductStatus, number>>;
  byCropType: Record<string, number>;
  transferCount: number;
  anomalyCount: number;
}

export interface ComplianceReport {
  reportId: string;
  title: string;
  generatedBy: string;
  generatedByName: string;
  filters: Record<string, unknown>;
  includedProducts: ReportProductRow[];
  summary: ReportSummary;
  anomalies: ComplianceAnomaly[];
  generatedAt: string;
  exportMetadata: {
    formats: string[];
    lastExportedAt: string | null;
    lastExportedFormat: string | null;
    downloadCount: number;
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface ReportListResponse {
  reports: ComplianceReport[];
  pagination: Pagination;
}

export type DashboardSectionKind = "table" | "list";

/** One row of a server-built section. Keys mirror the column headers. */
export type DashboardRow = Record<string, string | number | null>;

export interface DashboardSection {
  title: string;
  kind: DashboardSectionKind;
  /** Column headers, in order, for a table section. */
  columns?: readonly string[];
  items: DashboardRow[];
  emptyMessage: string;
  emptyAction?: { label: string; to: string };
}

export interface DashboardQuickAction {
  label: string;
  to: string;
  description: string;
}

export interface DashboardMetric {
  label: string;
  value: string | number;
  hint?: string;
  tone?: MetricTone;
}

export interface DashboardResponse {
  role: Role;
  /** Plain-language summary of what this screen is for. */
  introduction: string;
  metrics: DashboardMetric[];
  sections: DashboardSection[];
  quickActions: DashboardQuickAction[];
  /** True when the wallet has no on-chain participant registration yet. */
  onChainRegistrationRequired: boolean;
}

export interface AppNotification {
  notificationId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  productId: string | null;
  linkPath: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationFeed {
  notifications: AppNotification[];
  unreadCount: number;
}

export interface ActivityEntry {
  id: string;
  kind: ProvenanceKind;
  title: string;
  detail: string;
  productId: string | null;
  actorWallet: string | null;
  actorRole: string | null;
  occurredAt: string;
  transactionSignature: string | null;
}

export interface ActivityFeed {
  entries: ActivityEntry[];
  pagination: Pagination;
}

export interface ReconciliationTask {
  taskId: string;
  action: ReconciliationAction;
  status: "PENDING" | "RESOLVED" | "FAILED";
  productId: string;
  transactionSignature: string;
  intentHash: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ReconciliationProduct {
  productId: string;
  dataHash: string;
  onChainTxHash: string | null;
  updatedAt: string;
}

export interface ReconciliationTransfer {
  transferId: string;
  productId: string;
  fromWallet: string;
  toWallet: string;
  updatedAt: string;
}

export interface ReconciliationQueue {
  tasks: ReconciliationTask[];
  /** How many tasks have already been closed, for context. */
  resolvedCount: number;
  productsNeedingReconciliation: ReconciliationProduct[];
  transfersNeedingReconciliation: ReconciliationTransfer[];
}

/** The public runtime configuration the server publishes at `/health`. */
export interface RuntimeConfig {
  solanaNetwork: string;
  solanaClusterLabel: string;
  solanaProgramId: string;
  solanaCommitment: string;
  uploadMaxFileBytes: number;
}

/* ------------------------------------------------------------------ *
 * Narrowing helpers
 * ------------------------------------------------------------------ */

function includes<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

export function isRole(value: string): value is Role {
  return includes(ROLES, value);
}

export function isProductStatus(value: string): value is ProductStatus {
  return includes(PRODUCT_STATUSES, value);
}

export function isChainState(value: string): value is ChainState {
  return includes(CHAIN_STATES, value);
}

export function isTransferStatus(value: string): value is TransferStatus {
  return includes(TRANSFER_STATUSES, value);
}

export function isDeliveryStatus(value: string): value is DeliveryStatus {
  return includes(DELIVERY_STATUSES, value);
}

export function isVerificationResult(value: string): value is VerificationResult {
  return includes(VERIFICATION_RESULTS, value);
}

export function isMediaKind(value: string): value is MediaKind {
  return includes(MEDIA_KINDS, value);
}

export function isAnomalyKind(value: string): value is AnomalyKind {
  return includes(Object.keys(ANOMALY_KIND_LABELS) as AnomalyKind[], value);
}
