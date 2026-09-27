import mongoose, { Schema, model, type InferSchemaType, type Model } from "mongoose";

/**
 * A single-use sign-in challenge. The client signs the `message` with the
 * participant's wallet; the server verifies the signature against
 * `walletAddress` and then marks the challenge used, so a captured signature
 * can never be replayed.
 */
const authNonceSchema = new Schema(
  {
    nonce: { type: String, required: true, unique: true, immutable: true },
    walletAddress: { type: String, required: true, index: true },
    /** SHA-256 of the nonce, so a database disclosure cannot replay challenges. */
    nonceHash: { type: String, required: true },
    message: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    requestIp: { type: String, default: null },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true, versionKey: false, collection: "authNonces" }
);

authNonceSchema.index({ walletAddress: 1, createdAt: -1 });
authNonceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type AuthNonceDocument = InferSchemaType<typeof authNonceSchema> & { _id: unknown };

export const AuthNonceModel: Model<AuthNonceDocument> =
  (mongoose.models.AuthNonce as Model<AuthNonceDocument>) ??
  model<AuthNonceDocument>("AuthNonce", authNonceSchema);

/**
 * An authenticated session. The cookie carries a random token; only its
 * SHA-256 is stored, so a database disclosure does not yield usable sessions.
 */
const sessionSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true, immutable: true },
    /** SHA-256 of the cookie token. */
    tokenHash: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    walletAddress: { type: String, required: true },
    /** Double-submit CSRF secret, compared against the `x-csrf-token` header. */
    csrfTokenHash: { type: String, required: true },
    createdAt: { type: Date, required: true, default: () => new Date() },
    lastSeenAt: { type: Date, required: true, default: () => new Date() },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    /** Wallet and browser context, for showing "signed in elsewhere" warnings. */
    userAgent: { type: String, default: "" },
    ipAddress: { type: String, default: "" },
  },
  { timestamps: true, versionKey: false, collection: "sessions" }
);

