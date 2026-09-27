import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { logVerification, verifyProductPublic } from "../../api/endpoints";
import { ApiError, type ApiErrorCode } from "../../api/errors";
import {
  ROLE_LABELS,
  VERIFICATION_RESULT_LABELS,
  isRole,
  type PublicCertificateSummary,
  type PublicProduct,
  type ReaderSource,
  type Verification,
  type VerificationResponse,
  type VerificationResult,
} from "../../api/types";
import {
  ErrorState,
  FailureState,
  LoadingState,
  NotFoundState,
} from "../../components/states";
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  Panel,
  StatusBadge,
  Table,
  Timeline,
  type BadgeTone,
  type PanelTone,
  type TableColumn,
} from "../../components/ui/Index";
import { useToast } from "../../context/ToastContext";
import {
  formatDate,
  formatDateTime,
  formatQuantity,
  toIsoString,
  truncateAddress,
} from "../../lib/format";
import { explorerAddressUrl } from "../../lib/solana";

/* ------------------------------------------------------------------ *
 * The result banner: a label first, colour second
 * ------------------------------------------------------------------ */

interface ResultPresentation {
  readonly heading: string;
  readonly summary: string;
  readonly tone: PanelTone;
  readonly badge: string;
  readonly badgeTone: BadgeTone;
  readonly badgeIcon: "check" | "alertTriangle" | "search" | "warning";
}

const RESULT_PRESENTATION: Record<VerificationResult, ResultPresentation> = {
  VERIFIED: {
    heading: "This batch matches its blockchain record.",
    summary:
      "Every stored detail still produces the fingerprint that was anchored on the blockchain when the batch was registered. The history below is the record the supply chain has agreed on.",
    tone: "primary",
    badge: "Verified",
    badgeTone: "success",
    badgeIcon: "check",
  },
  MISMATCH: {
    heading: "This batch does not match its blockchain record.",
    summary:
      "The details held for this batch no longer produce the fingerprint that was anchored on the blockchain at registration. Something changed after the batch was recorded. Treat the batch as unverified, do not rely on the details below, and tell a regulator.",
    tone: "danger",
    badge: "Details do not match",
    badgeTone: "danger",
    badgeIcon: "alertTriangle",
  },
  NOT_FOUND: {
    heading: "No batch is registered under this identifier.",
    summary:
      "The blockchain holds no record for this identifier. Check the identifier against the packaging, or search for the crop and farm instead.",
    tone: "default",
    badge: "No record found",
    badgeTone: "neutral",
    badgeIcon: "search",
  },
  INCOMPLETE: {
    heading: "This batch could not be checked right now.",
    summary:
      "Either the network could not be reached, or this batch has not finished being written to the blockchain. Nothing here should be treated as verified. Try again shortly.",
    tone: "warning",
    badge: "Not yet fully registered",
    badgeTone: "warning",
    badgeIcon: "warning",
  },
};

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function decodeParam(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const decoded = decodeURIComponent(trimmed);
    return decoded.trim().length === 0 ? null : decoded;
  } catch {
    return trimmed;
  }
}

/**
 * How the reader reached this page. The server decides the rest of the recorded
 * channel from the session, because only the server can tell a regulator's
 * review from an anonymous visit.
 */
function readerSource(source: string | null): ReaderSource {
  if (source === "qr") return "qr";
  const referrer = typeof document === "undefined" ? "" : document.referrer;
  if (referrer.length > 0) {
    try {
      if (new URL(referrer).pathname.startsWith("/search")) return "search";
    } catch {
      // A referrer that is not a URL tells us nothing, so the direct case stands.
    }
  }
  return "direct";
}

/** The most plausible reason a check could not be completed, as an API error. */
function incompleteError(verification: Verification): ApiError {
  const code: ApiErrorCode = !verification.chainReachable
    ? "BLOCKCHAIN_RPC_UNAVAILABLE"
    : !verification.recordPresent
      ? "BLOCKCHAIN_ACCOUNT_NOT_FOUND"
      : "PRODUCT_STATE_INVALID";
  return new ApiError({ code, status: 0, message: verification.explanation });
}

function roleLabel(value: string | null): string {
  if (value === null || value.trim().length === 0) return "Not published";
  const trimmed = value.trim();
  return isRole(trimmed) ? ROLE_LABELS[trimmed] : trimmed;
}

