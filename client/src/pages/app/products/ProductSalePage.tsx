import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  getProduct,
  prepareProductStatusUpdate,
  submitProductStatusUpdate,
  updateProductSale,
} from "../../../api/endpoints";
import { fieldErrorFor, messageForError } from "../../../api/errors";
import {
  STATUS_LABELS,
  VERIFICATION_RESULT_LABELS,
  type Prepared,
  type Product,
  type SaleUpdateInput,
} from "../../../api/types";
import { PageHeader } from "../../../components/layout/PageHeader";
import { ErrorState, FailureState, LoadingState, NotFoundState, TransactionState, WalletRequiredState } from "../../../components/states";
import {
  Badge,
  Button,
  Field,
  Icon,
  NumberInput,
  Panel,
  Select,
  StatusBadge,
  TextArea,
} from "../../../components/ui/Index";
import { useAuth } from "../../../context/AuthContext";
import { useToast } from "../../../context/ToastContext";
import { useWalletState } from "../../../context/WalletContext";
import { formatCurrency, formatDate } from "../../../lib/format";
import { isNotFound, useProductId } from "../appData";
import { DatedTimeValue, SignatureValue } from "../appUi";
import { useChainAction } from "../useChainAction";

/**
 * A retailer's decision about a batch, and the one lifecycle change a retailer
 * makes.
 *
 * Two things are kept deliberately apart. Whether a batch is on offer, and at
 * what price, is a business decision recorded in the records service, and it
 * needs no signature. The stage of the batch, which is a fact every other
 * participant and every buyer can rely on, is on the blockchain, and it does.
 */

const CURRENCIES = [
  { value: "NGN", label: "Nigerian naira (NGN)" },
  { value: "USD", label: "United States dollar (USD)" },
  { value: "GBP", label: "Pound sterling (GBP)" },
  { value: "EUR", label: "Euro (EUR)" },
] as const;

interface SaleForm {
  listed: boolean;
  askingPrice: string;
  currency: string;
  note: string;
}

type SaveState =
  | { readonly phase: "idle" }
  | { readonly phase: "saving" }
  | { readonly phase: "failed"; readonly error: unknown };

