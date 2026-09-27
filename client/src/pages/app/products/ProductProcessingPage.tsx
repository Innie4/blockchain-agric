import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  createProcessingLog,
  getProduct,
  listProcessingLogs,
  submitProcessingLog,
} from "../../../api/endpoints";
import { fieldErrorFor } from "../../../api/errors";
import {
  STATUS_LABELS,
  type ProcessingLog,
  type ProcessingLogAccepted,
  type Product,
  type ProductStatus,
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
import { formatBytes, formatDateTime, truncateHash } from "../../../lib/format";
import { explorerTxUrl } from "../../../lib/solana";
import { isNotFound, nextProcessingStage, useProductId } from "../appData";
import { DatedTimeValue } from "../appUi";
import { useChainAction } from "../useChainAction";

/**
 * Recording what was done to a batch.
 *
 * Processing has two halves and the page is careful to separate them. The
 * narrative, the photographs and the documents stay off the blockchain; the stage
 * change, if there is one, is an on-chain instruction the processor signs. When
 * an entry does not move the batch, the server returns no transaction at all, and
 * this page says so rather than asking for a signature that means nothing.
 */

const MAX_IMAGES = 4;
const MAX_DOCUMENTS = 3;
const FALLBACK_MAX_FILE_BYTES = 5 * 1024 * 1024;

const ACTIVITY_OPTIONS = [
  { value: "SORTING", label: "Sorting and grading" },
  { value: "DRYING", label: "Drying" },
  { value: "FERMENTING", label: "Fermenting" },
  { value: "ROASTING", label: "Roasting" },
  { value: "MILLING", label: "Milling or grinding" },
  { value: "PACKING", label: "Packing and labelling" },
  { value: "QUALITY_CHECK", label: "Quality check" },
  { value: "OTHER", label: "Something else" },
] as const;

interface ProcessingForm {
  activity: string;
  activityDescription: string;
  occurredAt: string;
  newStatus: string;
}

interface EntryFiles {
  images: readonly File[];
  documents: readonly File[];
}

type FormErrors = Partial<Record<keyof ProcessingForm | "files", string>>;

function nowLocal(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}`;
}

/* ------------------------------------------------------------------ *
 * The entries already recorded
 * ------------------------------------------------------------------ */

function fileNames(files: readonly { fileName: string }[]): string {
  if (files.length === 0) return "None";
  return files.map((file) => file.fileName).join(", ");
}

const LOG_COLUMNS: readonly TableColumn<ProcessingLog>[] = [
  {
    key: "activity",
    header: "Activity",
    isRowHeader: true,
    render: (row) => (
      <span className="stack stack--tight">
        <span>{row.activity}</span>
        <span className="table__secondary">{row.processorName}</span>
      </span>
    ),
  },
  {
    key: "description",
    header: "What was done",
    render: (row) => <span className="measure">{row.activityDescription}</span>,
  },
  {
    key: "when",
    header: "When",
    render: (row) => <DatedTimeValue value={row.occurredAt} />,
  },
  {
    key: "stage",
    header: "Stage change",
    render: (row) => (
      <span className="stack stack--tight">
        <StatusBadge status={row.statusBefore} />
        <span className="table__secondary">then</span>
        <StatusBadge status={row.statusAfter} />
      </span>
    ),
  },
  {
    key: "chain",
    header: "Where it is recorded",
    render: (row) =>
      row.onChainTxHash === null ? (
        <Badge tone="neutral">Off the blockchain, with its own fingerprint</Badge>
      ) : (
        <span className="stack stack--tight">
          <Badge tone="success" icon="check">
            On the blockchain
          </Badge>
          {explorerTxUrl(row.onChainTxHash) === null ? null : (
            <a
              className="text-xs"
              href={explorerTxUrl(row.onChainTxHash) ?? "#"}
              target="_blank"
              rel="noreferrer noopener"
            >
              View the transaction
              <span className="visually-hidden">, opens in a new tab</span>
            </a>
          )}
        </span>
      ),
  },
  {
    key: "files",
    header: "Supporting files",
    render: (row) => (
      <span className="stack stack--tight text-xs text-secondary">
        <span>Images: {fileNames(row.supportingImages)}</span>
        <span>Documents: {fileNames(row.supportingDocuments)}</span>
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

export default function ProductProcessingPage() {
  const productId = useProductId();
  const { push } = useToast();
  const { publicKey, hasWallet, status: walletStatus, connect, connecting } = useWalletState();

  const [attempt, setAttempt] = useState(0);
  const [product, setProduct] = useState<Product | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [logs, setLogs] = useState<readonly ProcessingLog[]>([]);
  const [logsFailed, setLogsFailed] = useState(false);

  const [form, setForm] = useState<ProcessingForm>({
    activity: "SORTING",
    activityDescription: "",
    occurredAt: nowLocal(),
    newStatus: "",
  });
  const [files, setFiles] = useState<EntryFiles>({ images: [], documents: [] });
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

    listProcessingLogs(productId, controller.signal)
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

  const action = useChainAction<ProcessingLogAccepted, ProcessingLog>({
    prepare: async () => {
      if (productId === null) throw new Error("No batch was identified.");
      const body = new FormData();
      body.append("activity", form.activity);
      body.append("activityDescription", form.activityDescription.trim());
      body.append("occurredAt", new Date(form.occurredAt).toISOString());
      if (form.newStatus !== "") body.append("newStatus", form.newStatus);
      for (const file of files.images) body.append("images", file);
      for (const file of files.documents) body.append("documents", file);

      const accepted = await createProcessingLog(productId, body);
      return { prepared: accepted.prepared, record: accepted };
    },
    submit: async ({ signedTransaction, record }) => {
      if (productId === null) throw new Error("No batch was identified.");
      const confirmed = await submitProcessingLog(
        productId,
        record.log.logId,
        signedTransaction,
      );
      return confirmed;
    },
    signatureOf: (result) => result.onChainTxHash,
    onConfirmed: () => {
      setForm({ activity: "SORTING", activityDescription: "", occurredAt: nowLocal(), newStatus: "" });
      setFiles({ images: [], documents: [] });
      setErrors({});
      push({ tone: "success", title: "The processing entry was recorded" });
    },
  });

  function update<K extends keyof ProcessingForm>(key: K, value: ProcessingForm[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  }

  function submitForm(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const found: FormErrors = {};
    if (form.activityDescription.trim().length < 10) {
      found.activityDescription =
        "Describe what was done in at least ten characters, so the entry is meaningful a year from now.";
    }
    const when = new Date(form.occurredAt);
    if (Number.isNaN(when.getTime())) {
      found.occurredAt = "Enter the date and time the work was done.";
    } else if (when.getTime() > Date.now() + 60_000) {
      found.occurredAt = "The date and time cannot be in the future.";
    }
    setErrors(found);
    if (Object.values(found).some((message) => message !== undefined)) return;

    action.run();
  }

  if (productId === null) {
    return (
      <div className="page">
        <PageHeader title="Record processing" description="No batch identifier was given in the address." />
        <NotFoundState
          title="No batch identifier was given"
          description="The address on this page did not include a batch identifier, so there is no batch to record processing against."
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
      title="Record processing"
      description="What was done to this batch, by whom and when. The narrative stays in the records; a change of stage is written to the blockchain."
      breadcrumbs={[
        { label: "Batches", to: "/app/products" },
        { label: productId, to: `/app/products/${encodeURIComponent(productId)}` },
        { label: "Processing" },
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
            description="The registry holds no record under this identifier, so there is nothing to record processing against."
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

  const currentStage = product.status as ProductStatus;
  const following = nextProcessingStage(currentStage);
  const movesStage = form.newStatus !== "" && form.newStatus !== currentStage;

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
              <StatusBadge status={currentStage} showDescription />
            </dd>

            <dt>Next stage, if you finish</dt>
            <dd>
              {following === null ? (
                <span className="text-secondary">
                  There is no further processing stage from {STATUS_LABELS[currentStage].toLowerCase()}.
                  Entries can still be recorded against it, but they will not move it on.
                </span>
              ) : (
                <StatusBadge status={following} />
              )}
            </dd>
          </dl>
        </div>
      </Panel>

      <Panel
        title="Processing recorded against this batch"
        actions={
          <span className="text-xs text-muted">
            {logs.length} {logs.length === 1 ? "entry" : "entries"}
          </span>
        }
      >
        {logsFailed ? (
          <ErrorState
            title="The processing entries could not be read"
            retryLabel="Read them again"
            onRetry={reload}
          />
        ) : (
          <Table
            caption={`Processing recorded against batch ${product.productId}`}
            columns={LOG_COLUMNS}
            rows={logs}
            rowKey={(row) => row.logId}
            emptyState={
              <p className="text-sm text-secondary">
                No processing has been recorded against this batch yet. The first entry below will
                carry its own fingerprint, so it cannot be altered unnoticed.
              </p>
            }
          />
        )}
      </Panel>

      {publicKey === null ? (
        <WalletRequiredState
          purpose="record processing against this batch"
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
          <Panel title="Record a new processing entry">
            <form onSubmit={submitForm} noValidate className="stack">
              <Field
                id="processing-activity"
                label="Activity"
                required
                error={errors["activity"] ?? fieldErrorFor(action.error, "activity")}
                hint="Choose the closest activity. Something else is a valid answer."
              >
                <Select
                  name="activity"
                  value={form.activity}
                  options={ACTIVITY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                  onChange={(event) => { update("activity", event.target.value); }}
                />
              </Field>

              <Field
                id="processing-description"
                label="What was done"
                required
                error={errors["activityDescription"] ?? fieldErrorFor(action.error, "activityDescription")}
                hint="The account of the work itself: the method, the grade achieved, anything that went wrong."
              >
                <TextArea
                  name="activityDescription"
                  value={form.activityDescription}
                  rows={5}
                  maxLength={4000}
                  onChange={(event) => { update("activityDescription", event.target.value); }}
                />
              </Field>

              <Field
                id="processing-occurred-at"
                label="Date and time of the work"
                required
                error={errors["occurredAt"] ?? fieldErrorFor(action.error, "occurredAt")}
                hint="When it actually happened, which is not necessarily when you are recording it."
              >
                <TextInput
                  name="occurredAt"
                  type="datetime-local"
                  value={form.occurredAt}
                  onChange={(event) => { update("occurredAt", event.target.value); }}
                />
              </Field>

              <Field
                id="processing-new-status"
                label="Stage after this entry"
                optional
                error={fieldErrorFor(action.error, "newStatus")}
                hint={
                  following === null
                    ? "This batch cannot move to a further processing stage, so leave this blank and the entry will be recorded off the blockchain only."
                    : `Leave blank to record the entry without moving the batch, or choose a stage to move it. Choosing the stage it is already at records the entry off the blockchain only.`
                }
              >
                <Select
                  name="newStatus"
                  value={form.newStatus}
                  placeholder="Do not change the stage"
                  options={[
                    { value: "IN_PROCESSING", label: `In processing (${STATUS_LABELS.IN_PROCESSING})` },
                    { value: "PROCESSED", label: `Processed (${STATUS_LABELS.PROCESSED})` },
                  ]}
                  onChange={(event) => { update("newStatus", event.target.value); }}
                />
              </Field>

              <FileInput
                id="processing-images"
                label="Supporting images"
                accept="image/jpeg,image/png,image/webp"
                multiple
                files={files.images}
                onFilesChange={(chosen) => { setFiles((c) => ({ ...c, images: chosen })); }}
                maxFiles={MAX_IMAGES}
                maxSizeBytes={maxFileBytes}
                hint={`JPEG, PNG or WebP, up to ${formatBytes(maxFileBytes)} each, ${MAX_IMAGES} at a time.`}
              />

              <FileInput
                id="processing-documents"
                label="Supporting documents"
                accept="application/pdf"
                multiple
                files={files.documents}
                onFilesChange={(chosen) => { setFiles((c) => ({ ...c, documents: chosen })); }}
                maxFiles={MAX_DOCUMENTS}
                maxSizeBytes={maxFileBytes}
                hint={`PDF, up to ${formatBytes(maxFileBytes)} each, ${MAX_DOCUMENTS} at a time. Labelling sheets, moisture readings, weighbridge tickets.`}
              />

              <div className="cluster">
                <Button
                  type="submit"
                  variant="primary"
                  loading={action.phase === "preparing"}
                  loadingLabel="Saving the entry and, if the stage changes, building the transaction"
                >
                  <Icon name="clipboard" size={16} />
                  Record this entry
                </Button>
                <p className="text-xs text-muted">
                  {movesStage
                    ? "This entry moves the batch, so your wallet will be asked to sign."
                    : "This entry does not move the batch, so no signature will be requested."}
                </p>
              </div>
            </form>
          </Panel>

          {action.phase === "confirmed" && action.confirmed !== null ? (
            <Panel tone="primary" title="The entry was recorded">
              <div className="stack">
                <p className="measure text-secondary">
                  {action.isOffChainOnly
                    ? "The entry was recorded without a blockchain change. Nothing had to be signed, because the stage of the batch did not move. The entry carries its own fingerprint, so it cannot be altered unnoticed."
                    : "Solana confirmed the stage change and the server read the on-chain account back to check it."}
                </p>
                <p className="text-sm text-secondary">
                  {action.confirmed.activity} · {formatDateTime(action.confirmed.occurredAt)} ·{" "}
                  {STATUS_LABELS[action.confirmed.statusBefore]} to{" "}
                  {STATUS_LABELS[action.confirmed.statusAfter]}
                </p>
                <div className="cluster">
                  <Link
                    className="btn btn--secondary"
                    to={`/app/products/${encodeURIComponent(productId)}`}
                  >
                    <Icon name="package" size={16} />
                    Open the batch
                  </Link>
                  <Button variant="quiet" onClick={reload}>
                    <Icon name="refresh" size={16} />
                    Read the entries again
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
              cancelLabel="Discard this entry"
            >
              {action.isOffChainOnly ? (
                <p className="text-sm text-secondary">
                  No blockchain change is needed for this entry, so no signature is being asked for.
                  The server is being told to record it as it stands.
                </p>
              ) : null}
            </TransactionState>
          ) : null}

          {action.phase === "failed" || action.phase === "timed-out" ? (
            <FailureState
              error={action.error}
              context="record this processing entry"
              retryLabel="Try again"
              onRetry={action.retry}
            />
          ) : null}
        </>
      )}

      <Panel title="What is written where">
        <div className="measure stack text-sm text-secondary">
          <p>
            The narrative, the photographs and the documents are held in the records service. Each
            entry carries a SHA-256 of its own contents, printed in the table above, so a later
            change to what is stored would be detectable.
          </p>
          <p>
            The stage of the batch lives on the blockchain, because that is the fact a buyer, a
            processor or a regulator needs to be unable to dispute. Recording an entry that does not
            move the stage therefore needs no signature, and this page says so rather than asking
            for one.
          </p>
          <Badge tone="info" icon="info">
            Processing entries are made by the wallet that currently holds the batch
          </Badge>
        </div>
      </Panel>
    </div>
  );
}
