import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { ok } from "../lib/response.js";
import { toValidationError, validate, validatedQuery } from "../middleware/validate.js";
import { requireAuth, requireCsrf } from "../middleware/auth.js";
import { requirePermission, requireRole } from "../middleware/rbac.js";
import { idempotency } from "../middleware/idempotency.js";
import { generalLimiter, publicReadLimiter, uploadLimiter } from "../middleware/rateLimit.js";
import { acceptFiles } from "../middleware/upload.js";
import { AppError, ERROR_CODES } from "../lib/errors.js";
import {
  cancelRegistration,
  prepareRegistration,
  productRegistrationSchema,
  submitRegistration,
  verificationUrlFor,
} from "../services/products/registrationService.js";
import { listProducts, loadHistory, loadProductForParticipant } from "../services/products/productQueryService.js";
import { prepareTransfer } from "../services/products/transferService.js";
import {
  listProcessingLogs,
  prepareProcessingEvent,
  processingEventSchema,
  submitProcessingEvent,
} from "../services/products/processingService.js";
import {
  listTransportLogs,
  prepareTransportEvent,
  submitTransportEvent,
  transportEventSchema,
} from "../services/products/transportService.js";
import {
  attachCertificate,
  certificateSchema,
  listCertificates,
} from "../services/products/certificateService.js";
import {
  prepareStatusUpdate,
  saleUpdateSchema,
  submitStatusUpdate,
  updateSaleState,
} from "../services/products/retailService.js";
import { verifyProduct } from "../services/verification/verificationService.js";
import { storeUpload } from "../services/files/mediaStore.js";
import { writeAudit } from "../services/auth/authService.js";
import { PRODUCT_STATUSES, statusLabel, type ProductStatus } from "../lib/statusMachine.js";
import { ProductMetadataModel } from "../models/index.js";

const router = Router();


function optionalField(req: Request, name: string): string {
  const value = req.body?.[name];
  return typeof value === "string" ? value : "";
}

function filesOf(req: Request, name: string): Express.Multer.File[] {
  const bag = req.files as Record<string, Express.Multer.File[]> | undefined;
  return bag?.[name] ?? [];
}

function requireSession(req: Request): {
  walletAddress: string;
  role: string;
  userId: string;
  fullName: string;
  user: { fullName: string; role: string; organisation: string };
} {
  const session = req.session;
  if (session === undefined) throw new AppError(ERROR_CODES.UNAUTHORIZED);
  return {
    walletAddress: session.walletAddress,
    role: session.user.role,
    userId: session.userId,
    fullName: session.user.fullName,
    user: session.user,
  };
}

// ---------------------------------------------------------------- registration

/**
 * Stage one of registration. Stores the supporting files, hashes the canonical
 * payload, and returns an unsigned transaction for the farmer to sign. The
 * batch is not registered until the second call confirms.
 */
router.post(
  "/",
  generalLimiter,
  requireAuth,
  requireCsrf,
  requireRole("FARMER", "REGULATOR"),
  idempotency(),
  uploadLimiter,
  acceptFiles(8, "images", "certificates"),
  asyncHandler(async (req: Request, res: Response) => {
    const session = requireSession(req);
    const parsed = productRegistrationSchema.safeParse({
      // An absent multipart field reads as "", which the schema must see as
      // absent, not as a supplied but empty identifier.
      productId: optionalField(req, "productId") || undefined,
      cropType: optionalField(req, "cropType"),
      quantity: optionalField(req, "quantity"),
      unit: optionalField(req, "unit"),
      harvestDate: optionalField(req, "harvestDate"),
      farmLocation: optionalField(req, "farmLocation"),
      description: optionalField(req, "description"),
      additionalNotes: optionalField(req, "additionalNotes"),
    });
    if (!parsed.success) {
      throw toValidationError(parsed.error);
    }

    const draft = await prepareRegistration({
      input: parsed.data,
      walletAddress: session.walletAddress,
      role: session.role,
      images: filesOf(req, "images").map(toUpload),
      certificates: filesOf(req, "certificates").map(toUpload),
      existingCertificateHashes: [],
    });

    res.status(201).json(
      ok(
        draft,
        "The batch details are saved. Sign the transaction in your wallet to record it on the blockchain."
      )
    );
  })
);

const signedTransactionSchema = z
  .object({
    signedTransaction: z
      .string()
      .trim()
      .max(4096, "The signed transaction is larger than expected. Sign it again.")
      .default(""),
  })
  // The action identifier travels in the same body, so the fields this schema
  // does not know about have to survive validation for the handler to read them.
  .passthrough();

