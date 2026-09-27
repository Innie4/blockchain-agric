import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getReconciliationQueue, resolveReconciliationTask } from "../../api/endpoints";
import { messageForError } from "../../api/errors";
import {
  RECONCILIATION_ACTION_LABELS,
  type ReconciliationProduct,
  type ReconciliationQueue,
  type ReconciliationTask,
  type ReconciliationTransfer,
} from "../../api/types";
import { PageHeader } from "../../components/layout/PageHeader";
import { ErrorState, LoadingState } from "../../components/states";
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  Panel,
  Table,
  type TableColumn,
} from "../../components/ui/Index";
import { useToast } from "../../context/ToastContext";
import { truncateAddress, truncateHash } from "../../lib/format";
import { explorerTxUrl } from "../../lib/solana";
import { useCopyToClipboard } from "./appData";
import { DatedTimeValue, MetricRow, MetricTile } from "./appUi";

/**
 * The queue of work that a confirmed blockchain write left behind.
 *
 * Every action in this system is two requests. If the second one fails for any
 * reason, the transaction is already on Solana and the registry has no record of
 * it. That is the only gap this system has, and it is a gap on the paperwork
 * side rather than on the chain: the produce is real and the anchor is permanent.
 * This queue is where those gaps are found and closed, one at a time, by a person
 * who can see the transaction and the record it should have produced.
 */

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly error: unknown }
  | { readonly phase: "ready"; readonly queue: ReconciliationQueue };

const PRODUCT_COLUMNS: readonly TableColumn<ReconciliationProduct>[] = [
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
    key: "fingerprint",
    header: "Fingerprint held",
    render: (row) => (
      <span className="hash" title={row.dataHash}>
        {truncateHash(row.dataHash)}
      </span>
    ),
  },
  {
    key: "transaction",
    header: "Transaction",
    render: (row) => {
      const url = explorerTxUrl(row.onChainTxHash);
      if (row.onChainTxHash === null) {
        return <span className="text-secondary">No transaction was recorded.</span>;
      }
      return url === null ? (
        <span className="hash">{truncateAddress(row.onChainTxHash, 6, 6)}</span>
      ) : (
        <a href={url} target="_blank" rel="noreferrer noopener">
          View on Solana Explorer
          <span className="visually-hidden">, opens in a new tab</span>
        </a>
      );
    },
  },
  { key: "updated", header: "Flagged on", render: (row) => <DatedTimeValue value={row.updatedAt} /> },
];

