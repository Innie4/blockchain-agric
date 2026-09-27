import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { ok } from "../lib/response.js";
import { validate, validatedQuery } from "../middleware/validate.js";
import { requireAuth, requireCsrf } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { generalLimiter } from "../middleware/rateLimit.js";
import { AppError, ERROR_CODES } from "../lib/errors.js";
import {
  acknowledgeTransfer,
  cancelTransfer,
  submitTransfer,
  toTransferView,
} from "../services/products/transferService.js";
import { writeAudit } from "../services/auth/authService.js";
import { TransferModel, ProductMetadataModel } from "../models/index.js";

const router = Router();

const signedTransactionSchema = z.object({
  signedTransaction: z.string().trim().max(4096, "The signed transaction is larger than expected. Sign it again.").default(""),
});

const listQuerySchema = z.object({
  direction: z.enum(["incoming", "outgoing", "all"]).default("all"),
  status: z.string().trim().max(40).optional(),
  productId: z.string().trim().max(32).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** Incoming and outgoing transfers for the signed-in participant. */
router.get(
  "/",
  generalLimiter,
  requireAuth,
  requirePermission("transfer:review"),
  validate(listQuerySchema, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const session = req.session;
    if (session === undefined) throw new AppError(ERROR_CODES.UNAUTHORIZED);
    const query = validatedQuery<z.infer<typeof listQuerySchema>>(req);

    const filter: Record<string, unknown> = {};
    if (query.direction === "incoming") {
      filter["toWallet"] = session.walletAddress;
    } else if (query.direction === "outgoing") {
      filter["fromWallet"] = session.walletAddress;
    } else {
      filter["$or"] = [
        { fromWallet: session.walletAddress },
        { toWallet: session.walletAddress },
      ];
    }
    if (query.status !== undefined && query.status.length > 0) {
      filter["status"] = query.status;
    }
    if (query.productId !== undefined && query.productId.length > 0) {
      filter["productId"] = query.productId.toUpperCase();
    }

    const [records, total] = await Promise.all([
      TransferModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean(),
      TransferModel.countDocuments(filter),
    ]);

    const productIds = [...new Set(records.map((record) => record.productId))];
    const products = await ProductMetadataModel.find({ productId: { $in: productIds } })
      .select({ productId: 1, cropType: 1, quantity: 1, unit: 1, status: 1 })
      .lean();
    const byProduct = new Map(products.map((product) => [product.productId, product]));

    res.json(
      ok({
        transfers: records.map((record) =>
          toTransferView(record, byProduct.get(record.productId) ?? null)
        ),
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

/** Transfers the participant still has to act on. */
router.get(
  "/pending",
  generalLimiter,
  requireAuth,
  requirePermission("transfer:review"),
  asyncHandler(async (req: Request, res: Response) => {
    const session = req.session;
    if (session === undefined) throw new AppError(ERROR_CODES.UNAUTHORIZED);
    const records = await TransferModel.find({
      $or: [
        { toWallet: session.walletAddress, status: "COMPLETED", acknowledgedAt: null },
        { fromWallet: session.walletAddress, status: "PREPARED" },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json(ok({ transfers: records.map((record) => toTransferView(record)) }));
  })
);

router.get(
  "/:transferId",
  generalLimiter,
  requireAuth,
  requirePermission("transfer:review"),
  asyncHandler(async (req: Request, res: Response) => {
    const session = req.session;
    if (session === undefined) throw new AppError(ERROR_CODES.UNAUTHORIZED);
    const record = await TransferModel.findOne({
      transferId: req.params["transferId"] ?? "",
    }).lean();
    if (record === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        message: "No transfer exists with that identifier.",
      });
    }
    const isParty =
      record.fromWallet === session.walletAddress || record.toWallet === session.walletAddress;
    if (!isParty && session.user.role !== "REGULATOR") {
      throw new AppError(ERROR_CODES.FORBIDDEN, {
        message: "This transfer is between other participants.",
      });
    }
    const product = await ProductMetadataModel.findOne({ productId: record.productId })
      .select({ cropType: 1, quantity: 1, unit: 1, status: 1, farmLocation: 1, harvestDate: 1 })
      .lean();
    res.json(
      ok({
        transfer: toTransferView(record, product ?? null),
        product,
        viewerRole: isParty ? (record.toWallet === session.walletAddress ? "RECIPIENT" : "SENDER") : "REGULATOR",
        canAcknowledge:
          record.toWallet === session.walletAddress &&
          record.status === "COMPLETED" &&
          record.acknowledgedAt === null,
      })
    );
  })
);

router.post(
  "/:transferId/acknowledge",
  generalLimiter,
  requireAuth,
  requireCsrf,
  requirePermission("transfer:review"),
  asyncHandler(async (req: Request, res: Response) => {
    const session = req.session;
    if (session === undefined) throw new AppError(ERROR_CODES.UNAUTHORIZED);
    const transfer = await acknowledgeTransfer({
      transferId: req.params["transferId"] ?? "",
      walletAddress: session.walletAddress,
    });
    res.json(ok(transfer, "Receipt of the batch confirmed."));
  })
);

/**
 * Stage two of a transfer: the sender submits the signed transaction.
 *
 * The prepare step is `POST /api/products/:productId/transfers` because a
 * transfer is created for a batch; the submit step is addressed by the transfer
 * itself, so a client that has the transfer record can retry it without
 * restating which batch it belongs to.
 */
router.post(
  "/:transferId/submit",
  generalLimiter,
  requireAuth,
  requireCsrf,
  requirePermission("transfer:create"),
  validate(signedTransactionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const session = req.session;
    if (session === undefined) throw new AppError(ERROR_CODES.UNAUTHORIZED);
    const transfer = await submitTransfer({
      transferId: req.params["transferId"] ?? "",
      signedTransaction: req.body.signedTransaction,
      signerWallet: session.walletAddress,
    });
    await writeAudit({
      action: "product.transferred",
      actorWallet: session.walletAddress,
      actorRole: session.user.role,
      outcome: "SUCCESS",
      resourceType: "transfer",
      resourceId: transfer.transferId,
      requestId: req.requestId,
      ipAddress: req.ip,
      detail: {
        productId: transfer.productId,
        toWallet: transfer.toWallet,
        signature: transfer.transactionSignature,
      },
    });
    res.json(ok(transfer, `Batch ${transfer.productId} now belongs to the recipient.`));
  })
);

/** Abandons a transfer the sender prepared but never signed. */
router.post(
  "/:transferId/cancel",
  generalLimiter,
  requireAuth,
  requireCsrf,
  requirePermission("transfer:create"),
  asyncHandler(async (req: Request, res: Response) => {
    const session = req.session;
    if (session === undefined) throw new AppError(ERROR_CODES.UNAUTHORIZED);
    const transfer = await cancelTransfer({
      transferId: req.params["transferId"] ?? "",
      walletAddress: session.walletAddress,
    });
    res.json(ok(transfer, "The transfer was cancelled."));
  })
);

export default router;
