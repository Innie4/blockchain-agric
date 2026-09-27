import type { NextFunction, Request, Response } from "express";
import { AppError, ERROR_CODES } from "../lib/errors.js";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  sessionMaxAgeSeconds,
} from "../services/auth/cookies.js";
import { resolveSession, verifyCsrf, type ResolvedSession } from "../services/auth/authService.js";
import { SessionModel } from "../models/index.js";
import { sha256Hex } from "../lib/crypto.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: ResolvedSession;
    }
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Resolves the session cookie when present. Never rejects: routes decide
 * whether authentication is required. This lets public verification work
 * identically for a signed-in regulator and an anonymous consumer.
 */
export async function attachSession(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  try {
    const session = await resolveSession(token);
    if (session !== null) {
      req.session = session;
    }
    next();
  } catch (error) {
    next(error);
  }
}

/** Rejects a request with no live session. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (req.session === undefined) {
    next(
      new AppError(ERROR_CODES.UNAUTHORIZED, {
        message:
          "Your session has ended or was never started. Connect your wallet to continue.",
      })
    );
    return;
  }
  next();
}

/**
 * Double-submit CSRF check for state-changing requests. Applied after
 * `requireAuth` because it needs the session's stored CSRF digest.
 */
export async function requireCsrf(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  if (req.session === undefined) {
    next(new AppError(ERROR_CODES.UNAUTHORIZED));
    return;
  }

  const headerValue = req.header(CSRF_HEADER);
  const cookieValue = req.cookies?.[CSRF_COOKIE] as string | undefined;

  if (cookieValue === undefined || headerValue === undefined) {
    next(new AppError(ERROR_CODES.CSRF_TOKEN_INVALID));
    return;
  }
  if (headerValue !== cookieValue) {
    next(new AppError(ERROR_CODES.CSRF_TOKEN_INVALID));
    return;
  }

  const session = await SessionModel.findOne({
    sessionId: req.session.sessionId,
    revokedAt: null,
  }).lean();
  if (session === null) {
    next(new AppError(ERROR_CODES.UNAUTHORIZED));
    return;
  }
  if (!verifyCsrf({ sessionCsrfHash: session.csrfTokenHash, headerValue })) {
    next(new AppError(ERROR_CODES.CSRF_TOKEN_INVALID));
    return;
  }
  next();
}

export { SESSION_COOKIE, CSRF_COOKIE, CSRF_HEADER, sessionMaxAgeSeconds, sha256Hex };
