import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { createTransfer, getProduct, listParticipants, submitTransfer } from "../../../api/endpoints";
import {
  TRANSFER_RECIPIENT_ROLES,
  type ParticipantSummary,
  type Product,
  type Transfer,
  type TransferStatus,
} from "../../../api/types";
import { PageHeader } from "../../../components/layout/PageHeader";
import { ErrorState, FailureState, LoadingState, NotFoundState, TransactionState, WalletRequiredState } from "../../../components/states";
import {
  Badge,
  Button,
  Field,
  Icon,
  Panel,
  Select,
  StatusBadge,
  Table,
  TextArea,
  TextInput,
  type TableColumn,
} from "../../../components/ui/Index";
import { useToast } from "../../../context/ToastContext";
import { useWalletState } from "../../../context/WalletContext";
import { formatQuantity, truncateAddress } from "../../../lib/format";
import { isNotFound, isWalletAddressLike, roleLabelOrRaw, useCopyToClipboard, useProductId } from "../appData";
import { AddressValue, DatedValue, SignatureValue } from "../appUi";
import { useChainAction } from "../useChainAction";

/**
 * Handing a batch to the next participant.
 *
 * The two things that go wrong here are both about the recipient: a wallet that
 * is not a registered participant, and a wallet that is registered as something
 * that cannot hold a batch. Both are refused by the server, by the program, and
 * before either, the picker here only offers the roles that can receive one.
 */

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly error: unknown }
  | { readonly phase: "ready"; readonly product: Product };

const RECIPIENT_ROLES = TRANSFER_RECIPIENT_ROLES;

/**
 * The picker columns. Built here rather than at module scope because choosing a
 * participant writes into this form's state.
 */
function recipientColumns(
  onChoose: (walletAddress: string) => void,
): readonly TableColumn<ParticipantSummary>[] {
  return [
    {
      key: "participant",
      header: "Participant",
      isRowHeader: true,
      render: (row) => (
        <span className="stack stack--tight">
          <span>{row.fullName}</span>
          <span className="table__secondary">{row.organisation || "No organisation recorded"}</span>
        </span>
      ),
    },
    {
      key: "role",
      header: "Role",
      render: (row) => <Badge tone="info">{roleLabelOrRaw(row.role)}</Badge>,
    },
    {
      key: "state",
      header: "State",
      render: (row) => (row.state.length > 0 ? row.state : "Not given"),
    },
    {
      key: "wallet",
      header: "Wallet",
      render: (row) => (
        <span className="hash" title={row.walletAddress}>
          {truncateAddress(row.walletAddress)}
        </span>
      ),
    },
    {
      key: "choose",
      header: "Choose",
      render: (row) => (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            onChoose(row.walletAddress);
          }}
        >
          Select
          <span className="visually-hidden"> {row.fullName}</span>
        </Button>
      ),
    },
  ];
}

const STATUS_TONES: Record<TransferStatus, "neutral" | "info" | "success" | "warning" | "danger"> = {
  PREPARED: "warning",
  SUBMITTED: "info",
  COMPLETED: "success",
  FAILED: "danger",
  CANCELLED: "neutral",
  NEEDS_RECONCILIATION: "danger",
};

const STATUS_WORDS: Record<TransferStatus, string> = {
  PREPARED: "Awaiting your signature",
  SUBMITTED: "Submitted to Solana",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  NEEDS_RECONCILIATION: "Needs reconciliation",
};

