import { AppError, ERROR_CODES, type FieldIssue } from "./errors.js";

export interface SuccessBody<T> {
  success: true;
  data: T;
  message?: string;
}

export interface ErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

/** Wraps a payload in the single success envelope every endpoint returns. */
export function ok<T>(data: T, message?: string): SuccessBody<T> {
  return message === undefined ? { success: true, data } : { success: true, data, message };
}

/** Wraps a failure in the single error envelope every endpoint returns. */
export function fail(
  code: string,
  message: string,
  details?: unknown,
  requestId?: string
): ErrorBody {
  const error: ErrorBody["error"] = { code, message };
  if (details !== undefined) error.details = details;
  if (requestId !== undefined) error.requestId = requestId;
  return { success: false, error };
}

/** Narrows a Zod-style issue list into the API's field issue shape. */
export function toFieldIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): FieldIssue[] {
  return issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)",
    message: issue.message,
  }));
}

export function assertNever(value: never, context: string): never {
  throw new AppError(ERROR_CODES.INTERNAL_ERROR, {
    message: `Unhandled ${context}: ${String(value)}`,
  });
}
