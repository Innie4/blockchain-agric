import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { acknowledgeTransfer, listPendingTransfers } from "../../../api/endpoints";
import { messageForError } from "../../../api/errors";
import { TRANSFER_STATUS_LABELS, type Transfer } from "../../../api/types";
import { PageHeader } from "../../../components/layout/PageHeader";
import { ErrorState, LoadingState } from "../../../components/states";
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  Panel,
  Table,
  type TableColumn,
} from "../../../components/ui/Index";
import { useAuth } from "../../../context/AuthContext";
import { useToast } from "../../../context/ToastContext";
import { truncateAddress } from "../../../lib/format";
import { roleLabelOrRaw } from "../appData";
import { DatedTimeValue } from "../appUi";

/**
 * The two lists a participant has to act on, and nothing else.
 *
 * Incoming transfers that are complete on the blockchain but unacknowledged: the
 * goods are recorded as yours and the sender is still waiting to know they
 * arrived. Outgoing transfers still awaiting a signature: the transaction was
 * prepared but never signed, so nothing is recorded and the batch is still yours.
 *
 * Both are real work, so each gets its own heading and its own empty state
 * rather than being folded into a single list.
 */

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly error: unknown }
  | { readonly phase: "ready"; readonly transfers: readonly Transfer[] };

/* ------------------------------------------------------------------ *
 * The tables
 * ------------------------------------------------------------------ */

function incomingColumns(
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
      key: "from",
      header: "Sent by",
      render: (row) => (
        <span className="stack stack--tight">
          <span className="hash" title={row.fromWallet}>
            {truncateAddress(row.fromWallet)}
          </span>
          <span className="table__secondary">A {roleLabelOrRaw(row.fromRole).toLowerCase()}</span>
        </span>
      ),
    },
    { key: "confirmed", header: "Confirmed on", render: (row) => <DatedTimeValue value={row.confirmedAt} /> },
    {
      key: "note",
      header: "Note from the sender",
      render: (row) => (row.note.trim().length > 0 ? row.note : "No note was left."),
    },
    {
      key: "action",
      header: "Action",
      render: (row) => (
        <span className="cluster cluster--tight">
          <Link
            className="btn btn--secondary btn--sm"
            to={`/app/transfers/${encodeURIComponent(row.transferId)}`}
          >
            Open
            <span className="visually-hidden"> the transfer of {row.productId}</span>
          </Link>
          {row.acknowledgedAt === null ? (
            <Button
              variant="primary"
              size="sm"
              loading={acknowledging === row.transferId}
              loadingLabel="Confirming receipt of this batch"
              onClick={() => { onAcknowledge(row); }}
            >
              Confirm it arrived
            </Button>
          ) : (
            <span className="text-xs text-muted nowrap">
              Confirmed <DatedTimeValue value={row.acknowledgedAt} />
            </span>
          )}
        </span>
      ),
    },
  ];
}

