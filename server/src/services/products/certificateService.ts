import { z } from "zod";
import { AppError, ERROR_CODES } from "../../lib/errors.js";
import { assertProductId, newId } from "../../lib/crypto.js";
import { childLogger } from "../../lib/logger.js";
import { assertHashShape } from "../hashing/canonical.js";
import { CertificateModel, ProductMetadataModel } from "../../models/index.js";
import { storeUpload, type StoredMedia } from "../files/mediaStore.js";

const log = childLogger({ layer: "certificates" });

/** An optional date supplied as a form field, normalised to a plain string. */
const optionalDateField = (label: string) =>
  z
    .union([z.string(), z.undefined()])
    .transform((value) => value ?? "")
    .refine(
      (value) => value.length === 0 || !Number.isNaN(Date.parse(value)),
      `Enter a valid ${label}.`
    );

export const certificateSchema = z
  .object({
    issuingBody: z
      .string()
      .trim()
      .min(2, "Name the body that issued the certificate.")
      .max(200),
    certificateType: z
      .string()
      .trim()
      .min(2, "Name the type of certificate, for example organic or phytosanitary.")
      .max(120),
    referenceNumber: z.string().trim().max(120).default(""),
    issuedOn: optionalDateField("issue date"),
    expiresOn: optionalDateField("expiry date"),
  })
  .refine(
    (value) =>
      value.issuedOn.length === 0 ||
      value.expiresOn.length === 0 ||
      Date.parse(value.expiresOn) > Date.parse(value.issuedOn),
    { message: "The expiry date must be after the issue date.", path: ["expiresOn"] }
  );

export type CertificateInput = z.infer<typeof certificateSchema>;

export interface CertificateView {
  certificateId: string;
  productId: string;
  issuingBody: string;
  certificateType: string;
  referenceNumber: string;
  issuedOn: string | null;
  expiresOn: string | null;
  dataHash: string;
  uploadedByWallet: string;
  document: {
    mediaId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    contentHash: string;
  };
  createdAt: string;
}

/**
 * Attaches a certificate to a batch.
 *
 * The document is stored off-chain and its SHA-256 recorded, so a substituted
 * certificate is detectable even though the file itself is not anchored.
 *
 * Attaching a certificate after registration does not change the batch's
 * registration facts, so it does not disturb the anchored registration hash.
 * It is available to anyone the batch's owner, a regulator, or the certificate
 * uploader has authorised.
 */
export async function attachCertificate(input: {
  productId: string;
  uploaderWallet: string;
  uploaderRole: string;
  payload: CertificateInput;
  document: { buffer: Buffer; originalName: string; mimeType: string };
}): Promise<CertificateView> {
  const productId = assertProductId(input.productId);
  const product = await ProductMetadataModel.findOne({ productId });
  if (product === null) {
    throw new AppError(ERROR_CODES.PRODUCT_NOT_FOUND, { details: { productId } });
  }

  const isOwner = product.ownerWallet === input.uploaderWallet;
  const isRegistrant = product.registeredByWallet === input.uploaderWallet;
  const isRegulator = input.uploaderRole === "REGULATOR";
  if (!isOwner && !isRegistrant && !isRegulator) {
    throw new AppError(ERROR_CODES.FORBIDDEN, {
      message:
        "Only the participant holding this batch, the participant who registered it, or a regulator can attach a certificate to it.",
    });
  }

  const stored: StoredMedia = await storeUpload({
    buffer: input.document.buffer,
    originalName: input.document.originalName,
    mimeType: input.document.mimeType,
    uploadedByWallet: input.uploaderWallet,
    productId,
    kind: "DOCUMENT",
  });
  assertHashShape(stored.contentHash, "dataHash");

  const certificateId = newId();
  const created = await CertificateModel.create({
    certificateId,
    productId,
    issuingBody: input.payload.issuingBody,
    certificateType: input.payload.certificateType,
    referenceNumber: input.payload.referenceNumber,
    issuedOn: input.payload.issuedOn.length > 0 ? new Date(input.payload.issuedOn) : null,
    expiresOn: input.payload.expiresOn.length > 0 ? new Date(input.payload.expiresOn) : null,
    document: {
      mediaId: stored.mediaId,
      fileName: stored.fileName,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      contentHash: stored.contentHash,
    },
    dataHash: stored.contentHash,
    uploadedByWallet: input.uploaderWallet,
  });

  log.info({ certificateId, productId }, "attached certificate");
  return toView(created.toObject());
}

export async function listCertificates(productId: string): Promise<CertificateView[]> {
  const entries = await CertificateModel.find({ productId }).sort({ createdAt: 1 }).lean();
  return entries.map((entry) => toView(entry));
}

export async function readCertificate(certificateId: string): Promise<CertificateView> {
  const entry = await CertificateModel.findOne({ certificateId }).lean();
  if (entry === null) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      message: "No certificate exists with that identifier.",
    });
  }
  return toView(entry);
}

/** A lean MongoDB document omits unset fields, so absent and null both occur. */
function isoOrNull(value: Date | null | undefined): string | null {
  return value == null ? null : value.toISOString();
}

function toView(entry: {
  certificateId: string;
  productId: string;
  issuingBody: string;
  certificateType: string;
  referenceNumber: string;
  issuedOn?: Date | null;
  expiresOn?: Date | null;
  dataHash: string;
  uploadedByWallet: string;
  document: { mediaId: string; fileName: string; mimeType: string; sizeBytes: number; contentHash: string };
  createdAt: Date;
}): CertificateView {
  return {
    certificateId: entry.certificateId,
    productId: entry.productId,
    issuingBody: entry.issuingBody,
    certificateType: entry.certificateType,
    referenceNumber: entry.referenceNumber,
    issuedOn: isoOrNull(entry.issuedOn),
    expiresOn: isoOrNull(entry.expiresOn),
    dataHash: entry.dataHash,
    uploadedByWallet: entry.uploadedByWallet,
    document: {
      mediaId: entry.document.mediaId,
      fileName: entry.document.fileName,
      mimeType: entry.document.mimeType,
      sizeBytes: entry.document.sizeBytes,
      contentHash: entry.document.contentHash,
    },
    createdAt: entry.createdAt.toISOString(),
  };
}
