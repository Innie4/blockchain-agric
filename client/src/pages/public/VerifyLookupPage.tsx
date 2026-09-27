import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ErrorState } from "../../components/states/ErrorState";
import { Badge, Button, Field, Icon, Panel, TextInput } from "../../components/ui/Index";
import { verificationPath } from "../../lib/solana";

/* ------------------------------------------------------------------ *
 * The batch identifier
 * ------------------------------------------------------------------ */

/** `AGT-` + a 3–6 character crop code + a four-digit year + a six-character code. */
const BATCH_ID_PATTERN = /^AGT-[A-Z0-9]{3,6}-\d{4}-[A-Z0-9]{6}$/;
const BATCH_ID_MAX_LENGTH = 32;
const EXAMPLE_ID = "AGT-COCOA-2026-A1B2C3";
const IDENTIFIER_FIELD_ID = "batch-identifier";

const SHAPE_HELP =
  `An identifier looks like ${EXAMPLE_ID}: the letters AGT, a crop code of three to six letters ` +
  "or digits, the year, then a six-character code. Spaces and lower case are corrected for you.";

function normaliseIdentifier(raw: string): string {
  return raw.trim().replace(/\s+/g, "").toUpperCase();
}

function validateIdentifier(raw: string): string | null {
  const candidate = normaliseIdentifier(raw);
  if (candidate.length === 0) {
    return `Enter the identifier printed on the packaging, for example ${EXAMPLE_ID}.`;
  }
  if (candidate.length > BATCH_ID_MAX_LENGTH) {
    return "That is longer than any identifier issued. An identifier is at most 32 characters long.";
  }
  if (!BATCH_ID_PATTERN.test(candidate)) {
    return SHAPE_HELP;
  }
  return null;
}

/** The control `Field` gave the `id` to, so focus can be returned to it. */
function focusIdentifierInput(): void {
  const element = document.getElementById(IDENTIFIER_FIELD_ID);
  if (element instanceof HTMLInputElement) element.focus();
}

/* ------------------------------------------------------------------ *
 * QR scanning, behind a feature check
 * ------------------------------------------------------------------ */

interface DetectedBarcode {
  readonly rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}

interface BarcodeDetectorWindow extends Window {
  BarcodeDetector?: BarcodeDetectorConstructor;
}

const REQUESTED_FORMATS: readonly string[] = ["qr_code"];

interface DetectorFormats {
  readonly usable: readonly string[];
}

/**
 * Asks the browser which code formats it can read. A browser that answers with
 * no usable format is treated as having no scanner at all, so manual entry stays
 * the only path rather than offering a control that could never work.
 */
async function resolveDetectorFormats(): Promise<DetectorFormats> {
  if (typeof window === "undefined") return { usable: [] };
  const constructor = (window as BarcodeDetectorWindow).BarcodeDetector;
  if (typeof constructor !== "function") return { usable: [] };

  if (typeof constructor.getSupportedFormats !== "function") {
    return { usable: REQUESTED_FORMATS };
  }
  try {
    const supported = await constructor.getSupportedFormats();
    return { usable: REQUESTED_FORMATS.filter((format) => supported.includes(format)) };
  } catch {
    return { usable: [] };
  }
}

const CAMERA_PERMISSION_MESSAGES: Readonly<Record<string, string | undefined>> = {
  NotAllowedError:
    "The browser would not give this page the camera. Allow the camera for this site from your browser's address bar, then start the scanner again. You can always type the identifier instead.",
  NotFoundError: "No camera was found on this device. Type the identifier in the box instead.",
  NotReadableError:
    "The camera is already in use by another application. Close it, then start the scanner again, or type the identifier instead.",
  OverconstrainedError:
    "No camera on this device could provide a usable image. Type the identifier in the box instead.",
  SecurityError:
    "The browser blocked the camera, which usually means this page is not on a secure connection. Type the identifier in the box instead.",
};

interface ScannerBlocker {
  readonly title: string;
  readonly detail: string;
}

function cameraBlocker(error: unknown): ScannerBlocker {
  const name =
    typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  if (typeof name === "string") {
    const known = CAMERA_PERMISSION_MESSAGES[name];
    if (known !== undefined) return { title: "The camera could not be started", detail: known };
  }
  return {
    title: "The camera could not be started",
    detail:
      "The browser did not grant access to the camera, or no camera is available. Typing the identifier in the box does exactly the same job.",
  };
}

