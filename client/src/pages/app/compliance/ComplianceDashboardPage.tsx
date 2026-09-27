import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  getComplianceOverview,
  listComplianceVerifications,
  prepareAttestation,
  submitAttestation,
} from "../../../api/endpoints";
import {
  formatNumber,
  fromDateInputValue,
  todayInputValue,
  truncateAddress,
} from "../../../lib/format";
import { explorerTxUrl } from "../../../lib/solana";
import {
  ANOMALY_KIND_LABELS,
  VERIFICATION_RESULTS,
  VERIFICATION_RESULT_LABELS,
  isAnomalyKind,
  isProductStatus,
  type AttestationConfirmed,
  type AttestationInput,
  type ComplianceOverview,
  type ComplianceReviewVerification,
  type ComplianceTransferActivity,
  type ComplianceVerificationListResponse,
  type ComplianceVerificationRecord,
  type VerificationResult,
} from "../../../api/types";
import { PageHeader } from "../../../components/layout/PageHeader";
import { ErrorState, FailureState, LoadingState, TransactionState } from "../../../components/states";
import {
  Badge,
  Button,
  DateInput,
  EmptyState,
  Field,
  Icon,
  Panel,
  Select,
  Table,
  TextInput,
  type TableColumn,
} from "../../../components/ui/Index";
import { useToast } from "../../../context/ToastContext";
import { VERIFICATION_TONES, describeProductIdShape } from "../appData";
import {
  DatedTimeValue,
  MetricRow,
  MetricTile,
  PaginationControls,
  SignatureValue,
} from "../appUi";
import { useChainAction } from "../useChainAction";

/**
 * The regulator's overview of the whole registry.
 *
 * Every number on this page is a count the server computed from stored records,
 * and every count is printed with its label. The stage and crop breakdowns are
 * drawn as bars whose length is the real proportion and whose value is written
 * out beside it, because a picture that cannot be read as a number is decoration.
 *
 * Below the figures sit the two things a regulator actually does with them: work
 * through the review queue of checks, and anchor a finding on the blockchain so
 * it cannot later be denied.
 */

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly error: unknown }
  | { readonly phase: "ready"; readonly overview: ComplianceOverview };

/* ------------------------------------------------------------------ *
 * Breakdowns
 * ------------------------------------------------------------------ */

interface BarRow {
  label: string;
  value: number;
  note?: string;
  href?: string;
}

/**
 * A real horizontal bar.
 *
 * The width is a share of the largest figure, so the bars are comparable with
 * each other, and the number is printed in full next to the label. Nothing here
 * is scaled to look impressive.
 */
