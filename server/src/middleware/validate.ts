import type { NextFunction, Request, Response } from "express";
import type { ZodError} from "zod";
import { type ZodSchema } from "zod";
import { AppError, ERROR_CODES, type FieldIssue } from "../lib/errors.js";
import { toFieldIssues } from "../lib/response.js";

type Source = "body" | "query" | "params";

/**
 * Validates one part of a request against a schema and replaces it with the
 * parsed value, so handlers only ever see coerced, trimmed data.
 */
export function validate(schema: ZodSchema, source: Source = "body") {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(toValidationError(result.error));
      return;
    }
    if (source === "query") {
      // Express 5 exposes `req.query` as a getter, so the parsed value is
      // stashed rather than assigned.
      Object.defineProperty(req, "validatedQuery", { value: result.data, configurable: true });
    } else {
      req[source] = result.data as never;
    }
    next();
  };
}

export function validatedQuery<T>(req: Request): T {
  return (req as Request & { validatedQuery?: unknown }).validatedQuery as T;
}

export function toValidationError(error: ZodError): AppError {
  const issues: FieldIssue[] = toFieldIssues(error.issues);
  return new AppError(ERROR_CODES.VALIDATION_ERROR, {
    message: buildMessage(issues),
    details: issues,
  });
}

function buildMessage(issues: FieldIssue[]): string {
  if (issues.length === 0) return "Some of the submitted details are not valid.";
  if (issues.length === 1 && issues[0] !== undefined) {
    return `Check this detail: ${issues[0].message}`;
  }
  return `Check these details: ${issues.map((issue) => issue.message).join("; ")}`;
}
