import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { acknowledgeTransfer, listTransfers } from "../../../api/endpoints";
import { messageForError } from "../../../api/errors";
import {
  TRANSFER_STATUSES,
  TRANSFER_STATUS_LABELS,
  type Transfer,
  type TransferListResponse,
  type TransferStatus,
} from "../../../api/types";
import { PageHeader } from "../../../components/layout/PageHeader";
import { ErrorState, LoadingState } from "../../../components/states";
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  Panel,
  Select,
  Table,
  Tabs,
  type TableColumn,
} from "../../../components/ui/Index";
import { useAuth } from "../../../context/AuthContext";
import { useToast } from "../../../context/ToastContext";
import { truncateAddress } from "../../../lib/format";
import { roleLabelOrRaw, usePageParam } from "../appData";
import { DatedTimeValue, PaginationControls } from "../appUi";

/**
 * The transfers this participant is party to, in either direction.
 *
 * The direction lives in the address rather than in component state, so a
 * filtered view can be bookmarked, shared or opened from a notification without
 * losing its place.
 */

const PAGE_SIZE = 12;

type Direction = "all" | "incoming" | "outgoing";

const STATUS_TONES: Record<TransferStatus, "neutral" | "info" | "success" | "warning" | "danger"> = {
  PREPARED: "warning",
  SUBMITTED: "info",
  COMPLETED: "success",
  FAILED: "danger",
  CANCELLED: "neutral",
  NEEDS_RECONCILIATION: "danger",
};

function readDirection(params: URLSearchParams): Direction {
  const raw = params.get("direction");
  return raw === "incoming" || raw === "outgoing" ? raw : "all";
}

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly error: unknown }
  | { readonly phase: "ready"; readonly response: TransferListResponse };

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