function BreakdownBars({ rows, noun }: { rows: readonly BarRow[]; noun: string }) {
  const largest = rows.reduce((maximum, row) => Math.max(maximum, row.value), 0);
  const total = rows.reduce((sum, row) => sum + row.value, 0);

  return (
    <div className="stack">
      <dl className="definition-list">
        {rows.map((row) => (
          <Fragment key={row.label}>
            <dt>{row.href === undefined ? row.label : <Link to={row.href}>{row.label}</Link>}</dt>
            <dd>
              <span className="stack stack--tight" style={{ display: "block" }}>
                <span className="text-sm">
                  {formatNumber(row.value)}{" "}
                  <span className="text-secondary">
                    {row.value === 1 ? noun : `${noun}s`}
                    {total > 0
                      ? ` · ${Math.round((row.value / total) * 100)}% of the ${noun}s above`
                      : null}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  style={{
                    display: "block",
                    height: 8,
                    backgroundColor: "var(--surface-sunken)",
                    borderRadius: "var(--radius-sm)",
                  }}
                >
                  <span
                    style={{
                      display: "block",
                      height: 8,
                      width: `${largest === 0 ? 0 : Math.round((row.value / largest) * 100)}%`,
                      backgroundColor: "var(--color-primary)",
                      borderRadius: "var(--radius-sm)",
                    }}
                  />
                </span>
                {row.note === undefined ? null : (
                  <span className="text-xs text-secondary">{row.note}</span>
                )}
              </span>
            </dd>
          </Fragment>
        ))}
      </dl>
      <p className="text-xs text-muted">
        Bars are scaled against the largest row above, not against the total, so that a small figure
        is still visible. The count and its share are written out beside every bar.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Tables
 * ------------------------------------------------------------------ */

const VERIFICATION_COLUMNS: readonly TableColumn<ComplianceReviewVerification>[] = [
  {
    key: "batch",
    header: "Batch",
    isRowHeader: true,
    render: (row) => (
      <Link className="hash" to={`/app/products/${encodeURIComponent(row.productId)}`}>
        {row.productId}
      </Link>
    ),
  },
  {
    key: "result",
    header: "Result",
    render: (row) =>
      row.result === "MISMATCH" ? (
        <span className="stack stack--tight">
          <Badge tone="danger" icon="alertTriangle">
            Mismatch: the details no longer match
          </Badge>
          <span className="table__secondary">
            A buyer checking this batch now would be told not to rely on its details.
          </span>
        </span>
      ) : (
        <Badge tone={VERIFICATION_TONES[row.result as VerificationResult] ?? "neutral"}>
          {VERIFICATION_RESULT_LABELS[row.result as VerificationResult] ?? row.result}
        </Badge>
      ),
  },
  {
    key: "requester",
    header: "Checked by",
    render: (row) => (
      <span className="stack stack--tight">
        <span className="hash" title={row.requester}>
          {row.requester === "PUBLIC" ? "A member of the public" : truncateAddress(row.requester)}
        </span>
        <span className="table__secondary">{row.requesterRole}</span>
      </span>
    ),
  },
  {
    key: "channel",
    header: "How they arrived",
    render: (row) => row.requestChannel.replace(/_/g, " ").toLowerCase(),
  },
  { key: "when", header: "When", render: (row) => <DatedTimeValue value={row.createdAt} /> },
];

const TRANSFER_COLUMNS: readonly TableColumn<ComplianceTransferActivity>[] = [
  {
    key: "batch",
    header: "Batch",
    isRowHeader: true,
    render: (row) => (
      <Link className="hash" to={`/app/products/${encodeURIComponent(row.productId)}`}>
        {row.productId}
      </Link>
    ),
  },
  {
    key: "count",
    header: "Transfers",
    align: "right",
    render: (row) => formatNumber(row.count),
  },
  {
    key: "last",
    header: "Most recent",
    render: (row) => <DatedTimeValue value={row.lastTransferAt} />,
  },
];

/* ------------------------------------------------------------------ *
 * The review queue
 * ------------------------------------------------------------------ */

/** How many checks one page of the queue holds. */
const QUEUE_PAGE_SIZE = 15;

type QueueState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly error: unknown }
  | { readonly phase: "ready"; readonly response: ComplianceVerificationListResponse };

/**
 * The outcome, written out in words.
 *
 * A mismatch is never left to a colour: the badge says what happened and the
 * server's own explanation of what differed is printed underneath it.
 */
function ResultCell({ record }: { record: ComplianceVerificationRecord }) {
  if (record.result === "MISMATCH") {
    return (
      <span className="stack stack--tight">
        <Badge tone="danger" icon="alertTriangle">
          Mismatch: the details no longer match
        </Badge>
        {record.mismatchDetails === null ? null : (
          <span className="table__secondary">
            {record.mismatchDetails.explanation}
            {record.mismatchDetails.field === undefined
              ? null
              : ` (${record.mismatchDetails.field})`}
          </span>
        )}
      </span>
    );
  }
  return (
    <span className="stack stack--tight">
      <Badge tone={VERIFICATION_TONES[record.result] ?? "neutral"}>
        {VERIFICATION_RESULT_LABELS[record.result] ?? record.result}
      </Badge>
      {record.chainReachable ? null : (
        <span className="table__secondary">
          The blockchain could not be read for this check, so the result is not conclusive.
        </span>
      )}
      {record.recordPresent ? null : (
        <span className="table__secondary">The batch held no record when this was checked.</span>
      )}
    </span>
  );
}

/**
 * The queue columns. Built here rather than at module scope because recording a
 * finding writes into the attestation form below.
 */
function queueColumns(
  onAttest: (productId: string) => void,
): readonly TableColumn<ComplianceVerificationRecord>[] {
  return [
    {
      key: "batch",
      header: "Batch",
      isRowHeader: true,
      render: (row) => (
        <Link className="hash" to={`/verify/${encodeURIComponent(row.productId)}`}>
          {row.productId}
        </Link>
      ),
    },
    {
      key: "result",
      header: "Result",
      render: (row) => <ResultCell record={row} />,
    },
    {
      key: "requester",
      header: "Checked by",
      render: (row) => (
        <span className="stack stack--tight">
          <span className="hash" title={row.requester}>
            {row.requester === "PUBLIC" ? "A member of the public" : truncateAddress(row.requester)}
          </span>
          <span className="table__secondary">
            {row.requesterRole.replace(/_/g, " ").toLowerCase()}
          </span>
        </span>
      ),
    },
    {
      key: "channel",
      header: "How they arrived",
      render: (row) => row.requestChannel.replace(/_/g, " ").toLowerCase(),
    },
    { key: "when", header: "When", render: (row) => <DatedTimeValue value={row.createdAt} /> },
    {
      key: "attest",
      header: "Finding",
      render: (row) => (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            onAttest(row.productId);
          }}
        >
          Record on chain
          <span className="visually-hidden"> a finding about {row.productId}</span>
        </Button>
      ),
    },
  ];
}

