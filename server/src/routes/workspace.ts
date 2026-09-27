import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { ok } from "../lib/response.js";
import { validate, validatedQuery } from "../middleware/validate.js";
import { requireAuth, requireCsrf } from "../middleware/auth.js";
import { requirePermission, requireRole } from "../middleware/rbac.js";
import { generalLimiter } from "../middleware/rateLimit.js";
import { AppError, ERROR_CODES } from "../lib/errors.js";
import { buildDashboard } from "../services/dashboard/dashboardService.js";
import {
  listActivity,
  listNotifications,
  markNotificationRead,
} from "../services/products/productQueryService.js";
import {
  buildOverview,
  csvFor,
  generateReport,
  listReports,
  pdfFor,
  readReport,
  recordExport,
  reportRequestSchema,
} from "../services/compliance/complianceService.js";
import { VerificationEventModel } from "../models/index.js";
import { buildRecordVerification } from "../services/solana/instructions.js";
import { getProductAddress } from "../services/solana/pda.js";
import { getChainClient } from "../services/solana/chainClientRegistry.js";
import {
  prepareAction,
  submitAction,
} from "../services/orchestration/chainFlow.js";
import { toPublicKey } from "../lib/crypto.js";
import { statusLabel } from "../lib/statusMachine.js";
import {
  prepareParticipantRegistration,
  submitParticipantRegistration,
} from "../services/auth/participantService.js";

const router = Router();

// ------------------------------------------------------------------ dashboard

/** The role-aware landing view. Every figure is a count of stored records. */
router.get(
  "/dashboard",
  generalLimiter,
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const session = req.session;
    if (session === undefined) throw new AppError(ERROR_CODES.UNAUTHORIZED);
    res.json(
      ok(
        await buildDashboard({
          walletAddress: session.walletAddress,
          role: session.user.role,
          fullName: session.user.fullName,
          onChainRegistered: session.user.onChainRegistered,
        })
      )
    );
  })
);

// -------------------------------------------------------------- notifications

router.get(
  "/notifications",
  generalLimiter,
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const session = req.session;
    if (session === undefined) throw new AppError(ERROR_CODES.UNAUTHORIZED);
    const unreadOnly = req.query["unreadOnly"] === "true";
    res.json(
      ok(
        await listNotifications({
          walletAddress: session.walletAddress,
          unreadOnly,
          limit: 50,
        })
      )
    );
  })
);

router.post(
  "/notifications/:notificationId/read",
  generalLimiter,
  requireAuth,
  requireCsrf,
  asyncHandler(async (req: Request, res: Response) => {
    const session = req.session;
    if (session === undefined) throw new AppError(ERROR_CODES.UNAUTHORIZED);
    await markNotificationRead({
      notificationId: req.params["notificationId"] ?? "",
      walletAddress: session.walletAddress,
    });
    res.json(ok({ read: true }));
  })
);

// ------------------------------------------------------------------- activity

const activityQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

router.get(
  "/activity",
  generalLimiter,
  requireAuth,
  validate(activityQuerySchema, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const session = req.session;
    if (session === undefined) throw new AppError(ERROR_CODES.UNAUTHORIZED);
    const query = validatedQuery<z.infer<typeof activityQuerySchema>>(req);
    const activity = await listActivity({
      walletAddress: session.walletAddress,
      page: query.page,
      pageSize: query.pageSize,
    });
    res.json(ok({ entries: activity.rows, pagination: activity.pagination }));
  })
);

// ----------------------------------------------------------------- compliance

const regulatorOnly = [requireAuth, requireRole("REGULATOR")] as const;

router.get(
  "/compliance/overview",
  generalLimiter,
  ...regulatorOnly,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(ok(await buildOverview()));
  })
);

