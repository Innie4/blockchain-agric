import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import mongoose from "mongoose";
import { env } from "../../config/env.js";
import { AppError, ERROR_CODES } from "../../lib/errors.js";
import { sha256Hex } from "../../lib/crypto.js";
import { childLogger } from "../../lib/logger.js";

/** Mongoose re-exports the MongoDB driver, which owns GridFS. */
const { GridFSBucket } = mongoose.mongo;

type GridFsBucket = InstanceType<typeof GridFSBucket>;

const log = childLogger({ layer: "storage" });

export const BUCKET_NAME = "agri-trace-media";

/**
 * Allowed upload types. The list is enforced twice: once against the
 * client-declared MIME type and once against the file's magic bytes, because a
 * declared type can be set by the caller.
 */
export const ALLOWED_UPLOAD_TYPES = {
  "image/jpeg": { extensions: [".jpg", ".jpeg"], category: "IMAGE" },
  "image/png": { extensions: [".png"], category: "IMAGE" },
  "image/webp": { extensions: [".webp"], category: "IMAGE" },
  "application/pdf": { extensions: [".pdf"], category: "DOCUMENT" },
} as const;

export type AllowedMimeType = keyof typeof ALLOWED_UPLOAD_TYPES;
export type MediaCategory = "IMAGE" | "DOCUMENT";

export interface StoredMedia {
  mediaId: string;
  fileName: string;
  mimeType: AllowedMimeType;
  sizeBytes: number;
  contentHash: string;
  kind: MediaCategory;
  storedAt: Date;
}

export interface UploadInput {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  /** Who uploaded the file, recorded in GridFS metadata. */
  uploadedByWallet: string;
  productId: string | null;
  kind: MediaCategory;
  caption?: string;
}

let bucket: GridFsBucket | null = null;

export function mediaBucket(): GridFsBucket {
  if (bucket === null) {
    const database = mongoose.connection.db;
    if (mongoose.connection.readyState !== 1 || database === undefined) {
      throw new AppError(ERROR_CODES.DATABASE_UNAVAILABLE, {
        message: "Files cannot be stored because the database is not connected.",
      });
    }
    bucket = new GridFSBucket(database, {
      bucketName: BUCKET_NAME,
      chunkSizeBytes: 255 * 1024,
    });
  }
  return bucket;
}

/** Drops the cached handle; used after the connection is replaced in tests. */
export function resetMediaBucket(): void {
  bucket = null;
}

export function isAllowedMimeType(value: string): value is AllowedMimeType {
  return Object.prototype.hasOwnProperty.call(ALLOWED_UPLOAD_TYPES, value);
}

/** A safe, opaque name. The caller's filename is never used as a path. */
function safeFileName(originalName: string, mimeType: AllowedMimeType): string {
  const allowed = ALLOWED_UPLOAD_TYPES[mimeType];
  const extension = allowed.extensions[0] as string;
  const stem = originalName
    .replace(/\.[^.]+$/, "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const readable = stem.length > 0 ? stem.toLowerCase() : "document";
  return `${readable}-${randomUUID().slice(0, 8)}${extension}`;
}

/** Magic-byte checks, so a renamed executable cannot masquerade as an image. */
function detectMimeType(buffer: Buffer): AllowedMimeType | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  return null;
}

/**
 * Validates and stores one file. Throws before anything is written if the size,
 * the declared type or the actual bytes are unacceptable.
 */
export async function storeUpload(input: UploadInput): Promise<StoredMedia> {
  if (input.buffer.length === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
      message: "The uploaded file is empty.",
      details: [{ path: "file", message: "Empty file." }],
    });
  }
  if (input.buffer.length > env.UPLOAD_MAX_FILE_BYTES) {
    throw new AppError(ERROR_CODES.FILE_TOO_LARGE, {
      message: `Files must be ${formatBytes(env.UPLOAD_MAX_FILE_BYTES)} or smaller.`,
      details: {
        maxBytes: env.UPLOAD_MAX_FILE_BYTES,
        receivedBytes: input.buffer.length,
      },
    });
  }
  if (!isAllowedMimeType(input.mimeType)) {
    throw new AppError(ERROR_CODES.UNSUPPORTED_FILE_TYPE, {
      message: "Accepted file types are JPEG, PNG, WebP images and PDF documents.",
      details: { received: input.mimeType, allowed: Object.keys(ALLOWED_UPLOAD_TYPES) },
    });
  }
  const detected = detectMimeType(input.buffer);
  if (detected === null || detected !== input.mimeType) {
    throw new AppError(ERROR_CODES.UNSUPPORTED_FILE_TYPE, {
      message:
        "The contents of the file do not match the file type that was declared. Accepted types are JPEG, PNG, WebP and PDF.",
      details: { declared: input.mimeType, detected },
    });
  }
  if (input.kind !== ALLOWED_UPLOAD_TYPES[input.mimeType].category) {
    throw new AppError(ERROR_CODES.UNSUPPORTED_FILE_TYPE, {
      message: "That file type cannot be used in this part of the form.",
      details: { kind: input.kind, mimeType: input.mimeType },
    });
  }

  const fileName = safeFileName(input.originalName, input.mimeType);
  const contentHash = sha256Hex(input.buffer);
  const target = mediaBucket();
  const objectId = new mongoose.Types.ObjectId();
  const stream = target.openUploadStream(fileName, {
    // GridFS would otherwise mint its own `_id`, and the identifier recorded on
    // the product would not address the stored file.
    id: objectId,
    contentType: input.mimeType,
    metadata: {
      productId: input.productId,
      uploadedByWallet: input.uploadedByWallet,
      kind: input.kind,
      caption: input.caption ?? "",
      contentHash,
      uploadedAt: new Date().toISOString(),
    },
  });

  await pipeline(Readable.from(input.buffer), stream);

  log.info(
    { productId: input.productId, fileName, contentHash, bytes: input.buffer.length },
    "stored upload in GridFS"
  );

  return {
    mediaId: objectId.toHexString(),
    fileName,
    mimeType: input.mimeType,
    sizeBytes: input.buffer.length,
    contentHash,
    kind: input.kind,
    storedAt: new Date(),
  };
}

export interface RetrievedMedia {
  mediaId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  stream: Readable;
}

/**
 * Reads a stored file. Callers must have already checked that the requester is
 * allowed to see it; this function performs no authorisation itself.
 */
export async function retrieveMedia(
  mediaId: string
): Promise<RetrievedMedia | null> {
  if (!mongoose.Types.ObjectId.isValid(mediaId)) return null;
  const objectId = new mongoose.Types.ObjectId(mediaId);

  // The files collection is queried directly rather than through
  // `GridFSBucket.find`, whose cursor does not reliably return results across
  // driver versions.
  const database = mongoose.connection.db;
  if (database === undefined) return null;
  const file = await database
    .collection(`${BUCKET_NAME}.files`)
    .findOne({ _id: objectId });
  if (file === null) return null;

  const record = file as {
    length?: number;
    contentType?: string;
    filename?: string;
    metadata?: { contentHash?: string };
  };

  return {
    mediaId,
    fileName: record.filename ?? "document",
    mimeType: record.contentType ?? "application/octet-stream",
    sizeBytes: record.length ?? 0,
    contentHash: record.metadata?.contentHash ?? "",
    stream: Readable.from(
      mediaBucket().openDownloadStream(objectId)
    ),
  };
}

export async function deleteMedia(mediaId: string): Promise<void> {
  if (!mongoose.Types.ObjectId.isValid(mediaId)) return;
  await mediaBucket().delete(new mongoose.Types.ObjectId(mediaId));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