/**
 * Every check that has been made, newest first, filtered by outcome.
 *
 * The overview above shows only the most recent handful; this is the whole
 * record, so a regulator can work back through it and narrow it to the outcomes
 * that need a decision.
 */
function VerificationQueue({ onAttest }: { onAttest: (productId: string) => void }) {
  const [result, setResult] = useState("");
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<QueueState>({ phase: "loading" });

  const load = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  // Changing the outcome returns to the first page, because the page number
  // belonged to the previous result and may not exist in the new one.
  const filterByResult = useCallback((next: string) => {
    setResult(next);
    setPage(1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: "loading" });

    listComplianceVerifications(
      {
        ...(result === "" ? {} : { result: result as VerificationResult }),
        page,
        pageSize: QUEUE_PAGE_SIZE,
      },
      controller.signal,
    )
      .then((response) => {
        if (controller.signal.aborted) return;
        setState({ phase: "ready", response });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: "failed", error });
      });

    return () => controller.abort();
  }, [attempt, page, result]);

  const chosen = VERIFICATION_RESULTS.find((entry) => entry === result) ?? null;

  return (
    <Panel
      title="The review queue"
      actions={
        state.phase === "ready" ? (
          <span className="text-xs text-muted">
            {formatNumber(state.response.pagination.total)}{" "}
            {state.response.pagination.total === 1 ? "check" : "checks"} recorded
          </span>
        ) : null
      }
    >
      <div className="stack">
        <div className="filters">
          <div className="filters__field">
            <Field
              id="queue-result"
              label="Only show this outcome"
              optional
              hint="Every check ever made is kept. Narrowing the queue does not remove anything."
            >
              <Select
                name="queueResult"
                value={result}
                placeholder="Every outcome"
                options={VERIFICATION_RESULTS.map((entry) => ({
                  value: entry,
                  label: VERIFICATION_RESULT_LABELS[entry],
                }))}
                onChange={(event) => { filterByResult(event.target.value); }}
              />
            </Field>
          </div>
        </div>

        {state.phase === "loading" ? (
          <LoadingState label="Reading the review queue" rows={6} />
        ) : state.phase === "failed" ? (
          <ErrorState
            error={state.error}
            title="The review queue could not be read"
            retryLabel="Read the queue again"
            onRetry={load}
          />
        ) : state.response.verifications.length === 0 ? (
          <EmptyState
            icon="shield"
            title={
              chosen === null
                ? "No batch has been checked yet"
                : `No check has come back ${VERIFICATION_RESULT_LABELS[chosen].toLowerCase()}`
            }
            description={
              chosen === null
                ? "Nobody, public or signed in, has opened the verification page for any batch. Checks appear here the moment they are made, with the result and the channel the check arrived on."
                : "Choose a different outcome above to see the rest of the queue. Nothing has been removed; this outcome simply has not been recorded."
            }
          />
        ) : (
          <>
            <p className="text-sm text-secondary" aria-live="polite">
              {chosen === null
                ? `Showing every outcome, ${formatNumber(state.response.pagination.total)} checks in total.`
                : `Showing checks that came back ${VERIFICATION_RESULT_LABELS[chosen].toLowerCase()}, ${formatNumber(state.response.pagination.total)} in total.`}
            </p>
            <Table
              caption="Every recorded verification check, newest first"
              columns={queueColumns(onAttest)}
              rows={state.response.verifications}
              rowKey={(row) => row.verificationId}
              rowClassName={(row) => (row.result === "MISMATCH" ? "table__row--flagged" : undefined)}
              emptyState={
                <EmptyState
                  icon="shield"
                  title="No checks on this page"
                  description="There is no check to show for this page of results."
                />
              }
            />
            <PaginationControls
              pagination={state.response.pagination}
              onPageChange={setPage}
              noun="checks"
            />
          </>
        )}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * Recording a finding on the blockchain
 * ------------------------------------------------------------------ */

/**
 * The shape a batch identifier must have, mirrored from the server so a
 * typographical slip is caught before a signature is asked for.
 */
const BATCH_ID_PATTERN = /^AGT-[A-Z0-9]{3,6}-\d{4}-[A-Z0-9]{6}$/;

/**
 * A regulator's conclusion, anchored on the chain.
 *
 * A finding held only in these records can be argued with later. Written through
 * the program's `record_verification` instruction it becomes part of the batch's
 * on-chain history, and the program accepts it only from a regulator, so the
 * finding stands or is challenged on its merits rather than quietly withdrawn.
 */
function AttestationPanel({
  productId,
  onProductIdChange,
}: {
  productId: string;
  onProductIdChange: (value: string) => void;
}) {
  const { push } = useToast();
  const [result, setResult] = useState<VerificationResult>("VERIFIED");
  const [occurredAt, setOccurredAt] = useState(todayInputValue());
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});

  /** The finding as the server will store it, or `null` while it is incomplete. */
  const finding = useMemo<AttestationInput | null>(() => {
    const when = fromDateInputValue(occurredAt);
    if (when === undefined) return null;
    return { productId: productId.trim().toUpperCase(), result, occurredAt: when };
  }, [occurredAt, productId, result]);

  const action = useChainAction<AttestationInput, AttestationConfirmed>({
    prepare: async () => {
      if (finding === null) {
        throw new Error("The finding is not complete yet: choose when the check was made.");
      }
      const accepted = await prepareAttestation(finding);
      return { prepared: accepted.prepared, record: finding };
    },
    submit: async ({ signedTransaction, record }) =>
      submitAttestation({ ...record, signedTransaction }),
    signatureOf: (confirmed) => confirmed.signature,
    slotOf: (confirmed) => confirmed.slot,
    onConfirmed: (confirmed) => {
      push({
        tone: "success",
        title: "The finding is recorded on the blockchain",
        message: `Anchored against batch ${confirmed.productId}, in slot ${confirmed.slot}.`,
      });
    },
  });

  function recordFinding(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const found: Record<string, string | undefined> = {};
    const batch = productId.trim().toUpperCase();
    if (batch.length === 0) {
      found["productId"] = "Enter the batch this finding is about.";
    } else if (!BATCH_ID_PATTERN.test(batch)) {
      found["productId"] = "That is not a batch identifier. Use the AGT-COCOA-2026-A1B2C3 form.";
    }
    if (fromDateInputValue(occurredAt) === undefined) {
      found["occurredAt"] = "Enter the date the check this finding describes was made.";
    } else if (occurredAt > todayInputValue()) {
      found["occurredAt"] = "A check cannot have been made on a date that has not arrived.";
    }
    setErrors(found);
    if (Object.values(found).some((message) => message !== undefined)) return;

    action.run();
  }

  const isConfirmed = action.phase === "confirmed" && action.confirmed !== null;
  const attested = action.record;

  return (
    <Panel
      title="Record a finding on the blockchain"
      actions={
        <span className="text-xs text-muted">
          {VERIFICATION_RESULT_LABELS[result]} ·{" "}
          {productId.trim().length === 0
            ? "no batch chosen"
            : productId.trim().toUpperCase()}
        </span>
      }
    >
      {isConfirmed && action.confirmed !== null ? (
        <div className="stack">
          <div className="notice notice--success">
            <Icon name="check" size={18} />
            <div className="notice__body">
              <p className="notice__title">The finding is recorded on the blockchain</p>
              <p className="text-sm text-secondary">
                Solana confirmed the transaction and the server read the on-chain account back to
                check it. A {attested === null ? "" : VERIFICATION_RESULT_LABELS[attested.result].toLowerCase()}{" "}
                finding now stands against batch{" "}
                <span className="hash">{action.confirmed.productId}</span> in the program&rsquo;s own
                record, so it cannot later be denied or removed without leaving a trace. Anyone can
                check the signature below.
              </p>
              <p className="text-sm">
                <SignatureValue signature={action.confirmed.signature} />
              </p>
            </div>
          </div>
          <div className="cluster">
            <Button variant="secondary" onClick={action.reset}>
              <Icon name="refresh" size={16} />
              Record another finding
            </Button>
            <Link
              className="btn btn--quiet"
              to={`/verify/${encodeURIComponent(action.confirmed.productId)}`}
            >
              <Icon name="shield" size={16} />
              Read the batch&rsquo;s public page
            </Link>
          </div>
        </div>
      ) : (
        <div className="stack">
          <p className="measure text-secondary">
            A finding recorded here is written to Solana through the program&rsquo;s{" "}
            <span className="hash">record_verification</span> instruction, and only a regulator can
            make the program accept one. It is the one thing on this page that cannot be edited or
            withdrawn afterwards, so read the batch and its history before you sign.
          </p>

          <form onSubmit={recordFinding} noValidate className="stack">
            <Field
              id="attestation-product"
              label="Which batch is this about?"
              required
              error={errors["productId"]}
              hint={describeProductIdShape()}
            >
              <TextInput
                name="productId"
                value={productId}
                autoComplete="off"
                spellCheck={false}
                maxLength={32}
                placeholder="AGT-COCOA-2026-A1B2C3"
                onChange={(event) => {
                  onProductIdChange(event.target.value.toUpperCase());
                  setErrors((current) => ({ ...current, productId: undefined }));
                }}
              />
            </Field>

            <div className="grid grid--2">
              <Field
                id="attestation-result"
                label="What the finding is"
                required
                hint="A mismatch means the stored details no longer produce the fingerprint anchored on the blockchain."
              >
                <Select
                  name="result"
                  value={result}
                  options={VERIFICATION_RESULTS.map((entry) => ({
                    value: entry,
                    label: VERIFICATION_RESULT_LABELS[entry],
                  }))}
                  onChange={(event) => {
                    setResult(event.target.value as VerificationResult);
                  }}
                />
              </Field>

              <Field
                id="attestation-when"
                label="When the check was made"
                required
                error={errors["occurredAt"]}
                hint="The date the inspection or check happened, not the date you are recording it."
              >
                <DateInput
                  name="occurredAt"
                  value={occurredAt}
                  onChange={(event) => {
                    setOccurredAt(event.target.value);
                    setErrors((current) => ({ ...current, occurredAt: undefined }));
                  }}
                />
              </Field>
            </div>

            <div className="cluster">
              <Button
                type="submit"
                variant="primary"
                loading={action.phase === "preparing"}
                loadingLabel="Asking the server to build the attestation"
                disabled={
                  action.phase !== "idle" &&
                  action.phase !== "failed" &&
                  action.phase !== "timed-out" &&
                  action.phase !== "signature-rejected"
                }
              >
                <Icon name="shield" size={16} />
                Prepare the attestation
              </Button>
              <p className="text-xs text-muted">
                Preparing builds the transaction. Nothing is written until you sign it.
              </p>
            </div>
          </form>

          {action.phase !== "idle" ? (
            <TransactionState
              phase={action.phase}
              description={action.prepared?.description ?? null}
              prepared={action.prepared}
              signature={action.signature}
              slot={action.slot}
              error={action.error}
              onPrepare={action.retry}
              onSign={action.sign}
              onRetry={action.retry}
              onCancel={action.cancel}
              prepareLabel="Prepare the attestation"
              signLabel="Sign in my wallet"
              retryLabel="Prepare again"
              cancelLabel="Start again"
            >
              {action.phase === "signature-rejected" ? (
                <p className="text-sm text-secondary">
                  You declined, so nothing was written. Preparing again builds a fresh transaction
                  for the same finding.
                </p>
              ) : null}
            </TransactionState>
          ) : null}

          {action.phase === "failed" || action.phase === "timed-out" ? (
            <FailureState
              error={action.error}
              context="record this finding on the blockchain"
              retryLabel="Try again"
              onRetry={action.retry}
            />
          ) : null}
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function ComplianceDashboardPage() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  /**
   * Which batch the finding below is about. It is one field for the whole page
   * so that choosing a batch in the review queue carries straight through to the
   * attestation, which is what a regulator does next.
   */
  const [attestationProductId, setAttestationProductId] = useState("");

  const load = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: "loading" });

    getComplianceOverview(controller.signal)
      .then((overview) => {
        if (controller.signal.aborted) return;
        setState({ phase: "ready", overview });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: "failed", error });
      });

    return () => controller.abort();
  }, [attempt]);

  const heading = (
    <PageHeader
      title="Compliance overview"
      description="The state of the registry as it stands: what has been registered, what has been checked, and what is unfinished."
      actions={
        <div className="cluster cluster--tight">
          <Link className="btn btn--primary" to="/app/compliance/reports/new">
            <Icon name="fileText" size={16} />
            Generate a report
          </Link>
          <Link className="btn btn--secondary" to="/app/operations/reconciliation">
            <Icon name="refresh" size={16} />
            Reconciliation queue
          </Link>
        </div>
      }
    />
  );

  if (state.phase === "loading") {
    return (
      <div className="page">
        {heading}
        <LoadingState label="Reading the compliance overview" rows={8} />
      </div>
    );
  }

  if (state.phase === "failed") {
    return (
      <div className="page">
        {heading}
        <ErrorState
          error={state.error}
          title="The compliance overview could not be read"
          retryLabel="Read it again"
          onRetry={load}
        />
      </div>
    );
  }

  const { metrics, statusCounts, cropTypeCounts, recentVerifications, anomalies, transferActivity } =
    state.overview;

  const mismatches = recentVerifications.filter((entry) => entry.result === "MISMATCH").length;
  const statusRows: BarRow[] = statusCounts
    .filter((row) => isProductStatus(row.status))
    .map((row) => ({
      label: row.label.length > 0 ? row.label : row.status.replace(/_/g, " ").toLowerCase(),
      value: row.count,
      href: `/app/products?status=${row.status}`,
    }));
  const cropRows: BarRow[] = cropTypeCounts.map((row) => ({
    label: row.cropType,
    value: row.count,
    href: `/app/products?cropType=${encodeURIComponent(row.cropType)}`,
  }));

  return (
    <div className="page">
      {heading}

      <Panel title="Figures across the registry">
        <MetricRow>
          {metrics.map((metric) => (
            <MetricTile
              key={metric.key}
              label={metric.label}
              value={metric.value}
              {...(metric.hint === undefined ? {} : { hint: metric.hint })}
              {...(metric.tone === undefined ? {} : { tone: metric.tone })}
            />
          ))}
        </MetricRow>
        <p className="measure text-xs text-muted">
          Each figure is a count of records the server holds, computed when this page was read. None
          of it is a projection and none of it is carried over from an earlier visit.
        </p>
      </Panel>

      <Panel
        title="Blockchain writes that have not finished"
        actions={
          anomalies.length === 0 ? null : (
            <Badge tone="danger" icon="alertTriangle">
              {anomalies.length} outstanding
            </Badge>
          )
        }
      >
        {anomalies.length === 0 ? (
          <EmptyState
            icon="check"
            title="Every blockchain write has finished"
            description="No record is waiting for its database entry. When a transaction confirms on Solana but the matching record cannot be written, it appears here and in the reconciliation queue, where it can be finished by hand."
          />
        ) : (
          <div className="stack">
            <div className="notice notice--danger">
              <Icon name="alertTriangle" size={18} />
              <div className="notice__body">
                <p className="notice__title">
                  {anomalies.length} confirmed {anomalies.length === 1 ? "write has" : "writes have"} no
                  matching record
                </p>
                <p className="text-sm text-secondary">
                  Solana has accepted these transactions, so the produce really was registered or
                  transferred. What is missing is the database entry on this side. Nothing has been
                  lost and nothing has to be undone; each one has to be finished by an operator, and
                  until then a participant reading the batch may not see it.
                </p>
                <p className="notice__actions">
                  <Link className="btn btn--secondary btn--sm" to="/app/operations/reconciliation">
                    Open the reconciliation queue
                  </Link>
                </p>
              </div>
            </div>
            <Table
              caption="Blockchain writes that confirmed but were not written to the database"
              columns={[
                {
                  key: "batch",
                  header: "Batch",
                  isRowHeader: true,
                  render: (row: (typeof anomalies)[number]) => (
                    <Link className="hash" to={`/app/products/${encodeURIComponent(row.productId)}`}>
                      {row.productId}
                    </Link>
                  ),
                },
                {
                  key: "kind",
                  header: "What is unfinished",
                  render: (row) => (
                    <Badge tone="danger" icon="alertTriangle">
                      {isAnomalyKind(row.kind)
                        ? ANOMALY_KIND_LABELS[row.kind]
                        : row.kind.replace(/_/g, " ").toLowerCase()}
                    </Badge>
                  ),
                },
                {
                  key: "detail",
                  header: "Detail",
                  render: (row) => <span className="measure">{row.detail}</span>,
                },
                {
                  key: "signature",
                  header: "Transaction",
                  render: (row) => {
                    const url = explorerTxUrl(row.transactionSignature);
                    return (
                      <span className="stack stack--tight">
                        <span className="hash" title={row.transactionSignature}>
                          {truncateAddress(row.transactionSignature, 6, 6)}
                        </span>
                        {url === null ? null : (
                          <a href={url} target="_blank" rel="noreferrer noopener">
                            View on Solana Explorer
                            <span className="visually-hidden">, opens in a new tab</span>
                          </a>
                        )}
                      </span>
                    );
                  },
                },
                { key: "when", header: "Detected", render: (row) => <DatedTimeValue value={row.createdAt} /> },
              ]}
              rows={anomalies}
              rowKey={(row) => row.taskId}
              emptyState={
                <EmptyState
                  icon="check"
                  title="Every blockchain write has finished"
                  description="Nothing is waiting for a database entry."
                />
              }
            />
          </div>
        )}
      </Panel>

      <Panel
        title="Recent checks across the network"
        actions={
          mismatches === 0 ? null : (
            <Badge tone="danger" icon="alertTriangle">
              {mismatches} of these found a mismatch
            </Badge>
          )
        }
      >
        {recentVerifications.length === 0 ? (
          <EmptyState
            icon="shield"
            title="No batch has been checked yet"
            description="Nobody, public or signed in, has opened the verification page for any batch. Checks appear here as they happen, with the result and the channel the check arrived on."
          />
        ) : (
          <Table
            caption="The most recent verification checks across the registry"
            columns={VERIFICATION_COLUMNS}
            rows={recentVerifications}
            rowKey={(row) => row.verificationId}
            emptyState={
              <EmptyState
                icon="shield"
                title="No checks have been recorded"
                description="No batch has been checked yet."
              />
            }
          />
        )}
      </Panel>

      <VerificationQueue onAttest={setAttestationProductId} />

      <AttestationPanel
        productId={attestationProductId}
        onProductIdChange={setAttestationProductId}
      />

      <Panel title="Batches by stage">
        {statusRows.length === 0 ? (
          <EmptyState
            icon="package"
            title="No batches are registered yet"
            description="Nothing has been confirmed on the blockchain, so there is nothing to group by stage."
          />
        ) : (
          <BreakdownBars rows={statusRows} noun="batch" />
        )}
      </Panel>

      <Panel title="Batches by crop">
        {cropRows.length === 0 ? (
          <EmptyState
            icon="leaf"
            title="No crop has been registered yet"
            description="Once batches are registered, the registry groups them by crop so a regulator can see what is being supplied."
          />
        ) : (
          <BreakdownBars rows={cropRows} noun="batch" />
        )}
      </Panel>

      <Panel
        title="Where batches have changed hands"
        actions={
          <Link className="btn btn--quiet btn--sm" to="/app/transfers">
            All transfers
          </Link>
        }
      >
        {transferActivity.length === 0 ? (
          <EmptyState
            icon="truck"
            title="No batch has been transferred yet"
            description="A transfer is recorded here once a batch has changed hands on the blockchain at least once, so this table fills in as the chain is used."
          />
        ) : (
          <Table
            caption="Batches that have been transferred, and how often"
            columns={TRANSFER_COLUMNS}
            rows={transferActivity}
            rowKey={(row) => row.productId}
            compact
            emptyState={
              <EmptyState
                icon="truck"
                title="No batch has been transferred yet"
                description="Nothing to report."
              />
            }
          />
        )}
      </Panel>

      <Panel title="What a regulator does with this">
        <div className="measure stack text-sm text-secondary">
          <p>
            A batch whose details no longer produce the fingerprint anchored on the blockchain has
            been changed after registration. That is either an error or an attempt to deceive, and
            both are worth investigating: open the batch, read its history, and speak to the
            registrant and the current owner.
          </p>
          <p>
            A record listed as unfinished was confirmed on Solana and then lost here. The goods are
            real; the paperwork is missing. Finish it from the reconciliation queue rather than
            asking the participant to register the batch again, which would create a second,
            conflicting record.
          </p>
        </div>
      </Panel>

      <div className="cluster">
        <Button variant="quiet" onClick={load}>
          <Icon name="refresh" size={16} />
          Read the overview again
        </Button>
        <Link className="btn btn--quiet" to="/app/compliance/reports">
          <Icon name="fileText" size={16} />
          Reports
        </Link>
      </div>
    </div>
  );
}
