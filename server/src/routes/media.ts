import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { generalLimiter } from "../middleware/rateLimit.js";
import { AppError, ERROR_CODES } from "../lib/errors.js";
import { retrieveMedia } from "../services/files/mediaStore.js";
import { CertificateModel, ProcessingLogModel, ProductMetadataModel, TransportLogModel } from "../models/index.js";

/**
 * Stored files and the certificates that reference them.
 *
 * A file is only served when the requester is entitled to it: a guessed
 * identifier must not be enough. Product images are part of the public record,
 * so they are visible to anyone; documents stay with the participants and
 * regulators involved in the batch.
 */
const router = Router();

router.get(
  "/:mediaId",
  generalLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const mediaId = req.params["mediaId"] ?? "";
    const media = await retrieveMedia(mediaId);
    if (media === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { message: "That file does not exist." });
    }

    await assertMayView(req, media.mimeType);

    res.setHeader("content-type", media.mimeType);
    res.setHeader("content-length", String(media.sizeBytes));
    res.setHeader("content-disposition", `inline; filename="${media.fileName}"`);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "private, max-age=300");
    media.stream.on("error", () => res.destroy());
    media.stream.pipe(res);
  })
);

/**
 * Decides whether this requester may see the file behind an identifier. Images
 * are part of the batch's public record; documents are not.
 */
async function assertMayView(req: Request, mimeType: string): Promise<void> {
  if (mimeType.startsWith("image/")) return;
  const session = req.session;
  if (session === undefined) {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, {
      message: "Sign in with the wallet involved in this batch to view its documents.",
    });
  }
  if (session.user.role === "REGULATOR") return;

  const [certificate, processing, transport] = await Promise.all([
    CertificateModel.findOne({ "document.mediaId": req.params["mediaId"] ?? "" }).lean(),
    ProcessingLogModel.findOne({
      $or: [
        { "supportingDocuments.mediaId": req.params["mediaId"] ?? "" },
        { "supportingImages.mediaId": req.params["mediaId"] ?? "" },
      ],
    }).lean(),
    TransportLogModel.findOne({
      "supportingDocuments.mediaId": req.params["mediaId"] ?? "",
    }).lean(),
  ]);
  const productIds = [certificate, processing, transport]
    .map((entry) => entry?.productId)
    .filter((id): id is string => typeof id === "string");
  if (productIds.length === 0) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      message: "That file is not attached to any batch.",
    });
  }
  const involved = await ProductMetadataModel.countDocuments({
    productId: { $in: productIds },
    $or: [{ ownerWallet: session.walletAddress }, { registeredByWallet: session.walletAddress }],
  });
  if (involved === 0) {
    throw new AppError(ERROR_CODES.FORBIDDEN, {
      message: "This document belongs to a batch you are not part of.",
    });
  }
}

export default router;
