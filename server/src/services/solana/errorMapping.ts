import { AppError, ERROR_CODES, type ErrorCode } from "../../lib/errors.js";

/**
 * On-chain error codes. Anchor assigns `6000 + index` to the variants of
 * `AgriTraceError` in declaration order, so these numbers are part of the
 * program's public interface.
 */
export const PROGRAM_ERROR_CODES = {
  DuplicateProduct: 6000,
  UnauthorizedOwner: 6001,
  InvalidRecipient: 6002,
  InvalidStateTransition: 6003,
  MalformedIdentifier: 6004,
  RecipientRoleNotAllowed: 6005,
  RegulatorOnly: 6006,
  ProductFlagged: 6007,
  ProductClosed: 6008,
  ParticipantNotRegistered: 6009,
  InvalidTimestamp: 6010,
  ParticipantAlreadyRegistered: 6011,
  RegistrantRoleNotAllowed: 6012,
} as const;

export type ProgramErrorName = keyof typeof PROGRAM_ERROR_CODES;

const ERROR_CODE_BY_PROGRAM_CODE: Record<number, ErrorCode> = {
  [PROGRAM_ERROR_CODES.DuplicateProduct]: ERROR_CODES.PRODUCT_ALREADY_EXISTS,
  [PROGRAM_ERROR_CODES.UnauthorizedOwner]: ERROR_CODES.TRANSFER_NOT_ALLOWED,
  [PROGRAM_ERROR_CODES.InvalidRecipient]: ERROR_CODES.RECIPIENT_NOT_REGISTERED,
  [PROGRAM_ERROR_CODES.InvalidStateTransition]: ERROR_CODES.PRODUCT_STATE_INVALID,
  [PROGRAM_ERROR_CODES.MalformedIdentifier]: ERROR_CODES.VALIDATION_ERROR,
  [PROGRAM_ERROR_CODES.RecipientRoleNotAllowed]:
    ERROR_CODES.RECIPIENT_ROLE_NOT_ALLOWED,
  [PROGRAM_ERROR_CODES.RegulatorOnly]: ERROR_CODES.ROLE_NOT_ALLOWED,
  [PROGRAM_ERROR_CODES.ProductFlagged]: ERROR_CODES.PRODUCT_STATE_INVALID,
  [PROGRAM_ERROR_CODES.ProductClosed]: ERROR_CODES.PRODUCT_STATE_INVALID,
  [PROGRAM_ERROR_CODES.ParticipantNotRegistered]:
    ERROR_CODES.PARTICIPANT_NOT_REGISTERED,
  [PROGRAM_ERROR_CODES.InvalidTimestamp]: ERROR_CODES.VALIDATION_ERROR,
  [PROGRAM_ERROR_CODES.ParticipantAlreadyRegistered]:
    ERROR_CODES.PARTICIPANT_ALREADY_REGISTERED,
  [PROGRAM_ERROR_CODES.RegistrantRoleNotAllowed]: ERROR_CODES.ROLE_NOT_ALLOWED,
};

/** Anchor's own framework errors that participants can actually trigger. */
const FRAMEWORK_ERROR_NAMES: Record<string, ErrorCode> = {
  ConstraintAlreadyInUse: ERROR_CODES.PRODUCT_ALREADY_EXISTS,
  AccountAlreadyInUse: ERROR_CODES.PRODUCT_ALREADY_EXISTS,
  AccountNotInitialized: ERROR_CODES.RECIPIENT_NOT_REGISTERED,
  AccountDiscriminatorMismatch: ERROR_CODES.RECIPIENT_NOT_REGISTERED,
  ConstraintSeeds: ERROR_CODES.BLOCKCHAIN_TRANSACTION_FAILED,
  ConstraintRentExempt: ERROR_CODES.BLOCKCHAIN_TRANSACTION_FAILED,
  ConstraintAssociated: ERROR_CODES.BLOCKCHAIN_TRANSACTION_FAILED,
  ConstraintRaw: ERROR_CODES.BLOCKCHAIN_TRANSACTION_FAILED,
  ConstraintClose: ERROR_CODES.BLOCKCHAIN_TRANSACTION_FAILED,
  ConstraintAddress: ERROR_CODES.BLOCKCHAIN_TRANSACTION_FAILED,
  ConstraintExecutable: ERROR_CODES.BLOCKCHAIN_TRANSACTION_FAILED,
  ConstraintMut: ERROR_CODES.BLOCKCHAIN_TRANSACTION_FAILED,
  ConstraintOwner: ERROR_CODES.BLOCKCHAIN_TRANSACTION_FAILED,
  ConstraintSigner: ERROR_CODES.BLOCKCHAIN_TRANSACTION_FAILED,
  ConstraintHasOne: ERROR_CODES.BLOCKCHAIN_TRANSACTION_FAILED,
};