/** Stage two: submit the signed transaction and wait for real confirmation. */
router.post(
  "/:productId/submit",
  generalLimiter,
  requireAuth,
  requireCsrf,
  validate(signedTransactionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const session = requireSession(req);
    const result = await submitRegistration({
      productId: req.params["productId"] ?? "",
      signedTransaction: req.body.signedTransaction,
      walletAddress: session.walletAddress,
    });
    await writeAudit({
      action: "product.registered",
      actorWallet: session.walletAddress,
      actorRole: session.role,
      outcome: "SUCCESS",
      resourceType: "product",
      resourceId: result.product.productId,
      requestId: req.requestId,
      ipAddress: req.ip,
      detail: { signature: result.signature, dataHash: result.product.dataHash },
    });
    res.json(
      ok(
        result,
        `Batch ${result.product.productId} is recorded on the blockchain. Share its verification link with buyers.`
      )
    );
  })
);

router.post(
  "/:productId/cancel",
  generalLimiter,
  requireAuth,
  requireCsrf,
  asyncHandler(async (req: Request, res: Response) => {
    const session = requireSession(req);
    const productId = req.params["productId"] ?? "";
    await cancelRegistration({ productId, walletAddress: session.walletAddress });
    res.json(ok({ productId, chainState: "CANCELLED" }, "The draft registration was cancelled."));
  })
);

// ------------------------------------------------------------------- read paths

const listQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(PRODUCT_STATUSES as unknown as [string, ...string[]]).optional(),
  cropType: z.string().trim().max(120).optional(),
  owner: z.string().trim().max(44).optional(),
  chainState: z.string().trim().max(40).optional(),
  scope: z.enum(["mine", "all"]).default("all"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

router.get(
  "/",
  generalLimiter,
  requireAuth,
  validate(listQuerySchema, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const session = requireSession(req);
    const query = validatedQuery<z.infer<typeof listQuerySchema>>(req);
    const result = await listProducts(query, {
      walletAddress: session.walletAddress,
      role: session.role,
    });
    res.json(ok({ products: result.rows, pagination: result.pagination }));
  })
);

router.get(
  "/:productId",
  generalLimiter,
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const session = requireSession(req);
    const product = await loadProductForParticipant(req.params["productId"] ?? "", {
      walletAddress: session.walletAddress,
      role: session.role,
    });
    res.json(
      ok({
        product,
        verificationUrl: verificationUrlFor(product.productId),
        isOwner: product.ownerWallet === session.walletAddress,
        isRegistrant: product.registeredByWallet === session.walletAddress,
        canTransfer: product.ownerWallet === session.walletAddress,
        canRecordProcessing:
          product.ownerWallet === session.walletAddress && session.role === "PROCESSOR",
        canRecordTransport:
          product.ownerWallet === session.walletAddress && session.role === "TRANSPORTER",
        canListForSale:
          product.ownerWallet === session.walletAddress && session.role === "RETAILER",
      })
    );
  })
);

router.get(
  "/:productId/history",
  publicReadLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    res.json(ok(await loadHistory(req.params["productId"] ?? "")));
  })
);

/**
 * Verification from inside the application. Public: no session required, and it
 * does not record an event, so reading a batch from the dashboard cannot inflate
 * the regulator's count of deliberate checks.
 */
router.get(
  "/:productId/verify",
  publicReadLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const session = req.session;
    const result = await verifyProduct({
      productId: req.params["productId"] ?? "",
      requesterWallet: session?.walletAddress,
      requesterRole: session?.user.role,
      channel: session === undefined ? "SEARCH" : "DASHBOARD",
      logEvent: false,
    });
    res.json(ok(result));
  })
);

// ------------------------------------------------------------------ processing

router.post(
  "/:productId/processing",
  generalLimiter,
  requireAuth,
  requireCsrf,
  requirePermission("product:record-processing"),
  uploadLimiter,
  acceptFiles(6, "images", "documents"),
  asyncHandler(async (req: Request, res: Response) => {
    const session = requireSession(req);
    const parsed = processingEventSchema.safeParse({
      activity: optionalField(req, "activity"),
      activityDescription: optionalField(req, "activityDescription"),
      occurredAt: optionalField(req, "occurredAt"),
      newStatus: optionalField(req, "newStatus") || undefined,
    });
    if (!parsed.success) throw toValidationError(parsed.error);

    const result = await prepareProcessingEvent({
      productId: req.params["productId"] ?? "",
      processorWallet: session.walletAddress,
      processorName: session.user.fullName,
      payload: parsed.data,
      images: filesOf(req, "images").map(toUpload),
      documents: filesOf(req, "documents").map(toUpload),
    });
    res.status(201).json(
      ok(
        result,
        result.prepared.transaction.length === 0
          ? "The processing entry was recorded."
          : "The processing entry is saved. Sign the transaction to record the change on the blockchain."
      )
    );
  })
);