/** Who performed the check, taken from the batch's own verification history. */
function describeLastRequester(product: PublicProduct): string {
  const history = product.verificationHistory;
  const last = history.length === 0 ? undefined : history[history.length - 1];
  if (last === undefined) return "No earlier check has been recorded for this batch.";

  if (last.requester === "PUBLIC") {
    return "Checked by a member of the public, with no account.";
  }

  const roles = product.provenance
    .filter((event) => event.kind === "VERIFICATION" && event.actorRole !== null)
    .map((event) => event.actorRole)
    .filter((role): role is string => role !== null);
  const category = roles.at(-1);

  if (category === undefined) return "Checked by a signed-in participant.";
  return `Checked by a signed-in participant, recorded under the category ${roleLabel(category)}.`;
}

/* ------------------------------------------------------------------ *
 * Pieces of the result
 * ------------------------------------------------------------------ */

function DatedValue({ value }: { value: string | null | undefined }) {
  const iso = toIsoString(value);
  if (iso === undefined) return <>Not recorded</>;
  return (
    <time dateTime={iso}>{formatDate(value)}</time>
  );
}

function DatedTimeValue({ value }: { value: string | null | undefined }) {
  const iso = toIsoString(value);
  if (iso === undefined) return <>Not recorded</>;
  return <time dateTime={iso}>{formatDateTime(value)}</time>;
}

function FingerprintRow({ hash, onCopy }: { hash: string | null; onCopy: (value: string) => void }) {
  if (hash === null || hash.length === 0) {
    return <dd className="text-secondary">No fingerprint has been anchored for this batch.</dd>;
  }
  const short = hash.slice(0, 16);
  return (
    <dd>
      <span className="cluster cluster--tight">
        <span className="hash" title={hash} aria-label={`Anchored fingerprint ${hash}`}>
          {short}
          <span aria-hidden="true">…</span>
        </span>
        <Button
          variant="quiet"
          size="sm"
          onClick={() => {
            onCopy(hash);
          }}
        >
          <Icon name="clipboard" size={16} />
          Copy
          <span className="visually-hidden"> the full anchored fingerprint</span>
        </Button>
      </span>
      <span className="visually-hidden">{hash}</span>
    </dd>
  );
}

const CERTIFICATE_COLUMNS: readonly TableColumn<PublicCertificateSummary>[] = [
  {
    key: "certificate",
    header: "Certificate",
    isRowHeader: true,
    render: (row) => (
      <span>
        {row.issuingBody}
        <span className="table__secondary">{row.referenceNumber}</span>
      </span>
    ),
  },
  { key: "type", header: "Type", render: (row) => row.certificateType },
  { key: "issued", header: "Issued", render: (row) => <DatedValue value={row.issuedOn} /> },
  { key: "expires", header: "Expires", render: (row) => <DatedValue value={row.expiresOn} /> },
];

function HashComparison({ verification }: { verification: Verification }) {
  const { onChain, stored, computed } = verification.dataHash;
  const rows: ReadonlyArray<{ label: string; detail: string; value: string | null }> = [
    {
      label: "On the blockchain",
      detail: "The fingerprint anchored when the batch was registered. It cannot be edited.",
      value: onChain,
    },
    {
      label: "Held in the records",
      detail: "The fingerprint of the details as they were saved at registration.",
      value: stored,
    },
    {
      label: "Recomputed now",
      detail: "The fingerprint the details produce when they are read again just now.",
      value: computed,
    },
  ];

  return (
    <Panel title="Why it does not match" tone="danger">
      <p className="measure text-sm text-secondary">
        These are the three values that were compared. A buyer or a regulator can read the
        difference directly, without trusting this interface's conclusion.
      </p>
      <dl className="definition-list">
        {rows.map((row) => (
          <Fragment key={row.label}>
            <dt>{row.label}</dt>
            <dd>
              {row.value === null || row.value.length === 0 ? (
                <span className="text-secondary">No value was returned.</span>
              ) : (
                <span className="hash" title={row.value} aria-label={`${row.label}: ${row.value}`}>
                  {row.value}
                </span>
              )}
              <span className="table__secondary">{row.detail}</span>
            </dd>
          </Fragment>
        ))}
      </dl>
    </Panel>
  );
}