export default function ProductTransferPage() {
  const productId = useProductId();
  const copy = useCopyToClipboard();
  const { push } = useToast();
  const { publicKey, hasWallet, status: walletStatus, connect, connecting } = useWalletState();

  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [recipient, setRecipient] = useState("");
  const [note, setNote] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [participants, setParticipants] = useState<readonly ParticipantSummary[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [participantsFailed, setParticipantsFailed] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ toWallet?: string; note?: string }>({});

  const load = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  useEffect(() => {
    if (productId === null) return;
    const controller = new AbortController();
    setState({ phase: "loading" });

    getProduct(productId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setState({ phase: "ready", product: response.product });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: "failed", error });
      });

    return () => controller.abort();
  }, [attempt, productId]);

  useEffect(() => {
    const controller = new AbortController();
    setIsSearching(true);
    setParticipantsFailed(false);

    listParticipants(
      {
        ...(roleFilter === "" ? {} : { role: roleFilter }),
        ...(appliedSearch.trim().length > 0 ? { search: appliedSearch.trim() } : {}),
        limit: 50,
      },
      controller.signal,
    )
      .then((response) => {
        if (controller.signal.aborted) return;
        setParticipants(response.participants);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setParticipantsFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsSearching(false);
      });

    return () => controller.abort();
  }, [appliedSearch, roleFilter]);

  const choose = useCallback((walletAddress: string) => {
    setRecipient(walletAddress);
    setFieldErrors((current) => ({ ...current, toWallet: undefined }));
  }, []);

  const action = useChainAction<Transfer, Transfer>({
    prepare: async () => {
      const accepted = await createTransfer(
        productId ?? "",
        recipient.trim(),
        note.trim().length > 0 ? note.trim() : undefined,
      );
      return { prepared: accepted.prepared, record: accepted.transfer };
    },
    submit: async ({ signedTransaction, record }) => {
      const confirmed = await submitTransfer(record.transferId, signedTransaction);
      return confirmed;
    },
    signatureOf: (result) => result.transactionSignature,
    onConfirmed: () => {
      push({
        tone: "success",
        title: "The batch has changed hands",
        message: "The blockchain now names the recipient as the owner.",
      });
    },
  });

  function prepareTransfer(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const errors: { toWallet?: string; note?: string } = {};
    const address = recipient.trim();
    if (address.length === 0) {
      errors.toWallet = "Choose a recipient from the list, or paste their wallet address.";
    } else if (!isWalletAddressLike(address)) {
      errors.toWallet =
        "That is not a Solana wallet address. A wallet address is 32 to 44 letters and digits, with no letter O, I, l or zero.";
    }
    if (note.trim().length > 1000) {
      errors.note = "Keep the note to a thousand characters or fewer.";
    }
    setFieldErrors(errors);
    if (Object.values(errors).some((message) => message !== undefined)) return;

    action.run();
  }

  if (productId === null) {
    return (
      <div className="page">
        <PageHeader title="Hand on a batch" description="No batch identifier was given in the address." />
        <NotFoundState
          title="No batch identifier was given"
          description="The address on this page did not include a batch identifier, so there is no batch to hand on."
          action={
            <Link className="btn btn--primary" to="/app/products">
              Go to the batch list
            </Link>
          }
        />
      </div>
    );
  }

  const heading = (
    <PageHeader
      title="Hand this batch on"
      description="A transfer changes who owns the batch, and it is only real once Solana has confirmed it. You will be asked to sign."
      breadcrumbs={[
        { label: "Batches", to: "/app/products" },
        { label: productId, to: `/app/products/${encodeURIComponent(productId)}` },
        { label: "Hand on" },
      ]}
    />
  );

  if (state.phase === "loading") {
    return (
      <div className="page">
        {heading}
        <LoadingState label={`Reading batch ${productId}`} rows={6} />
      </div>
    );
  }

  if (state.phase === "failed") {
    if (isNotFound(state.error)) {
      return (
        <div className="page">
          {heading}
          <NotFoundState
            title={`No batch is registered as ${productId}`}
            description="The registry holds no record under this identifier, so there is nothing to hand on."
            action={
              <Link className="btn btn--primary" to="/app/products">
                Go to the batch list
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
          title={`Batch ${productId} could not be read`}
          retryLabel="Read it again"
          onRetry={load}
        />
      </div>
    );
  }

  const { product } = state;
  // The confirmed transfer is the one the submit call returned. The prepared
  // record cannot carry a transaction signature, because the server does not
  // have one until the participant signs, so the confirmation panel must read
  // from the confirmed value or it would report a completed transfer as though
  // nothing had been recorded.
  const isConfirmedTransfer = action.phase === "confirmed" && action.confirmed !== null;

  if (publicKey === null) {
    return (
      <div className="page">
        {heading}
        <Panel title="The batch you are handing on">
          <BatchSummary product={product} copy={copy} />
        </Panel>
        <WalletRequiredState
          purpose="hand this batch on"
          isConnecting={connecting}
          {...(hasWallet && walletStatus !== "unavailable"
            ? {
                onConnect: () => {
                  void connect().catch(() => undefined);
                },
              }
            : { noWalletDetected: true })}
        />
      </div>
    );
  }

  return (
    <div className="page">
      {heading}

      <Panel title="The batch you are handing on">
        <BatchSummary product={product} copy={copy} />
      </Panel>

      {isConfirmedTransfer && action.confirmed !== null ? (
        <TransferConfirmedPanel
          transfer={action.confirmed}
          productId={product.productId}
          copy={copy}
        />
      ) : (
        <>
          <Panel title="Who is taking it on?">
            <form onSubmit={prepareTransfer} noValidate className="stack">
              <div className="notice notice--info">
                <Icon name="info" size={18} />
                <div className="notice__body">
                  <p className="notice__title">The recipient has to be registered on the blockchain</p>
                  <p className="text-sm text-secondary">
                    Only a processor, a transporter or a retailer may hold a batch, and only once
                    their wallet has been registered as an on-chain participant. If the wallet you
                    choose is not registered, the transfer is refused before anything is written and
                    the server will tell you so. Ask them to register from their own account first;
                    it takes one signature.
                  </p>
                </div>
              </div>

              <div className="filters">
                <div className="filters__field">
                  <Field id="transfer-role-filter" label="Only show" optional>
                    <Select
                      name="roleFilter"
                      value={roleFilter}
                      placeholder="Processors, transporters and retailers"
                      options={RECIPIENT_ROLES.map((role) => ({
                        value: role,
                        label: roleLabelOrRaw(role),
                      }))}
                      onChange={(event) => { setRoleFilter(event.target.value); }}
                    />
                  </Field>
                </div>

                <div className="filters__field">
                  <Field
                    id="transfer-participant-search"
                    label="Find a participant"
                    optional
                    hint="By name, organisation or wallet address."
                  >
                    <TextInput
                      name="participantSearch"
                      type="search"
                      value={search}
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={120}
                      placeholder="cooperative"
                      onChange={(event) => { setSearch(event.target.value); }}
                      onBlur={() => { setAppliedSearch(search); }}
                    />
                  </Field>
                </div>

                <div className="cluster">
                  <Button
                    variant="secondary"
                    onClick={() => { setAppliedSearch(search); }}
                    loading={isSearching}
                    loadingLabel="Searching the participants registered on-chain"
                  >
                    <Icon name="search" size={16} />
                    Search
                  </Button>
                </div>
              </div>

              {participantsFailed ? (
                <p className="text-sm text-secondary" role="status">
                  The list of registered participants could not be read, so the picker is empty. You
                  can still paste a wallet address below, provided you know that it belongs to a
                  registered processor, transporter or retailer.
                </p>
              ) : null}

              {!participantsFailed ? (
                <Table
                  caption="Participants registered on the blockchain who may receive a batch"
                  columns={recipientColumns(choose)}
                  rows={participants}
                  rowKey={(row) => row.walletAddress}
                  compact
                  emptyState={
                    <p className="text-sm text-secondary">
                      {isSearching
                        ? "Looking for participants."
                        : "No registered processor, transporter or retailer matches. Widen the search, or paste a wallet address below."}
                    </p>
                  }
                />
              ) : null}

              <Field
                id="transfer-recipient"
                label="Recipient wallet address"
                required
                error={fieldErrors["toWallet"]}
                hint="Selecting a participant above fills this in. You can also paste an address directly."
              >
                <TextInput
                  name="toWallet"
                  value={recipient}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={44}
                  placeholder="The recipient's Solana address"
                  onChange={(event) => {
                    setRecipient(event.target.value);
                    setFieldErrors((current) => ({ ...current, toWallet: undefined }));
                  }}
                />
              </Field>

              <Field
                id="transfer-note"
                label="Note"
                optional
                error={fieldErrors["note"]}
                hint="A short message recorded with the transfer, such as the condition of the batch on arrival or the agreed price. Both parties can read it."
              >
                <TextArea
                  name="note"
                  value={note}
                  rows={3}
                  maxLength={1000}
                  onChange={(event) => { setNote(event.target.value); }}
                />
              </Field>

              <div className="cluster">
                <Button
                  type="submit"
                  variant="primary"
                  loading={action.phase === "preparing"}
                  loadingLabel="Asking the server to build the transfer"
                  disabled={action.phase !== "idle" && action.phase !== "failed" && action.phase !== "timed-out" && action.phase !== "signature-rejected"}
                >
                  <Icon name="truck" size={16} />
                  Prepare transfer
                </Button>
                <p className="text-xs text-muted">
                  Preparing builds the transaction. Nothing is written until you sign it.
                </p>
              </div>
            </form>
          </Panel>

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
              prepareLabel="Prepare the transfer"
              signLabel="Sign in my wallet"
              retryLabel="Prepare again"
              cancelLabel="Start again"
            >
              {action.phase === "signature-rejected" ? (
                <p className="text-sm text-secondary">
                  You declined, so the batch is still yours and nothing was written. Preparing again
                  creates a fresh transaction for the same recipient.
                </p>
              ) : null}
            </TransactionState>
          ) : null}

          {action.phase === "failed" || action.phase === "timed-out" ? (
            <FailureState
              error={action.error}
              context="hand this batch over"
              retryLabel="Try again"
              onRetry={action.retry}
              actions={
                <Link className="btn btn--secondary" to={`/app/products/${encodeURIComponent(productId)}`}>
                  Back to the batch
                </Link>
              }
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------ */

function BatchSummary({ product, copy }: { product: Product; copy: (value: string) => void }) {
  return (
    <div className="stack">
      <dl className="definition-list">
        <dt>Batch</dt>
        <dd>
          <span className="hash">{product.productId}</span>
        </dd>

        <dt>What it is</dt>
        <dd>
          {product.cropType} · {formatQuantity(product.quantity, product.unit)}
        </dd>

        <dt>Current stage</dt>
        <dd>
          <StatusBadge status={product.status} showDescription />
        </dd>

        <dt>Current owner</dt>
        <dd>
          <AddressValue address={product.ownerWallet} onCopy={copy} what="owner wallet address" />
          <span className="table__secondary">
            This is the wallet that has to sign the transfer. A different wallet cannot hand this
            batch on, and the server will refuse it.
          </span>
        </dd>

        <dt>Registered on</dt>
        <dd>
          <DatedValue value={product.onChainRegisteredAt} />
        </dd>
      </dl>
    </div>
  );
}

function TransferConfirmedPanel({
  transfer,
  productId,
  copy,
}: {
  transfer: Transfer;
  productId: string;
  copy: (value: string) => void;
}) {
  return (
    <>
      <Panel tone="primary" title="The batch now belongs to the recipient">
        <div className="stack">
          <p className="measure text-secondary">
            Solana confirmed the transfer and the server read the on-chain account back to check it.
            Ownership has changed on the blockchain, not just in these records, so the new owner is
            the only party who can move the batch on.
          </p>
          <dl className="definition-list">
            <dt>Batch</dt>
            <dd>
              <span className="hash">{transfer.productId}</span>
            </dd>

            <dt>New owner</dt>
            <dd>
              <AddressValue address={transfer.toWallet} onCopy={copy} what="new owner wallet address" />
              <span className="table__secondary">
                A {roleLabelOrRaw(transfer.toRole).toLowerCase()}, who holds the batch from now on.
              </span>
            </dd>

            <dt>Previous owner</dt>
            <dd>
              <AddressValue address={transfer.fromWallet} onCopy={copy} what="previous owner wallet address" />
            </dd>

            <dt>Resulting stage</dt>
            <dd>
              {transfer.resultingStatus === null ? (
                <span className="text-secondary">
                  The on-chain account did not report a stage. Open the batch to see its current one.
                </span>
              ) : (
                <StatusBadge status={transfer.resultingStatus} />
              )}
              <span className="table__secondary">
                The batch was at {transfer.previousStatus.replace(/_/g, " ").toLowerCase()} before the
                transfer.
              </span>
            </dd>

            <dt>Transfer status</dt>
            <dd>
              <Badge tone={STATUS_TONES[transfer.status]}>{STATUS_WORDS[transfer.status]}</Badge>
            </dd>

            <dt>Transaction signature</dt>
            <dd>
              <SignatureValue signature={transfer.transactionSignature} />
            </dd>
          </dl>
          <p className="measure text-sm text-secondary">
            The recipient now has to acknowledge receipt, which is how the registry closes the loop
            and confirms the goods actually arrived. That is their action, not yours, and the batch
            is recorded as theirs either way.
          </p>
          <div className="cluster">
            <Link
              className="btn btn--primary"
              to={`/app/transfers/${encodeURIComponent(transfer.transferId)}`}
            >
              <Icon name="fileText" size={16} />
              Open the transfer record
            </Link>
            <Link className="btn btn--secondary" to={`/app/products/${encodeURIComponent(productId)}`}>
              <Icon name="package" size={16} />
              Open the batch
            </Link>
            <Link className="btn btn--quiet" to="/app/transfers">
              All my transfers
            </Link>
          </div>
        </div>
      </Panel>
    </>
  );
}
