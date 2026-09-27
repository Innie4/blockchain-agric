import { api, type QueryParams } from "./client";
import type {
  ActivityFeed,
  AttestationConfirmed,
  AttestationInput,
  AttestationPrepared,
  AuthChallenge,
  CancelRegistrationResult,
  Certificate,
  CertificateListResponse,
  ComplianceOverview,
  ComplianceReport,
  ComplianceVerificationListResponse,
  DashboardResponse,
  HealthReport,
  LogoutResult,
  LogVerificationResult,
  MediaAttachment,
  NotificationFeed,
  ParticipantListResponse,
  Prepared,
  ProcessingLogAccepted,
  ProcessingLogConfirmed,
  ProcessingLogListResponse,
  Product,
  ProductDetailResponse,
  ProductHistoryResponse,
  ProductListResponse,
  ProductRegistrationAccepted,
  ProductRegistrationConfirmed,
  ProductStatus,
  ReconciliationQueue,
  ReportExportFormat,
  ReportFilterInput,
  ReportListResponse,
  ReaderSource,
  SaleUpdateInput,
  SearchResponse,
  SessionState,
  Transfer,
  TransferAccepted,
  TransferConfirmed,
  TransferListResponse,
  TransportLogAccepted,
  TransportLogConfirmed,
  TransportLogListResponse,
  UpdateProfileInput,
  UpdateStatusInput,
  User,
  VerificationResponse,
  VerificationResult,
  VerifiedSignIn,
} from "./types";

/* ------------------------------------------------------------------ *
 * Session and identity
 * ------------------------------------------------------------------ */

