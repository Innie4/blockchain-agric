import type { FieldIssue } from "./types";

/**
 * The stable error vocabulary shared by the API, the on-chain program and this
 * client. These strings must match `server/src/lib/errors.ts` exactly: the
 * client switches on them to decide what the participant is told to do next.
 */
export const API_ERROR_CODES = [
  "WALLET_NOT_CONNECTED",
  "WALLET_SIGNATURE_REJECTED",
  "UNSUPPORTED_WALLET",
  "AUTH_NONCE_EXPIRED",
  "AUTH_NONCE_INVALID",
  "AUTH_SIGNATURE_INVALID",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "CSRF_TOKEN_INVALID",
  "ROLE_NOT_ALLOWED",
  "PARTICIPANT_NOT_REGISTERED",
  "PARTICIPANT_ALREADY_REGISTERED",
  "PRODUCT_NOT_FOUND",
  "PRODUCT_ALREADY_EXISTS",
  "PRODUCT_STATE_INVALID",
  "TRANSFER_NOT_ALLOWED",
  "RECIPIENT_NOT_REGISTERED",
  "RECIPIENT_ROLE_NOT_ALLOWED",
  "BLOCKCHAIN_RPC_UNAVAILABLE",
  "BLOCKCHAIN_TRANSACTION_FAILED",
  "BLOCKCHAIN_CONFIRMATION_TIMEOUT",
  "BLOCKCHAIN_ACCOUNT_NOT_FOUND",
  "BLOCKCHAIN_CONFIG_MISSING",
  "DATABASE_UNAVAILABLE",
  "HASH_MISMATCH",
  "FILE_TOO_LARGE",
  "UNSUPPORTED_FILE_TYPE",
  "VALIDATION_ERROR",
  "RATE_LIMITED",
  "NOT_FOUND",
  "IDEMPOTENT_REQUEST_CONFLICT",
  "RECONCILIATION_REQUIRED",
  "INTERNAL_ERROR",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * Local copy for each code, written for the person doing the work rather than
 * for a developer reading a log. The server sends its own `message` and that is
 * preferred; this is the fallback when a failure never reached the server, or
 * when a proxy answered instead of the application.
 */
export const ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  WALLET_NOT_CONNECTED:
    "Connect your wallet first. Everything you do here is recorded against the wallet you sign with.",
  WALLET_SIGNATURE_REJECTED:
    "You declined the signature request, so nothing was written to the blockchain. You can try again whenever you are ready.",
  UNSUPPORTED_WALLET:
    "This browser has no Solana wallet we can use. Install Phantom or another Solana wallet, then reload this page.",
  AUTH_NONCE_EXPIRED:
    "The sign-in request expired before it was signed. Ask for a new one and sign it straight away.",
  AUTH_NONCE_INVALID:
    "That sign-in request is no longer usable. Ask for a new one and sign that instead.",
  AUTH_SIGNATURE_INVALID:
    "The wallet signature did not match the sign-in request. Check that you signed with the same wallet you connected, then try again.",
  UNAUTHORIZED:
    "You need to connect your wallet and sign in before you can see this.",
  FORBIDDEN:
    "This action is not open to your account. If you think that is wrong, ask a regulator to review your participant role.",
  CSRF_TOKEN_INVALID:
    "The page lost its security token, so the request was refused. Reload the page and try again; nothing was changed.",
  ROLE_NOT_ALLOWED:
    "Your participant role does not cover this action. A farmer registers produce, a processor records processing, a transporter records transport, and a retailer handles sale.",
  PARTICIPANT_NOT_REGISTERED:
    "Your wallet is not yet a registered participant on the blockchain. Register it first, then this action becomes available.",
  PARTICIPANT_ALREADY_REGISTERED:
    "This wallet is already registered as a participant on the blockchain, so it cannot be registered a second time.",
  PRODUCT_NOT_FOUND:
    "No batch is recorded under that identifier. Check the identifier, or search for the crop and farm instead.",
  PRODUCT_ALREADY_EXISTS:
    "A batch with that identifier is already registered on the blockchain. Identifiers are permanent, so choose a different one.",
  PRODUCT_STATE_INVALID:
    "This batch is not at a stage where that change can be made. Check its current status on the product page.",
  TRANSFER_NOT_ALLOWED:
    "This batch cannot change hands right now. A regulator may have withheld it, or it may already have been sold.",
  RECIPIENT_NOT_REGISTERED:
    "That wallet is not a registered participant. Ask them to register on the blockchain before you send them a batch.",
  RECIPIENT_ROLE_NOT_ALLOWED:
    "A batch can only be handed to a processor, a transporter or a retailer. This wallet holds a different role.",
  BLOCKCHAIN_RPC_UNAVAILABLE:
    "The Solana network could not be reached, so the record was not written. Wait a moment and try again.",
  BLOCKCHAIN_TRANSACTION_FAILED:
    "Solana rejected the transaction. Nothing was recorded. Check your wallet's balance and network, then prepare the record again.",
  BLOCKCHAIN_CONFIRMATION_TIMEOUT:
    "The transaction reached Solana but confirmation took too long. It may still settle, so open the batch before trying again.",
  BLOCKCHAIN_ACCOUNT_NOT_FOUND:
    "There is no on-chain record for this identifier. If the batch exists here, the blockchain write never completed.",
  BLOCKCHAIN_CONFIG_MISSING:
    "This deployment is not configured to talk to Solana. A system administrator needs to set the Solana settings before blockchain actions will work.",
  DATABASE_UNAVAILABLE:
    "The records service is not reachable, so nothing was saved. Wait a moment and try again.",
  HASH_MISMATCH:
    "The stored details no longer match the copy anchored on the blockchain. Treat this batch as unverified and report it to a regulator.",
  FILE_TOO_LARGE:
    "That file is larger than the upload limit. Reduce its size, or split the document, and try again.",
  UNSUPPORTED_FILE_TYPE:
    "That file type is not accepted. Upload a JPEG, PNG or WebP image, or a PDF document.",
  VALIDATION_ERROR:
    "Some of the details are not valid. Correct the highlighted fields and try again.",
  RATE_LIMITED:
    "You have made a lot of requests in a short time. Wait about a minute before trying again.",
  NOT_FOUND:
    "That record does not exist. It may have been removed, or the link may be out of date.",
  IDEMPOTENT_REQUEST_CONFLICT:
    "This request repeats an earlier one but with different details, which cannot be allowed. Refresh the page and start again.",
  RECONCILIATION_REQUIRED:
    "Solana accepted the transaction but the matching record could not be saved. Nothing has been lost. A regulator has been notified and can finish it.",
  INTERNAL_ERROR: "The server could not complete this request. Wait a moment and try again.",
};