/**
 * Pulls the identifier out of whatever the code decoded to: a bare identifier, a
 * relative link such as `/verify/AGT-…`, or the absolute form printed on a
 * packaging label.
 */
function identifierFromDecodedText(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  let candidate = trimmed;
  if (trimmed.includes("/")) {
    const withoutQuery = trimmed.split(/[?#]/)[0] ?? trimmed;
    const lastSegment = withoutQuery
      .split("/")
      .filter((part) => part.length > 0)
      .at(-1);
    if (lastSegment === undefined) return null;
    try {
      candidate = decodeURIComponent(lastSegment);
    } catch {
      candidate = lastSegment;
    }
  }

  const identifier = normaliseIdentifier(candidate);
  return BATCH_ID_PATTERN.test(identifier) ? identifier : null;
}

type ScannerStatus = "idle" | "starting" | "scanning";

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function VerifyLookupPage() {
  const navigate = useNavigate();

  const [identifier, setIdentifier] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const [detectorFormats, setDetectorFormats] = useState<DetectorFormats | null>(null);
  const [scannerStatus, setScannerStatus] = useState<ScannerStatus>("idle");
  const [blocker, setBlocker] = useState<ScannerBlocker | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);

  // The scanner control only exists if this browser can actually read a code.
  useEffect(() => {
    let cancelled = false;
    void resolveDetectorFormats().then((formats) => {
      if (!cancelled) setDetectorFormats(formats);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const stopScanner = useCallback((): void => {
    cancelledRef.current = true;
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream !== null) {
      for (const track of stream.getTracks()) track.stop();
    }
    const video = videoRef.current;
    if (video !== null) {
      video.pause();
      video.srcObject = null;
    }
  }, []);

  useEffect(() => stopScanner, [stopScanner]);

  const onDecoded = useCallback(
    (value: string) => {
      stopScanner();
      setBlocker(null);
      setIdentifier(value);
      setFieldError(null);
      setHasSubmitted(false);
      navigate(`${verificationPath(value)}?source=qr`);
    },
    [navigate, stopScanner],
  );

  const startScanner = useCallback((): void => {
    const formats = detectorFormats;
    if (formats === null || formats.usable.length === 0) return;

    stopScanner();
    cancelledRef.current = false;
    setBlocker(null);
    setScannerStatus("starting");

    const run = async (): Promise<void> => {
      const constructor = (window as BarcodeDetectorWindow).BarcodeDetector;
      if (typeof constructor !== "function") return;
      const detector = new constructor({ formats: [...formats.usable] });

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
      } catch (error) {
        if (cancelledRef.current) return;
        setBlocker(cameraBlocker(error));
        setScannerStatus("idle");
        return;
      }

      if (cancelledRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;

      const video = videoRef.current;
      if (video !== null) {
        video.srcObject = stream;
        try {
          await video.play();
        } catch {
          // A preview that will not start playing is not fatal: `detect` can
          // still read frames once the element has metadata.
        }
      }
      if (cancelledRef.current) {
        stopScanner();
        return;
      }
      setScannerStatus("scanning");

      const step = (): void => {
        if (cancelledRef.current || video === null) return;
        void detector
          .detect(video)
          .then((codes) => {
            if (cancelledRef.current) return;
            for (const code of codes) {
              const found = identifierFromDecodedText(code.rawValue);
              if (found !== null) {
                onDecoded(found);
                return;
              }
            }
          })
          .catch(() => undefined)
          .then(() => {
            if (!cancelledRef.current) frameRef.current = window.requestAnimationFrame(step);
          });
      };
      frameRef.current = window.requestAnimationFrame(step);
    };

    void run();
  }, [detectorFormats, onDecoded, stopScanner]);

  const closeScanner = useCallback((): void => {
    stopScanner();
    setScannerStatus("idle");
  }, [stopScanner]);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setHasSubmitted(true);
    const problem = validateIdentifier(identifier);
    if (problem !== null) {
      setFieldError(problem);
      return;
    }
    setFieldError(null);
    navigate(verificationPath(normaliseIdentifier(identifier)));
  }

  function clearProblem(): void {
    setFieldError(null);
    setHasSubmitted(false);
    focusIdentifierInput();
  }

  const scannerAvailable = detectorFormats !== null && detectorFormats.usable.length > 0;
  const scannerOpen = scannerStatus === "starting" || scannerStatus === "scanning";

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__text">
          <h1 className="page-header__title">Check a batch</h1>
          <p className="page-header__description">
            Enter the identifier printed on the packaging. Checking a batch needs no account, no
            wallet and no sign-in.
          </p>
        </div>
      </header>

      {hasSubmitted && fieldError !== null ? (
        <ErrorState
          error={new Error(fieldError)}
          title="That identifier could not be checked"
          retryLabel="Clear it and try again"
          onRetry={clearProblem}
          actions={
            <Link className="btn btn--secondary" to="/search">
              Search the registry
            </Link>
          }
        />
      ) : null}

      <Panel title="Batch identifier">
        <form onSubmit={onSubmit} noValidate>
          <div className="stack">
            <Field
              id={IDENTIFIER_FIELD_ID}
              label="Batch identifier"
              hint={`Printed on the packaging as ${EXAMPLE_ID}. ${SHAPE_HELP}`}
              error={fieldError}
              required
            >
              <TextInput
                name="productId"
                value={identifier}
                onChange={(event) => {
                  const next = event.target.value;
                  setIdentifier(next);
                  if (hasSubmitted) setFieldError(validateIdentifier(next));
                }}
                placeholder={EXAMPLE_ID}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={BATCH_ID_MAX_LENGTH + 8}
              />
            </Field>

            <div className="cluster">
              <Button type="submit" variant="primary">
                <Icon name="shield" size={16} />
                Check this batch
              </Button>

              {scannerAvailable && !scannerOpen ? (
                <Button variant="secondary" onClick={startScanner}>
                  <Icon name="qr" size={16} />
                  Scan the QR code
                </Button>
              ) : null}

              {scannerOpen ? (
                <Button variant="quiet" onClick={closeScanner}>
                  <Icon name="x" size={16} />
                  Stop the camera
                </Button>
              ) : null}
            </div>
          </div>
        </form>
      </Panel>

      {scannerAvailable ? (
        <Panel title="Scanning" tone={scannerOpen ? "default" : "sunken"}>
          {blocker === null ? null : (
            <div className="notice notice--danger">
              <Icon name="alertTriangle" size={18} />
              <div className="notice__body">
                <p className="notice__title">{blocker.title}</p>
                <p className="text-sm text-secondary">{blocker.detail}</p>
                <p className="notice__actions">
                  <Button variant="secondary" size="sm" onClick={() => setBlocker(null)}>
                    <Icon name="x" size={16} />
                    Dismiss this and carry on typing
                  </Button>
                </p>
              </div>
            </div>
          )}

          {scannerOpen ? (
            <div
              className="stack stack--tight"
              aria-live="polite"
              aria-busy={scannerStatus === "starting"}
            >
              <p className="cluster cluster--tight text-sm">
                <Badge tone="info" icon="qr">
                  {scannerStatus === "starting" ? "Camera starting" : "Camera on"}
                </Badge>
                <span className="text-secondary">
                  {scannerStatus === "starting"
                    ? "Waiting for the browser to open the camera."
                    : "Hold the label inside the frame. The identifier is filled in for you and the batch opens straight away."}
                </span>
              </p>

              <video
                ref={videoRef}
                className="qr__frame"
                playsInline
                muted
                aria-label="Live camera view, used to read the batch's QR code"
              />

              <p className="text-xs text-muted">
                The camera stops as soon as a code is read, when you press stop, or when you leave
                this page. Nothing is recorded and no image is uploaded.
              </p>
            </div>
          ) : blocker === null ? (
            <p className="text-sm text-secondary">
              This browser can read a QR code with its own camera, so the label does not have to be
              typed out. Typing the identifier by hand always works and does exactly the same thing.
            </p>
          ) : null}
        </Panel>
      ) : null}

      <Panel title="Where do I find the identifier?">
        <div className="measure stack text-sm text-secondary">
          <p>
            It is printed on the packaging as part of a longer code, usually beneath the batch
            number, and it may also be encoded as a QR code. On a label it looks like{" "}
            <span className="hash">{EXAMPLE_ID}</span>.
          </p>
          <p>
            An identifier is permanent. If a batch is re-packed or re-labelled, the original
            identifier stays the same, so a check against an old label still works.
          </p>
          <p>
            If the packaging carries no identifier, search by the crop or the farm instead.
          </p>
          <p>
            <Link to="/search">Search the registry</Link> returns summary information only, and
            needs no account either.
          </p>
        </div>
      </Panel>
    </div>
  );
}