router.post(
  "/:productId/processing/submit",
  generalLimiter,
  requireAuth,
  requireCsrf,
  validate(signedTransactionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const session = requireSession(req);
    const logId = (req.body["logId"] as string | undefined) ?? "";
    if (logId.length === 0) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
        message: "The processing entry identifier is missing.",
        details: [{ path: "logId", message: "This field is required." }],
      });
    }
    res.json(
      ok(
        await submitProcessingEvent({
          logId,
          signedTransaction: req.body.signedTransaction,
          processorWallet: session.walletAddress,
        }),
        "The processing event was recorded."
      )
    );
  })
);

router.get(
  "/:productId/processing",
  generalLimiter,
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    res.json(ok({ logs: await listProcessingLogs(req.params["productId"] ?? "") }));
  })
);

// ------------------------------------------------------------------- transport

router.post(
  "/:productId/transport",
  generalLimiter,
  requireAuth,
  requireCsrf,
  requirePermission("product:record-transport"),
  uploadLimiter,
  acceptFiles(6, "documents"),
  asyncHandler(async (req: Request, res: Response) => {
    const session = requireSession(req);
    const parsed = transportEventSchema.safeParse({
      origin: optionalField(req, "origin"),
      destination: optionalField(req, "destination"),
      routeDetails: optionalField(req, "routeDetails"),
      vehicleDescription: optionalField(req, "vehicleDescription"),
      departedAt: optionalField(req, "departedAt"),
      expectedArrivalAt: optionalField(req, "expectedArrivalAt"),
      deliveryStatus: optionalField(req, "deliveryStatus") || "IN_TRANSIT",
    });
    if (!parsed.success) throw toValidationError(parsed.error);

    const result = await prepareTransportEvent({
      productId: req.params["productId"] ?? "",
      transporterWallet: session.walletAddress,
      transporterName: session.user.fullName,
      payload: parsed.data,
      documents: filesOf(req, "documents").map(toUpload),
    });
    res.status(201).json(
      ok(
        result,
        result.prepared.transaction.length === 0
          ? "The journey was recorded."
          : "The journey is saved. Sign the transaction to record the movement on the blockchain."
      )
    );
  })
);

router.post(
  "/:productId/transport/submit",
  generalLimiter,
  requireAuth,
  requireCsrf,
  validate(signedTransactionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const session = requireSession(req);
    const logId = (req.body["logId"] as string | undefined) ?? "";
    if (logId.length === 0) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
        message: "The transport entry identifier is missing.",
        details: [{ path: "logId", message: "This field is required." }],
      });
    }
    res.json(
      ok(
        await submitTransportEvent({
          logId,
          signedTransaction: req.body.signedTransaction,
          transporterWallet: session.walletAddress,
        }),
        "The transport event was recorded."
      )
    );
  })
);

router.get(
  "/:productId/transport",
  generalLimiter,
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    res.json(ok({ logs: await listTransportLogs(req.params["productId"] ?? "") }));
  })
);

/**
 * Attaches a file to the batch. The file is hashed on arrival, so its contents
 * can be checked later for substitution.
 */
router.post(
  "/:productId/media",
  generalLimiter,
  requireAuth,
  requireCsrf,
  requirePermission("certificate:attach"),
  uploadLimiter,
  acceptFiles(1, "file"),
  asyncHandler(async (req: Request, res: Response) => {
    const session = requireSession(req);
    const kind = optionalField(req, "kind");
    if (kind !== "IMAGE" && kind !== "DOCUMENT") {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
        message: "Choose whether the file is an image or a document.",
        details: [{ path: "kind", message: "Use IMAGE or DOCUMENT." }],
      });
    }
    const product = await ProductMetadataModel.findOne({
      productId: (req.params["productId"] ?? "").toUpperCase(),
    });
    if (product === null) {
      throw new AppError(ERROR_CODES.PRODUCT_NOT_FOUND, {
        details: { productId: req.params["productId"] },
      });
    }
    const isParty =
      product.ownerWallet === session.walletAddress ||
      product.registeredByWallet === session.walletAddress;
    if (!isParty && session.user.role !== "REGULATOR") {
      throw new AppError(ERROR_CODES.FORBIDDEN, {
        message: "Only the participants handling this batch can attach files to it.",
      });
    }
    const file = filesOf(req, "file")[0];
    if (file === undefined) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
        message: "Select a file to upload.",
        details: [{ path: "file", message: "A file is required." }],
      });
    }
    res.status(201).json(
      ok(
        {
          media: await storeUpload({
            buffer: file.buffer,
            originalName: file.originalname,
            mimeType: file.mimetype,
            uploadedByWallet: session.walletAddress,
            productId: product.productId,
            kind,
          }),
        },
        "The file was stored."
      )
    );
  })
);
// ----------------------------------------------------------------- transfers