/**
 * What the participant can actually do about a failure. Kept separate from the
 * message so the two can change independently, and so the interface can show a
 * recovery step instead of only a complaint.
 */
export const RECOVERY_HINTS: Partial<Record<ApiErrorCode, string>> = {
  WALLET_NOT_CONNECTED: "Connect the wallet that owns this batch, then try again.",
  WALLET_SIGNATURE_REJECTED:
    "Nothing was written. Prepare the record again when you are ready to sign.",
  UNSUPPORTED_WALLET:
    "Install a Solana wallet such as Phantom, then reload this page.",
  AUTH_NONCE_EXPIRED: "Ask for a fresh sign-in request and sign it immediately.",
  AUTH_NONCE_INVALID: "Ask for a fresh sign-in request.",
  AUTH_SIGNATURE_INVALID:
    "Make sure the wallet you connected is the one doing the signing, then ask for a new request.",
  CSRF_TOKEN_INVALID: "Reload the page, then repeat the action.",
  UNAUTHORIZED: "Connect your wallet and sign in, then try again.",
  FORBIDDEN: "Ask a regulator to confirm which actions your role permits.",
  ROLE_NOT_ALLOWED: "Ask a regulator to confirm which actions your role permits.",
  PARTICIPANT_NOT_REGISTERED:
    "Register the wallet as a participant from your profile page, then return here.",
  PRODUCT_NOT_FOUND: "Return to the product list and open the batch from there.",
  PRODUCT_STATE_INVALID: "Reload the product to see its current status.",
  TRANSFER_NOT_ALLOWED: "Reload the product to see its current status and owner.",
  RECIPIENT_NOT_REGISTERED: "Ask the recipient to register, then select them again.",
  RECIPIENT_ROLE_NOT_ALLOWED: "Choose a processor, transporter or retailer as the recipient.",
  BLOCKCHAIN_RPC_UNAVAILABLE:
    "Wait about a minute. The Solana network is reached through a public endpoint that is occasionally busy.",
  BLOCKCHAIN_TRANSACTION_FAILED:
    "Check the wallet has enough Solana for the fee, then prepare the record again.",
  BLOCKCHAIN_CONFIRMATION_TIMEOUT:
    "Open the batch in a minute. If the record appears there, no further action is needed.",
  DATABASE_UNAVAILABLE: "Wait about a minute, then repeat the action.",
  HASH_MISMATCH: "Report the batch to a regulator. Do not act on its details.",
  FILE_TOO_LARGE: "Compress the file or upload a smaller one.",
  UNSUPPORTED_FILE_TYPE: "Convert the file to JPEG, PNG, WebP or PDF.",
  RATE_LIMITED: "Wait about a minute before trying again.",
  IDEMPOTENT_REQUEST_CONFLICT: "Reload the page and submit the form once.",
  RECONCILIATION_REQUIRED:
    "No action is needed from you. Do not repeat the action; a regulator will finish the record.",
  INTERNAL_ERROR: "Wait a moment and try again. If it keeps happening, report the time.",
};

