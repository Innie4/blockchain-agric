import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { MulterError } from "multer";
import { ZodError } from "zod";
import { AppError, ERROR_CODES } from "../lib/errors.js";
import { childLogger } from "../lib/logger.js";
import { fail } from "../lib/response.js";
import { toValidationError } from "./validate.js";

const log = childLogger({ layer: "errors" });

/** Terminal 404 handler for unmatched routes. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(
    new AppError(ERROR_CODES.NOT_FOUND, {
      message: `No API route matches ${req.method} ${req.path}.`,
    })
  );
}

/**
 * The single place an error becomes a response. Nothing else writes an error
 * body, which is what keeps the envelope consistent and keeps stack traces out
 * of production responses.
 */
export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const normalised = normalise(error);
  const level = normalised.status >= 500 ? "error" : "warn";

  log[level](
    {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      status: normalised.status,
      code: normalised.code,
      problem: normalised.message,
      cause: normalised.cause instanceof Error ? normalised.cause.message : undefined,
    },
    "request failed"
  );

  const exposeCause = process.env["NODE_ENV"] === "development";
  res.status(normalised.status).json(
    fail(
      normalised.code,
      normalised.message,
      exposeCause && normalised.cause instanceof Error
        ? { cause: normalised.cause.message }
        : normalised.details,
      req.requestId
    )
  );
};

function normalise(error: unknown): AppError {
  if (AppError.isAppError(error)) return error;

  if (error instanceof ZodError) return toValidationError(error);

  if (error instanceof MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return new AppError(ERROR_CODES.FILE_TOO_LARGE, {
        message: "One of the uploaded files is larger than the permitted size.",
      });
    }
    if (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE") {
      return new AppError(ERROR_CODES.VALIDATION_ERROR, {
        message: "More files were uploaded than this form accepts.",
        details: [{ path: "files", message: "Too many files." }],
      });
    }
    return new AppError(ERROR_CODES.VALIDATION_ERROR, {
      message: `The upload could not be accepted: ${error.message}`,
    });
  }

  if (isBodyParserError(error)) {
    return new AppError(ERROR_CODES.VALIDATION_ERROR, {
      message: "The request body could not be read as JSON.",
    });
  }

  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "MongoNetworkError" || name === "MongoServerSelectionError") {
    return new AppError(ERROR_CODES.DATABASE_UNAVAILABLE, {
      message: "The database is not reachable right now. Try again shortly.",
      cause: error,
    });
  }
  if (name === "CastError") {
    return new AppError(ERROR_CODES.VALIDATION_ERROR, {
      message: "One of the values in the request is not in the expected format.",
      cause: error,
    });
  }
  if (name === "ValidationError" && typeof error === "object" && error !== null) {
    return new AppError(ERROR_CODES.VALIDATION_ERROR, {
      message: "One of the submitted values is not valid.",
      cause: error,
    });
  }

  log.error({ problem: String(error) }, "unhandled error");
  return new AppError(ERROR_CODES.INTERNAL_ERROR, { cause: error });
}

function isBodyParserError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { type?: string; status?: number };
  return (
    candidate.type === "entity.parse.failed" ||
    candidate.type === "entity.too.large" ||
    (candidate.status === 400 && candidate.type?.startsWith("entity.") === true)
  );
}

/** Wraps a synchronous handler so a throw reaches the error handler. */
export function syncHandler<T extends (...args: never[]) => unknown>(handler: T): RequestHandler {
  return (req, res, next) => {
    try {
      const result = handler(req as never, res as never, next as never);
      if (result instanceof Promise) {
        result.catch(next);
      }
    } catch (error) {
      next(error);
    }
  };
}
