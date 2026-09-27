import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { ok } from "../lib/response.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { generalLimiter } from "../middleware/rateLimit.js";
import { AppError, ERROR_CODES } from "../lib/errors.js";
import {
  ReconciliationTaskModel,
  TransferModel,
  ProductMetadataModel,
} from "../models/index.js";

const router = Router();

/**
 * Operational view for regulators: the transactions that confirmed on-chain but
 * could not be written to the database. Surfacing this is what stops the system
 * from quietly losing a confirmed action.
 */
router.get(
  "/reconciliation",
  generalLimiter,
  requireAuth,
  requireRole("REGULATOR"),
  asyncHandler(async (_req: Request, res: Response) => {
    const [pending, resolved, stuckProducts, stuckTransfers] = await Promise.all([
      ReconciliationTaskModel.find({ status: "PENDING" })
        .sort({ createdAt: -1 })
        .limit(200)
        .lean(),
      ReconciliationTaskModel.find({ status: "RESOLVED" })
        .sort({ resolvedAt: -1 })
        .limit(50)
        .lean(),
      ProductMetadataModel.find({ chainState: "NEEDS_RECONCILIATION" })
        .select({ productId: 1, chainState: 1, dataHash: 1, onChainTxHash: 1, updatedAt: 1 })
        .lean(),
      TransferModel.find({ status: "NEEDS_RECONCILIATION" })
        .select({ transferId: 1, productId: 1, fromWallet: 1, toWallet: 1, updatedAt: 1 })
        .lean(),
    ]);

    res.json(
      ok({
        tasks: pending.map((task) => ({
          taskId: task.taskId,
          action: task.action,
          status: task.status,
          productId: task.productId,
          transactionSignature: task.transactionSignature,
          lastError: task.lastError,
          attempts: task.attempts,
          createdAt: task.createdAt.toISOString(),
        })),
        resolvedCount: resolved.length,
        productsNeedingReconciliation: stuckProducts.map((product) => ({
          productId: product.productId,
          dataHash: product.dataHash,
          onChainTxHash: product.onChainTxHash,
          updatedAt: product.updatedAt.toISOString(),
        })),
        transfersNeedingReconciliation: stuckTransfers.map((transfer) => ({
          transferId: transfer.transferId,
          productId: transfer.productId,
          fromWallet: transfer.fromWallet,
          toWallet: transfer.toWallet,
          updatedAt: transfer.updatedAt.toISOString(),
        })),
      })
    );
  })
);

/** Marks a task as resolved once an operator has completed the write. */
router.post(
  "/reconciliation/:taskId/resolve",
  generalLimiter,
  requireAuth,
  requireRole("REGULATOR"),
  asyncHandler(async (req: Request, res: Response) => {
    const task = await ReconciliationTaskModel.findOneAndUpdate(
      { taskId: req.params["taskId"] ?? "", status: "PENDING" },
      { $set: { status: "RESOLVED", resolvedAt: new Date() }, $inc: { attempts: 1 } },
      { new: true }
    );
    if (task === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        message: "No unfinished task exists with that identifier.",
      });
    }
    res.json(
      ok(
        { taskId: task.taskId, status: task.status, resolvedAt: task.resolvedAt },
        "The task is marked as finished."
      )
    );
  })
);

export default router;
