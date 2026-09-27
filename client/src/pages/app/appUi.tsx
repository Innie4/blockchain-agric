import type { ReactNode } from "react";
import { Badge, Button, Icon } from "../../components/ui/Index";
import type { ChainState, MetricTone, Pagination } from "../../api/types";
import { formatDate, formatDateTime, toIsoString, truncateAddress } from "../../lib/format";
import { explorerAddressUrl, explorerTxUrl } from "../../lib/solana";
import { chainStateLabel, chainStateTone, describeRange } from "./appData";

/**
 * Presentational pieces every authenticated page needs and none should define
 * twice: a date that is also machine-readable, a value with a copy control, a
 * real pair of pagination buttons, and a figure with its label.
 *
 * Nothing here fetches anything, and nothing here computes a business value.
 */

/* ------------------------------------------------------------------ *
 * Dates
 * ------------------------------------------------------------------ */

/** A date, or an honest statement that none was recorded. */
export function DatedValue({ value }: { value: string | null | undefined }) {
  const iso = toIsoString(value);
  if (iso === undefined) return <>Not recorded</>;
  return <time dateTime={iso}>{formatDate(value)}</time>;
}

/** A date with the time, for a moment rather than a day. */
export function DatedTimeValue({ value }: { value: string | null | undefined }) {
  const iso = toIsoString(value);
  if (iso === undefined) return <>Not recorded</>;
  return <time dateTime={iso}>{formatDateTime(value)}</time>;
}

/* ------------------------------------------------------------------ *
 * Copyable values
 * ------------------------------------------------------------------ */

export function CopyButton({
  value,
  what,
  onCopy,
}: {
  value: string;
  what: string;
  onCopy: (value: string) => void;
}) {
  return (
    <Button variant="quiet" size="sm" onClick={() => { onCopy(value); }}>
      <Icon name="clipboard" size={16} />
      Copy
      <span className="visually-hidden"> the {what}</span>
    </Button>
  );
}

/** A wallet address, shortened for reading and whole for the clipboard. */
export function AddressValue({
  address,
  onCopy,
  what = "wallet address",
}: {
  address: string | null | undefined;
  onCopy: (value: string) => void;
  what?: string;
}) {
  if (address === null || address === undefined || address.length === 0) {
    return <span className="text-secondary">Not recorded</span>;
  }
  const explorerUrl = explorerAddressUrl(address);
  return (
    <span className="cluster cluster--tight">
      <span className="hash" title={address} aria-label={`${what} ${address}`}>
        {truncateAddress(address)}
      </span>
      <CopyButton value={address} what={what} onCopy={onCopy} />
      {explorerUrl === null ? null : (
        <a href={explorerUrl} target="_blank" rel="noreferrer noopener">
          Explorer
          <span className="visually-hidden">
            {" "}
            for {truncateAddress(address)}, opens in a new tab
          </span>
        </a>
      )}
    </span>
  );
}

/** A transaction signature, with a link to check it on the explorer. */
export function SignatureValue({ signature }: { signature: string | null | undefined }) {
  if (signature === null || signature === undefined || signature.length === 0) {
    return <span className="text-secondary">No transaction has been recorded yet.</span>;
  }
  const explorerUrl = explorerTxUrl(signature);
  return (
    <span className="stack stack--tight">
      <span className="hash" title={signature} aria-label={`Transaction signature ${signature}`}>
        {truncateAddress(signature, 8, 8)}
      </span>
      {explorerUrl === null ? null : (
        <a href={explorerUrl} target="_blank" rel="noreferrer noopener">
          View this transaction on Solana Explorer
          <span className="visually-hidden">, opens in a new tab</span>
        </a>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * The chain state
 * ------------------------------------------------------------------ */

/**
 * How far the blockchain side of a record has got.
 *
 * A batch that is waiting for a signature is not registered, and saying so
 * plainly is the whole point: the label is written out and never left to the
 * colour.
 */
export function ChainStateBadge({ state }: { state: ChainState }) {
  return (
    <Badge tone={chainStateTone(state)} icon={state === "CONFIRMED" ? "check" : "warning"}>
      {chainStateLabel(state)}
    </Badge>
  );
}

/* ------------------------------------------------------------------ *
 * Figures
 * ------------------------------------------------------------------ */

const METRIC_TONE_CLASSES: Record<MetricTone, string | null> = {
  neutral: null,
  success: "metric--success",
  warning: "metric--warning",
  danger: "metric--danger",
  info: "metric--info",
};

/**
 * One labelled figure.
 *
 * Every figure on this screen came from the server; the tile only decides how
 * it reads. A tone tints the value, and the label is always written out, so
 * colour is never the only signal.
 */
export function MetricTile({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: MetricTone;
}) {
  return (
    <div
      className={["metric", METRIC_TONE_CLASSES[tone]].filter(isPresent).join(" ")}
    >
      <span className="metric__label">{label}</span>
      <span className="metric__value">{value}</span>
      {hint === undefined ? null : <span className="metric__hint">{hint}</span>}
    </div>
  );
}

/** A row of labelled figures. */
export function MetricRow({ children }: { children: ReactNode }) {
  return <div className="metric-grid">{children}</div>;
}

/* ------------------------------------------------------------------ *
 * Pagination
 * ------------------------------------------------------------------ */

/**
 * Real previous and next controls.
 *
 * They are disabled at the ends rather than hidden, so a reader can see there
 * is nothing further in that direction, and the range is stated in words.
 */
export function PaginationControls({
  pagination,
  onPageChange,
  noun = "records",
  busy = false,
}: {
  pagination: Pagination;
  onPageChange: (page: number) => void;
  noun?: string;
  busy?: boolean;
}) {
  const { page, total, totalPages } = pagination;
  const isFirst = page <= 1;
  const isLast = page >= totalPages || total === 0;

  return (
    <nav className="pagination" aria-label="Pagination">
      <p className="text-sm" aria-live="polite">
        {describeRange(pagination)} {noun}
      </p>
      <div className="pagination__controls">
        <Button
          variant="secondary"
          size="sm"
          disabled={isFirst || busy}
          onClick={() => {
            onPageChange(page - 1);
          }}
        >
          <Icon name="chevronRight" size={16} className="rotate-90" />
          Previous
        </Button>
        <span className="text-sm text-secondary nowrap">
          Page {page} of {totalPages}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={isLast || busy}
          onClick={() => {
            onPageChange(page + 1);
          }}
        >
          Next
          <Icon name="chevronRight" size={16} />
        </Button>
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------------ *
 * Small pieces
 * ------------------------------------------------------------------ */

/** Keeps an optional class name out of the attribute when it is absent. */
function isPresent(value: string | null | undefined): value is string {
  return value !== null && value !== undefined;
}