function formFrom(product: Product): SaleForm {
  return {
    listed: product.retail.listed,
    askingPrice:
      product.retail.askingPrice === null ? "" : String(product.retail.askingPrice),
    currency:
      product.retail.currency.trim().length > 0 ? product.retail.currency : "NGN",
    note: product.retail.note,
  };
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function ProductSalePage() {
  const productId = useProductId();
  const { user } = useAuth();
  const { push } = useToast();
  const { publicKey, hasWallet, status: walletStatus, connect, connecting } = useWalletState();

  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<Product | null>(null);
  /** Decided by the server, which knows the session wallet and role. */
  const [canListForSale, setCanListForSale] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [isLoading, setIsLoading] = useState(true);

  const [form, setForm] = useState<SaleForm | null>(null);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [state, setState] = useState<SaveState>({ phase: "idle" });

  const reload = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  useEffect(() => {
    if (productId === null) return;
    const controller = new AbortController();
    setIsLoading(true);

    getProduct(productId, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setResponse(next.product);
        setCanListForSale(next.canListForSale);
        setForm(formFrom(next.product));
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [attempt, productId]);

  const action = useChainAction<Prepared, Product>({
    prepare: async () => {
      if (productId === null) throw new Error("No batch was identified.");
      if (response === null) throw new Error("The batch has not been read yet.");
      const target = response.retail.listed ? "LISTED" : "AT_RETAILER";
      const prepared = await prepareProductStatusUpdate(productId, {
        status: target,
        occurredAt: new Date().toISOString(),
      });
      return { prepared: prepared.prepared, record: prepared.prepared };
    },
    submit: async ({ signedTransaction }) => {
      if (productId === null) throw new Error("No batch was identified.");
      return submitProductStatusUpdate(productId, signedTransaction);
    },
    signatureOf: (result) => result.onChainTxHash,
    onConfirmed: (result) => {
      setResponse(result);
      setForm(formFrom(result));
      push({
        tone: "success",
        title: "The stage of the batch is now on the blockchain",
        message: `Recorded as ${STATUS_LABELS[result.status].toLowerCase()}.`,
      });
    },
  });

  function saveListing(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (productId === null || form === null) return;

    const found: Record<string, string | undefined> = {};
    const price = form.askingPrice.trim().length === 0 ? null : Number(form.askingPrice);
    if (form.listed && price !== null && (!Number.isFinite(price) || price < 0)) {
      found["askingPrice"] = "Enter an asking price of zero or more, or leave it blank.";
    }
    if (form.listed && price !== null && price > 1_000_000_000) {
      found["askingPrice"] = "That asking price is larger than the registry accepts.";
    }
    if ((CURRENCIES as ReadonlyArray<{ value: string }>).some((c) => c.value === form.currency) === false) {
      found["currency"] = "Choose a currency from the list.";
    }
    if (form.note.trim().length > 1000) {
      found["note"] = "Keep the note to a thousand characters or fewer.";
    }
    setErrors(found);
    if (Object.values(found).some((message) => message !== undefined)) return;

    const input: SaleUpdateInput = {
      listed: form.listed,
      askingPrice: price,
      currency: form.currency,
      note: form.note.trim(),
    };

    setState({ phase: "saving" });
    void updateProductSale(productId, input)
      .then((next) => {
        setState({ phase: "idle" });
        setResponse(next);
        setForm(formFrom(next));
        push({
          tone: "success",
          title: next.retail.listed
            ? "The batch is listed for sale"
            : "The batch is no longer listed for sale",
        });
      })
      .catch((error: unknown) => {
        setState({ phase: "failed", error });
        setErrors({
          listed: fieldErrorFor(error, "listed"),
          askingPrice: fieldErrorFor(error, "askingPrice"),
          currency: fieldErrorFor(error, "currency"),
          note: fieldErrorFor(error, "note"),
        });
      });
  }

  if (productId === null) {
    return (
      <div className="page">
        <PageHeader title="Listing and price" description="No batch identifier was given in the address." />
        <NotFoundState
          title="No batch identifier was given"
          description="The address on this page did not include a batch identifier, so there is no batch to list."
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
      title="Listing and price"
      description="Whether this batch is on offer, and at what price. This is your commercial decision, held in the records service."
      breadcrumbs={[
        { label: "Batches", to: "/app/products" },
        { label: productId, to: `/app/products/${encodeURIComponent(productId)}` },
        { label: "Listing" },
      ]}
    />
  );

  if (isLoading) {
    return (
      <div className="page">
        {heading}
        <LoadingState label={`Reading batch ${productId}`} rows={6} />
      </div>
    );
  }

  if (loadError !== null || response === null || form === null) {
    if (isNotFound(loadError)) {
      return (
        <div className="page">
          {heading}
          <NotFoundState
            title={`No batch is registered as ${productId}`}
            description="The registry holds no record under this identifier, so there is nothing to list."
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
          error={loadError}
          title={`Batch ${productId} could not be read`}
          retryLabel="Read it again"
          onRetry={reload}
        />
      </div>
    );
  }

  const product = response;
  const canSell = canListForSale;
  const stageIsOutOfStep =
    product.retail.listed && product.status !== "LISTED" && product.status !== "SOLD";

  return (
    <div className="page">
      {heading}

      <Panel
        title="This batch"
        actions={
          <span className="cluster cluster--tight">
            <StatusBadge status={product.status} />
            {product.retail.listed ? (
              <Badge tone="success" icon="store">
                Listed
              </Badge>
            ) : (
              <Badge tone="neutral">Not listed</Badge>
            )}
          </span>
        }
      >
        <div className="stack">
          <dl className="definition-list">
            <dt>Batch</dt>
            <dd>
              <span className="hash">{product.productId}</span>
            </dd>

            <dt>What it is</dt>
            <dd>
              {product.cropType}
              <span className="table__secondary">
                {product.quantity} {product.unit}
              </span>
            </dd>

            <dt>Stage</dt>
            <dd>
              <StatusBadge status={product.status} showDescription />
            </dd>

            <dt>Last check</dt>
            <dd>
              {VERIFICATION_RESULT_LABELS[product.lastVerificationResult]}
              <span className="table__secondary">
                {product.lastVerifiedAt === null
                  ? "This batch has never been checked against the blockchain."
                  : `Last checked on ${formatDate(product.lastVerifiedAt)}.`}{" "}
                The full result is on the batch's own page, where it can be read and, if you want
                the check recorded, logged.              </span>
            </dd>

            <dt>Listing since</dt>
            <dd>
              <DatedTimeValue value={product.retail.listedAt} />
            </dd>
          </dl>
          <div className="cluster">
            <Link
              className="btn btn--secondary"
              to={`/app/products/${encodeURIComponent(product.productId)}`}
            >
              <Icon name="package" size={16} />
              Open the batch
            </Link>
            <Link
              className="btn btn--secondary"
              to={`/app/products/${encodeURIComponent(product.productId)}/verify`}
            >
              <Icon name="shield" size={16} />
              Its verification result
            </Link>
          </div>
        </div>
      </Panel>

      {!canSell ? (
        <div className="notice notice--warning">
          <Icon name="shield" size={18} />
          <div className="notice__body">
            <p className="notice__title">Your role does not include setting a listing</p>
            <p className="text-sm text-secondary">
              {user === null
                ? "This batch is not yours to list."
                : `You are signed in as a ${user.role.replace(/_/g, " ").toLowerCase()}. Only the retailer holding a batch can set its listing and price, and the server refuses the change from any other wallet. This page is read-only for you.`}
            </p>
          </div>
        </div>
      ) : null}

      <Panel title="The commercial decision">
        <div className="stack">
          <p className="measure text-secondary">
            Whether a batch is on offer, and at what price, is a business decision. It is held in the
            records service, not on the blockchain, and saving it needs no signature. The stage of
            the batch, which everybody relies on, is a separate thing and is handled below.
          </p>

          <form onSubmit={saveListing} noValidate className="stack">
            <div className="field" role="group" aria-labelledby="sale-listed-label">
              <span className="field__label" id="sale-listed-label">
                Is this batch on offer?
              </span>
              <label className="checkbox-row" htmlFor="sale-listed">
                <input
                  id="sale-listed"
                  name="listed"
                  type="checkbox"
                  checked={form.listed}
                  disabled={!canSell}
                  aria-invalid={errors["listed"] === undefined ? undefined : true}
                  onChange={(event) => {
                    setForm((current) =>
                      current === null ? null : { ...current, listed: event.target.checked },
                    );
                    setErrors((current) => ({ ...current, listed: undefined }));
                  }}
                />
                <span>
                  Yes, list this batch for sale
                  <span className="field__hint" id="listed-hint">
                    Buyers can see a listed batch in search results. They still have to open it and
                    check it themselves.
                  </span>
                </span>
              </label>
              {errors["listed"] === undefined ? null : (
                <p className="field__error" id="sale-listed-error">
                  <Icon name="alertTriangle" size={14} />
                  <span>{errors["listed"]}</span>
                </p>
              )}
            </div>

            <div className="grid grid--2">
              <Field
                id="sale-price"
                label="Asking price"
                optional
                error={errors["askingPrice"] ?? fieldErrorFor(state.phase === "failed" ? state.error : null, "askingPrice")}
                hint="Leave blank if the price is negotiable and not fixed."
              >
                <NumberInput
                  name="askingPrice"
                  value={form.askingPrice}
                  min={0}
                  step="any"
                  inputMode="decimal"
                  disabled={!canSell}
                  addon={<span>{form.currency}</span>}
                  onChange={(event) => {
                    setForm((current) =>
                      current === null ? null : { ...current, askingPrice: event.target.value },
                    );
                  }}
                />
              </Field>

              <Field
                id="sale-currency"
                label="Currency"
                required
                error={errors["currency"]}
                hint="The currency the price is quoted in."
              >
                <Select
                  name="currency"
                  value={form.currency}
                  options={CURRENCIES.map((currency) => ({ value: currency.value, label: currency.label }))}
                  disabled={!canSell}
                  onChange={(event) => {
                    setForm((current) =>
                      current === null ? null : { ...current, currency: event.target.value },
                    );
                  }}
                />
              </Field>
            </div>

            <Field
              id="sale-note"
              label="Note"
              optional
              error={errors["note"]}
              hint="A short note for buyers and for whoever picks up the batch next, such as a bulk discount or a delivery window."
            >
              <TextArea
                name="note"
                value={form.note}
                rows={3}
                maxLength={1000}
                disabled={!canSell}
                onChange={(event) => {
                  setForm((current) =>
                    current === null ? null : { ...current, note: event.target.value },
                  );
                }}
              />
            </Field>

            {state.phase === "failed" ? (
              <p className="text-sm text-danger" role="alert">
                {messageForError(state.error)} Nothing was changed. Correct the fields above and try
                again.
              </p>
            ) : null}

            <div className="cluster">
              <Button
                type="submit"
                variant="primary"
                loading={state.phase === "saving"}
                loadingLabel="Saving the listing"
                disabled={!canSell}
              >
                <Icon name="store" size={16} />
                Save the listing
              </Button>
              <p className="text-xs text-muted">
                Saved in the records service. No signature is needed for a price.
              </p>
            </div>
          </form>
        </div>
      </Panel>

      <Panel title="The stage of the batch">
        <div className="stack">
          <p className="measure text-secondary">
            A batch is {STATUS_LABELS[product.status].toLowerCase()} on the blockchain. When the
            commercial decision and the recorded stage disagree, a buyer reading the record sees the
            stage, not the price, so it is worth putting right. Writing the stage needs your wallet
            signature, because every other participant and every regulator reads it.
          </p>

          <div className="notice notice--info">
            <Icon name="info" size={18} />
            <div className="notice__body">
              <p className="notice__title">Where this batch stands</p>
              <p className="text-sm text-secondary">
                {product.retail.listed
                  ? stageIsOutOfStep
                    ? "It is listed commercially but the recorded stage has not been moved to listed for sale yet. Recording that closes the gap."
                    : "It is listed, and the recorded stage agrees."
                  : "It is not on offer. Recording the stage as at retailer reflects that it is sitting with you."}
              </p>
            </div>
          </div>

          {publicKey === null ? (
            <WalletRequiredState
              purpose="record the stage of this batch"
              isConnecting={connecting}
              {...(hasWallet && walletStatus !== "unavailable"
                ? {
                    onConnect: () => {
                      void connect().catch(() => undefined);
                    },
                  }
                : { noWalletDetected: true })}
            />
          ) : (
            <>
              <div className="cluster">
                <Button
                  variant="secondary"
                  onClick={action.run}
                  loading={action.phase === "preparing"}
                  loadingLabel="Building the transaction"
                  disabled={!canSell || !stageIsOutOfStep}
                >
                  <Icon name="link" size={16} />
                  {product.retail.listed
                    ? "Record the stage as listed for sale"
                    : "Record the stage as at retailer"}
                </Button>
                <p className="text-xs text-muted">
                  {!canSell
                    ? "Only the retailer holding this batch can record its stage."
                    : !stageIsOutOfStep
                      ? "The recorded stage already agrees with the listing, so there is nothing to write."
                      : "This writes to Solana and asks you to sign."}
                </p>
              </div>

              {action.phase !== "idle" ? (
                <TransactionState
                  phase={action.phase}
                  description={action.prepared?.description ?? null}
                  prepared={action.prepared}
                  signature={action.signature}
                  slot={action.slot}
                  error={action.error}
                  onPrepare={action.run}
                  onSign={action.sign}
                  onRetry={action.retry}
                  onCancel={action.cancel}
                  prepareLabel="Prepare the transaction"
                  signLabel="Sign in my wallet"
                  retryLabel="Prepare again"
                  cancelLabel="Not now"
                />
              ) : null}

              {action.phase === "failed" || action.phase === "timed-out" ? (
                <FailureState
                  error={action.error}
                  context="record the stage of this batch"
                  retryLabel="Try again"
                  onRetry={action.retry}
                />
              ) : null}
            </>
          )}

          <dl className="definition-list">
            <dt>Asking price as recorded</dt>
            <dd>
              {product.retail.askingPrice === null
                ? "No price recorded."
                : formatCurrency(product.retail.askingPrice, product.retail.currency)}
            </dd>

            <dt>Stage transaction</dt>
            <dd>
              <SignatureValue signature={product.onChainTxHash} />
            </dd>
          </dl>
        </div>
      </Panel>
    </div>
  );
}
