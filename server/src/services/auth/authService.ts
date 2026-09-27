import { randomBytes } from "node:crypto";
import { env } from "../../config/env.js";
import { AppError, ERROR_CODES } from "../../lib/errors.js";
import {
  generateCsrfToken,
  generateSessionToken,
  newId,
  normaliseWallet,
  safeEqual,
  sessionTokenDigest,
  sha256Hex,
  stringOr,
} from "../../lib/crypto.js";
import { childLogger } from "../../lib/logger.js";
import { UserModel, SessionModel, AuthNonceModel, AuditLogModel } from "../../models/index.js";
import type { ParticipantRoleValue } from "../../lib/roles.js";
import { SIGN_IN_DOMAIN } from "./cookies.js";
import { assertValidSignature, buildSignInMessage } from "./signature.js";

const log = childLogger({ layer: "auth" });

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export interface IssuedChallenge {
  nonce: string;
  message: string;
  expiresAt: string;
  /** Minimum seconds the client should wait before asking the wallet to sign. */
  notBefore: string;
}

export interface AuthenticatedUser {
  userId: string;
  walletAddress: string;
  fullName: string;
  role: ParticipantRoleValue;
  contactInfo: { email: string; phone: string; address: string; state: string };
  organisation: string;
  status: string;
  onChainRegistered: boolean;
  onChainRegistrationTx: string | null;
  profileHash: string | null;
  registrationDate: string;
  lastSeen: string;
}

export interface SessionGrant {
  sessionId: string;
  user: AuthenticatedUser;
  token: string;
  csrfToken: string;
  expiresAt: string;
}


export function toAuthenticatedUser(record: Record<string, unknown>): AuthenticatedUser {
  const contact = (record.contactInfo ?? {}) as Record<string, unknown>;
  return {
    userId: String(record.userId),
    walletAddress: String(record.walletAddress),
    fullName: stringOr(record.fullName),
    role: String(record.role) as ParticipantRoleValue,
    contactInfo: {
      email: stringOr(contact.email),
      phone: stringOr(contact.phone),
      address: stringOr(contact.address),
      state: stringOr(contact.state),
    },
    organisation: stringOr(record.organisation),
    status: stringOr(record.status, "ACTIVE"),
    onChainRegistered: Boolean(record.onChainRegistered),
    onChainRegistrationTx:
      record.onChainRegistrationTx === null || record.onChainRegistrationTx === undefined
        ? null
        : stringOr(record.onChainRegistrationTx),
    profileHash:
      record.profileHash === null || record.profileHash === undefined
        ? null
        : stringOr(record.profileHash),
    registrationDate: toIso(record.registrationDate),
    lastSeen: toIso(record.lastSeen),
  };
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date(0).toISOString();
}

/**
 * Issues a single-use sign-in challenge for a wallet address.
 *
 * The nonce is stored hashed and expires, so a leaked database row cannot be
 * replayed and an intercepted signature is only usable within the window.
 */
export async function issueChallenge(input: {
  walletAddress: string;
  requestIp?: string | undefined;
}): Promise<IssuedChallenge> {
  const walletAddress = normaliseWallet(input.walletAddress);
  const user = await UserModel.findOne({ walletAddress }).lean();
  if (user?.lockedUntil instanceof Date && user.lockedUntil.getTime() > Date.now()) {
    throw new AppError(ERROR_CODES.RATE_LIMITED, {
      message: `Too many failed sign-in attempts. Try again after ${user.lockedUntil.toISOString()}.`,
    });
  }

  const nonce = randomBytes(32).toString("base64url");
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + env.AUTH_NONCE_TTL_SECONDS * 1000);
  const challenge = buildSignInMessage({
    domain: SIGN_IN_DOMAIN,
    walletAddress,
    nonce,
    issuedAt,
    expiresAt,
  });

  await AuthNonceModel.create({
    nonce,
    walletAddress,
    nonceHash: sha256Hex(nonce),
    message: challenge.message,
    expiresAt,
    requestIp: input.requestIp ?? null,
  });

  return {
    nonce,
    message: challenge.message,
    expiresAt: expiresAt.toISOString(),
    notBefore: issuedAt.toISOString(),
  };
}

