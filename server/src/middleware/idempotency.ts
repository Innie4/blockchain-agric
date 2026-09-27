import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { AppError, ERROR_CODES } from "../lib/errors.js";
import { sha256Hex } from "../lib/crypto.js";
import { childLogger } from "../lib/logger.js";
import { IdempotencyKeyModel } from "../models/index.js";

const log = childLogger({ layer: "idempotency" });

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      idempotency?: {
        key: string;
        requestHash: string;
        recordId: string;
      };
    }
  }
}

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Fingerprints the parts of a request that define its identity. Multipart
 * bodies are represented by their field names and file digests rather than raw
 * bytes, so the fingerprint stays stable across an identical resubmission.
 */
function fingerprint(req: Request): string {
  const parts: string[] = [req.method, req.path];
  if (req.query !== undefined && Object.keys(req.query).length > 0) {
    parts.push(JSON.stringify(sortedEntries(req.query)));
  }
  if (req.body !== undefined && req.body !== null && typeof req.body === "object") {
    const body = req.body as Record<string, unknown>;
    const files: string[] = [];
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      if (Buffer.isBuffer(value)) {
        files.push(`${key}:${sha256Hex(value)}`);
      } else if (typeof value === "object") {
        files.push(`${key}:${JSON.stringify(value)}`);
      } else {
        parts.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
      }
    }
    if (files.length > 0) parts.push(files.sort().join("|"));
  }
  return sha256Hex(parts.join("\n"));
}

function sortedEntries(value: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Records the response for a state-changing request keyed by `Idempotency-Key`,
 * so a retried request replays the original outcome instead of creating a
 * second blockchain action. Requests without the header are allowed through:
 * the header is how a careful client opts into exactly-once behaviour.
 */
export function idempotency() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = req.header("idempotency-key");
    if (key === undefined || key.length === 0 || !STATE_CHANGING.has(req.method)) {
      next();
      return;
    }
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
      next(
        new AppError(ERROR_CODES.VALIDATION_ERROR, {
          message:
            "An idempotency key may contain letters, digits, dots, colons, dashes and underscores, and must be between 8 and 128 characters.",
          details: [{ path: "Idempotency-Key", message: "Unusable key." }],
        })
      );
      return;
    }
    if (req.session === undefined) {
      next();
      return;
    }
    // The middleware also runs for the whole `/api` prefix, so a route that
    // declares it explicitly would otherwise see its own reservation as a
    // concurrent duplicate and refuse the very request the key was sent for.
    if (req.idempotency !== undefined) {
      next();
      return;
    }

    const requestHash = fingerprint(req);
    const userId = req.session.userId;

    try {
      const existing = await IdempotencyKeyModel.findOne({ key, userId }).lean();
      if (existing !== null) {
        if (existing.requestHash !== requestHash) {
          next(
            new AppError(ERROR_CODES.IDEMPOTENT_REQUEST_CONFLICT, {
              details: { key },
            })
          );
          return;
        }
        if (existing.state === "COMPLETED" && existing.responseBody !== null) {
          log.info({ key, userId }, "replaying stored idempotent response");
          res
            .status(existing.statusCode ?? 200)
            .setHeader("idempotent-replay", "true")
            .json(existing.responseBody);
          return;
        }
        // A previous attempt is still in flight; refuse rather than duplicate it.
        next(
          new AppError(ERROR_CODES.IDEMPOTENT_REQUEST_CONFLICT, {
            message:
              "An identical request is still being processed. Wait for it to finish before retrying.",
            details: { key },
          })
        );
        return;
      }

      await IdempotencyKeyModel.create({
        key,
        userId,
        method: req.method,
        path: req.path,
        requestHash,
        state: "IN_PROGRESS",
      });
    } catch (error) {
      // A duplicate insert means a concurrent request won the race.
      if ((error as { code?: number }).code === 11000) {
        res.status(409).json({
          success: false,
          error: {
            code: ERROR_CODES.IDEMPOTENT_REQUEST_CONFLICT,
            message:
              "An identical request is already being processed. Wait for it to finish before retrying.",
          },
        });
        return;
      }
      next(error);
      return;
    }

    req.idempotency = { key, requestHash, recordId: `${userId}:${key}` };

    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      void IdempotencyKeyModel.updateOne(
        { key, userId },
        {
          $set: {
            state: "COMPLETED",
            statusCode: res.statusCode,
            responseBody: body,
            completedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        }
      ).catch((error: unknown) => {
        log.error({ key, problem: String(error) }, "could not store idempotent response");
      });
      return originalJson(body);
    }) as Response["json"];

    next();
  };
}

/** Releases a reservation so a client may retry after a failure. */
export async function releaseIdempotencyKey(
  key: string | undefined,
  userId: string | undefined
): Promise<void> {
  if (key === undefined || userId === undefined) return;
  await IdempotencyKeyModel.deleteOne({ key, userId, state: "IN_PROGRESS" }).catch(() => undefined);
}

export function idempotencyTtlSeconds(): number {
  return env.IDEMPOTENCY_TTL_SECONDS;
}
