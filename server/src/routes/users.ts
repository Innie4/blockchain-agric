import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { ok } from "../lib/response.js";
import { validate, validatedQuery } from "../middleware/validate.js";
import { requireAuth, requireCsrf } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { generalLimiter } from "../middleware/rateLimit.js";
import { AppError, ERROR_CODES } from "../lib/errors.js";
import { toAuthenticatedUser, writeAudit } from "../services/auth/authService.js";
import { listTransferCandidates } from "../services/compliance/complianceService.js";
import { UserModel } from "../models/index.js";
import type { ParticipantRoleValue } from "../lib/roles.js";

const router = Router();

const profileUpdateSchema = z.object({
  fullName: z.string().trim().min(2, "Enter your full name.").max(160).optional(),
  contactEmail: z
    .string()
    .trim()
    .max(200)
    .refine(
      (value) => value.length === 0 || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
      "Enter a valid email address or leave it blank."
    )
    .optional(),
  contactPhone: z.string().trim().max(40).optional(),
  address: z.string().trim().max(400).optional(),
  state: z.string().trim().max(120).optional(),
  organisation: z.string().trim().max(200).optional(),
});

/**
 * A participant's own profile. A role is never settable here: it is set
 * deliberately, and the on-chain registry is the authority for it.
 */
router.patch(
  "/me",
  generalLimiter,
  requireAuth,
  requireCsrf,
  requirePermission("profile:manage"),
  validate(profileUpdateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const session = req.session;
    if (session === undefined) throw new AppError(ERROR_CODES.UNAUTHORIZED);

    const user = await UserModel.findOne({ walletAddress: session.walletAddress });
    if (user === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        message: "Your participant record could not be found.",
      });
    }
    if (user.role === "CONSUMER" && (req.body.fullName !== undefined || req.body.organisation !== undefined)) {
      // A consumer record is minimal by design; accepting a name here would
      // suggest a level of registration the consumer never asked for.
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
        message:
          "A consumer account holds no participant details. Register as a supply chain participant to maintain a profile.",
      });
    }

    if (req.body.fullName !== undefined) user.fullName = req.body.fullName;
    if (req.body.organisation !== undefined) user.organisation = req.body.organisation;
    const contact = user.contactInfo;
    if (req.body.contactEmail !== undefined) contact.email = req.body.contactEmail.toLowerCase();
    if (req.body.contactPhone !== undefined) contact.phone = req.body.contactPhone;
    if (req.body.address !== undefined) contact.address = req.body.address;
    if (req.body.state !== undefined) contact.state = req.body.state;
    await user.save();

    await writeAudit({
      action: "user.profile.updated",
      actorWallet: session.walletAddress,
      actorRole: user.role,
      outcome: "SUCCESS",
      resourceType: "user",
      resourceId: user.userId,
      requestId: req.requestId,
      ipAddress: req.ip,
    });

    res.json(ok(toAuthenticatedUser(user.toObject() as Record<string, unknown>), "Profile saved."));
  })
);

router.get(
  "/me",
  generalLimiter,
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const session = req.session;
    if (session === undefined) throw new AppError(ERROR_CODES.UNAUTHORIZED);
    res.json(ok(toAuthenticatedUser(session.user as unknown as Record<string, unknown>)));
  })
);

const participantsQuerySchema = z.object({
  role: z
    .enum(["PROCESSOR", "TRANSPORTER", "RETAILER"])
    .optional()
    .describe("Restrict to participants who may receive a product."),
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  scope: z.enum(["transfer", "directory"]).default("transfer"),
});

/** The recipient picker for a transfer. */
router.get(
  "/participants",
  generalLimiter,
  requireAuth,
  validate(participantsQuerySchema, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const query = validatedQuery<z.infer<typeof participantsQuerySchema>>(req);
    const session = req.session;
    if (session === undefined) throw new AppError(ERROR_CODES.UNAUTHORIZED);

    if (query.scope === "directory") {
      if (session.user.role !== "REGULATOR") {
        throw new AppError(ERROR_CODES.ROLE_NOT_ALLOWED, {
          message: "The full participant directory is available to regulators only.",
        });
      }
      const filter: Record<string, unknown> = { status: "ACTIVE" };
      if (query.role !== undefined) filter["role"] = query.role;
      if (query.search !== undefined && query.search.length > 0) {
        const safe = query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        filter["$or"] = [
          { fullName: new RegExp(safe, "i") },
          { organisation: new RegExp(safe, "i") },
          { walletAddress: new RegExp(safe, "i") },
        ];
      }
      const users = await UserModel.find(filter)
        .select({
          walletAddress: 1,
          fullName: 1,
          role: 1,
          organisation: 1,
          onChainRegistered: 1,
          status: 1,
          "contactInfo.state": 1,
        })
        .sort({ fullName: 1 })
        .limit(query.limit)
        .lean();
      res.json(
        ok({
          participants: users.map((user) => ({
            walletAddress: user.walletAddress,
            fullName: user.fullName,
            role: user.role as ParticipantRoleValue,
            organisation: user.organisation,
            state: (user.contactInfo as { state?: string } | undefined)?.state ?? "",
            onChainRegistered: user.onChainRegistered,
          })),
        })
      );
      return;
    }

    const participants = await listTransferCandidates({
      role: query.role,
      search: query.search,
      limit: query.limit,
      excludeWallet: session.walletAddress,
    });
    res.json(ok({ participants }));
  })
);

export default router;