const TRANSFER_COLUMNS: readonly TableColumn<ReconciliationTransfer>[] = [
  {
    key: "transfer",
    header: "Transfer",
    isRowHeader: true,
    render: (row) => (
      <Link className="hash" to={`/app/transfers/${encodeURIComponent(row.transferId)}`}>
        {row.transferId}
      </Link>
    ),
  },
  {
    key: "batch",
    header: "Batch",
    render: (row) => (
      <Link className="hash" to={`/app/products/${encodeURIComponent(row.productId)}`}>
        {row.productId}
      </Link>
    ),
  },
  {
    key: "from",
    header: "From",
    render: (row) => (
      <span className="hash" title={row.fromWallet}>
        {truncateAddress(row.fromWallet)}
      </span>
    ),
  },
  {
    key: "to",
    header: "To",
    render: (row) => (
      <span className="hash" title={row.toWallet}>
        {truncateAddress(row.toWallet)}
      </span>
    ),
  },
  { key: "updated", header: "Flagged on", render: (row) => <DatedTimeValue value={row.updatedAt} /> },
];

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function OperationsReconciliationPage() {
  const copy = useCopyToClipboard();
  const { push } = useToast();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [resolving, setResolving] = useState<string | null>(null);

  const load = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: "loading" });

    getReconciliationQueue(controller.signal)
      .then((queue) => {
        if (controller.signal.aborted) return;
        setState({ phase: "ready", queue });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: "failed", error });
      });

    return () => controller.abort();
  }, [attempt]);

  const resolve = useCallback(
    (task: ReconciliationTask) => {
      setResolving(task.taskId);
      void resolveReconciliationTask(task.taskId)
        .then(() => {
          setState((current) =>
            current.phase !== "ready"
              ? current
              : {
                  phase: "ready",
                  queue: {
                    ...current.queue,
                    tasks: current.queue.tasks.filter((entry) => entry.taskId !== task.taskId),
                    resolvedCount: current.queue.resolvedCount + 1,
                  },
                },
          );
          push({
            tone: "success",
            title: "The task is marked as finished",
            message: `Batch ${task.productId} is no longer on the outstanding list.`,
          });
        })
        .catch((error: unknown) => {
          push({
            tone: "error",
            title: "The task could not be marked as finished",
            message: messageForError(error),
          });
        })
        .finally(() => {
          setResolving(null);
        });
    },
    [push],
  );

  const heading = (
    <PageHeader
      title="Reconciliation queue"
      description="Transactions that Solana confirmed but the records service never wrote. Nothing has been lost; these are the records that have to be finished by hand."
      actions={
        <div className="cluster cluster--tight">
          <Link className="btn btn--secondary" to="/app/compliance">
            <Icon name="shield" size={16} />
            Compliance overview
          </Link>
          <Button variant="quiet" onClick={load}>
            <Icon name="refresh" size={16} />
            Read the queue again
          </Button>
        </div>
      }
    />
  );

  if (state.phase === "loading") {
    return (
      <div className="page">
        {heading}
        <LoadingState label="Reading the reconciliation queue" rows={8} />
      </div>
    );
  }

  if (state.phase === "failed") {
    return (
      <div className="page">
        {heading}
        <ErrorState
          error={state.error}
          title="The reconciliation queue could not be read"
          retryLabel="Read it again"
          onRetry={load}
        />
      </div>
    );
  }

  const { tasks, resolvedCount, productsNeedingReconciliation, transfersNeedingReconciliation } =
    state.queue;
  const outstanding =
    tasks.length + productsNeedingReconciliation.length + transfersNeedingReconciliation.length;

  return (
    <div className="page">
      {heading}

      <Panel title="Why this queue exists">
        <div className="measure stack text-secondary">
          <p>
            Every action in this system is two requests. The server builds a transaction, the
            participant signs it, and the server submits it and waits for Solana to confirm. The
            blockchain write and the database write are separate acts, and the second one can fail
            after the first has already succeeded.
          </p>
          <p>
            When that happens, the produce really was registered, transferred or recorded, and the
            fingerprint really was anchored: the blockchain does not know the database failed. What
            is missing is the entry on this side, so a participant opening the batch may not see it,
            and a buyer checking it may be told there is no record.
          </p>
          <p>
            Rather than let that happen quietly, every such transaction is queued here with the
            reason it failed. An operator checks the transaction on the explorer, writes the missing
            record, and marks the task as finished. The transaction is never repeated, because
            repeating it would create a second, conflicting record for the same batch.
          </p>
        </div>
      </Panel>

      <Panel title="The state of the queue">
        <MetricRow>
          <MetricTile
            label="Unfinished blockchain writes"
            value={tasks.length}
            tone={tasks.length === 0 ? "success" : "danger"}
            {...(tasks.length === 0 ? { hint: "Nothing outstanding" } : { hint: "Each needs finishing by hand" })}
          />
          <MetricTile
            label="Batches flagged as needing reconciliation"
            value={productsNeedingReconciliation.length}
            tone={productsNeedingReconciliation.length === 0 ? "success" : "warning"}
          />
          <MetricTile
            label="Transfers flagged as needing reconciliation"
            value={transfersNeedingReconciliation.length}
            tone={transfersNeedingReconciliation.length === 0 ? "success" : "warning"}
          />
          <MetricTile
            label="Tasks already finished"
            value={resolvedCount}
            hint="Closed since this queue was last emptied"
          />
        </MetricRow>
        <p className="measure text-xs text-muted">
          Every figure is a count the server returned when this page was read. Nothing here is
          estimated, and nothing is carried over from an earlier visit.
        </p>
      </Panel>

      <Panel
        title="Unfinished blockchain writes"
        actions={
          tasks.length === 0 ? null : (
            <Badge tone="danger" icon="alertTriangle">
              {tasks.length} to finish
            </Badge>
          )
        }
      >
        {tasks.length === 0 ? (
          <EmptyState
            icon="check"
            title="Nothing is outstanding"
            description="Every transaction that Solana has confirmed for this deployment has been written to the records service. There is no paper missing and nothing to reconcile."
            action={
              <Link className="btn btn--secondary" to="/app/compliance">
                <Icon name="shield" size={16} />
                Read the compliance overview
              </Link>
            }
          />
        ) : (
          <div className="stack">
            <div className="notice notice--warning">
              <Icon name="warning" size={18} />
              <div className="notice__body">
                <p className="notice__title">
                  {tasks.length} {tasks.length === 1 ? "transaction is" : "transactions are"} confirmed
                  on Solana with no record here
                </p>
                <p className="text-sm text-secondary">
                  For each one, open the transaction on the explorer, check that it did what it says,
                  then write the missing record. Marking a task as finished only closes the item in
                  this queue; it does not write to the blockchain, because the transaction has
                  already been confirmed there.
                </p>
              </div>
            </div>

            <Table
              caption="Transactions confirmed on Solana whose records are unfinished"
              columns={[
                {
                  key: "action",
                  header: "What has to be finished",
                  isRowHeader: true,
                  render: (row: ReconciliationTask) => (
                    <span className="stack stack--tight">
                      <span>{RECONCILIATION_ACTION_LABELS[row.action]}</span>
                      <span className="table__secondary">
                        {row.action.replace(/_/g, " ").toLowerCase()}
                      </span>
                    </span>
                  ),
                },
                {
                  key: "batch",
                  header: "Batch",
                  render: (row) => (
                    <Link className="hash" to={`/app/products/${encodeURIComponent(row.productId)}`}>
                      {row.productId}
                    </Link>
                  ),
                },
                {
                  key: "signature",
                  header: "Transaction signature",
                  render: (row) => {
                    const url = explorerTxUrl(row.transactionSignature);
                    return (
                      <span className="stack stack--tight">
                        <span className="hash" title={row.transactionSignature}>
                          {truncateAddress(row.transactionSignature, 6, 6)}
                        </span>
                        <span className="cluster cluster--tight">
                          <Button
                            variant="quiet"
                            size="sm"
                            onClick={() => { copy(row.transactionSignature, "Transaction signature"); }}
                          >
                            <Icon name="clipboard" size={14} />
                            Copy
                          </Button>
                          {url === null ? null : (
                            <a className="text-xs" href={url} target="_blank" rel="noreferrer noopener">
                              View on Solana Explorer
                              <span className="visually-hidden">, opens in a new tab</span>
                            </a>
                          )}
                        </span>
                      </span>
                    );
                  },
                },
                {
                  key: "error",
                  header: "Why it did not finish",
                  render: (row) =>
                    row.lastError === null ? (
                      <span className="text-secondary">No reason was recorded.</span>
                    ) : (
                      <span className="measure text-sm">{row.lastError}</span>
                    ),
                },
                {
                  key: "attempts",
                  header: "Attempts",
                  align: "right",
                  render: (row) => row.attempts,
                },
                {
                  key: "created",
                  header: "Queued on",
                  render: (row) => <DatedTimeValue value={row.createdAt} />,
                },
                {
                  key: "action-do",
                  header: "Action",
                  render: (row) => (
                    <Button
                      variant="primary"
                      size="sm"
                      loading={resolving === row.taskId}
                      loadingLabel="Marking this task as finished"
                      onClick={() => { resolve(row); }}
                    >
                      Mark as finished
                      <span className="visually-hidden">: {row.action} for {row.productId}</span>
                    </Button>
                  ),
                },
              ]}
              rows={tasks}
              rowKey={(row) => row.taskId}
              emptyState={
                <EmptyState
                  icon="check"
                  title="Nothing is outstanding"
                  description="No transaction is waiting for its record to be written."
                />
              }
            />
          </div>
        )}
      </Panel>

      <Panel
        title="Batches still flagged as needing reconciliation"
        actions={
          productsNeedingReconciliation.length === 0 ? null : (
            <Badge tone="warning" icon="flag">
              {productsNeedingReconciliation.length} flagged
            </Badge>
          )
        }
      >
        {productsNeedingReconciliation.length === 0 ? (
          <p className="measure text-secondary">
            No batch is flagged. Every batch whose transaction confirmed has its record in place.
          </p>
        ) : (
          <div className="stack">
            <p className="measure text-secondary">
              These batches have a confirmed registration or movement on the blockchain, but the
              record on this side is still marked as needing reconciliation. They are visible to the
              participant who holds them, and the gap is closed by finishing the task above.
            </p>
            <Table
              caption="Batches flagged as needing reconciliation"
              columns={PRODUCT_COLUMNS}
              rows={productsNeedingReconciliation}
              rowKey={(row) => row.productId}
              compact
            />
          </div>
        )}
      </Panel>

      <Panel
        title="Transfers still flagged as needing reconciliation"
        actions={
          transfersNeedingReconciliation.length === 0 ? null : (
            <Badge tone="warning" icon="flag">
              {transfersNeedingReconciliation.length} flagged
            </Badge>
          )
        }
      >
        {transfersNeedingReconciliation.length === 0 ? (
          <p className="measure text-secondary">
            No transfer is flagged. Every confirmed transfer has its record in place.
          </p>
        ) : (
          <div className="stack">
            <p className="measure text-secondary">
              These transfers changed ownership on Solana but the registry could not be updated. The
              new owner is correct on the chain; the registry does not yet say so, which is why the
              recipient may not see the batch on their own list.
            </p>
            <Table
              caption="Transfers flagged as needing reconciliation"
              columns={TRANSFER_COLUMNS}
              rows={transfersNeedingReconciliation}
              rowKey={(row) => row.transferId}
              compact
            />
          </div>
        )}
      </Panel>

      <Panel title="What marking a task as finished does, and does not do">
        <div className="measure stack text-sm text-secondary">
          <p>
            It closes the item in this queue and records that an operator has dealt with it. It
            does not write to the blockchain, because the transaction is already confirmed there: the
            fingerprint, the owner and the stage cannot be changed by anything this page does.
          </p>
          <p>
            It is not a way to make a failure disappear. Only mark a task as finished once the
            missing record has actually been written, and check the transaction on the explorer
            first, so the record you write matches what was confirmed.
          </p>
          <p className="text-xs text-muted">
            {outstanding === 0
              ? "Nothing on this page needs attention at the moment."
              : `${outstanding} item${outstanding === 1 ? "" : "s"} on this page need attention.`}
          </p>
        </div>
      </Panel>
    </div>
  );
}