const RPC_MESSAGE_HINTS: ReadonlyArray<[RegExp, ErrorCode]> = [
  [/blockhash not found/i, ERROR_CODES.BLOCKCHAIN_TRANSACTION_FAILED],
  [/block height exceeded|exceeded maximum block height/i, ERROR_CODES.BLOCKCHAIN_CONFIRMATION_TIMEOUT],
  [/not confirmed|confirmation status/i, ERROR_CODES.BLOCKCHAIN_CONFIRMATION_TIMEOUT],
  [/user rejected the request/i, ERROR_CODES.WALLET_SIGNATURE_REJECTED],
  [/blockchain operation canceled/i, ERROR_CODES.WALLET_SIGNATURE_REJECTED],
  [/fetch failed|ECONNREFUSED|ENOTFOUND|socket hang up|network error|fetching|http request failed/i, ERROR_CODES.BLOCKCHAIN_RPC_UNAVAILABLE],
  [/429|too many requests|rate limit/i, ERROR_CODES.BLOCKCHAIN_RPC_UNAVAILABLE],
  [/timeout|timed out/i, ERROR_CODES.BLOCKCHAIN_CONFIRMATION_TIMEOUT],
];

interface SolanaErrorShape {
  code?: unknown;
  err?: unknown;
  error?: unknown;
  cause?: unknown;
  data?: unknown;
  logs?: unknown;
  message?: unknown;
  name?: unknown;
  InstructionError?: unknown;
}

/** Reads the code out of the `Custom program error: 0x1770` form used in logs. */
function customProgramCodeFromText(value: string): number | null {
  const match = /custom program error: 0x([0-9a-f]+)/i.exec(value);
  if (match?.[1] === undefined) return null;
  return Number.parseInt(match[1], 16);
}

/**
 * Reads the code out of the `InstructionError: [index, detail]` tuple the RPC
 * returns, where detail is either `{ Custom: 6000 }` from a simulation or the
 * human-readable `Custom program error: 0x1770` from a transaction log.
 */
function customProgramCode(instructionError: unknown): number | null {
  if (!Array.isArray(instructionError) || instructionError.length < 2) return null;
  const detail: unknown = instructionError[1];
  if (typeof detail === "string") return customProgramCodeFromText(detail);
  if (typeof detail === "object" && detail !== null) {
    const custom: unknown = (detail as { Custom?: unknown }).Custom;
    return typeof custom === "number" ? custom : null;
  }
  return null;
}

/** Digs a numeric or named program error code out of a web3.js error object. */
export function extractProgramErrorCode(error: unknown): number | null {
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (typeof current !== "object") continue;
    const candidate = current as SolanaErrorShape;
    if (typeof candidate.code === "number" && candidate.code >= 6000 && candidate.code < 7000) {
      return candidate.code;
    }
    const fromInstruction = customProgramCode(candidate.InstructionError);
    if (fromInstruction !== null) return fromInstruction;
    if (Array.isArray(candidate.logs)) {
      for (const line of candidate.logs) {
        if (typeof line !== "string") continue;
        const fromLog = customProgramCodeFromText(line);
        if (fromLog !== null) return fromLog;
      }
    }
    for (const key of ["err", "cause", "error", "data"] as const) {
      if (candidate[key] !== undefined) stack.push(candidate[key]);
    }
  }
  return null;
}