router.post(
  "/:productId/transfers",
  generalLimiter,
  requireAuth,
  requireCsrf,
  requirePermission("transfer:create"),
  idempotency(),
  asyncHandler(async (req: Request, res: Response) => {
    const session = requireSession(req);
    const prepared = await prepareTransfer({
      productId: req.params["productId"] ?? "",
      signerWallet: session.walletAddress,
      signerRole: session.role,
      payload: {
        toWallet: String(req.body?.["toWallet"] ?? "").trim(),
        note: String(req.body?.["note"] ?? "").trim(),
      },
    });
    res.status(201).json(
      ok(
        prepared,
        "The transfer is prepared. Sign the transaction in your wallet to hand the batch over."
      )
    );
  })
);

// --------------------------------------------------------------- certificates

router.post(
  "/:productId/certificates",
  generalLimiter,
  requireAuth,
  requireCsrf,
  requirePermission("certificate:attach"),
  uploadLimiter,
  acceptFiles(1, "document"),
  asyncHandler(async (req: Request, res: Response) => {
    const session = requireSession(req);
    const parsed = certificateSchema.safeParse({
      issuingBody: optionalField(req, "issuingBody"),
      certificateType: optionalField(req, "certificateType"),
      referenceNumber: optionalField(req, "referenceNumber"),
      issuedOn: optionalField(req, "issuedOn"),
      expiresOn: optionalField(req, "expiresOn"),
    });
    if (!parsed.success) throw toValidationError(parsed.error);
    const document = filesOf(req, "document")[0];
    if (document === undefined) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
        message: "Select the certificate document to upload.",
        details: [{ path: "document", message: "A file is required." }],
      });
    }
    res.status(201).json(
      ok(
        await attachCertificate({
          productId: req.params["productId"] ?? "",
          uploaderWallet: session.walletAddress,
          uploaderRole: session.role,
          payload: parsed.data,
          document: toUpload(document),
        }),
        "The certificate was attached to the batch."
      )
    );
  })
);

router.get(
  "/:productId/certificates",
  generalLimiter,
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    res.json(ok({ certificates: await listCertificates(req.params["productId"] ?? "") }));
  })
);

// ------------------------------------------------------------------ status/sale

const statusUpdateSchema = z.object({
  status: z.enum([
    "IN_PROCESSING",
    "PROCESSED",
    "IN_TRANSIT",
    "AT_RETAILER",
    "LISTED",
    "SOLD",
  ]),
  occurredAt: z
    .string()
    .trim()
    .refine((value) => !Number.isNaN(Date.parse(value)), "Enter a valid date and time."),
});

router.post(
  "/:productId/status/prepare",
  generalLimiter,
  requireAuth,
  requireCsrf,
  requirePermission("product:update-status"),
  validate(statusUpdateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const session = requireSession(req);
    const result = await prepareStatusUpdate({
      productId: req.params["productId"] ?? "",
      actorWallet: session.walletAddress,
      actorRole: session.role,
      status: req.body.status,
      occurredAt: req.body.occurredAt,
    });
    res.json(
      ok(result, "Sign the transaction in your wallet to record the change on the blockchain.")
    );
  })
);

router.post(
  "/:productId/status/submit",
  generalLimiter,
  requireAuth,
  requireCsrf,
  validate(signedTransactionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const session = requireSession(req);
    const product = await submitStatusUpdate({
      productId: req.params["productId"] ?? "",
      signedTransaction: req.body.signedTransaction,
      actorWallet: session.walletAddress,
      actorRole: session.role,
    });
    res.json(
      ok(product, `The batch is now recorded as ${statusLabel(product.status as ProductStatus).toLowerCase()}.`)
    );
  })
);

/** Retailer listing state, which is a business decision rather than a chain one. */
router.patch(
  "/:productId/sale",
  generalLimiter,
  requireAuth,
  requireCsrf,
  requirePermission("product:list-for-sale"),
  validate(saleUpdateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const session = requireSession(req);
    const product = await updateSaleState({
      productId: req.params["productId"] ?? "",
      retailerWallet: session.walletAddress,
      payload: req.body,
    });
    res.json(
      ok(
        product,
        product.retail["listed"] === true
          ? "The batch is listed for sale."
          : "The batch is no longer listed for sale."
      )
    );
  })
);

// -------------------------------------------------------------------- helpers

function toUpload(file: Express.Multer.File): {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
} {
  return { buffer: file.buffer, originalName: file.originalname, mimeType: file.mimetype };
}


export default router;
