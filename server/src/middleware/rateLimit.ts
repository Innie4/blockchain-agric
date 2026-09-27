import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import { env } from "../config/env.js";
import { ERROR_CODES } from "../lib/errors.js";
import { fail } from "../lib/response.js";

/**
 * Rate limits for the endpoints that are cheap to abuse: anonymous public
 * verification, sign-in attempts, and uploads. Limits are per-IP and reported
 * through the standard `RateLimit-*` headers.
 */
function build(options: { limit: number; windowMs: number }): RateLimitRequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: () => process.env["NODE_ENV"] === "test",
    handler: (_req, res) => {
      res.status(429).json(
        fail(
          ERROR_CODES.RATE_LIMITED,
          "Too many requests. Wait a moment and try again."
        )
      );
    },
  });
}

/** Anonymous and signed-in traffic on the general API. */
export const generalLimiter = build({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX_AUTHENTICATED,
});

/** Public verification and search, which anyone may call. */
export const publicReadLimiter = build({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX_PUBLIC,
});

/** Wallet challenge issuance and verification. */
export const authLimiter = build({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX_AUTH_ATTEMPTS,
});

/** Multipart uploads, which are the most expensive operation. */
export const uploadLimiter = build({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX_UPLOADS,
});