export interface VerifiedSignIn {
  walletAddress: string;
  user: AuthenticatedUser;
  isNewParticipant: boolean;
  needsRoleSelection: boolean;
  needsOnChainRegistration: boolean;
}

/**
 * Consumes a challenge and proves control of the wallet.
 *
 * The nonce is marked used in the same call that verifies the signature, and a
 * nonce can only be used once, so a captured signed message is worthless.
 */
export async function verifyChallenge(input: {
  walletAddress: string;
  nonce: string;
  signature: string;
  requestIp?: string | undefined;
  userAgent?: string | undefined;
}): Promise<VerifiedSignIn> {
  const walletAddress = normaliseWallet(input.walletAddress);
  const nonceRecord = await AuthNonceModel.findOne({ nonce: input.nonce });

  if (nonceRecord === null) {
    throw new AppError(ERROR_CODES.AUTH_NONCE_INVALID, {
      message:
        "That sign-in challenge is not recognised. Request a new challenge and sign it.",
    });
  }
  if (nonceRecord.walletAddress !== walletAddress) {
    throw new AppError(ERROR_CODES.AUTH_NONCE_INVALID, {
      message:
        "That sign-in challenge was issued for a different wallet. Request a new challenge from this wallet.",
    });
  }
  if (nonceRecord.usedAt !== null && nonceRecord.usedAt !== undefined) {
    throw new AppError(ERROR_CODES.AUTH_NONCE_INVALID, {
      message:
        "That sign-in challenge has already been used. Request a new challenge and sign it.",
    });
  }
  if (nonceRecord.expiresAt.getTime() <= Date.now()) {
    throw new AppError(ERROR_CODES.AUTH_NONCE_EXPIRED);
  }
  if (nonceRecord.attempts >= MAX_FAILED_ATTEMPTS) {
    throw new AppError(ERROR_CODES.RATE_LIMITED, {
      message:
        "Too many attempts to use this sign-in challenge. Request a new one.",
    });
  }

  nonceRecord.attempts += 1;
  await nonceRecord.save();

  try {
    assertValidSignature({
      walletAddress,
      message: nonceRecord.message,
      signature: input.signature,
    });
  } catch (error) {
    await recordFailedSignIn(walletAddress);
    await writeAudit({
      action: "auth.verify",
      actorWallet: walletAddress,
      outcome: "DENIED",
      detail: { reason: AppError.isAppError(error) ? error.code : "unknown" },
      ipAddress: input.requestIp,
    });
    throw error;
  }

  nonceRecord.usedAt = new Date();
  await nonceRecord.save();

  const existing = await UserModel.findOne({ walletAddress });
  const now = new Date();

  if (existing === null) {
    // A wallet that has never signed in is a consumer by default. Consumers can
    // verify publicly and hold no privileged role; a business role is only
    // granted deliberately, on-chain and off-chain.
    const created = await UserModel.create({
      userId: newId(),
      walletAddress,
      fullName: "",
      role: "CONSUMER",
      status: "ACTIVE",
      registrationDate: now,
      lastSeen: now,
      onChainRegistered: false,
    });
    log.info({ walletAddress }, "created participant record on first sign-in");
    return {
      walletAddress,
      user: toAuthenticatedUser(created.toObject()),
      isNewParticipant: true,
      needsRoleSelection: true,
      needsOnChainRegistration: false,
    };
  }

  if (existing.status !== "ACTIVE") {
    throw new AppError(ERROR_CODES.FORBIDDEN, {
      message:
        existing.status === "SUSPENDED"
          ? "This account is suspended. Contact a regulator."
          : "This account has been withdrawn.",
    });
  }

  existing.lastSeen = now;
  existing.failedAuthAttempts = 0;
  existing.lockedUntil = null;
  await existing.save();

  return {
    walletAddress,
    user: toAuthenticatedUser(existing.toObject()),
    isNewParticipant: false,
    needsRoleSelection: existing.role === "CONSUMER",
    needsOnChainRegistration: !existing.onChainRegistered && existing.role !== "CONSUMER",
  };
}