export function extractErrorName(error: unknown): string | null {
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (typeof current !== "object") continue;
    const candidate = current as SolanaErrorShape;
    if (typeof candidate.name === "string" && candidate.name.length > 0) {
      return candidate.name;
    }
    for (const key of ["err", "cause", "error"] as const) {
      if (candidate[key] !== undefined) stack.push(candidate[key]);
    }
  }
  return null;
}

function collectMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const candidate = error as SolanaErrorShape;
    const parts: string[] = [];
    if (typeof candidate.message === "string") parts.push(candidate.message);
    if (candidate.logs && Array.isArray(candidate.logs)) {
      parts.push(candidate.logs.filter((l): l is string => typeof l === "string").join(" "));
    }
    if (candidate.err !== undefined) parts.push(JSON.stringify(candidate.err));
    return parts.join(" | ");
  }
  return String(error);
}

/**
 * Turns anything the RPC layer or the participant's wallet throws into a
 * single `AppError` with a stable code and a message a farmer can act on.
 */
export function normaliseBlockchainError(error: unknown, context: string): AppError {
  if (AppError.isAppError(error)) return error;

  const programCode = extractProgramErrorCode(error);
  if (programCode !== null) {
    const mapped = ERROR_CODE_BY_PROGRAM_CODE[programCode];
    if (mapped) {
      return new AppError(mapped, {
        message: programMessageFor(mapped),
        details: { programErrorCode: programCode, context },
        cause: error,
      });
    }
  }

  const name = extractErrorName(error);
  if (name && FRAMEWORK_ERROR_NAMES[name]) {
    return new AppError(FRAMEWORK_ERROR_NAMES[name], {
      message: frameworkMessageFor(FRAMEWORK_ERROR_NAMES[name]),
      details: { programErrorName: name, context },
      cause: error,
    });
  }

  const message = collectMessage(error);
  for (const [pattern, code] of RPC_MESSAGE_HINTS) {
    if (pattern.test(message)) {
      return new AppError(code, { details: { context }, cause: error });
    }
  }

  return new AppError(ERROR_CODES.BLOCKCHAIN_TRANSACTION_FAILED, {
    message: `The Solana transaction could not be completed${context ? ` (${context})` : ""}.`,
    details: { context },
    cause: error,
  });
}

function programMessageFor(code: ErrorCode): string | undefined {
  switch (code) {
    case ERROR_CODES.PRODUCT_ALREADY_EXISTS:
      return "A product with that identifier is already registered on-chain.";
    case ERROR_CODES.TRANSFER_NOT_ALLOWED:
      return "Only the wallet that currently owns this product may change it.";
    case ERROR_CODES.RECIPIENT_NOT_REGISTERED:
      return "The recipient is not a registered participant on-chain, so this product cannot be transferred to them.";
    case ERROR_CODES.PRODUCT_STATE_INVALID:
      return "The product is not in a state that allows this change.";
    case ERROR_CODES.RECIPIENT_ROLE_NOT_ALLOWED:
      return "A product may only be transferred to a processor, transporter or retailer.";
    case ERROR_CODES.ROLE_NOT_ALLOWED:
      return "Your participant role may not perform this on-chain action.";
    case ERROR_CODES.PARTICIPANT_ALREADY_REGISTERED:
      return "This wallet already holds an on-chain participant registration.";
    case ERROR_CODES.PARTICIPANT_NOT_REGISTERED:
      return "Your wallet has no on-chain participant registration yet.";
    default:
      return undefined;
  }
}

function frameworkMessageFor(code: ErrorCode): string | undefined {
  switch (code) {
    case ERROR_CODES.PRODUCT_ALREADY_EXISTS:
      return "A record with that identifier already exists on-chain.";
    case ERROR_CODES.RECIPIENT_NOT_REGISTERED:
      return "That wallet has no on-chain participant registration, so it cannot take ownership.";
    default:
      return undefined;
  }
}

/** Maps a numeric status to its name for log messages and diagnostics. */
export function programErrorName(code: number): ProgramErrorName | null {
  const entry = (Object.keys(PROGRAM_ERROR_CODES) as ProgramErrorName[]).find(
    (name) => PROGRAM_ERROR_CODES[name] === code
  );
  return entry ?? null;
}
