import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { acknowledgeTransfer, cancelTransfer, getTransfer } from "../../../api/endpoints";
import { messageForError } from "../../../api/errors";
import {
  TRANSFER_STATUS_LABELS,
  type Transfer,
  type TransferStatus,
} from "../../../api/types";
import { PageHeader } from "../../../components/layout/PageHeader";
import { ErrorState, LoadingState, NotFoundState } from "../../../components/states";
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  Panel,
  StatusBadge,
} from "../../../components/ui/Index";
import { useAuth } from "../../../context/AuthContext";
import { useToast } from "../../../context/ToastContext";
import { formatQuantity } from "../../../lib/format";
import { decodeParam, isForbidden, isNotFound, roleLabelOrRaw, useCopyToClipboard } from "../appData";
import { AddressValue, DatedTimeValue, SignatureValue } from "../appUi";

/**
 * One transfer, and everything that is known about it.
 *
 * A transfer is a permanent record: it names two wallets, two roles, the stage
 * the batch was at and the stage it reached, and the Solana transaction that made
 * it so. The only thing about it that can still change is the recipient's
 * acknowledgement, and that changes only once.
 */

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly error: unknown }
  | { readonly phase: "ready"; readonly transfer: Transfer; readonly canAcknowledge: boolean };

const STATUS_TONES: Record<TransferStatus, "neutral" | "info" | "success" | "warning" | "danger"> = {
  PREPARED: "warning",
  SUBMITTED: "info",
  COMPLETED: "success",
  FAILED: "danger",
  CANCELLED: "neutral",
  NEEDS_RECONCILIATION: "danger",
};

function isMeaningful(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}