const OUTGOING_COLUMNS: readonly TableColumn<Transfer>[] = [
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
    key: "to",
    header: "Sent to",
    render: (row) => (
      <span className="stack stack--tight">
        <span className="hash" title={row.toWallet}>
          {truncateAddress(row.toWallet)}
        </span>
        <span className="table__secondary">A {roleLabelOrRaw(row.toRole).toLowerCase()}</span>
      </span>
    ),
  },
  { key: "prepared", header: "Prepared", render: (row) => <DatedTimeValue value={row.createdAt} /> },
  {
    key: "status",
    header: "State",
    render: (row) => (
      <Badge tone="warning" icon="warning">
        {TRANSFER_STATUS_LABELS[row.status]}
      </Badge>
    ),
  },
  {
    key: "action",
    header: "Action",
    render: (row) => (
      <span className="cluster cluster--tight">
        <Link
          className="btn btn--primary btn--sm"
          to={`/app/products/${encodeURIComponent(row.productId)}/transfer`}
        >
          Prepare it again
          <span className="visually-hidden"> for {row.productId}</span>
        </Link>
        <Link
          className="btn btn--quiet btn--sm"
          to={`/app/transfers/${encodeURIComponent(row.transferId)}`}
        >
          Open the record
        </Link>
      </span>
    ),
  },
];

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function PendingTransfersPage() {
  const { user } = useAuth();
  const { push } = useToast();
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

    listPendingTransfers(controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setState({ phase: "ready", transfers: response.transfers });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: "failed", error });
      });

    return () => controller.abort();
  }, [attempt]);

  /**
   * Confirming receipt is patched in place rather than reloading the page, so the
   * reader does not lose their place and the pending item leaves the list as
   * soon as the server has agreed.
   */
  const acknowledge = useCallback(
    (transfer: Transfer) => {
      setAcknowledging(transfer.transferId);
      void acknowledgeTransfer(transfer.transferId)
        .then((result) => {
          setState((current) =>
            current.phase !== "ready"
              ? current
              : {
                  phase: "ready",
                  transfers: current.transfers.map((item) =>
                    item.transferId === transfer.transferId ? result.transfer : item,
                  ),
                },
          );
          push({
            tone: "success",
            title: "Receipt of the batch confirmed",
            message: `${result.transfer.productId} is now recorded as received by you. The sender has been told.`,
          });
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
    [push],
  );

  const heading = (
    <PageHeader
      title="Waiting for you"
      description="Two kinds of work, and nothing else. Confirm the batches that have reached you, and finish the transfers you started."
      actions={
        <Link className="btn btn--secondary" to="/app/transfers">
          <Icon name="truck" size={16} />
          Every transfer
        </Link>
      }
    />
  );

  if (state.phase === "loading") {
    return (
      <div className="page">
        {heading}
        <LoadingState label="Reading the transfers waiting on you" rows={6} />
      </div>
    );
  }

  if (state.phase === "failed") {
    return (
      <div className="page">
        {heading}
        <ErrorState
          error={state.error}
          title="The transfers waiting on you could not be read"
          retryLabel="Read them again"
          onRetry={load}
        />
      </div>
    );
  }

  const incoming = state.transfers.filter(
    (transfer) => transfer.toWallet === wallet && transfer.status === "COMPLETED",
  );
  const outgoing = state.transfers.filter(
    (transfer) => transfer.fromWallet === wallet && transfer.status === "PREPARED",
  );

  return (
    <div className="page">
      {heading}

      <Panel
        title="Batches that have arrived and need your confirmation"
        actions={
          incoming.length === 0 ? null : (
            <Badge tone="info" icon="bell">
              {incoming.length} to confirm
            </Badge>
          )
        }
      >
        {incoming.length === 0 ? (
          <EmptyState
            icon="check"
            title="Nothing is waiting for you"
            description="No batch has been transferred to you and left unconfirmed. When a farmer, processor or retailer hands you a batch, it appears here for you to confirm that it arrived."
            action={
              <Link className="btn btn--secondary" to="/app/products?scope=mine">
                <Icon name="package" size={16} />
                See the batches you hold
              </Link>
            }
          />
        ) : (
          <div className="stack">
            <p className="measure text-secondary">
              These transfers are complete on the blockchain, so the batch is already recorded as
              yours. What is missing is your word that the goods actually turned up. Confirming that
              tells the sender the batch arrived; it writes nothing to the blockchain.
            </p>
            <Table
              caption="Transfers to you that are complete and unacknowledged"
              columns={incomingColumns(acknowledging, acknowledge)}
              rows={incoming}
              rowKey={(row) => row.transferId}
            />
          </div>
        )}
      </Panel>

      <Panel
        title="Transfers you started and have not signed"
        actions={
          outgoing.length === 0 ? null : (
            <Badge tone="warning" icon="warning">
              {outgoing.length} unsigned
            </Badge>
          )
        }
      >
        {outgoing.length === 0 ? (
          <EmptyState
            icon="check"
            title="Nothing is waiting for you"
            description="Every transfer you have started has been signed or cancelled. A transfer stays here only while it is prepared and unsigned, which means the batch is still yours and nothing has been recorded."
          />
        ) : (
          <div className="stack">
            <p className="measure text-secondary">
              A prepared transfer is a transaction the server built and nobody signed. Because it was
              never signed, nothing was written to the blockchain, the batch is still recorded as
              yours, and the recipient has not been told anything. Preparing the transfer again asks
              the server for a fresh transaction, because the old one has expired.
            </p>
            <Table
              caption="Transfers you prepared that have not been signed"
              columns={OUTGOING_COLUMNS}
              rows={outgoing}
              rowKey={(row) => row.transferId}
            />
          </div>
        )}
      </Panel>

      <Panel title="Why these two lists are all there is">
        <div className="measure stack text-sm text-secondary">
          <p>
            Neither list writes to the blockchain, and neither needs a signature. By the time a
            transfer reaches either list it is already on the chain; what is outstanding is a
            participant&rsquo;s word, and a word is exactly what this page collects.
          </p>
          <p>
            Every other transfer you have been party to is complete and recorded. Those are on the
            transfers page, where the permanent record of each one can be read.
          </p>
        </div>
      </Panel>
    </div>
  );
}