/** Verification events, for the regulator's review queue. */
const verificationQuerySchema = z.object({
  result: z.string().trim().max(40).optional(),
  productId: z.string().trim().max(32).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

router.get(
  "/compliance/verifications",
  generalLimiter,
  ...regulatorOnly,
  validate(verificationQuerySchema, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const query = validatedQuery<z.infer<typeof verificationQuerySchema>>(req);
    const filter: Record<string, unknown> = {};
    if (query.result !== undefined && query.result.length > 0) {
      filter["verificationResult"] = query.result;
    }
    if (query.productId !== undefined && query.productId.length > 0) {
      filter["productId"] = query.productId.toUpperCase();
    }
    const [records, total] = await Promise.all([
      VerificationEventModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean(),
      VerificationEventModel.countDocuments(filter),
    ]);
    res.json(
      ok({
        verifications: records.map((entry) => ({
          verificationId: entry.verificationId,
          productId: entry.productId,
          result: entry.verificationResult,
          requester: entry.requester,
          requesterRole: entry.requesterRole,
          requestChannel: entry.requestChannel,
          chainReachable: entry.chainReachable,
          recordPresent: entry.recordPresent,
          mismatchDetails: entry.mismatchDetails,
          createdAt: entry.createdAt.toISOString(),
        })),
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        },
      })
    );
  })
);

router.post(
  "/compliance/reports",
  generalLimiter,
  requireCsrf,
  ...regulatorOnly,
  requirePermission("compliance:report-generate"),
  validate(reportRequestSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const session = req.session;
    if (session === undefined) throw new AppError(ERROR_CODES.UNAUTHORIZED);
    const report = await generateReport({
      title: req.body.title,
      generatedBy: session.walletAddress,
      generatedByName: session.user.fullName,
      request: req.body,
    });
    res.status(201).json(ok(report, "The compliance report is ready."));
  })
);

