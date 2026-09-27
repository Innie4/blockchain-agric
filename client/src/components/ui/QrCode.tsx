import { useEffect, useState } from "react";
import { toDataURL } from "qrcode";
import { Button } from "./Button";
import { Icon } from "./Icon";

export interface QrCodeProps {
  /** Used in the image's alternative text, so it is not decorative. */
  productId: string;
  /** The text to encode. Defaults to the public verification link. */
  payload: string;
  /** Rendered size in pixels. */
  size?: number;
  caption?: string;
}

const ENCODE_OPTIONS = {
  errorCorrectionLevel: "M",
  margin: 2,
  color: { dark: "#23261F", light: "#FFFFFF" },
} as const;

/**
 * The verification code printed on a pack.
 *
 * Scanning it opens the public verification page, which anyone can reach and
 * which needs no account. If the code cannot be drawn, the link is printed in
 * full underneath, so the label is still usable by hand.
 */
export function QrCode({ productId, payload, size = 192, caption }: QrCodeProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [hasFailed, setHasFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    setHasFailed(false);
    void toDataURL(payload, { ...ENCODE_OPTIONS, width: size * 2 })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setHasFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [payload, size]);

  return (
    <div className="qr">
      {dataUrl === null ? (
        <p className="text-secondary text-sm">
          {hasFailed
            ? "The code could not be drawn. Use the link below instead."
            : "Preparing the code."}
        </p>
      ) : (
        <div className="qr__frame">
          <img
            className="qr__image"
            src={dataUrl}
            width={size}
            height={size}
            alt={`Verification QR code for batch ${productId}`}
          />
        </div>
      )}

      {caption === undefined ? null : <p className="qr__caption">{caption}</p>}

      <p className="qr__payload">{payload}</p>

      <div className="qr__actions">
        {dataUrl === null ? null : (
          <a
            className="btn btn--secondary btn--sm"
            href={dataUrl}
            download={`verification-${productId}.png`}
          >
            <Icon name="download" size={16} />
            Download code
          </a>
        )}
        <a className="btn btn--quiet btn--sm" href={payload} target="_blank" rel="noreferrer noopener">
          <Icon name="externalLink" size={16} />
          Open the verification page
        </a>
        <Button
          variant="quiet"
          size="sm"
          onClick={() => {
            if (typeof window !== "undefined") window.print();
          }}
        >
          <Icon name="clipboard" size={16} />
          Print this label
        </Button>
      </div>
    </div>
  );
}
