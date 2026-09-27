/**
 * The single error vocabulary shared by the API, the on-chain program and the
 * React client. Codes are stable strings; the HTTP status attached to each one
 * is applied centrally by the error handler.
 */
export const ERROR_CODES = {
  WALLET_NOT_CONNECTED: "WALLET_NOT_CONNECTED",
  WALLET_SIGNATURE_REJECTED: "WALLET_SIGNATURE_REJECTED",
  UNSUPPORTED_WALLET: "UNSUPPORTED_WALLET",
  AUTH_NONCE_EXPIRED: "AUTH_NONCE_EXPIRED",
  AUTH_NONCE_INVALID: "AUTH_NONCE_INVALID",
  AUTH_SIGNATURE_INVALID: "AUTH_SIGNATURE_INVALID",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  CSRF_TOKEN_INVALID: "CSRF_TOKEN_INVALID",
  ROLE_NOT_ALLOWED: "ROLE_NOT_ALLOWED",
  PARTICIPANT_NOT_REGISTERED: "PARTICIPANT_NOT_REGISTERED",
  PARTICIPANT_ALREADY_REGISTERED: "PARTICIPANT_ALREADY_REGISTERED",
  PRODUCT_NOT_FOUND: "PRODUCT_NOT_FOUND",
  PRODUCT_ALREADY_EXISTS: "PRODUCT_ALREADY_EXISTS",
  PRODUCT_STATE_INVALID: "PRODUCT_STATE_INVALID",
  TRANSFER_NOT_ALLOWED: "TRANSFER_NOT_ALLOWED",
  RECIPIENT_NOT_REGISTERED: "RECIPIENT_NOT_REGISTERED",
  RECIPIENT_ROLE_NOT_ALLOWED: "RECIPIENT_ROLE_NOT_ALLOWED",
  BLOCKCHAIN_RPC_UNAVAILABLE: "BLOCKCHAIN_RPC_UNAVAILABLE",
  BLOCKCHAIN_TRANSACTION_FAILED: "BLOCKCHAIN_TRANSACTION_FAILED",
  BLOCKCHAIN_CONFIRMATION_TIMEOUT: "BLOCKCHAIN_CONFIRMATION_TIMEOUT",
  BLOCKCHAIN_ACCOUNT_NOT_FOUND: "BLOCKCHAIN_ACCOUNT_NOT_FOUND",
  BLOCKCHAIN_CONFIG_MISSING: "BLOCKCHAIN_CONFIG_MISSING",
  DATABASE_UNAVAILABLE: "DATABASE_UNAVAILABLE",
  HASH_MISMATCH: "HASH_MISMATCH",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  UNSUPPORTED_FILE_TYPE: "UNSUPPORTED_FILE_TYPE",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  NOT_FOUND: "NOT_FOUND",
  IDEMPOTENT_REQUEST_CONFLICT: "IDEMPOTENT_REQUEST_CONFLICT",
  RECONCILIATION_REQUIRED: "RECONCILIATION_REQUIRED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

type HttpStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 413
  | 415
  | 422
  | 429
  | 500
  | 502
  | 503
  | 504;

const STATUS_BY_CODE: Record<ErrorCode, HttpStatus> = {
  WALLET_NOT_CONNECTED: 401,
  WALLET_SIGNATURE_REJECTED: 401,
  UNSUPPORTED_WALLET: 400,
  AUTH_NONCE_EXPIRED: 401,
  AUTH_NONCE_INVALID: 401,
  AUTH_SIGNATURE_INVALID: 401,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  CSRF_TOKEN_INVALID: 403,
  ROLE_NOT_ALLOWED: 403,
  PARTICIPANT_NOT_REGISTERED: 422,
  PARTICIPANT_ALREADY_REGISTERED: 409,
  PRODUCT_NOT_FOUND: 404,
  PRODUCT_ALREADY_EXISTS: 409,
  PRODUCT_STATE_INVALID: 409,
  TRANSFER_NOT_ALLOWED: 409,
  RECIPIENT_NOT_REGISTERED: 422,
  RECIPIENT_ROLE_NOT_ALLOWED: 422,
  BLOCKCHAIN_RPC_UNAVAILABLE: 503,
  BLOCKCHAIN_TRANSACTION_FAILED: 502,
  BLOCKCHAIN_CONFIRMATION_TIMEOUT: 504,
  BLOCKCHAIN_ACCOUNT_NOT_FOUND: 404,
  BLOCKCHAIN_CONFIG_MISSING: 503,
  DATABASE_UNAVAILABLE: 503,
  HASH_MISMATCH: 409,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_FILE_TYPE: 415,
  VALIDATION_ERROR: 422,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  IDEMPOTENT_REQUEST_CONFLICT: 409,
  RECONCILIATION_REQUIRED: 409,
  INTERNAL_ERROR: 500,
};

/** Fallback copy used when a failure has no more specific explanation. */
const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
  WALLET_NOT_CONNECTED: "Connect your wallet to continue.",
  WALLET_SIGNATURE_REJECTED: "The wallet signature request was declined.",
  UNSUPPORTED_WALLET:
    "This browser has no supported Solana wallet installed. Install Phantom and reload.",
  AUTH_NONCE_EXPIRED:
    "The sign-in challenge expired. Request a new one and sign again.",
  AUTH_NONCE_INVALID:
    "The sign-in challenge is no longer valid. Request a new one and sign again.",
  AUTH_SIGNATURE_INVALID:
    "The wallet signature could not be verified against the sign-in challenge.",
  UNAUTHORIZED: "You need to sign in with a wallet to view this resource.",
  FORBIDDEN: "Your account may not perform this action.",
  CSRF_TOKEN_INVALID:
    "This request was rejected because its security token was missing or did not match. Reload the page and try again.",
  ROLE_NOT_ALLOWED: "Your participant role may not perform this action.",
  PARTICIPANT_NOT_REGISTERED:
    "Your wallet is not registered on-chain as a supply chain participant yet.",
  PARTICIPANT_ALREADY_REGISTERED:
    "This wallet already holds an on-chain participant registration.",
  PRODUCT_NOT_FOUND: "No product exists with that identifier.",
  PRODUCT_ALREADY_EXISTS:
    "A product with that identifier is already registered on-chain.",
  PRODUCT_STATE_INVALID:
    "The product is not in a state that allows this change.",
  TRANSFER_NOT_ALLOWED: "This product cannot be transferred from its current state.",
  RECIPIENT_NOT_REGISTERED:
    "The recipient wallet is not a registered participant. They must register first.",
  RECIPIENT_ROLE_NOT_ALLOWED:
    "The recipient's role may not take ownership of this product.",
  BLOCKCHAIN_RPC_UNAVAILABLE:
    "The Solana network is not reachable right now. Try again shortly.",
  BLOCKCHAIN_TRANSACTION_FAILED:
    "The Solana transaction was rejected by the network.",
  BLOCKCHAIN_CONFIRMATION_TIMEOUT:
    "The Solana transaction was submitted but did not confirm in time. It may still settle; check the product before retrying.",
  BLOCKCHAIN_ACCOUNT_NOT_FOUND:
    "The on-chain record for this identifier does not exist.",
  BLOCKCHAIN_CONFIG_MISSING:
    "The server is not configured for Solana operation. An administrator must set the Solana environment variables.",
  DATABASE_UNAVAILABLE: "The database is not reachable right now. Try again shortly.",
  HASH_MISMATCH:
    "The stored details do not match the blockchain-anchored record. Treat this product as unverified.",
  FILE_TOO_LARGE: "The uploaded file exceeds the permitted size.",
  UNSUPPORTED_FILE_TYPE: "That file type is not accepted.",
  VALIDATION_ERROR: "Some of the submitted details are not valid.",
  RATE_LIMITED: "Too many requests. Wait a moment and try again.",
  NOT_FOUND: "The requested resource does not exist.",
  IDEMPOTENT_REQUEST_CONFLICT:
    "This request repeats an earlier one with different details. Retry with the original details or use a new idempotency key.",
  RECONCILIATION_REQUIRED:
    "The blockchain transaction succeeded but the record could not be finalised. Support has been notified.",
  INTERNAL_ERROR: "The server could not complete this request.",
};

export interface FieldIssue {
  path: string;
  message: string;
}

export interface AppErrorOptions {
  details?: Record<string, unknown> | FieldIssue[];
  cause?: unknown;
  /** Overrides the default message when a more specific explanation exists. */
  message?: string;
  status?: HttpStatus;
}

/** An error with a stable code, an HTTP status and a safe public message. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: HttpStatus;
  readonly details?: Record<string, unknown> | FieldIssue[];
  override readonly cause?: unknown;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(options.message ?? DEFAULT_MESSAGE[code]);
    this.name = "AppError";
    this.code = code;
    this.status = options.status ?? STATUS_BY_CODE[code];
    this.details = options.details;
    this.cause = options.cause;
  }

  static isAppError(value: unknown): value is AppError {
    return value instanceof AppError;
  }
}

export function statusForCode(code: ErrorCode): HttpStatus {
  return STATUS_BY_CODE[code];
}

export function defaultMessageForCode(code: ErrorCode): string {
  return DEFAULT_MESSAGE[code];
}

/** Builds a validation failure carrying one issue per rejected field. */
export function validationError(issues: FieldIssue[]): AppError {
  return new AppError(ERROR_CODES.VALIDATION_ERROR, { details: issues });
}
