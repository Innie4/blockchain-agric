import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { ok } from "../lib/response.js";
import { validate } from "../middleware/validate.js";
import { publicReadLimiter } from "../middleware/rateLimit.js";
import { verifyProduct, type RequestChannel } from "../services/verification/verificationService.js";

/**
 * How a reader arrived at the batch: from the search page, from a scanned code,
 * or by typing the address. This is the only part of the channel a client can
 * honestly know, because only the browser can see where the reader came from.
 */
const readerSourceSchema = z.enum(["search", "qr", "direct"]);

/**
 * Public verification and search. Nothing here requires a session, because a
 * consumer checking a batch must never need an account.
 */
const router = Router();

/**
 * Verifies a batch by identifier and returns the full provenance.
 *
 * This read does NOT record a verification event. Recording is a separate,
 * explicit call to `POST /api/verify/:productId/log`, so that a regulator's
 * count of how often a batch was checked is a count of deliberate checks and
 * not of page loads, and a single visit cannot inflate it twice.
 */
router.get(
  "/:productId",
  publicReadLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const session = req.session;
    const result = await verifyProduct({
      productId: req.params["productId"] ?? "",
      requesterWallet: session?.walletAddress,
      requesterRole: session?.user.role,
      channel: channelFor(req, req.query["source"]),
      logEvent: false,
    });
    res.json(ok(result));
  })
);

/**
 * Records a verification attempt. This is what a regulator's review history is
 * built from, so it is a deliberate action rather than a side effect of reading.
 */
router.post(
  "/:productId/log",
  publicReadLimiter,
  validate(z.object({ source: readerSourceSchema.default("direct") })),
  asyncHandler(async (req: Request, res: Response) => {
    const session = req.session;
    const result = await verifyProduct({
      productId: req.params["productId"] ?? "",
      requesterWallet: session?.walletAddress,
      requesterRole: session?.user.role,
      // The actor half of the channel comes from the session, never from the
      // request body: a client must not be able to label its own check as a
      // regulator's review, and a regulator's review must not be filed as a
      // casual visit.
      channel: channelFor(req, req.body.source),
      logEvent: true,
    });
    res.json(
      ok(
        {
          verificationId: result.verification.verificationId,
          result: result.verification.result,
          recordedAt: result.verification.verifiedAt,
        },
        "The check was recorded."
      )
    );
  })
);

/**
 * Decides the recorded channel.
 *
 * The session decides who is checking, so it decides the part of the channel
 * that describes the checker. `readerSource` only says how they arrived, and is
 * honoured solely for the anonymous cases where there is no session to describe.
 */
function channelFor(req: Request, readerSource: unknown): RequestChannel {
  const arrivedByQr = readerSource === "qr" || req.query["source"] === "qr";
  if (req.session?.user.role === "REGULATOR") return "REGULATOR_REVIEW";
  if (req.session !== undefined) return "DASHBOARD";
  if (arrivedByQr) return "QR_SCAN";
  if (readerSource === "search") return "SEARCH";
  return "DIRECT_URL";
}

export default router;
