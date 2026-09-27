import multer from "multer";
import { env } from "../config/env.js";
import { AppError, ERROR_CODES } from "../lib/errors.js";
import { ALLOWED_UPLOAD_TYPES } from "../services/files/mediaStore.js";

/**
 * Uploads are buffered in memory with a hard size cap, then validated by
 * content before anything is written. Buffering is safe here because the cap is
 * a few megabytes and it keeps malformed files away from storage entirely.
 */
const allowedMimeTypes = Object.keys(ALLOWED_UPLOAD_TYPES);

export const uploadMedia = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.UPLOAD_MAX_FILE_BYTES,
    files: env.UPLOAD_MAX_FILES_PER_REQUEST,
    fields: 40,
    parts: env.UPLOAD_MAX_FILES_PER_REQUEST + 40,
  },
  fileFilter: (_req, file, callback) => {
    if (!allowedMimeTypes.includes(file.mimetype)) {
      callback(
        new AppError(ERROR_CODES.UNSUPPORTED_FILE_TYPE, {
          message:
            "Accepted file types are JPEG, PNG, WebP images and PDF documents.",
          details: { received: file.mimetype, allowed: allowedMimeTypes },
        })
      );
      return;
    }
    callback(null, true);
  },
});

/** Accepts up to `count` files under any of the given field names. */
export function acceptFiles(count: number, ...fields: string[]) {
  return uploadMedia.fields(fields.map((name) => ({ name, maxCount: count })));
}

/** Rejects a request that carries no file where one is required. */
export function requireFile(
  files: Record<string, Express.Multer.File[]> | undefined,
  field: string
): Express.Multer.File {
  const file = files?.[field]?.[0];
  if (file === undefined) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, {
      message: "Select a file to upload before continuing.",
      details: [{ path: field, message: "A file is required." }],
    });
  }
  return file;
}