async function recordFailedSignIn(walletAddress: string): Promise<void> {
  const user = await UserModel.findOne({ walletAddress });
  if (user === null) return;
  user.failedAuthAttempts += 1;
  if (user.failedAuthAttempts >= MAX_FAILED_ATTEMPTS) {
    user.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
    log.warn({ walletAddress }, "wallet locked after repeated failed sign-ins");
  }
  await user.save();
}

/** Creates a session bound to the verified wallet. */
export async function createSession(input: {
  walletAddress: string;
  userId: string;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}): Promise<SessionGrant> {
  const token = generateSessionToken();
  const csrfToken = generateCsrfToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.SESSION_TTL_SECONDS * 1000);
  const sessionId = newId();

  await SessionModel.create({
    sessionId,
    tokenHash: sessionTokenDigest(token, env.SESSION_SECRET),
    userId: input.userId,
    walletAddress: input.walletAddress,
    csrfTokenHash: sha256Hex(csrfToken),
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
    userAgent: input.userAgent ?? "",
    ipAddress: input.ipAddress ?? "",
  });

  const user = await UserModel.findOne({ userId: input.userId }).lean();
  if (user === null) {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, {
      message: "The participant record for this session no longer exists.",
    });
  }

  return {
    sessionId,
    user: toAuthenticatedUser(user),
    token,
    csrfToken,
    expiresAt: expiresAt.toISOString(),
  };
}

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  walletAddress: string;
  user: AuthenticatedUser;
}

/** Resolves a session cookie to a live session and participant record. */
export async function resolveSession(token: string | undefined): Promise<ResolvedSession | null> {
  if (token === undefined || token.length === 0) return null;
  const session = await SessionModel.findOne({
    tokenHash: sessionTokenDigest(token, env.SESSION_SECRET),
    revokedAt: null,
  });
  if (session === null) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;

  const user = await UserModel.findOne({ userId: session.userId }).lean();
  if (user === null) return null;
  if (user.status !== "ACTIVE") return null;

  session.lastSeenAt = new Date();
  await session.save();

  return {
    sessionId: session.sessionId,
    userId: session.userId,
    walletAddress: session.walletAddress,
    user: toAuthenticatedUser(user),
  };
}

/**
 * Confirms a state-changing request really came from the session's own page.
 *
 * The CSRF cookie is readable by scripts by design, so an attacker's page can
 * read it but cannot read the `httpOnly` session cookie that authorises the
 * request. Requiring both halves defeats cross-site requests.
 */
export function verifyCsrf(input: {
  sessionCsrfHash: string;
  headerValue: string | undefined;
}): boolean {
  if (input.headerValue === undefined || input.headerValue.length === 0) return false;
  return safeEqual(sha256Hex(input.headerValue), input.sessionCsrfHash);
}

export async function revokeSession(token: string | undefined): Promise<void> {
  if (token === undefined || token.length === 0) return;
  await SessionModel.updateOne(
    { tokenHash: sessionTokenDigest(token, env.SESSION_SECRET), revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
}

export async function revokeAllSessionsForWallet(walletAddress: string): Promise<number> {
  const result = await SessionModel.updateMany(
    { walletAddress, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
  return result.modifiedCount ?? 0;
}

export async function writeAudit(input: {
  action: string;
  actorWallet?: string | null | undefined;
  actorRole?: string | null | undefined;
  outcome: "SUCCESS" | "DENIED" | "FAILED";
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  requestId?: string | undefined;
  ipAddress?: string | undefined;
  detail?: Record<string, unknown> | undefined;
}): Promise<void> {
  try {
    await AuditLogModel.create({
      action: input.action,
      actorWallet: input.actorWallet ?? null,
      actorRole: input.actorRole ?? null,
      outcome: input.outcome,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      requestId: input.requestId ?? null,
      ipAddress: input.ipAddress ?? null,
      detail: input.detail ?? null,
    });
  } catch (error) {
    // An audit write must never mask the outcome of the request itself.
    log.error({ action: input.action, problem: String(error) }, "audit write failed");
  }
}