export interface ApiErrorInit {
  code: ApiErrorCode;
  status: number;
  message?: string;
  details?: unknown;
  requestId?: string;
  isNetworkError?: boolean;
  cause?: unknown;
}

export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly requestId?: string;
  /** True when the request never reached the server at all. */
  readonly isNetworkError: boolean;
  readonly cause?: unknown;

  constructor(init: ApiErrorInit) {
    super(init.message ?? ERROR_MESSAGES[init.code] ?? ERROR_MESSAGES.INTERNAL_ERROR);
    this.code = init.code;
    this.status = init.status;
    this.details = init.details;
    this.requestId = init.requestId;
    this.isNetworkError = init.isNetworkError ?? false;
    this.cause = init.cause;
  }

  static isApiError(value: unknown): value is ApiError {
    return value instanceof ApiError;
  }

  /** Builds the failure raised when `fetch` itself rejects. */
  static network(message: string, cause?: unknown): ApiError {
    return new ApiError({
      code: "DATABASE_UNAVAILABLE",
      status: 0,
      message,
      isNetworkError: true,
      ...(cause === undefined ? {} : { cause }),
    });
  }

  /** True for failures a plain retry is likely to clear. */
  get isRetryable(): boolean {
    if (this.isNetworkError) return true;
    return (
      this.code === "RATE_LIMITED" ||
      this.code === "DATABASE_UNAVAILABLE" ||
      this.code === "BLOCKCHAIN_RPC_UNAVAILABLE"
    );
  }

  /** The one actionable next step for this failure, when there is one. */
  get recoveryHint(): string | null {
    return RECOVERY_HINTS[this.code] ?? null;
  }
}

function isKnownCode(value: string): value is ApiErrorCode {
  return (API_ERROR_CODES as readonly string[]).includes(value);
}

/** Narrows a code from the wire, which is typed as a plain string. */
export function toApiErrorCode(value: string): ApiErrorCode {
  return isKnownCode(value) ? value : "INTERNAL_ERROR";
}

/**
 * The single place that turns an unknown thrown value into a sentence fit for a
 * participant. Server copy wins, then the local vocabulary, then a plain
 * statement of fact.
 */
export function messageForError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message.length > 0 ? error.message : ERROR_MESSAGES[error.code];
  }
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return ERROR_MESSAGES.INTERNAL_ERROR;
}

/** The recovery step for a failure, or `null` when there is nothing to suggest. */
export function recoveryHintFor(error: unknown): string | null {
  if (error instanceof ApiError) return error.recoveryHint;
  return null;
}

/**
 * Field-level issues from a `VALIDATION_ERROR`. The server sends them as either
 * an array of `{ path, message }` or an object keyed by field name; both shapes
 * are normalised so a form can render them without special-casing.
 */
export function fieldIssuesOf(error: unknown): FieldIssue[] {
  if (!(error instanceof ApiError) || error.details === undefined) return [];

  const { details } = error;
  if (Array.isArray(details)) {
    return details.flatMap((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return [];
      const path = (entry as { path?: unknown }).path;
      const message = (entry as { message?: unknown }).message;
      if (typeof path !== "string" || typeof message !== "string") return [];
      return [{ path, message }];
    });
  }

  if (typeof details === "object") {
    return Object.entries(details as Record<string, unknown>).flatMap(([path, value]) => {
      if (typeof value === "string") return [{ path, message: value }];
      if (Array.isArray(value)) {
        return value.flatMap((item: unknown) =>
          typeof item === "string" ? [{ path, message: item }] : [],
        );
      }
      return [];
    });
  }

  return [];
}

/** The message recorded against a named field, if the server rejected it. */
export function fieldErrorFor(error: unknown, field: string): string | undefined {
  return fieldIssuesOf(error).find((issue) => issue.path === field)?.message;
}