const reportListQuerySchema = z.object({
  mine: z.enum(["true", "false"]).default("true"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

router.get(
  "/compliance/reports",
  generalLimiter,
  ...regulatorOnly,
  validate(reportListQuerySchema, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const session = req.session;
    if (session === undefined) throw new AppError(ERROR_CODES.UNAUTHORIZED);
    const query = validatedQuery<z.infer<typeof reportListQuerySchema>>(req);
    const result = await listReports({
      page: query.page,
      pageSize: query.pageSize,
      generatedBy: query.mine === "true" ? session.walletAddress : undefined,
    });
    res.json(
      ok({
        reports: result.reports,
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total: result.total,
          totalPages: Math.max(1, Math.ceil(result.total / query.pageSize)),
        },
      })
    );
  })
);

router.get(
  "/compliance/reports/:reportId",
  generalLimiter,
  ...regulatorOnly,
  asyncHandler(async (req: Request, res: Response) => {
    res.json(ok(await readReport(req.params["reportId"] ?? "")));
  })
);

/** Export as PDF or CSV, produced locally with no third-party service. */
router.get(
  "/compliance/reports/:reportId/export",
  generalLimiter,
  ...regulatorOnly,
  asyncHandler(async (req: Request, res: Response) => {
    const reportId = req.params["reportId"] ?? "";
    const format = (req.query["format"] as string | undefined) ?? "pdf";
    if (format !== "pdf" && format !== "csv") {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
        message: "A report can be exported as PDF or CSV.",
        details: [{ path: "format", message: "Use pdf or csv." }],
      });
    }
    const report = await readReport(reportId);
    const filename = `compliance-${report.reportId}.${format}`;
    if (format === "csv") {
      await recordExport(reportId, "csv");
      res.setHeader("content-type", "text/csv; charset=utf-8");
      res.setHeader("content-disposition", `attachment; filename="${filename}"`);
      res.send(csvFor(report));
      return;
    }
    const buffer = await pdfFor(report);
    await recordExport(reportId, "pdf");
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-length", String(buffer.length));
    res.setHeader("content-disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  })
);

// ---------------------------------------------------- on-chain attestation

const attestationSchema = z.object({
  productId: z.string().trim().min(8).max(32),
  result: z.enum(["VERIFIED", "MISMATCH", "NOT_FOUND", "INCOMPLETE"]),
  occurredAt: z.string().trim().refine((value) => !Number.isNaN(Date.parse(value))),
});

/**
 * A regulator's finding is anchored on-chain, so it cannot later be denied.
 * Only a regulator can record one, enforced again by the program.
 */
router.post(
  "/compliance/attestations/prepare",
  generalLimiter,
  requireCsrf,
  ...regulatorOnly,
  validate(attestationSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const session = req.session;
    if (session === undefined) throw new AppError(ERROR_CODES.UNAUTHORIZED);
    const chain = getChainClient();
    const productId = req.body.productId.toUpperCase();
    const occurredAt = Math.floor(new Date(req.body.occurredAt).getTime() / 1000);
    const verification = await VerificationEventModel.findOne({
      productId,
      verificationResult: req.body.result,
    })
      .sort({ createdAt: -1 })
      .lean();
    const onChain = await chain.fetchProduct(productId);
    const verificationHash = Buffer.from(
      verification?.calculatedHash ?? onChain?.offChainDataHash ?? "0".repeat(64),
      "hex"
    );

    const instruction = buildRecordVerification(
      chain.programId,
      toPublicKey(session.walletAddress, "walletAddress"),
      productId,
      req.body.result,
      verificationHash,
      occurredAt
    );
    const prepared = await prepareAction({
      instructions: [instruction],
      feePayer: session.walletAddress,
      description: `Record a ${req.body.result.replace(/_/g, " ").toLowerCase()} finding on batch ${productId}`,
      targetAddress: getProductAddress(chain.programId, productId).toBase58(),
    });
    res.json(
      ok(
        {
          prepared,
          productId,
          result: req.body.result,
          statusLabel: statusLabel(onChain?.status ?? "REGISTERED"),
        },
        "Sign the transaction in your wallet to record this finding on the blockchain."
      )
    );
  })
);

router.post(
  "/compliance/attestations/submit",
  generalLimiter,
  requireCsrf,
  ...regulatorOnly,
  validate(
    attestationSchema.extend({
      signedTransaction: z.string().trim().max(4096),
    })
  ),
  asyncHandler(async (req: Request, res: Response) => {
    const session = req.session;
    if (session === undefined) throw new AppError(ERROR_CODES.UNAUTHORIZED);
    const chain = getChainClient();
    const productId = req.body.productId.toUpperCase();
    const confirmed = await submitAction({
      signedTransaction: req.body.signedTransaction,
      expectedSigner: session.walletAddress,
      description: `Record a finding on batch ${productId}`,
      targetAddress: getProductAddress(chain.programId, productId).toBase58(),
      productId,
    });
    await VerificationEventModel.updateMany(
      { productId },
      { $set: { attestationTxHash: confirmed.signature } }
    );
    res.json(
      ok(
        { signature: confirmed.signature, productId, slot: confirmed.slot },
        "The finding is recorded on the blockchain."
      )
    );
  })
);

// ------------------------------------------------- on-chain participant setup

router.post(
  "/participant/register/prepare",
  generalLimiter,
  requireAuth,
  requireCsrf,
  asyncHandler(async (req: Request, res: Response) => {
    const session = req.session;
    if (session === undefined) throw new AppError(ERROR_CODES.UNAUTHORIZED);
    const result = await prepareParticipantRegistration({
      walletAddress: session.walletAddress,
      payload: req.body,
      requestId: req.requestId,
    });
    res.json(
      ok(
        result,
        "Sign the transaction in your wallet to complete your on-chain registration."
      )
    );
  })
);

router.post(
  "/participant/register/submit",
  generalLimiter,
  requireAuth,
  requireCsrf,
  validate(
    z.object({
      signedTransaction: z.string().trim().min(16).max(4096),
    })
  ),
  asyncHandler(async (req: Request, res: Response) => {
    const session = req.session;
    if (session === undefined) throw new AppError(ERROR_CODES.UNAUTHORIZED);
    const result = await submitParticipantRegistration({
      walletAddress: session.walletAddress,
      signedTransaction: req.body.signedTransaction,
      requestId: req.requestId,
    });
    res.json(ok(result, "Your on-chain participant registration is complete."));
  })
);

export default router;
