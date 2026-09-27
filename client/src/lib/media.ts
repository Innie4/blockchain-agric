import { downloadMedia } from "../api";
import type { MediaRef } from "../api/types";
import { useEffect, useState } from "react";

/**
 * Fetches a stored file and returns an object URL for it.
 *
 * The URL is revoked when the component unmounts or the id changes, so a long
 * product page does not leak a blob per image.
 */
export function useMediaObjectUrl(
  mediaId: string | null,
): { url: string | null; isLoading: boolean; hasFailed: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);

  useEffect(() => {
    if (mediaId === null || mediaId.length === 0) {
      setUrl(null);
      setHasFailed(false);
      return;
    }

    const controller = new AbortController();
    let revoked = false;
    let objectUrl: string | null = null;

    setIsLoading(true);
    setHasFailed(false);

    void downloadMedia(mediaId, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setHasFailed(true);
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setIsLoading(false);
      });

    return () => {
      controller.abort();
      if (objectUrl !== null && !revoked) {
        revoked = true;
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [mediaId]);

  return { url, isLoading, hasFailed };
}

/** Convenience: the caption an image should be shown with, or a neutral one. */
export function captionFor(reference: MediaRef | { fileName: string; caption: string }): string {
  const caption = reference.caption.trim();
  if (caption.length > 0) return caption;
  return reference.fileName;
}