export default function TransferDetailPage() {
  const { transferId: rawParam } = useParams();
  const transferId = decodeParam(rawParam);
  const { user } = useAuth();
  const copy = useCopyToClipboard();
  const { push } = useToast();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [isAcknowledging, setIsAcknowledging] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const wallet = user?.walletAddress ?? null;

  const load = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  useEffect(() => {
    if (transferId === null) return;
    const controller = new AbortController();
    setState({ phase: "loading" });

    getTransfer(transferId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        const canAcknowledge =
          response.canAcknowledge ??
          (response.transfer.toWallet === wallet &&
            response.transfer.status === "COMPLETED" &&
            response.transfer.acknowledgedAt === null);
        setState({ phase: "ready", transfer: response.transfer, canAcknowledge });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: "failed", error });
      });

    return () => controller.abort();
    // `wallet` only refines a decision the server also makes, so a change of
    // session re-reads the record rather than guessing.
  }, [attempt, transferId, wallet]);

  const acknowledge = useCallback(() => {
    if (transferId === null) return;
    setIsAcknowledging(true);
    void acknowledgeTransfer(transferId)
      .then((result) => {
        setState((current) =>
          current.phase !== "ready"
            ? current
            : { phase: "ready", transfer: result.transfer, canAcknowledge: false },
        );
        push({
          tone: "success",
          title: "Receipt of the batch confirmed",
          message: "The sender has been told that the batch arrived.",
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
        setIsAcknowledging(false);
      });
  }, [push, transferId]);

  /**
   * The sender abandons a transfer they prepared but never signed. Nothing has
   * reached the blockchain, so this only closes the record the sender left
   * behind; the batch never moved and stays with them.
   */
  const cancel = useCallback(() => {
    if (transferId === null) return;
    setIsCancelling(true);
    void cancelTransfer(transferId)
      .then((result) => {
        // The response is the authoritative record, so the page says the
        // transfer is cancelled at once; the read that follows confirms it.
        setState({ phase: "ready", transfer: result.transfer, canAcknowledge: false });
        push({
          tone: "success",
          title: "The transfer was cancelled",
          message: "Nothing was written to the blockchain and the batch is still yours.",
        });
        load();
      })
      .catch((error: unknown) => {
        push({
          tone: "error",
          title: "The transfer could not be cancelled",
          message: messageForError(error),
        });
      })
      .finally(() => {
        setIsCancelling(false);
      });
  }, [load, push, transferId]);

  if (transferId === null) {
    return (
      <div className="page">
        <PageHeader title="Transfer" description="No transfer identifier was given in the address." />
        <NotFoundState
          title="No transfer identifier was given"
          description="The address on this page did not include a transfer identifier, so there is no record to read."
          action={
            <Link className="btn btn--primary" to="/app/transfers">
              Go to my transfers
            </Link>
          }
        />
      </div>
    );
  }

  const heading = (
    <PageHeader
      title="Transfer record"
      description="A transfer is permanent. It names both parties, the stage the batch moved between, and the transaction that made it so."
      breadcrumbs={[
        { label: "Transfers", to: "/app/transfers" },
        { label: "Record" },
      ]}
    />
  );

  if (state.phase === "loading") {
    return (
      <div className="page">
        {heading}
        <LoadingState label="Reading the transfer record" rows={7} />
      </div>
    );
  }

  if (state.phase === "failed") {
    if (isForbidden(state.error)) {
      return (
        <div className="page">
          {heading}
          <div role="alert">
            <EmptyState
              icon="shield"
              tone="warning"
              title="This transfer is between other participants"
              description="The registry will not show a transfer to a participant who is neither the sender nor the recipient, and that refusal is deliberate: a transfer names two businesses, and a competitor has no need to read it. If you believe you are party to this transfer, the wallet that sent it is not the one you are signed in with."
              action={
                <div className="cluster cluster--tight">
                  <Link className="btn btn--primary" to="/app/transfers">
                    <Icon name="truck" size={16} />
                    Go to my transfers
                  </Link>
                  {user?.role === "REGULATOR" ? null : (
                    <span className="text-sm text-secondary">
                      A regulator can see any transfer, for oversight.
                    </span>
                  )}
                </div>
              }
            />
          </div>
        </div>
      );
    }
    if (isNotFound(state.error)) {
      return (
        <div className="page">
          {heading}
          <NotFoundState
            title="No transfer exists with that identifier"
            description="The registry holds no record of it. Check the identifier in the address, or open it from the list of your own transfers."
            action={
              <Link className="btn btn--primary" to="/app/transfers">
                Go to my transfers
              </Link>
            }
          />
        </div>
      );
    }
    return (
      <div className="page">
        {heading}
        <ErrorState
          error={state.error}
          title="The transfer record could not be read"
          retryLabel="Read it again"
          onRetry={load}
        />
      </div>
    );
  }

  const { transfer, canAcknowledge } = state;
  const isSender = transfer.fromWallet === wallet;
  const isRecipient = transfer.toWallet === wallet;

  return (
    <div className="page">
      {heading}

      <Panel
        title="The transfer"
        actions={
          <span className="cluster cluster--tight">
            <Badge tone={STATUS_TONES[transfer.status]}>{TRANSFER_STATUS_LABELS[transfer.status]}</Badge>
            {isSender ? <Badge tone="earth">You sent this</Badge> : null}
            {isRecipient ? <Badge tone="info">You received this</Badge> : null}
          </span>
        }
      >
        <div className="stack">
          <p className="text-sm text-secondary">
            Transfer identifier{" "}
            <span className="hash">{transfer.transferId}</span>
          </p>
          <p className="measure text-secondary">
            {transfer.status === "PREPARED"
              ? "This transfer was prepared and has not been signed, so nothing was written to the blockchain. The batch is still with the sender."
              : transfer.status === "COMPLETED"
                ? "Solana confirmed this transfer and the server read the on-chain account back to check it. The ownership change is permanent."
                : transfer.status === "NEEDS_RECONCILIATION"
                  ? "The transfer confirmed on-chain but the matching record could not be written at the time. Nothing has been lost: a regulator can finish it from the reconciliation queue."
                  : transfer.status === "FAILED"
                    ? "The transfer did not complete. The reason is recorded below, and the batch did not change hands."
                    : "This transfer was cancelled before anything was signed, so nothing was written to the blockchain."}
          </p>
          {isMeaningful(transfer.failureReason) ? (
            <p className="text-sm">
              <strong>Reason recorded:</strong> {transfer.failureReason}
            </p>
          ) : null}
        </div>
      </Panel>

      <Panel title="The batch">
        <dl className="definition-list">
          <dt>Batch</dt>
          <dd>
            <Link className="hash" to={`/app/products/${encodeURIComponent(transfer.productId)}`}>
              {transfer.productId}
            </Link>
            {transfer.cropType === undefined ? null : (
              <span className="table__secondary">
                {transfer.cropType}
                {transfer.quantity === undefined ? null : ` · ${formatQuantity(transfer.quantity, transfer.unit ?? "")}`}
              </span>
            )}
          </dd>

          <dt>Stage before</dt>
          <dd>
            <StatusBadge status={transfer.previousStatus} />
            <span className="table__secondary">
              {transfer.previousStatus.replace(/_/g, " ").toLowerCase()}
            </span>
          </dd>

          <dt>Stage after</dt>
          <dd>
            {transfer.resultingStatus === null ? (
              <span className="text-secondary">
                The transfer has not completed, so the batch has not moved to a new stage.
              </span>
            ) : (
              <StatusBadge status={transfer.resultingStatus} />
            )}
          </dd>
        </dl>
      </Panel>

      <Panel title="The two parties">
        <dl className="definition-list">
          <dt>Sent by</dt>
          <dd>
            <AddressValue address={transfer.fromWallet} onCopy={copy} what="sending wallet address" />
            <span className="table__secondary">
              A {roleLabelOrRaw(transfer.fromRole).toLowerCase()}. This is the wallet that signed the
              transaction, which is why it could make the transfer.
            </span>
          </dd>

          <dt>Sent to</dt>
          <dd>
            <AddressValue address={transfer.toWallet} onCopy={copy} what="receiving wallet address" />
            <span className="table__secondary">
              A {roleLabelOrRaw(transfer.toRole).toLowerCase()}. Only this wallet can move the batch
              on from here.
            </span>
          </dd>
        </dl>
      </Panel>

      <Panel title="The note">
        {transfer.note.trim().length > 0 ? (
          <p className="measure">{transfer.note}</p>
        ) : (
          <p className="measure text-secondary">
            No note was left with this transfer. The note is where a sender records the condition of
            the batch on handover or an agreed price, and both parties can read it.
          </p>
        )}
      </Panel>

      <Panel title="The blockchain record">
        <dl className="definition-list">
          <dt>Transaction signature</dt>
          <dd>
            <SignatureValue signature={transfer.transactionSignature} />
          </dd>

          <dt>Prepared</dt>
          <dd>
            <DatedTimeValue value={transfer.createdAt} />
          </dd>

          <dt>Submitted</dt>
          <dd>
            <DatedTimeValue value={transfer.submittedAt} />
            <span className="table__secondary">
              The moment the signed transaction was sent to the cluster.
            </span>
          </dd>

          <dt>Confirmed</dt>
          <dd>
            <DatedTimeValue value={transfer.confirmedAt} />
            <span className="table__secondary">
              The moment Solana settled it and the server re-read the on-chain account.
            </span>
          </dd>

          <dt>Receipt acknowledged</dt>
          <dd>
            <DatedTimeValue value={transfer.acknowledgedAt} />
            <span className="table__secondary">
              {transfer.acknowledgedAt === null
                ? "Not yet. The recipient has not confirmed that the batch arrived."
                : "The recipient confirmed the batch arrived. This cannot be undone."}
            </span>
          </dd>
        </dl>
      </Panel>

      {canAcknowledge ? (
        <Panel tone="primary" title="Confirm that this batch reached you">
          <div className="stack">
            <p className="measure text-secondary">
              The transfer is complete on the blockchain and the batch is recorded as yours, but
              nobody has confirmed that the goods actually turned up. Confirming that closes the loop
              between the two of you. It writes nothing to the blockchain and needs no signature: it
              is a statement about the world, not about the chain.
            </p>
            <p className="text-sm text-secondary">
              If the batch did not arrive, or arrived in poor condition, do not confirm it. Tell the
              sender instead, and ask a regulator for advice.
            </p>
            <div className="cluster">
              <Button
                variant="primary"
                loading={isAcknowledging}
                loadingLabel="Confirming receipt of this batch"
                onClick={acknowledge}
              >
                <Icon name="check" size={16} />
                Confirm the batch arrived
              </Button>
              <p className="text-xs text-muted">This can only be done once.</p>
            </div>
          </div>
        </Panel>
      ) : null}

      {transfer.status === "PREPARED" && isSender ? (
        <Panel title="Cancel this transfer">
          <div className="stack">
            <p className="measure text-secondary">
              This transfer was prepared and never signed, so nothing was written to the blockchain
              and the batch is still yours. Cancelling closes the record rather than leaving it
              waiting: the recipient will not be able to sign it, and the batch can be handed to
              somebody else.
            </p>
            <p className="text-sm text-secondary">
              Cancelling is not reversible. If the batch is still meant to go to this recipient, sign
              the prepared transaction instead.
            </p>
            <div className="cluster">
              <Button
                variant="danger"
                loading={isCancelling}
                loadingLabel="Cancelling this transfer"
                onClick={cancel}
              >
                <Icon name="x" size={16} />
                Cancel this transfer
              </Button>
              <p className="text-xs text-muted">
                No signature is needed: nothing on the blockchain changes.
              </p>
            </div>
          </div>
        </Panel>
      ) : null}

      <Panel title="Where to go from here">
        <div className="cluster">
          <Link
            className="btn btn--secondary"
            to={`/app/products/${encodeURIComponent(transfer.productId)}`}
          >
            <Icon name="package" size={16} />
            Open the batch
          </Link>
          <Link
            className="btn btn--secondary"
            to={`/app/products/${encodeURIComponent(transfer.productId)}/history`}
          >
            <Icon name="flag" size={16} />
            Read the batch history
          </Link>
          <Link className="btn btn--quiet" to="/app/transfers">
            Every transfer
          </Link>
        </div>
      </Panel>
    </div>
  );
}
