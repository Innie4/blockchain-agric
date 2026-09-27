import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { ok } from "../lib/response.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, requireCsrf } from "../middleware/auth.js";
import { authLimiter, generalLimiter } from "../middleware/rateLimit.js";
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  csrfCookieOptions,
  clearCookieOptions,
  sessionCookieOptions,
  sessionMaxAgeSeconds,
} from "../services/auth/cookies.js";
import {
  createSession,
  issueChallenge,
  revokeSession,
  verifyChallenge,
  writeAudit,
} from "../services/auth/authService.js";
import { refreshRegistrationState } from "../services/auth/participantService.js";
import { permissionsFor } from "../lib/roles.js";
import { UserModel } from "../models/index.js";
import { normaliseWallet } from "../lib/crypto.js";

const router = Router();

const nonceRequestSchema = z.object({
  walletAddress: z
    .string()
    .trim()
    .min(32, "Enter the wallet address you want to connect.")
    .max(44, "That is not a Solana wallet address."),
});

const verifyRequestSchema = z.object({
  walletAddress: z.string().trim().min(32).max(44),
  nonce: z.string().trim().min(16, "Request a new sign-in challenge.").max(256),
  signature: z
    .string()
    .trim()
    .min(16, "Sign the challenge in your wallet to continue.")
    .max(512),
});

/**
 * Step 1 of wallet authentication: the server issues a single-use challenge.
 * The wallet address here is only a claim; nothing is trusted until step 3.
 */
router.post(
  "/nonce",
  authLimiter,
  validate(nonceRequestSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const challenge = await issueChallenge({
      walletAddress: normaliseWallet(req.body.walletAddress),
      requestIp: req.ip,
    });
    res.status(201).json(ok(challenge, "Sign this message in your wallet to continue."));
  })
);

/**
 * Steps 2 and 3: the wallet signed the challenge; verify the signature, then
 * open a session. A wallet public key alone would not be proof of anything.
 */
router.post(
  "/verify",
  authLimiter,
  validate(verifyRequestSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const signed = await verifyChallenge({
      walletAddress: normaliseWallet(req.body.walletAddress),
      nonce: req.body.nonce,
      signature: req.body.signature,
      requestIp: req.ip,
      userAgent: req.header("user-agent") ?? "",
    });

    // Notice if a registration that was believed to exist has disappeared.
    if (signed.needsOnChainRegistration) {
      await refreshRegistrationState(signed.walletAddress).catch(() => false);
      const refreshed = await UserModel.findOne({ walletAddress: signed.walletAddress }).lean();
      if (refreshed !== null) {
        signed.needsOnChainRegistration = !refreshed.onChainRegistered;
      }
    }

    const grant = await createSession({
      walletAddress: signed.walletAddress,
      userId: signed.user.userId,
      userAgent: req.header("user-agent") ?? "",
      ipAddress: req.ip ?? "",
    });

    const maxAge = sessionMaxAgeSeconds();
    res.cookie(SESSION_COOKIE, grant.token, sessionCookieOptions(maxAge));
    res.cookie(CSRF_COOKIE, grant.csrfToken, csrfCookieOptions(maxAge));

    await writeAudit({
      action: "auth.session.created",
      actorWallet: signed.walletAddress,
      actorRole: signed.user.role,
      outcome: "SUCCESS",
      resourceType: "session",
      resourceId: grant.sessionId,
      requestId: req.requestId,
      ipAddress: req.ip,
    });

    res.json(
      ok(
        {
          walletAddress: signed.walletAddress,
          user: signed.user,
          permissions: permissionsFor(signed.user.role),
          isNewParticipant: signed.isNewParticipant,
          needsRoleSelection: signed.needsRoleSelection,
          needsOnChainRegistration: signed.needsOnChainRegistration,
          expiresAt: grant.expiresAt,
        },
        "Signed in."
      )
    );
  })
);

/** The current session, used by the client on every page load. */
router.get(
  "/me",
  generalLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    if (req.session === undefined) {
      res.json(
        ok({
          authenticated: false,
          user: null,
          permissions: [] as string[],
        })
      );
      return;
    }
    const user = req.session.user;
    res.json(
      ok({
        authenticated: true,
        user,
        permissions: permissionsFor(user.role),
        sessionExpiresAt: new Date(
          Date.now() + sessionMaxAgeSeconds() * 1000
        ).toISOString(),
      })
    );
  })
);

/** Ends the session. Safe to call when already signed out. */
router.post(
  "/logout",
  generalLimiter,
  requireAuth,
  requireCsrf,
  asyncHandler(async (req: Request, res: Response) => {
    await revokeSession(req.cookies?.[SESSION_COOKIE] as string | undefined);
    await writeAudit({
      action: "auth.session.revoked",
      actorWallet: req.session?.walletAddress,
      actorRole: req.session?.user.role,
      outcome: "SUCCESS",
      resourceType: "session",
      requestId: req.requestId,
      ipAddress: req.ip,
    });
    res.clearCookie(SESSION_COOKIE, clearCookieOptions());
    res.clearCookie(CSRF_COOKIE, clearCookieOptions());
    res.json(ok({ signedOut: true }, "Signed out."));
  })
);

export default router;