function ProductFacts({
  product,
  onCopy,
  provenanceIsUntrusted,
}: {
  product: PublicProduct;
  onCopy: (value: string) => void;
  provenanceIsUntrusted: boolean;
}) {
  const address = product.onChainAddress;
  const explorerUrl = explorerAddressUrl(address);

  return (
    <>
      <Panel title="The facts on record">
        <dl className="definition-list">
          <dt>Product type</dt>
          <dd>{product.cropType}</dd>

          <dt>Quantity</dt>
          <dd>{formatQuantity(product.quantity, product.unit)}</dd>

          <dt>Origin as recorded</dt>
          <dd>{product.origin}</dd>

          <dt>Harvest date</dt>
          <dd>
            <DatedValue value={product.harvestDate} />
          </dd>

          <dt>Registered on the blockchain</dt>
          <dd>
            <DatedValue value={product.registeredAt} />
          </dd>

          <dt>Current owner</dt>
          <dd>
            {roleLabel(product.currentOwnerCategory)}
            <span className="table__secondary">
              The public record gives the category of business only, never the wallet address.
            </span>
          </dd>

          <dt>Registered by</dt>
          <dd>{roleLabel(product.registrantCategory)}</dd>

          <dt>Stage</dt>
          <dd>
            <StatusBadge status={product.status} />
            <span className="table__secondary">{product.statusLabel}</span>
          </dd>

          <dt>Anchored fingerprint</dt>
          <FingerprintRow hash={product.dataHash} onCopy={onCopy} />

          <dt>On-chain address</dt>
          <dd>
            {address === null || address.length === 0 ? (
              <span className="text-secondary">
                No account address was returned, so the record cannot be opened on the explorer.
              </span>
            ) : (
              <span className="stack stack--tight">
                <span className="hash" title={address} aria-label={`On-chain address ${address}`}>
                  {truncateAddress(address)}
                </span>
                {explorerUrl === null ? null : (
                  <a href={explorerUrl} target="_blank" rel="noreferrer noopener">
                    View on Solana Explorer
                    <span className="visually-hidden">
                      {" "}
                      for {truncateAddress(address)}, opens in a new tab
                    </span>
                  </a>
                )}
              </span>
            )}
          </dd>

          {product.description.trim().length === 0 ? null : (
            <>
              <dt>Description</dt>
              <dd>{product.description}</dd>
            </>
          )}
        </dl>
      </Panel>

      {provenanceIsUntrusted ? (
        <div className="notice notice--danger">
          <Icon name="alertTriangle" size={18} />
          <div className="notice__body">
            <p className="notice__title">Shown for reference only — not verified</p>
            <p className="text-sm text-secondary">
              Because the fingerprint does not match, nothing in the history or the certificates
              below has been checked against the blockchain. Read it as a claim, not as a fact.
            </p>
          </div>
        </div>
      ) : null}

      <Panel
        title={provenanceIsUntrusted ? "History (unverified)" : "History"}
        actions={
          provenanceIsUntrusted ? (
            <Badge tone="danger" icon="alertTriangle">
              Not verified
            </Badge>
          ) : null
        }
      >
        <Timeline
          events={product.provenance}
          emptyLabel="No events have been recorded against this batch yet."
        />
      </Panel>

      <Panel title="Certificates">
        {product.certificates.length === 0 ? (
          <EmptyState
            icon="fileText"
            title="No certificates are attached to this batch"
            description="A processor or a retailer can attach a certificate to the batch. Until one is attached, there is nothing to show here."
          />
        ) : (
          <Table
            caption="Certificates attached to this batch"
            columns={CERTIFICATE_COLUMNS}
            rows={product.certificates}
            rowKey={(row) => row.certificateId}
            compact
          />
        )}
      </Panel>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly error: unknown }
  | { readonly phase: "ready"; readonly response: VerificationResponse };

type LogState =
  | { readonly phase: "pending" }
  | { readonly phase: "recorded"; readonly verificationId: string }
  | { readonly phase: "failed"; readonly message: string };

export default function VerifyResultPage() {
  const { productId: rawParam } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { push } = useToast();

  const productId = useMemo(() => decodeParam(rawParam), [rawParam]);
  const source = searchParams.get("source");
  const source_ = useMemo(() => readerSource(source), [source]);

  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [log, setLog] = useState<LogState>({ phase: "pending" });

  useEffect(() => {
    if (productId === null) return;
    const controller = new AbortController();
    setLoad({ phase: "loading" });
    setLog({ phase: "pending" });

    verifyProductPublic(productId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setLoad({ phase: "ready", response });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({ phase: "failed", error });
      });

    return () => controller.abort();
  }, [attempt, productId]);

  // The attempt is written to the server so a regulator can see who checked what.
  useEffect(() => {
    if (productId === null) return;
    if (load.phase !== "ready") return;

    const controller = new AbortController();
    logVerification(productId, source_, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setLog({ phase: "recorded", verificationId: result.verificationId });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLog({
          phase: "failed",
          message: error instanceof Error ? error.message : "The attempt could not be recorded.",
        });
      });

    return () => controller.abort();
  }, [source_, load, productId]);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  const copy = useCallback(
    (value: string) => {
      void navigator.clipboard
        ?.writeText(value)
        .then(() => {
          push({ tone: "info", title: "Fingerprint copied to the clipboard" });
        })
        .catch(() => {
          push({
            tone: "warning",
            title: "The fingerprint could not be copied",
            message: "Select the value and copy it manually.",
          });
        });
    },
    [push],
  );

  const printPage = useCallback(() => {
    if (typeof window !== "undefined") window.print();
  }, []);

  if (productId === null) {
    return (
      <div className="page">
        <h1>Check a batch</h1>
        <ErrorState
          title="No batch identifier was given"
          error={new Error("The address on this page did not include a batch identifier.")}
          onRetry={() => {
            navigate("/verify");
          }}
          retryLabel="Go to the batch lookup"
          actions={
            <Link className="btn btn--secondary" to="/search">
              Search the registry
            </Link>
          }
        />
      </div>
    );
  }

  const heading = (
    <header className="page-header">
      <div className="page-header__text">
        <h1 className="page-header__title">Batch {productId}</h1>
        <p className="page-header__description">
          {load.phase === "ready"
            ? "Checked just now against the record anchored on the blockchain. No account was used, and none is needed."
            : "Checking this batch against the record anchored on the blockchain."}
        </p>
      </div>
      <div className="page-header__actions">
        <Link className="btn btn--secondary" to="/verify">
          <Icon name="search" size={16} />
          Check another batch
        </Link>
      </div>
    </header>
  );

  if (load.phase === "loading") {
    return (
      <div className="page">
        {heading}
        <LoadingState
          label={`Checking batch ${productId} against the blockchain record`}
          rows={4}
        />
      </div>
    );
  }

  if (load.phase === "failed") {
    return (
      <div className="page">
        {heading}
        <ErrorState
          error={load.error}
          title={`Batch ${productId} could not be checked`}
          retryLabel="Check it again"
          onRetry={retry}
          actions={
            <>
              <Link className="btn btn--secondary" to="/search">
                Search the registry
              </Link>
              <Link className="btn btn--quiet" to="/verify">
                Check a different batch
              </Link>
            </>
          }
        />
      </div>
    );
  }

  const { verification, product } = load.response;
  const presentation = RESULT_PRESENTATION[verification.result];
  const isMismatch = verification.result === "MISMATCH";

  const chainNotices: ReactNode[] = [];
  if (!verification.chainReachable) {
    chainNotices.push(
      <div key="chain" className="notice notice--warning">
        <Icon name="warning" size={18} />
        <div className="notice__body">
          <p className="notice__title">The network could not be reached for this check</p>
          <p className="text-sm text-secondary">
            The comparison could not be made, so nothing on this page should be read as confirmed.
            Nothing has been changed.
          </p>
        </div>
      </div>,
    );
  }
  if (!verification.recordPresent && verification.result !== "NOT_FOUND") {
    chainNotices.push(
      <div key="record" className="notice notice--warning">
        <Icon name="warning" size={18} />
        <div className="notice__body">
          <p className="notice__title">No on-chain record was found for this identifier</p>
          <p className="text-sm text-secondary">
            The record may still be being written, or the write may never have completed. Ask the
            supplier, and tell a regulator if the batch is being sold in the meantime.
          </p>
        </div>
      </div>,
    );
  }

  const banner = (
    <Panel tone={presentation.tone}>
      <div className="stack stack--tight">
        <div className="cluster cluster--tight">
          <Badge tone={presentation.badgeTone} icon={presentation.badgeIcon}>
            {presentation.badge}
          </Badge>
          <span className="text-xs text-muted">
            Result {VERIFICATION_RESULT_LABELS[verification.result]} · reference{" "}
            <span className="hash">{verification.verificationId}</span>
          </span>
        </div>
        <h2>{presentation.heading}</h2>
        <p className="measure text-secondary">{presentation.summary}</p>
        {verification.explanation === presentation.summary ? null : (
          <p className="measure text-secondary">{verification.explanation}</p>
        )}

        {isMismatch && verification.mismatch !== null ? (
          <p className="text-sm">
            <strong>Reason recorded: {verification.mismatch.reason}</strong>
            {verification.mismatch.field === undefined ? null : (
              <span className="text-secondary"> — the field that differs is {verification.mismatch.field}.</span>
            )}
          </p>
        ) : null}

        {isMismatch ? (
          <div className="cluster">
            <Button variant="primary" onClick={printPage}>
              <Icon name="fileText" size={16} />
              Print or save this result
            </Button>
            <Link className="btn btn--secondary" to="/verify">
              Check another batch
            </Link>
            <Link className="btn btn--quiet" to="/search">
              Search the registry
            </Link>
          </div>
        ) : null}
      </div>
    </Panel>
  );

  if (verification.result === "NOT_FOUND") {
    return (
      <div className="page">
        {heading}
        <div role="alert">{banner}</div>
        <NotFoundState
          title={`No batch is registered as ${productId}`}
          description="The blockchain holds no record under this identifier. Check it against the packaging — a mistyped or truncated identifier is the usual cause. You can also search by crop or farm location."
          action={
            <div className="cluster cluster--tight">
              <Link className="btn btn--primary" to="/verify">
                Check a different batch
              </Link>
              <Link className="btn btn--secondary" to="/search">
                Search the registry
              </Link>
            </div>
          }
        />
      </div>
    );
  }

  if (verification.result === "INCOMPLETE") {
    return (
      <div className="page">
        {heading}
        <div role="alert">{banner}</div>
        {chainNotices}
        <FailureState
          error={incompleteError(verification)}
          context="check this batch"
          onRetry={retry}
          retryLabel="Check it again"
          actions={
            <>
              <Link className="btn btn--secondary" to="/verify">
                Check a different batch
              </Link>
              <Link className="btn btn--quiet" to="/search">
                Search the registry
              </Link>
            </>
          }
        />
      </div>
    );
  }

  if (product === null) {
    return (
      <div className="page">
        {heading}
        <div role="alert">{banner}</div>
        <ErrorState
          title="The details of this batch could not be returned"
          error={new Error(verification.explanation)}
          retryLabel="Ask for them again"
          onRetry={retry}
          actions={
            <Link className="btn btn--secondary" to="/search">
              Search the registry
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="page">
      {heading}
      <div role="alert">{banner}</div>
      {chainNotices}

      <Panel title="Last checked">
        <div className="measure stack stack--tight text-sm">
          <p>
            This check was carried out at <DatedTimeValue value={verification.verifiedAt} />.
          </p>
          <p className="text-secondary">{describeLastRequester(product)}</p>
          <p className="text-secondary">
            Checks recorded for this batch: {product.verificationCount}
            {product.lastVerificationResult === verification.result ? null : (
              <>
                {" "}
                · the result recorded before this one was{" "}
                {VERIFICATION_RESULT_LABELS[product.lastVerificationResult].toLowerCase()}
              </>
            )}
          </p>
          <p className="text-secondary" aria-live="polite">
            {log.phase === "pending" ? (
              <span className="cluster cluster--tight">
                <Icon name="refresh" size={14} />
                <span>Recording this check so a regulator can see who looked at what.</span>
              </span>
            ) : log.phase === "recorded" ? (
              <span>
                This check was recorded on the server. Reference <span className="hash">{log.verificationId}</span>.
              </span>
            ) : (
              <span className="text-danger">
                This check could not be recorded on the server, so it will not appear in the audit
                trail: {log.message} Nothing was changed, and the result above still stands.
              </span>
            )}
          </p>
        </div>
      </Panel>

      {isMismatch ? <HashComparison verification={verification} /> : null}

      <ProductFacts
        product={product}
        onCopy={copy}
        provenanceIsUntrusted={isMismatch}
      />

      <p className="text-xs text-muted">
        Nothing on this page is a guarantee about the produce itself. It is a report of what the
        record says and whether that record still matches the fingerprint anchored on the
        blockchain. Where the two disagree, the record is the thing in question.
      </p>
    </div>
  );
}