function columnsFor(
  wallet: string | null,
  acknowledging: string | null,
  onAcknowledge: (transfer: Transfer) => void,
): readonly TableColumn<Transfer>[] {
  return [
    {
      key: "batch",
      header: "Batch",
      isRowHeader: true,
      render: (row) => (
        <span className="stack stack--tight">
          <Link className="hash" to={`/app/products/${encodeURIComponent(row.productId)}`}>
            {row.productId}
          </Link>
          <span className="table__secondary">{row.cropType ?? "The batch"}</span>
        </span>
      ),
    },
    {
      key: "direction",
      header: "Direction",
      render: (row) => {
        const outgoing = row.fromWallet === wallet;
        return (
          <span className="stack stack--tight">
            <Badge tone={outgoing ? "earth" : "info"}>
              {outgoing ? "You sent it" : "You received it"}
            </Badge>
            <span className="table__secondary">
              {outgoing
                ? `To a ${roleLabelOrRaw(row.toRole).toLowerCase()}`
                : `From a ${roleLabelOrRaw(row.fromRole).toLowerCase()}`}
            </span>
          </span>
        );
      },
    },
    {
      key: "counterparty",
      header: "Counterparty",
      render: (row) => {
        const other = row.fromWallet === wallet ? row.toWallet : row.fromWallet;
        return (
          <span className="hash" title={other} aria-label={`Counterparty ${other}`}>
            {truncateAddress(other)}
          </span>
        );
      },
    },
    {
      key: "stage",
      header: "Stage",
      render: (row) => (
        <span className="stack stack--tight">
          <span className="text-xs text-muted">
            {row.previousStatus.replace(/_/g, " ").toLowerCase()} to{" "}
            {(row.resultingStatus ?? row.previousStatus).replace(/_/g, " ").toLowerCase()}
          </span>
          {row.failureReason === null ? null : (
            <span className="table__secondary">{row.failureReason}</span>
          )}
        </span>
      ),
    },
    { key: "created", header: "Created", render: (row) => <DatedTimeValue value={row.createdAt} /> },
    {
      key: "confirmed",
      header: "Confirmed",
      render: (row) => <DatedTimeValue value={row.confirmedAt} />,
    },
    {
      key: "status",
      header: "Status",
      render: (row) => (
        <span className="stack stack--tight">
          <Badge tone={STATUS_TONES[row.status]}>{TRANSFER_STATUS_LABELS[row.status]}</Badge>
          {row.status === "COMPLETED" && row.acknowledgedAt !== null ? (
            <span className="table__secondary">
              Receipt confirmed <DatedTimeValue value={row.acknowledgedAt} />
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "action",
      header: "Action",
      render: (row) => {
        const canAcknowledge =
          row.toWallet === wallet && row.status === "COMPLETED" && row.acknowledgedAt === null;
        return (
          <span className="cluster cluster--tight">
            <Link
              className="btn btn--secondary btn--sm"
              to={`/app/transfers/${encodeURIComponent(row.transferId)}`}
            >
              Open
              <span className="visually-hidden"> transfer of {row.productId}</span>
            </Link>
            {canAcknowledge ? (
              <Button
                variant="primary"
                size="sm"
                loading={acknowledging === row.transferId}
                loadingLabel="Confirming receipt of this batch"
                onClick={() => {
                  onAcknowledge(row);
                }}
              >
                Acknowledge receipt
              </Button>
            ) : null}
          </span>
        );
      },
    },
  ];
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function TransferListPage() {
  const { user } = useAuth();
  const { push } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = usePageParam();

  const direction = readDirection(searchParams);
  const [statusFilter, setStatusFilter] = useState<string>(
    searchParams.get("status") ?? "",
  );
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [acknowledging, setAcknowledging] = useState<string | null>(null);

  const wallet = user?.walletAddress ?? null;

  const load = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: "loading" });

    listTransfers(
      {
        direction,
        ...(statusFilter === "" ? {} : { status: statusFilter }),
        page,
        pageSize: PAGE_SIZE,
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
  }, [attempt, direction, page, statusFilter]);

  const setDirection = useCallback(
    (next: Direction) => {
      setSearchParams(
        (previous) => {
          const updated = new URLSearchParams(previous);
          if (next === "all") updated.delete("direction");
          else updated.set("direction", next);
          updated.delete("page");
          return updated;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const acknowledge = useCallback(
    (transfer: Transfer) => {
      setAcknowledging(transfer.transferId);
      void acknowledgeTransfer(transfer.transferId)
        .then((result) => {
          push({
            tone: "success",
            title: "Receipt of the batch confirmed",
            message: `Batch ${result.transfer.productId} is now recorded as received by you.`,
          });
          load();
        })
        .catch((error: unknown) => {
          push({
            tone: "error",
            title: "Receipt could not be confirmed",
            message: messageForError(error),
          });
        })
        .finally(() => {
          setAcknowledging(null);
        });
    },
    [load, push],
  );

  const transferContent = (): ReactNode => {
    if (state.phase === "loading") return <LoadingState label="Reading your transfers" rows={8} />;
    if (state.phase === "failed") {
      return (
        <ErrorState
          error={state.error}
          title="Your transfers could not be read"
          retryLabel="Read them again"
          onRetry={load}
        />
      );
    }

    const transfers = state.response.transfers;
    const pagination = state.response.pagination;
    const awaitingMe = transfers.filter(
      (transfer) =>
        transfer.toWallet === wallet && transfer.status === "COMPLETED" && transfer.acknowledgedAt === null,
    ).length;

    if (transfers.length === 0) {
      return (
        <EmptyState
          icon="truck"
          title={
            direction === "incoming"
              ? "No batch has been sent to you"
              : direction === "outgoing"
                ? "You have not sent any batch on"
                : "There are no transfers yet"
          }
          description={
            statusFilter === ""
              ? direction === "outgoing"
                ? "A transfer appears here once you hand a batch to a processor, a transporter or a retailer and the transfer is confirmed on the blockchain."
                : direction === "incoming"
                  ? "A transfer appears here once a farmer, processor or retailer hands you a batch and the transfer is confirmed on the blockchain."
                  : "A transfer is the moment a batch changes hands. It is recorded on the blockchain by the sending wallet, and it cannot be removed afterwards."
              : `No transfer with the status ${TRANSFER_STATUS_LABELS[statusFilter as TransferStatus].toLowerCase()} matches this direction.`
          }
          action={
            statusFilter === "" ? (
              <div className="cluster cluster--tight">
                <Link className="btn btn--secondary" to="/app/products">
                  See the batches you hold
                </Link>
                <Link className="btn btn--quiet" to="/app/transfers/pending">
                  What is waiting for you
                </Link>
              </div>
            ) : (
              <Button
                variant="primary"
                onClick={() => {
                  setStatusFilter("");
                  setSearchParams(
                    (previous) => {
                      const updated = new URLSearchParams(previous);
                      updated.delete("status");
                      updated.delete("page");
                      return updated;
                    },
                    { replace: true },
                  );
                }}
              >
                <Icon name="x" size={16} />
                Clear the status filter
              </Button>
            )
          }
        />
      );
    }

    return (
      <Panel
        title={
          direction === "incoming"
            ? "Batches sent to you"
            : direction === "outgoing"
              ? "Batches you sent on"
              : "Every transfer you are party to"
        }
        actions={
          awaitingMe === 0 ? null : (
            <Badge tone="info" icon="bell">
              {awaitingMe} awaiting your acknowledgement
            </Badge>
          )
        }
      >
        <p className="text-sm text-secondary" aria-live="polite">
          {pagination.total} {pagination.total === 1 ? "transfer" : "transfers"} in this view.
        </p>
        <Table
          caption="Transfers you sent or received"
          columns={columnsFor(wallet, acknowledging, acknowledge)}
          rows={transfers}
          rowKey={(row) => row.transferId}
          emptyState={
            <EmptyState
              icon="truck"
              title="No transfers on this page"
              description="There is nothing to show for this page of results."
            />
          }
        />
        <PaginationControls
          pagination={pagination}
          onPageChange={setPage}
          noun="transfers"
        />
      </Panel>
    );
  };

  const content = transferContent();

  const tabs = [
    { id: "all", label: "All", icon: "truck" as const, content },
    { id: "incoming", label: "Incoming", icon: "package" as const, content },
    { id: "outgoing", label: "Outgoing", icon: "externalLink" as const, content },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Transfers"
        description="Every time a batch changed hands and was confirmed on the blockchain. A transfer can only be made by the wallet holding the batch."
        actions={
          <Link className="btn btn--secondary" to="/app/transfers/pending">
            <Icon name="bell" size={16} />
            What is waiting for you
          </Link>
        }
      />

      <div className="filters">
        <div className="filters__field">
          <span className="field__label" id="transfer-status-label">
            Status
          </span>
          <Select
            aria-labelledby="transfer-status-label"
            name="status"
            value={statusFilter}
            placeholder="Any status"
            options={TRANSFER_STATUSES.map((status) => ({
              value: status,
              label: TRANSFER_STATUS_LABELS[status],
            }))}
            onChange={(event) => {
              const next = event.target.value;
              setStatusFilter(next);
              setSearchParams(
                (previous) => {
                  const updated = new URLSearchParams(previous);
                  if (next === "") updated.delete("status");
                  else updated.set("status", next);
                  updated.delete("page");
                  return updated;
                },
                { replace: true },
              );
            }}
          />
          <p className="field__hint">
            The status a transfer is in: awaiting a signature, submitted, completed, failed or
            cancelled.
          </p>
        </div>
      </div>

      <Tabs
        label="Transfer direction"
        tabs={tabs}
        activeId={direction}
        onChange={(id) => { setDirection(id as Direction); }}
      />

      <Panel title="How a transfer works">
        <div className="measure stack text-sm text-secondary">
          <p>
            A transfer has three steps. The wallet holding the batch asks the server to build the
            transaction, signs it, and the server submits it and waits for Solana to confirm. Only
            then does the on-chain owner change, and only then does the registry record it.
          </p>
          <p>
            Once a transfer is complete, the recipient acknowledges that the goods arrived. That
            closes the loop between the two participants, and it is the only step on this page that
            is not signed, because it asserts nothing about the chain.
          </p>
          <p>
            A transfer that was never signed is not a transfer, and does not appear as one. The
            record of a signed transfer is permanent, including the fact that it failed.
          </p>
        </div>
      </Panel>
    </div>
  );
}
