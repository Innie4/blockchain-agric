import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  createTransportLog,
  getProduct,
  listTransportLogs,
  submitTransportLog,
} from "../../../api/endpoints";
import { fieldErrorFor } from "../../../api/errors";
import {
  DELIVERY_STATUSES,
  DELIVERY_STATUS_LABELS,
  type DeliveryStatus,
  type Product,
  type TransportLog,
  type TransportLogAccepted,
} from "../../../api/types";
import { PageHeader } from "../../../components/layout/PageHeader";
import { ErrorState, FailureState, LoadingState, NotFoundState, TransactionState, WalletRequiredState } from "../../../components/states";
import {
  Badge,
  Button,
  Field,
  FileInput,
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
import { formatBytes, truncateHash } from "../../../lib/format";
import { explorerTxUrl } from "../../../lib/solana";
import { isNotFound, useProductId } from "../appData";
import { DatedTimeValue } from "../appUi";
import { useChainAction } from "../useChainAction";

/**
 * Recording a journey.
 *
 * What a transporter knows and can attest to: where the batch came from, where it
 * is going, the route, the vehicle, when it left and when it is due. Those are the
 * facts that can be entered honestly from a phone in a depot or at a farm gate.
 *
 * Automated capture of position, temperature or humidity is deliberately absent.
 * The system does not collect it, so offering a field for it would be asking a
 * transporter to type a number their tractor cannot produce.
 */

const MAX_DOCUMENTS = 3;
const FALLBACK_MAX_FILE_BYTES = 5 * 1024 * 1024;

interface TransportForm {
  origin: string;
  destination: string;
  routeDetails: string;
  vehicleDescription: string;
  departedAt: string;
  expectedArrivalAt: string;
  deliveryStatus: DeliveryStatus;
}

type FormErrors = Partial<Record<keyof TransportForm | "documents", string>>;

function nowLocal(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}`;
}

function blankForm(): TransportForm {
  return {
    origin: "",
    destination: "",
    routeDetails: "",
    vehicleDescription: "",
    departedAt: nowLocal(),
    expectedArrivalAt: "",
    deliveryStatus: "IN_TRANSIT",
  };
}

/* ------------------------------------------------------------------ *
 * The journeys already recorded
 * ------------------------------------------------------------------ */

const DELIVERY_TONES: Record<DeliveryStatus, "neutral" | "info" | "success" | "warning" | "danger"> = {
  SCHEDULED: "neutral",
  IN_TRANSIT: "info",
  DELIVERED: "success",
  DELAYED: "warning",
  CANCELLED: "danger",
};

const LOG_COLUMNS: readonly TableColumn<TransportLog>[] = [
  {
    key: "route",
    header: "Journey",
    isRowHeader: true,
    render: (row) => (
      <span className="stack stack--tight">
        <span>
          {row.origin} to {row.destination}
        </span>
        <span className="table__secondary">{row.transporterName}</span>
      </span>
    ),
  },
  {
    key: "details",
    header: "Route and vehicle",
    render: (row) => (
      <span className="stack stack--tight text-sm">
        <span>{row.routeDetails.length > 0 ? row.routeDetails : "No route details recorded"}</span>
        <span className="table__secondary">
          {row.vehicleDescription.length > 0 ? row.vehicleDescription : "No vehicle described"}
        </span>
      </span>
    ),
  },
  {
    key: "departed",
    header: "Departed",
    render: (row) => <DatedTimeValue value={row.departedAt} />,
  },
  {
    key: "arrival",
    header: "Arrival",
    render: (row) => (
      <span className="stack stack--tight">
        <span className="text-xs text-muted">
          Due <DatedTimeValue value={row.expectedArrivalAt} />
        </span>
        <span className="text-xs text-muted">
          Delivered <DatedTimeValue value={row.deliveredAt} />
        </span>
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    render: (row) => (
      <Badge tone={DELIVERY_TONES[row.deliveryStatus]} icon={row.deliveryStatus === "DELAYED" ? "warning" : undefined}>
        {DELIVERY_STATUS_LABELS[row.deliveryStatus]}
      </Badge>
    ),
  },
  {
    key: "chain",
    header: "Where it is recorded",
    render: (row) =>
      row.onChainTxHash === null ? (
        <Badge tone="neutral">Off the blockchain, with its own fingerprint</Badge>
      ) : (
        <a
          className="text-xs"
          href={explorerTxUrl(row.onChainTxHash) ?? "#"}
          target="_blank"
          rel="noreferrer noopener"
        >
          On the blockchain
          <span className="visually-hidden">, view the transaction, opens in a new tab</span>
        </a>
      ),
  },
  {
    key: "documents",
    header: "Supporting documents",
    render: (row) => (
      <span className="stack stack--tight text-xs text-secondary">
        <span>
          {row.supportingDocuments.length === 0
            ? "None"
            : row.supportingDocuments.map((file) => file.fileName).join(", ")}
        </span>
        <span className="hash" title={row.dataHash}>
          Fingerprint {truncateHash(row.dataHash)}
        </span>
      </span>
    ),
  },
];

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function ProductTransportPage() {
  const productId = useProductId();
  const { push } = useToast();
  const { publicKey, hasWallet, status: walletStatus, connect, connecting } = useWalletState();

  const [attempt, setAttempt] = useState(0);
  const [product, setProduct] = useState<Product | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [logs, setLogs] = useState<readonly TransportLog[]>([]);
  const [logsFailed, setLogsFailed] = useState(false);

  const [form, setForm] = useState<TransportForm>(blankForm);
  const [documents, setDocuments] = useState<readonly File[]>([]);
  const [errors, setErrors] = useState<FormErrors>({});
  const [maxFileBytes] = useState<number>(FALLBACK_MAX_FILE_BYTES);

  const reload = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  useEffect(() => {
    if (productId === null) return;
    const controller = new AbortController();
    setIsLoading(true);

    getProduct(productId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setProduct(response.product);
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

  useEffect(() => {
    if (productId === null) return;
    const controller = new AbortController();

    listTransportLogs(productId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setLogs(response.logs);
        setLogsFailed(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setLogsFailed(true);
      });

    return () => controller.abort();
  }, [attempt, productId]);

  const action = useChainAction<TransportLogAccepted, TransportLog>({
    prepare: async () => {
      if (productId === null) throw new Error("No batch was identified.");
      const body = new FormData();
      body.append("origin", form.origin.trim());
      body.append("destination", form.destination.trim());
      body.append("routeDetails", form.routeDetails.trim());
      body.append("vehicleDescription", form.vehicleDescription.trim());
      body.append("departedAt", new Date(form.departedAt).toISOString());
      if (form.expectedArrivalAt.trim().length > 0) {
        body.append("expectedArrivalAt", new Date(form.expectedArrivalAt).toISOString());
      }
      body.append("deliveryStatus", form.deliveryStatus);
      for (const file of documents) body.append("documents", file);

      const accepted = await createTransportLog(productId, body);
      return { prepared: accepted.prepared, record: accepted };
    },
    submit: async ({ signedTransaction, record }) => {
      if (productId === null) throw new Error("No batch was identified.");
      const confirmed = await submitTransportLog(productId, record.log.logId, signedTransaction);
      return confirmed;
    },
    signatureOf: (result) => result.onChainTxHash,
    onConfirmed: () => {
      setForm(blankForm());
      setDocuments([]);
      setErrors({});
      push({ tone: "success", title: "The journey was recorded" });
    },
  });

  function update<K extends keyof TransportForm>(key: K, value: TransportForm[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  }

  function submitForm(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const found: FormErrors = {};
    const origin = form.origin.trim();
    const destination = form.destination.trim();

    if (origin.length < 2) {
      found.origin = "Name where the batch left from, for example the farm gate or a depot.";
    }
    if (destination.length < 2) {
      found.destination = "Name where the batch is going, for example a processor's depot or a market.";
    } else if (destination.toLowerCase() === origin.toLowerCase()) {
      found.destination = "The destination has to be different from the origin.";
    }

    const departed = new Date(form.departedAt);
    if (Number.isNaN(departed.getTime())) {
      found.departedAt = "Enter the date and time the batch left.";
    } else if (departed.getTime() > Date.now() + 60_000) {
      found.departedAt = "The departure time cannot be in the future.";
    }

    if (form.expectedArrivalAt.trim().length > 0) {
      const arrival = new Date(form.expectedArrivalAt);
      if (Number.isNaN(arrival.getTime())) {
        found.expectedArrivalAt = "Enter a valid expected arrival, or leave it blank.";
      } else if (!Number.isNaN(departed.getTime()) && arrival.getTime() < departed.getTime()) {
        found.expectedArrivalAt = "The expected arrival cannot be before the departure.";
      }
    }

    if ((DELIVERY_STATUSES as readonly string[]).includes(form.deliveryStatus) === false) {
      found.deliveryStatus = "Choose the delivery status that describes this journey.";
    }

    setErrors(found);
    if (Object.values(found).some((message) => message !== undefined)) return;

    action.run();
  }

  if (productId === null) {
    return (
      <div className="page">
        <PageHeader title="Record a journey" description="No batch identifier was given in the address." />
        <NotFoundState
          title="No batch identifier was given"
          description="The address on this page did not include a batch identifier, so there is no batch to record a journey for."
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
      title="Record a journey"
      description="Where a batch travelled, when, and in what. The facts recorded here are the ones a transporter can attest to first hand."
      breadcrumbs={[
        { label: "Batches", to: "/app/products" },
        { label: productId, to: `/app/products/${encodeURIComponent(productId)}` },
        { label: "Transport" },
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

  if (loadError !== null || product === null) {
    if (isNotFound(loadError)) {
      return (
        <div className="page">
          {heading}
          <NotFoundState
            title={`No batch is registered as ${productId}`}
            description="The registry holds no record under this identifier, so there is nothing to record a journey for."
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

  return (
    <div className="page">
      {heading}

      <Panel title="Where this batch is now">
        <div className="stack">
          <dl className="definition-list">
            <dt>Batch</dt>
            <dd>
              <span className="hash">{product.productId}</span>
            </dd>

            <dt>Current stage</dt>
            <dd>
              <StatusBadge status={product.status} showDescription />
              <span className="table__secondary">
                Recording a journey normally moves the batch into transit, which is written to the
                blockchain and signed by your wallet.
              </span>
            </dd>
          </dl>
        </div>
      </Panel>

      <Panel
        title="Journeys recorded against this batch"
        actions={
          <span className="text-xs text-muted">
            {logs.length} {logs.length === 1 ? "journey" : "journeys"}
          </span>
        }
      >
        {logsFailed ? (
          <ErrorState
            title="The journeys could not be read"
            retryLabel="Read them again"
            onRetry={reload}
          />
        ) : (
          <Table
            caption={`Journeys recorded against batch ${product.productId}`}
            columns={LOG_COLUMNS}
            rows={logs}
            rowKey={(row) => row.logId}
            emptyState={
              <p className="text-sm text-secondary">
                No journey has been recorded against this batch yet.
              </p>
            }
          />
        )}
      </Panel>

      {publicKey === null ? (
        <WalletRequiredState
          purpose="record a journey for this batch"
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
          <Panel title="Record a journey">
            <form onSubmit={submitForm} noValidate className="stack">
              <div className="grid grid--2">
                <Field
                  id="transport-origin"
                  label="Origin"
                  required
                  error={errors["origin"] ?? fieldErrorFor(action.error, "origin")}
                  hint="Where the batch left from."
                >
                  <TextInput
                    name="origin"
                    value={form.origin}
                    maxLength={300}
                    autoComplete="off"
                    placeholder="Ado-Ekiti farm gate"
                    onChange={(event) => { update("origin", event.target.value); }}
                  />
                </Field>

                <Field
                  id="transport-destination"
                  label="Destination"
                  required
                  error={errors["destination"] ?? fieldErrorFor(action.error, "destination")}
                  hint="Where the batch is going. It has to be different from the origin."
                >
                  <TextInput
                    name="destination"
                    value={form.destination}
                    maxLength={300}
                    autoComplete="off"
                    placeholder="Ibadan processing depot"
                    onChange={(event) => { update("destination", event.target.value); }}
                  />
                </Field>
              </div>

              <Field
                id="transport-route"
                label="Route details"
                optional
                error={errors["routeDetails"] ?? fieldErrorFor(action.error, "routeDetails")}
                hint="The roads taken, the stops made, anything that affected the journey."
              >
                <TextArea
                  name="routeDetails"
                  value={form.routeDetails}
                  rows={3}
                  maxLength={4000}
                  onChange={(event) => { update("routeDetails", event.target.value); }}
                />
              </Field>

              <Field
                id="transport-vehicle"
                label="Vehicle"
                optional
                error={errors["vehicleDescription"] ?? fieldErrorFor(action.error, "vehicleDescription")}
                hint="What carried the batch: a truck and its capacity, a motorcycle, a trailer."
              >
                <TextInput
                  name="vehicleDescription"
                  value={form.vehicleDescription}
                  maxLength={300}
                  autoComplete="off"
                  placeholder="Three tonne truck, ABJ registration"
                  onChange={(event) => { update("vehicleDescription", event.target.value); }}
                />
              </Field>

              <div className="grid grid--2">
                <Field
                  id="transport-departed-at"
                  label="Departure"
                  required
                  error={errors["departedAt"] ?? fieldErrorFor(action.error, "departedAt")}
                  hint="When the batch actually left."
                >
                  <TextInput
                    name="departedAt"
                    type="datetime-local"
                    value={form.departedAt}
                    onChange={(event) => { update("departedAt", event.target.value); }}
                  />
                </Field>

                <Field
                  id="transport-expected-arrival"
                  label="Expected arrival"
                  optional
                  error={errors["expectedArrivalAt"] ?? fieldErrorFor(action.error, "expectedArrivalAt")}
                  hint="When you expect to arrive. It cannot be before the departure."
                >
                  <TextInput
                    name="expectedArrivalAt"
                    type="datetime-local"
                    value={form.expectedArrivalAt}
                    onChange={(event) => { update("expectedArrivalAt", event.target.value); }}
                  />
                </Field>
              </div>

              <Field
                id="transport-delivery-status"
                label="Delivery status"
                required
                error={errors["deliveryStatus"] ?? fieldErrorFor(action.error, "deliveryStatus")}
                hint="What is true of this journey at the moment you are recording it."
              >
                <Select
                  name="deliveryStatus"
                  value={form.deliveryStatus}
                  options={DELIVERY_STATUSES.map((status) => ({
                    value: status,
                    label: DELIVERY_STATUS_LABELS[status],
                  }))}
                  onChange={(event) => { update("deliveryStatus", event.target.value as DeliveryStatus); }}
                />
              </Field>

              <FileInput
                id="transport-documents"
                label="Supporting documents"
                accept="application/pdf"
                multiple
                files={documents}
                onFilesChange={setDocuments}
                maxFiles={MAX_DOCUMENTS}
                maxSizeBytes={maxFileBytes}
                hint={`PDF, up to ${formatBytes(maxFileBytes)} each, ${MAX_DOCUMENTS} at a time. A waybill, a weighbridge ticket, a loading photograph.`}
              />

              <div className="cluster">
                <Button
                  type="submit"
                  variant="primary"
                  loading={action.phase === "preparing"}
                  loadingLabel="Saving the journey and building the transaction"
                >
                  <Icon name="truck" size={16} />
                  Record this journey
                </Button>
                <p className="text-xs text-muted">
                  Recording a journey usually moves the batch, so your wallet will be asked to sign.
                </p>
              </div>
            </form>
          </Panel>

          {action.phase === "confirmed" && action.confirmed !== null ? (
            <Panel tone="primary" title="The journey was recorded">
              <div className="stack">
                <p className="measure text-secondary">
                  {action.isOffChainOnly
                    ? "The journey was recorded without a blockchain change, because the batch was already in the stage this entry describes."
                    : "Solana confirmed the movement and the server read the on-chain account back to check it."}
                </p>
                <p className="text-sm text-secondary">
                  {action.confirmed.origin} to {action.confirmed.destination} ·{" "}
                  {DELIVERY_STATUS_LABELS[action.confirmed.deliveryStatus]}
                </p>
                <div className="cluster">
                  <Link className="btn btn--secondary" to={`/app/products/${encodeURIComponent(productId)}`}>
                    <Icon name="package" size={16} />
                    Open the batch
                  </Link>
                  <Button variant="quiet" onClick={reload}>
                    <Icon name="refresh" size={16} />
                    Read the journeys again
                  </Button>
                </div>
              </div>
            </Panel>
          ) : null}

          {action.phase !== "idle" && action.phase !== "confirmed" ? (
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
              prepareLabel="Prepare the transaction"
              signLabel="Sign in my wallet"
              retryLabel="Prepare again"
              cancelLabel="Discard this journey"
            />
          ) : null}

          {action.phase === "failed" || action.phase === "timed-out" ? (
            <FailureState
              error={action.error}
              context="record this journey"
              retryLabel="Try again"
              onRetry={action.retry}
            />
          ) : null}
        </>
      )}

      <Panel title="What this records, and what it does not">
        <div className="measure stack text-sm text-secondary">
          <p>
            A journey records where a batch came from, where it is going, the route, the vehicle, the
            departure, the expected arrival and how the delivery stands. Each entry carries a SHA-256
            of its own contents, and a movement of the batch is written to the blockchain.
          </p>
          <p>
            This page does not record position, temperature, humidity or any other sensor reading.
            The system does not collect them, and asking for a number a vehicle cannot produce would
            put a figure in the record that nobody measured. Those readings would need equipment
            that reads and signs for itself, which is not part of this system.
          </p>
        </div>
      </Panel>
    </div>
  );
}