sessionSchema.index({ walletAddress: 1, createdAt: -1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type SessionDocument = InferSchemaType<typeof sessionSchema> & { _id: unknown };

export const SessionModel: Model<SessionDocument> =
  (mongoose.models.Session as Model<SessionDocument>) ??
  model<SessionDocument>("Session", sessionSchema);

/**
 * Idempotency records. A retried request with the same key returns the stored
 * response instead of creating a second on-chain action.
 */
const idempotencyKeySchema = new Schema(
  {
    key: { type: String, required: true },
    userId: { type: String, required: true },
    method: { type: String, required: true },
    path: { type: String, required: true },
    /** SHA-256 of the canonical request, used to detect key reuse with new data. */
    requestHash: { type: String, required: true },
    state: {
      type: String,
      enum: ["IN_PROGRESS", "COMPLETED"],
      required: true,
      default: "IN_PROGRESS",
    },
    statusCode: { type: Number, default: null },
    responseBody: { type: Schema.Types.Mixed, default: null },
    createdAt: { type: Date, required: true, default: () => new Date() },
    completedAt: { type: Date, default: null },
  },
  { versionKey: false, collection: "idempotencyKeys" }
);

idempotencyKeySchema.index({ key: 1, userId: 1 }, { unique: true });
idempotencyKeySchema.index({ createdAt: 1 }, { expireAfterSeconds: 86_400 });

export type IdempotencyKeyDocument = InferSchemaType<typeof idempotencyKeySchema> & {
  _id: unknown;
};

export const IdempotencyKeyModel: Model<IdempotencyKeyDocument> =
  (mongoose.models.IdempotencyKey as Model<IdempotencyKeyDocument>) ??
  model<IdempotencyKeyDocument>("IdempotencyKey", idempotencyKeySchema);

/**
 * Operations queue for the case the design must handle honestly: the cluster
 * confirmed a transaction but the database write did not land. These records
 * keep the transaction signature and the intended write so an operator can
 * finish the job, and they are surfaced to regulators as anomalies.
 */
const RECONCILIATION_ACTIONS = [
  "COMPLETE_PRODUCT_REGISTRATION",
  "COMPLETE_TRANSFER",
  "COMPLETE_STATUS_UPDATE",
  "COMPLETE_PROCESSING_LOG",
  "COMPLETE_TRANSPORT_LOG",
  "COMPLETE_CERTIFICATE",
] as const;

export { RECONCILIATION_ACTIONS };
export type ReconciliationAction = (typeof RECONCILIATION_ACTIONS)[number];

const reconciliationTaskSchema = new Schema(
  {
    taskId: { type: String, required: true, unique: true, immutable: true },
    action: { type: String, enum: RECONCILIATION_ACTIONS as unknown as string[], required: true },
    status: {
      type: String,
      enum: ["PENDING", "RESOLVED", "FAILED"],
      required: true,
      default: "PENDING",
    },
    productId: { type: String, required: true, index: true },
    transactionSignature: { type: String, required: true },
    /** SHA-256 of the canonical intent, so the retry is provably the same action. */
    intentHash: { type: String, required: true },
    intent: { type: Schema.Types.Mixed, required: true },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    lastError: { type: String, default: null },
    createdAt: { type: Date, required: true, default: () => new Date() },
    resolvedAt: { type: Date, default: null },
  },
  { versionKey: false, collection: "reconciliationTasks" }
);

reconciliationTaskSchema.index({ status: 1, createdAt: -1 });
reconciliationTaskSchema.index({ productId: 1, action: 1 });

export type ReconciliationTaskDocument = InferSchemaType<typeof reconciliationTaskSchema> & {
  _id: unknown;
};

export const ReconciliationTaskModel: Model<ReconciliationTaskDocument> =
  (mongoose.models.ReconciliationTask as Model<ReconciliationTaskDocument>) ??
  model<ReconciliationTaskDocument>("ReconciliationTask", reconciliationTaskSchema);

/**
 * In-application notifications. Transfer receipts and reconciliation warnings
 * are delivered here rather than by email, which the project does not include.
 */
const notificationSchema = new Schema(
  {
    notificationId: { type: String, required: true, unique: true, immutable: true },
    recipientWallet: { type: String, required: true, index: true },
    kind: {
      type: String,
      enum: [
        "TRANSFER_RECEIVED",
        "TRANSFER_SENT",
        "PRODUCT_REGISTERED",
        "PRODUCT_FLAGGED",
        "PRODUCT_RELEASED",
        "VERIFICATION_MISMATCH",
        "RECONCILIATION_REQUIRED",
        "SYSTEM",
      ],
      required: true,
    },
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, required: true, maxlength: 1000 },
    productId: { type: String, default: null },
    linkPath: { type: String, default: null },
    readAt: { type: Date, default: null },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { versionKey: false, collection: "notifications" }
);

notificationSchema.index({ recipientWallet: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 777_600 });

export type NotificationDocument = InferSchemaType<typeof notificationSchema> & { _id: unknown };

export const NotificationModel: Model<NotificationDocument> =
  (mongoose.models.Notification as Model<NotificationDocument>) ??
  model<NotificationDocument>("Notification", notificationSchema);

/**
 * Audit trail for security-relevant actions. Separate from application logs so
 * it can be retained independently and reviewed without log access.
 */
const auditLogSchema = new Schema(
  {
    action: { type: String, required: true, index: true },
    actorWallet: { type: String, default: null, index: true },
    actorRole: { type: String, default: null },
    outcome: { type: String, enum: ["SUCCESS", "DENIED", "FAILED"], required: true },
    resourceType: { type: String, default: null },
    resourceId: { type: String, default: null },
    requestId: { type: String, default: null },
    ipAddress: { type: String, default: null },
    detail: { type: Schema.Types.Mixed, default: null },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { versionKey: false, collection: "auditLogs" }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ actorWallet: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, outcome: 1, createdAt: -1 });

export type AuditLogDocument = InferSchemaType<typeof auditLogSchema> & { _id: unknown };

export const AuditLogModel: Model<AuditLogDocument> =
  (mongoose.models.AuditLog as Model<AuditLogDocument>) ??
  model<AuditLogDocument>("AuditLog", auditLogSchema);