/** Step one of sign-in: ask the server for a single-use challenge. */
export function getNonce(walletAddress: string, signal?: AbortSignal): Promise<AuthChallenge> {
  return api.request<AuthChallenge>("POST", "/auth/nonce", {
    body: { walletAddress },
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Step two of sign-in: exchange a wallet signature for a session cookie. */
export function verifySignature(input: {
  walletAddress: string;
  nonce: string;
  signature: string;
}): Promise<VerifiedSignIn> {
  return api.request<VerifiedSignIn>("POST", "/auth/verify", { body: input });
}

export function logout(signal?: AbortSignal): Promise<LogoutResult> {
  return api.request<LogoutResult>("POST", "/auth/logout", {
    ...(signal === undefined ? {} : { signal }),
  });
}

export function getSession(signal?: AbortSignal): Promise<SessionState> {
  return api.request<SessionState>("GET", "/auth/me", {
    ...(signal === undefined ? {} : { signal }),
  });
}

export function getHealth(signal?: AbortSignal): Promise<HealthReport> {
  return api.request<HealthReport>("GET", "/health", {
    ...(signal === undefined ? {} : { signal }),
  });
}

export function updateProfile(input: UpdateProfileInput, signal?: AbortSignal): Promise<User> {
  return api.request<User>("PATCH", "/users/me", {
    body: input,
    ...(signal === undefined ? {} : { signal }),
  });
}

export interface ParticipantQuery {
  role?: string;
  search?: string;
  limit?: number;
}

export function listParticipants(
  query: ParticipantQuery = {},
  signal?: AbortSignal,
): Promise<ParticipantListResponse> {
  return api.request<ParticipantListResponse>("GET", "/users/participants", {
    query: query as QueryParams,
    ...(signal === undefined ? {} : { signal }),
  });
}

/* ------------------------------------------------------------------ *
 * Products: registration
 * ------------------------------------------------------------------ */

/** Phase one. Returns the unsigned transaction the wallet must sign. */
export function registerProduct(
  formData: FormData,
  signal?: AbortSignal,
): Promise<ProductRegistrationAccepted> {
  return api.request<ProductRegistrationAccepted>("POST", "/products", {
    formData,
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Phase two. Submits wallet-signed bytes and waits for confirmation. */
export function submitProductRegistration(
  productId: string,
  signedTransaction: string,
  signal?: AbortSignal,
): Promise<ProductRegistrationConfirmed> {
  return api.request<ProductRegistrationConfirmed>(
    "POST",
    `/products/${encodeURIComponent(productId)}/submit`,
    { body: { signedTransaction }, ...(signal === undefined ? {} : { signal }) },
  );
}

/** Abandons a prepared registration before anything has been signed. */
export function cancelProductRegistration(
  productId: string,
  signal?: AbortSignal,
): Promise<CancelRegistrationResult> {
  return api.request<CancelRegistrationResult>(
    "POST",
    `/products/${encodeURIComponent(productId)}/cancel`,
    { ...(signal === undefined ? {} : { signal }) },
  );
}

/* ------------------------------------------------------------------ *
 * Products: reading
 * ------------------------------------------------------------------ */

export interface ProductQuery {
  search?: string;
  status?: ProductStatus;
  cropType?: string;
  owner?: string;
  /** `mine` narrows to batches this wallet registered or currently holds. */
  scope?: "mine" | "all";
  page?: number;
  pageSize?: number;
}

export function listProducts(
  query: ProductQuery = {},
  signal?: AbortSignal,
): Promise<ProductListResponse> {
  return api.request<ProductListResponse>("GET", "/products", {
    query: query as QueryParams,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function getProduct(productId: string, signal?: AbortSignal): Promise<ProductDetailResponse> {
  return api.request<ProductDetailResponse>("GET", `/products/${encodeURIComponent(productId)}`, {
    ...(signal === undefined ? {} : { signal }),
  });
}

export function getProductHistory(
  productId: string,
  signal?: AbortSignal,
): Promise<ProductHistoryResponse> {
  return api.request<ProductHistoryResponse>(
    "GET",
    `/products/${encodeURIComponent(productId)}/history`,
    { ...(signal === undefined ? {} : { signal }) },
  );
}

/** Authenticated verification. Records who asked, for the audit trail. */
export function verifyProduct(
  productId: string,
  signal?: AbortSignal,
): Promise<VerificationResponse> {
  return api.request<VerificationResponse>(
    "GET",
    `/products/${encodeURIComponent(productId)}/verify`,
    { ...(signal === undefined ? {} : { signal }) },
  );
}

/** Public verification. No session required. */
export function verifyProductPublic(
  productId: string,
  signal?: AbortSignal,
): Promise<VerificationResponse> {
  return api.request<VerificationResponse>("GET", `/verify/${encodeURIComponent(productId)}`, {
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Records a public verification attempt, including the channel it arrived on. */
export function logVerification(
  productId: string,
  source: ReaderSource,
  signal?: AbortSignal
): Promise<LogVerificationResult> {
  return api.request<LogVerificationResult>(
    "POST",
    `/verify/${encodeURIComponent(productId)}/log`,
    { body: { source }, ...(signal === undefined ? {} : { signal }) },
  );
}

export function searchProducts(
  q: string,
  limit?: number,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  return api.request<SearchResponse>("GET", "/search", {
    query: { q, ...(limit === undefined ? {} : { limit }) },
    ...(signal === undefined ? {} : { signal }),
  });
}

/* ------------------------------------------------------------------ *
 * Products: lifecycle
 * ------------------------------------------------------------------ */

/** Phase one of an on-chain stage change, for example moving to listed or sold. */
export function prepareProductStatusUpdate(
  productId: string,
  input: UpdateStatusInput,
  signal?: AbortSignal,
): Promise<{ prepared: Prepared; product: Product }> {
  return api.request<{ prepared: Prepared; product: Product }>(
    "POST",
    `/products/${encodeURIComponent(productId)}/status/prepare`,
    { body: input, ...(signal === undefined ? {} : { signal }) },
  );
}

/** Phase two of an on-chain stage change. */
export function submitProductStatusUpdate(
  productId: string,
  signedTransaction: string,
  signal?: AbortSignal,
): Promise<Product> {
  return api.request<Product>(
    "POST",
    `/products/${encodeURIComponent(productId)}/status/submit`,
    { body: { signedTransaction }, ...(signal === undefined ? {} : { signal }) },
  );
}

export function updateProductSale(
  productId: string,
  input: SaleUpdateInput,
  signal?: AbortSignal,
): Promise<Product> {
  return api.request<Product>(
    "PATCH",
    `/products/${encodeURIComponent(productId)}/sale`,
    { body: input, ...(signal === undefined ? {} : { signal }) },
  );
}

/* ------------------------------------------------------------------ *
 * Transfers
 * ------------------------------------------------------------------ */

/** Phase one. Builds the ownership-change transaction for the current owner. */
export function createTransfer(
  productId: string,
  toWallet: string,
  note?: string,
  signal?: AbortSignal,
): Promise<TransferAccepted> {
  return api.request<TransferAccepted>(
    "POST",
    `/products/${encodeURIComponent(productId)}/transfers`,
    {
      body: { toWallet, ...(note === undefined ? {} : { note }) },
      ...(signal === undefined ? {} : { signal }),
    },
  );
}

/** Phase two. Submits wallet-signed bytes and waits for confirmation. */
export function submitTransfer(
  transferId: string,
  signedTransaction: string,
  signal?: AbortSignal,
): Promise<TransferConfirmed> {
  return api.request<TransferConfirmed>(
    "POST",
    `/transfers/${encodeURIComponent(transferId)}/submit`,
    { body: { signedTransaction }, ...(signal === undefined ? {} : { signal }) },
  );
}

export interface TransferQuery {
  direction?: "incoming" | "outgoing" | "all";
  status?: string;
  page?: number;
  pageSize?: number;
}

export function listTransfers(
  query: TransferQuery = {},
  signal?: AbortSignal,
): Promise<TransferListResponse> {
  return api.request<TransferListResponse>("GET", "/transfers", {
    query: query as QueryParams,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function listPendingTransfers(
  signal?: AbortSignal,
): Promise<{ transfers: Transfer[] }> {
  return api.request<{ transfers: Transfer[] }>("GET", "/transfers/pending", {
    ...(signal === undefined ? {} : { signal }),
  });
}

export function getTransfer(
  transferId: string,
  signal?: AbortSignal,
): Promise<{
  transfer: Transfer;
  /** True when the signed-in wallet is the recipient and receipt is unconfirmed. */
  canAcknowledge?: boolean;
  viewerRole?: "SENDER" | "RECIPIENT" | "REGULATOR";
}> {
  return api.request<{
    transfer: Transfer;
    canAcknowledge?: boolean;
    viewerRole?: "SENDER" | "RECIPIENT" | "REGULATOR";
  }>("GET", `/transfers/${encodeURIComponent(transferId)}`, {
    ...(signal === undefined ? {} : { signal }),
  });
}

/** The recipient confirms receipt once the goods are physically in hand. */
export function acknowledgeTransfer(
  transferId: string,
  signal?: AbortSignal,
): Promise<{ transfer: Transfer }> {
  return api.request<{ transfer: Transfer }>(
    "POST",
    `/transfers/${encodeURIComponent(transferId)}/acknowledge`,
    { ...(signal === undefined ? {} : { signal }) },
  );
}

/** The sender abandons a transfer they prepared but never signed. */
export function cancelTransfer(
  transferId: string,
  signal?: AbortSignal,
): Promise<{ transfer: Transfer }> {
  return api.request<{ transfer: Transfer }>(
    "POST",
    `/transfers/${encodeURIComponent(transferId)}/cancel`,
    { ...(signal === undefined ? {} : { signal }) },
  );
}

/* ------------------------------------------------------------------ *
 * Processing and transport
 * ------------------------------------------------------------------ */

export function createProcessingLog(
  productId: string,
  formData: FormData,
  signal?: AbortSignal,
): Promise<ProcessingLogAccepted> {
  return api.request<ProcessingLogAccepted>(
    "POST",
    `/products/${encodeURIComponent(productId)}/processing`,
    { formData, ...(signal === undefined ? {} : { signal }) },
  );
}

export function submitProcessingLog(
  productId: string,
  logId: string,
  signedTransaction: string,
  signal?: AbortSignal,
): Promise<ProcessingLogConfirmed> {
  return api.request<ProcessingLogConfirmed>(
    "POST",
    `/products/${encodeURIComponent(productId)}/processing/submit`,
    {
      body: { logId, signedTransaction },
      ...(signal === undefined ? {} : { signal }),
    },
  );
}

export function listProcessingLogs(
  productId: string,
  signal?: AbortSignal,
): Promise<ProcessingLogListResponse> {
  return api.request<ProcessingLogListResponse>(
    "GET",
    `/products/${encodeURIComponent(productId)}/processing`,
    { ...(signal === undefined ? {} : { signal }) },
  );
}

export function createTransportLog(
  productId: string,
  formData: FormData,
  signal?: AbortSignal,
): Promise<TransportLogAccepted> {
  return api.request<TransportLogAccepted>(
    "POST",
    `/products/${encodeURIComponent(productId)}/transport`,
    { formData, ...(signal === undefined ? {} : { signal }) },
  );
}

export function submitTransportLog(
  productId: string,
  logId: string,
  signedTransaction: string,
  signal?: AbortSignal,
): Promise<TransportLogConfirmed> {
  return api.request<TransportLogConfirmed>(
    "POST",
    `/products/${encodeURIComponent(productId)}/transport/submit`,
    {
      body: { logId, signedTransaction },
      ...(signal === undefined ? {} : { signal }),
    },
  );
}

export function listTransportLogs(
  productId: string,
  signal?: AbortSignal,
): Promise<TransportLogListResponse> {
  return api.request<TransportLogListResponse>(
    "GET",
    `/products/${encodeURIComponent(productId)}/transport`,
    { ...(signal === undefined ? {} : { signal }) },
  );
}

/* ------------------------------------------------------------------ *
 * Certificates and media
 * ------------------------------------------------------------------ */

export function attachCertificate(
  productId: string,
  formData: FormData,
  signal?: AbortSignal,
): Promise<{ certificate: Certificate }> {
  return api.request<{ certificate: Certificate }>(
    "POST",
    `/products/${encodeURIComponent(productId)}/certificates`,
    { formData, ...(signal === undefined ? {} : { signal }) },
  );
}

export function listCertificates(
  productId: string,
  signal?: AbortSignal,
): Promise<CertificateListResponse> {
  return api.request<CertificateListResponse>(
    "GET",
    `/products/${encodeURIComponent(productId)}/certificates`,
    { ...(signal === undefined ? {} : { signal }) },
  );
}

export function getCertificate(
  certificateId: string,
  signal?: AbortSignal,
): Promise<{ certificate: Certificate }> {
  return api.request<{ certificate: Certificate }>(
    "GET",
    `/certificates/${encodeURIComponent(certificateId)}`,
    { ...(signal === undefined ? {} : { signal }) },
  );
}

export function attachMedia(
  productId: string,
  formData: FormData,
  signal?: AbortSignal,
): Promise<{ media: MediaAttachment }> {
  return api.request<{ media: MediaAttachment }>(
    "POST",
    `/products/${encodeURIComponent(productId)}/media`,
    { formData, ...(signal === undefined ? {} : { signal }) },
  );
}

/**
 * Fetches a stored file. This uses the binary path and never the JSON envelope,
 * so the bytes arrive intact.
 */
export function downloadMedia(mediaId: string, signal?: AbortSignal): Promise<Blob> {
  return api.download(`/media/${encodeURIComponent(mediaId)}`, {
    ...(signal === undefined ? {} : { signal }),
  });
}

/* ------------------------------------------------------------------ *
 * Compliance
 * ------------------------------------------------------------------ */

export function getComplianceOverview(signal?: AbortSignal): Promise<ComplianceOverview> {
  return api.request<ComplianceOverview>("GET", "/compliance/overview", {
    ...(signal === undefined ? {} : { signal }),
  });
}

export interface VerificationQuery {
  /** Narrows the queue to one outcome. Omitted means every outcome. */
  result?: VerificationResult;
  productId?: string;
  page?: number;
  pageSize?: number;
}

/** The whole queue of checks, for the regulator to work through. */
export function listComplianceVerifications(
  query: VerificationQuery = {},
  signal?: AbortSignal,
): Promise<ComplianceVerificationListResponse> {
  return api.request<ComplianceVerificationListResponse>("GET", "/compliance/verifications", {
    query: query as QueryParams,
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Phase one. Builds the transaction that anchors a finding on the chain. */
export function prepareAttestation(
  input: AttestationInput,
  signal?: AbortSignal,
): Promise<AttestationPrepared> {
  return api.request<AttestationPrepared>("POST", "/compliance/attestations/prepare", {
    body: input,
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Phase two. Submits the signed attestation and waits for confirmation. */
export function submitAttestation(
  input: AttestationInput & { signedTransaction: string },
  signal?: AbortSignal,
): Promise<AttestationConfirmed> {
  return api.request<AttestationConfirmed>("POST", "/compliance/attestations/submit", {
    body: input,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function createComplianceReport(
  input: ReportFilterInput,
  signal?: AbortSignal,
): Promise<ComplianceReport> {
  return api.request<ComplianceReport>("POST", "/compliance/reports", {
    body: input,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function listComplianceReports(
  query: { page?: number; pageSize?: number } = {},
  signal?: AbortSignal,
): Promise<ReportListResponse> {
  return api.request<ReportListResponse>("GET", "/compliance/reports", {
    query: query as QueryParams,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function getComplianceReport(
  reportId: string,
  signal?: AbortSignal,
): Promise<ComplianceReport> {
  return api.request<ComplianceReport>(
    "GET",
    `/compliance/reports/${encodeURIComponent(reportId)}`,
    { ...(signal === undefined ? {} : { signal }) },
  );
}

/** Downloads a generated report. Raw bytes, so the binary path is used. */
export function exportComplianceReport(
  reportId: string,
  format: ReportExportFormat,
  signal?: AbortSignal,
): Promise<Blob> {
  return api.download(`/compliance/reports/${encodeURIComponent(reportId)}/export`, {
    query: { format },
    ...(signal === undefined ? {} : { signal }),
  });
}

/* ------------------------------------------------------------------ *
 * Dashboard, notifications and activity
 * ------------------------------------------------------------------ */

export function getDashboard(signal?: AbortSignal): Promise<DashboardResponse> {
  return api.request<DashboardResponse>("GET", "/dashboard", {
    ...(signal === undefined ? {} : { signal }),
  });
}

export function getNotifications(signal?: AbortSignal): Promise<NotificationFeed> {
  return api.request<NotificationFeed>("GET", "/notifications", {
    ...(signal === undefined ? {} : { signal }),
  });
}

export function markNotificationRead(
  notificationId: string,
  signal?: AbortSignal,
): Promise<{ notification: NotificationFeed["notifications"][number] }> {
  return api.request<{ notification: NotificationFeed["notifications"][number] }>(
    "POST",
    `/notifications/${encodeURIComponent(notificationId)}/read`,
    { ...(signal === undefined ? {} : { signal }) },
  );
}

export function getActivity(
  query: { page?: number; pageSize?: number } = {},
  signal?: AbortSignal,
): Promise<ActivityFeed> {
  return api.request<ActivityFeed>("GET", "/activity", {
    query: query as QueryParams,
    ...(signal === undefined ? {} : { signal }),
  });
}

/* ------------------------------------------------------------------ *
 * Participant registration on the blockchain
 * ------------------------------------------------------------------ */

export interface ParticipantRegistrationInput {
  role: string;
  fullName: string;
  contactEmail: string;
  contactPhone: string;
  organisation: string;
}

export interface ParticipantRegistrationPrepared {
  prepared: Prepared;
  profileHash: string;
}

/**
 * What the server returns once the signed registration has been submitted,
 * confirmed and stored. The fields are the payload itself rather than a wrapper,
 * so a confirmed write is never mis-read as a failure.
 */
export interface ParticipantRegistrationConfirmed {
  walletAddress: string;
  role: string;
  onChainRegistered: boolean;
  profileHash: string;
  transactionSignature: string;
}

/** Phase one. Builds the on-chain participant registration transaction. */
export function prepareParticipantRegistration(
  input: ParticipantRegistrationInput,
  signal?: AbortSignal,
): Promise<ParticipantRegistrationPrepared> {
  return api.request<ParticipantRegistrationPrepared>("POST", "/participant/register/prepare", {
    body: input,
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Phase two. Submits wallet-signed bytes and stores the confirmed registration. */
export function submitParticipantRegistration(
  signedTransaction: string,
  signal?: AbortSignal,
): Promise<ParticipantRegistrationConfirmed> {
  return api.request<ParticipantRegistrationConfirmed>("POST", "/participant/register/submit", {
    body: { signedTransaction },
    ...(signal === undefined ? {} : { signal }),
  });
}

/* ------------------------------------------------------------------ *
 * Operations
 * ------------------------------------------------------------------ */

export function getReconciliationQueue(signal?: AbortSignal): Promise<ReconciliationQueue> {
  return api.request<ReconciliationQueue>("GET", "/operations/reconciliation", {
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Closes a task once the missing database write has been completed by hand. */
export function resolveReconciliationTask(
  taskId: string,
  signal?: AbortSignal,
): Promise<{ taskId: string; status: string; resolvedAt: string | null }> {
  return api.request<{ taskId: string; status: string; resolvedAt: string | null }>(
    "POST",
    `/operations/reconciliation/${encodeURIComponent(taskId)}/resolve`,
    { ...(signal === undefined ? {} : { signal }) },
  );
}
