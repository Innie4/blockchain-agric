import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  cancelProductRegistration,
  getHealth,
  registerProduct,
  submitProductRegistration,
} from "../../../api/endpoints";
import { fieldErrorFor } from "../../../api/errors";
import type { ProductRegistrationAccepted, ProductRegistrationConfirmed } from "../../../api/types";
import { PageHeader } from "../../../components/layout/PageHeader";
import { FailureState, TransactionState, WalletRequiredState } from "../../../components/states";
import {
  Button,
  Field,
  FileInput,
  Icon,
  NumberInput,
  Panel,
  QrCode,
  Select,
  TextArea,
  TextInput,
  DateInput,
} from "../../../components/ui/Index";
import { useAuth } from "../../../context/AuthContext";
import { useToast } from "../../../context/ToastContext";
import { useWalletState } from "../../../context/WalletContext";
import { formatQuantity, fromDateInputValue, todayInputValue } from "../../../lib/format";
import { verificationUrl } from "../../../lib/solana";
import { useChainAction } from "../useChainAction";
import { useCopyToClipboard } from "../appData";

/**
 * Registering a batch. A farmer's most important form, and the one place where
 * a mistake becomes permanent.
 *
 * Two things shape the design. First, everything is anchored: the details entered
 * here are hashed into a fingerprint that is written to Solana and cannot be
 * changed afterwards, so the form says what will be written. Second, registration
 * is two requests. The details are saved by the first, and nothing exists on the
 * blockchain until the participant signs and the second confirms, so the page
 * follows the participant through both and never leaves them guessing.
 */

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

/**
 * The units an agricultural batch is actually counted in. These are the words
 * used at a farm gate in Nigeria and across West Africa, not a generic list of
 * weights.
 */
const UNIT_OPTIONS = [
  { value: "kg", label: "Kilograms (kg)" },
  { value: "tonnes", label: "Tonnes" },
  { value: "bags", label: "Bags (typically 50 kg)" },
  { value: "crates", label: "Crates" },
  { value: "bunches", label: "Bunches" },
  { value: "pieces", label: "Pieces" },
] as const;

const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp";
const DOCUMENT_ACCEPT = "application/pdf";
const MAX_IMAGES = 6;
const MAX_DOCUMENTS = 3;
const FALLBACK_MAX_FILE_BYTES = 5 * 1024 * 1024;

const BATCH_ID_SHAPE =
  "An identifier looks like AGT-COCOA-2026-A1B2C3: the prefix AGT, a crop code of three to six characters, the year of harvest, then a six character batch code. Leave it blank and the server will suggest one.";

const BATCH_ID_PATTERN = /^AGT-[A-Z0-9]{3,6}-\d{4}-[A-Z0-9]{6}$/;

interface RegistrationForm {
  productId: string;
  cropType: string;
  quantity: string;
  unit: string;
  harvestDate: string;
  farmLocation: string;
  description: string;
  additionalNotes: string;
}

/** The shape of the payload, described for a reader who has never seen it. */
function payloadSummary(form: RegistrationForm): string {
  const quantity = Number.parseFloat(form.quantity);
  const parts = [
    `crop ${form.cropType.trim() || "not given"}`,
    Number.isFinite(quantity) ? formatQuantity(quantity, form.unit) : "quantity not given",
    `harvested ${form.harvestDate || "on a date not given"}`,
    `at ${form.farmLocation.trim() || "a location not given"}`,
  ];
  return parts.join(", ");
}

function emptyForm(): RegistrationForm {
  return {
    productId: "",
    cropType: "",
    quantity: "",
    unit: "kg",
    harvestDate: todayInputValue(),
    farmLocation: "",
    description: "",
    additionalNotes: "",
  };
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

type FormErrors = Partial<Record<keyof RegistrationForm, string>>;

function validate(form: RegistrationForm): FormErrors {
  const errors: FormErrors = {};

  const batchId = form.productId.trim().toUpperCase();
  if (batchId.length > 0 && !BATCH_ID_PATTERN.test(batchId)) {
    errors.productId =
      "That is not a batch identifier. Use the AGT-COCOA-2026-A1B2C3 form, or leave it blank and let the server suggest one.";
  }

  if (form.cropType.trim().length < 2) {
    errors.cropType = "Name the crop or product, for example cocoa, maize or cashew.";
  }

  const quantity = Number.parseFloat(form.quantity);
  if (form.quantity.trim().length === 0) {
    errors.quantity = "Enter how much of the batch there is.";
  } else if (!Number.isFinite(quantity) || quantity <= 0) {
    errors.quantity = "Enter a quantity greater than zero.";
  }

  if (form.unit.trim().length === 0) {
    errors.unit = "Choose the unit the batch is counted in.";
  }

  if (form.harvestDate.trim().length === 0) {
    errors.harvestDate = "Enter the date the batch was harvested.";
  } else if (Number.isNaN(new Date(form.harvestDate).getTime())) {
    errors.harvestDate = "Enter a valid harvest date.";
  } else if (form.harvestDate > todayInputValue()) {
    errors.harvestDate = "The harvest date cannot be in the future.";
  }

  if (form.farmLocation.trim().length < 3) {
    errors.farmLocation =
      "Describe where the batch was grown, for example the village, the local government area and the state.";
  }

  if (form.description.trim().length < 10) {
    errors.description =
      "Describe the batch in at least ten characters: the variety, how it was grown, and anything a buyer would want to know.";
  }

  return errors;
}

/* ------------------------------------------------------------------ *
 * What happens after it is confirmed
 * ------------------------------------------------------------------ */

function RegisteredPanel({
  confirmed,
  onRegisterAnother,
}: {
  confirmed: ProductRegistrationConfirmed;
  onRegisterAnother: () => void;
}) {
  const copy = useCopyToClipboard();
  const link = confirmed.verificationUrl.length > 0
    ? confirmed.verificationUrl
    : verificationUrl(confirmed.product.productId);

  return (
    <>
      <Panel tone="primary" title={`Batch ${confirmed.product.productId} is on the blockchain`}>
        <div className="stack">
          <p className="measure text-secondary">
            Solana has confirmed the registration and the server has read the on-chain account back
            to check it. The details you entered are now anchored: the fingerprint below was written
            to the blockchain and cannot be edited, corrected or removed by anybody, including an
            administrator.
          </p>
          <dl className="definition-list">
            <dt>Batch identifier</dt>
            <dd>
              <span className="hash">{confirmed.product.productId}</span>
            </dd>

            <dt>What was recorded</dt>
            <dd>{payloadSummaryFromProduct(confirmed.product)}</dd>

            <dt>Anchored fingerprint</dt>
            <dd>
              <span className="hash" title={confirmed.product.dataHash}>
                {confirmed.product.dataHash}
              </span>
            </dd>

            <dt>Transaction signature</dt>
            <dd>
              <span className="hash">{confirmed.signature}</span>
            </dd>

            <dt>Confirmed in slot</dt>
            <dd>{confirmed.slot}</dd>

            <dt>Registered on</dt>
            <dd>
              <span className="hash">
                {confirmed.product.onChainRegisteredAt ?? confirmed.product.updatedAt}
              </span>
            </dd>
          </dl>
        </div>
      </Panel>

      <Panel title="Share it with the people who buy from you">
        <div className="stack">
          <p className="measure text-secondary">
            Anyone who has this link can check the batch without an account, a wallet or an app. It
            is the same page a buyer would reach by scanning the code printed on the packaging.
          </p>
          <p className="cluster cluster--tight">
            <span className="hash">{link}</span>
            <Button variant="secondary" size="sm" onClick={() => { copy(link, "Verification link"); }}>
              <Icon name="clipboard" size={16} />
              Copy the link
            </Button>
          </p>
        </div>
      </Panel>

      <Panel title="The code to print">
        <QrCode
          productId={confirmed.product.productId}
          payload={confirmed.qrPayload.length > 0 ? confirmed.qrPayload : link}
          caption="Print this on the packaging or on a tag tied to the batch. Scanning it opens the public verification page for this batch."
        />
      </Panel>

      <Panel title="What to do next">
        <div className="stack">
          <p className="measure text-secondary">
            Three things are worth doing now, and only you can do them.
          </p>
          <ol className="transaction__steps">
            <li className="transaction__step" data-state="current">
              <span className="transaction__step-marker" aria-hidden="true">
                1
              </span>
              <span>
                <span className="visually-hidden">Step 1. </span>
                Share the verification link, or print the code above, so a buyer can check the batch
                themselves rather than taking your word for it.
              </span>
            </li>
            <li className="transaction__step">
              <span className="transaction__step-marker" aria-hidden="true">
                2
              </span>
              <span>
                <span className="visually-hidden">Step 2. </span>
                Open the batch to see the record, its history and the photographs and certificates
                you attached.
              </span>
            </li>
            <li className="transaction__step">
              <span className="transaction__step-marker" aria-hidden="true">
                3
              </span>
              <span>
                <span className="visually-hidden">Step 3. </span>
                When the batch is sold or handed to a processor, transfer it from the batch page. The
                buyer then becomes the recorded owner, and only their wallet can move it on.
              </span>
            </li>
          </ol>
          <div className="cluster">
            <Link
              className="btn btn--primary"
              to={`/app/products/${encodeURIComponent(confirmed.product.productId)}`}
            >
              <Icon name="package" size={16} />
              Open the batch
            </Link>
            <Link
              className="btn btn--secondary"
              to={`/verify/${encodeURIComponent(confirmed.product.productId)}`}
            >
              <Icon name="shield" size={16} />
              See the public verification page
            </Link>
            <Button variant="quiet" onClick={onRegisterAnother}>
              <Icon name="leaf" size={16} />
              Register another batch
            </Button>
          </div>
        </div>
      </Panel>
    </>
  );
}

function payloadSummaryFromProduct(product: {
  cropType: string;
  quantity: number;
  unit: string;
  harvestDate: string;
  farmLocation: string;
}): string {
  return payloadSummary({
    productId: "",
    cropType: product.cropType,
    quantity: String(product.quantity),
    unit: product.unit,
    harvestDate: product.harvestDate.slice(0, 10),
    farmLocation: product.farmLocation,
    description: "",
    additionalNotes: "",
  });
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function RegisterProductPage() {
  const { user } = useAuth();
  const { publicKey, status: walletStatus, hasWallet, connect, connecting } = useWalletState();
  const { push } = useToast();

  const [form, setForm] = useState<RegistrationForm>(emptyForm);
  const [errors, setErrors] = useState<FormErrors>({});
  const [images, setImages] = useState<readonly File[]>([]);
  const [documents, setDocuments] = useState<readonly File[]>([]);
  const [maxFileBytes, setMaxFileBytes] = useState<number>(FALLBACK_MAX_FILE_BYTES);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void getHealth(controller.signal)
      .then((health) => {
        if (controller.signal.aborted) return;
        const limit = health.runtime["uploadMaxFileBytes"];
        if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
          setMaxFileBytes(limit);
        }
      })
      .catch(() => {
        // The limit is only a courtesy here; the server enforces its own, and the
        // hint below already says what this build allows.
      });
    return () => controller.abort();
  }, []);

  const action = useChainAction<ProductRegistrationAccepted, ProductRegistrationConfirmed>({
    prepare: async () => {
      const body = new FormData();
      const batchId = form.productId.trim().toUpperCase();
      if (batchId.length > 0) body.append("productId", batchId);
      body.append("cropType", form.cropType.trim());
      body.append("quantity", form.quantity.trim());
      body.append("unit", form.unit);
      body.append(
        "harvestDate",
        fromDateInputValue(form.harvestDate) ?? new Date().toISOString(),
      );
      body.append("farmLocation", form.farmLocation.trim());
      body.append("description", form.description.trim());
      body.append("additionalNotes", form.additionalNotes.trim());
      for (const file of images) body.append("images", file);
      for (const file of documents) body.append("certificates", file);

      setIsSubmitting(true);
      try {
        const accepted = await registerProduct(body);
        return { prepared: accepted.prepared, record: accepted };
      } finally {
        setIsSubmitting(false);
      }
    },
    submit: async ({ signedTransaction, record }) =>
      submitProductRegistration(record.productId, signedTransaction),
    signatureOf: (result) => result.signature,
    slotOf: (result) => result.slot,
    onConfirmed: () => {
      push({
        tone: "success",
        title: "The batch is recorded on the blockchain",
        message: "Share the verification link so a buyer can check it themselves.",
      });
    },
    onAbandon: (record) => {
      if (record === null) return;
      void cancelProductRegistration(record.productId).catch(() => {
        // The draft is left behind only if the server cannot be told, and its
        // blockhash expires on its own a moment later.
      });
    },
  });

  function update<K extends keyof RegistrationForm>(key: K, value: RegistrationForm[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  }

  const prepare = useCallback(() => {
    const found = validate(form);
    setErrors(found);
    if (Object.values(found).some((message) => message !== undefined)) {
      push({
        tone: "warning",
        title: "The form still needs attention",
        message: "Correct the highlighted fields, then submit again.",
      });
      return;
    }
    action.run();
  }, [action, form, push]);

  const abandon = useCallback(() => {
    action.cancel();
    resetForm();
    push({
      tone: "info",
      title: "The draft registration was abandoned",
      message: "Nothing was written to the blockchain and the draft is no longer held.",
    });
  }, [action, push]);

  function resetForm(): void {
    setForm(emptyForm());
    setErrors({});
    setImages([]);
    setDocuments([]);
  }

  const isPreparing = action.phase === "preparing" || isSubmitting;
  const isSettled = action.phase !== "idle";
  const serverError = action.phase === "failed" ? action.error : null;

  if (action.phase === "confirmed" && action.confirmed !== null) {
    return (
      <div className="page">
        <PageHeader
          title="Batch registered"
          description="Confirmed on Solana. Here is what was written, and what to do with it."
        />
        <RegisteredPanel
          confirmed={action.confirmed}
          onRegisterAnother={() => {
            action.reset();
            resetForm();
          }}
        />
      </div>
    );
  }

  if (publicKey === null) {
    return (
      <div className="page">
        <PageHeader
          title="Register a batch"
          description="Recording a batch writes a fingerprint of its details to Solana, so it can only be done by the wallet that stands behind the batch."
        />
        <WalletRequiredState
          purpose="register a batch"
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
      <PageHeader
        title="Register a batch"
        description="Everything you enter here is hashed into a fingerprint and written to Solana when you sign. The record cannot be edited afterwards, so read each field before you sign."
        breadcrumbs={[
          { label: "Batches", to: "/app/products" },
          { label: "Register a batch" },
        ]}
        actions={
          <Link className="btn btn--secondary" to="/app/products">
            <Icon name="package" size={16} />
            Back to my batches
          </Link>
        }
      />

      <form
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          prepare();
        }}
        noValidate
        className="stack"
      >
        <Panel title="Which batch is this?">
          <div className="stack">
            <Field
              id="register-product-id"
              label="Batch identifier"
              optional
              error={errors["productId"] ?? fieldErrorFor(serverError, "productId")}
              hint={BATCH_ID_SHAPE}
            >
              <TextInput
                name="productId"
                value={form.productId}
                maxLength={32}
                autoComplete="off"
                spellCheck={false}
                placeholder="AGT-COCOA-2026-A1B2C3"
                onChange={(event) => {
                  update("productId", event.target.value.toUpperCase());
                }}
              />
            </Field>
            <p className="text-sm text-secondary">
              Leave this blank and the server will suggest an identifier from the crop and the year
              of harvest. If you do enter one, it is checked against the format above and against the
              batches already registered, because identifiers are permanent.
            </p>
          </div>
        </Panel>

        <Panel title="What is in the batch?">
          <div className="stack">
            <Field
              id="register-crop-type"
              label="Crop or product type"
              required
              error={errors["cropType"] ?? fieldErrorFor(serverError, "cropType")}
              hint="For example cocoa, maize, cashew, palm fruit, yam or vegetable rice."
            >
              <TextInput
                name="cropType"
                value={form.cropType}
                maxLength={120}
                autoComplete="off"
                onChange={(event) => { update("cropType", event.target.value); }}
              />
            </Field>

            <div className="grid grid--2">
              <Field
                id="register-quantity"
                label="Quantity"
                required
                error={errors["quantity"] ?? fieldErrorFor(serverError, "quantity")}
                hint="Count it the way you sell it."
              >
                <NumberInput
                  name="quantity"
                  value={form.quantity}
                  min={0}
                  step="any"
                  inputMode="decimal"
                  addon={
                    <span>{unitLabel(form.unit)}</span>
                  }
                  onChange={(event) => { update("quantity", event.target.value); }}
                />
              </Field>

              <Field
                id="register-unit"
                label="Unit"
                required
                error={errors["unit"] ?? fieldErrorFor(serverError, "unit")}
                hint="The unit the batch is counted in."
              >
                <Select
                  name="unit"
                  value={form.unit}
                  options={UNIT_OPTIONS}
                  onChange={(event) => { update("unit", event.target.value); }}
                />
              </Field>
            </div>

            <Field
              id="register-harvest-date"
              label="Harvest date"
              required
              error={errors["harvestDate"] ?? fieldErrorFor(serverError, "harvestDate")}
              hint="The day the batch came off the farm. This cannot be changed once anchored."
            >
              <DateInput
                name="harvestDate"
                value={form.harvestDate}
                max={todayInputValue()}
                onChange={(event) => { update("harvestDate", event.target.value); }}
              />
            </Field>

            <Field
              id="register-farm-location"
              label="Farm location"
              required
              error={errors["farmLocation"] ?? fieldErrorFor(serverError, "farmLocation")}
              hint="As precise as you are willing to publish: village, local government area and state. Precise coordinates are never published."
            >
              <TextInput
                name="farmLocation"
                value={form.farmLocation}
                maxLength={400}
                autoComplete="off"
                onChange={(event) => { update("farmLocation", event.target.value); }}
              />
            </Field>
          </div>
        </Panel>

        <Panel title="Describe the batch">
          <div className="stack">
            <Field
              id="register-description"
              label="Description"
              required
              error={errors["description"] ?? fieldErrorFor(serverError, "description")}
              hint="What a buyer needs to know: the variety, how it was grown, and anything unusual about this lot."
            >
              <TextArea
                name="description"
                value={form.description}
                rows={5}
                maxLength={4000}
                onChange={(event) => { update("description", event.target.value); }}
              />
            </Field>

            <Field
              id="register-notes"
              label="Additional notes"
              optional
              error={fieldErrorFor(serverError, "additionalNotes")}
              hint="Anything else worth keeping with the record, such as a harvest date agreed with a cooperative, or storage arrangements."
            >
              <TextArea
                name="additionalNotes"
                value={form.additionalNotes}
                rows={3}
                maxLength={4000}
                onChange={(event) => { update("additionalNotes", event.target.value); }}
              />
            </Field>
          </div>
        </Panel>

        <Panel title="Photographs and certificates">
          <div className="stack">
            <p className="measure text-secondary">
              Photographs and certificates are held off the blockchain. What is anchored is the
              fingerprint of the batch details above, and the SHA-256 of each file, so a file cannot
              be quietly swapped for a different one.
            </p>

            <FileInput
              id="register-images"
              label="Photographs of the batch"
              accept={IMAGE_ACCEPT}
              multiple
              files={images}
              onFilesChange={(files) => { setImages(files); }}
              maxFiles={MAX_IMAGES}
              maxSizeBytes={maxFileBytes}
              hint={`JPEG, PNG or WebP, up to ${Math.round(maxFileBytes / (1024 * 1024))} MB each, ${MAX_IMAGES} at a time. The file's own hash is recorded, so a photograph cannot later be replaced.`}
            />

            <FileInput
              id="register-certificates"
              label="Certificates"
              accept={DOCUMENT_ACCEPT}
              multiple
              files={documents}
              onFilesChange={(files) => { setDocuments(files); }}
              maxFiles={MAX_DOCUMENTS}
              maxSizeBytes={maxFileBytes}
              hint={`PDF only, up to ${Math.round(maxFileBytes / (1024 * 1024))} MB each, ${MAX_DOCUMENTS} at a time. Attach an organic, fairtrade or phytosanitary certificate if you hold one.`}
            />
          </div>
        </Panel>

        <Panel title="What will be written">
          <div className="stack">
            <p className="measure text-secondary">
              This is the payload the fingerprint is computed from. Read it as if it were permanent,
              because it is.
            </p>
            <p className="measure text-secondary">
              {payloadSummary(form)}
              {form.description.trim().length > 0 ? `: ${form.description.trim()}` : null}
            </p>
            <p className="text-sm text-secondary">
              Registered by {user === null ? "your wallet" : user.fullName || "your wallet"} as a{" "}
              {user === null ? "participant" : user.role.replace(/_/g, " ").toLowerCase()}. The
              batch is owned by your wallet from the moment it is confirmed, and only your wallet
              can transfer it on.
            </p>
            <div className="cluster">
              <Button
                type="submit"
                variant="primary"
                loading={isPreparing}
                loadingLabel="Saving your details and asking the server to build the transaction"
              >
                <Icon name="leaf" size={16} />
                Register this batch
              </Button>
              {isSettled ? (
                <Button variant="quiet" onClick={abandon}>
                  <Icon name="x" size={16} />
                  Abandon this draft
                </Button>
              ) : null}
              <Link className="btn btn--quiet" to="/app/products">
                Cancel and go back
              </Link>
            </div>
          </div>
        </Panel>
      </form>

      {isSettled ? (
        <div className="stack">
          <h2 className="page-header__title" id="registration-progress">
            Registering this batch
          </h2>
          <TransactionState
            phase={action.phase}
            description={action.prepared?.description ?? null}
            prepared={action.prepared}
            signature={action.signature}
            slot={action.slot}
            error={action.error}
            onPrepare={prepare}
            onSign={action.sign}
            onRetry={action.retry}
            onCancel={abandon}
            prepareLabel="Save my details and build the transaction"
            signLabel="Sign in my wallet"
            retryLabel="Prepare again"
            cancelLabel="Abandon this draft"
          >
            {action.phase === "signature-rejected" ? (
              <p className="text-sm text-secondary">
                You declined the signature, so nothing has been written and the record is unchanged.
                Preparing again is safe: the same batch identifier is reused, not a new one.
              </p>
            ) : null}

            {action.phase === "timed-out" ? (
              <p className="text-sm text-secondary">
                A prepared transaction is only valid for about {action.prepared?.validForSeconds ?? 0}{" "}
                seconds, because Solana blockhashes expire. Preparing again asks the server for a
                fresh one; nothing was written by the expired one.
              </p>
            ) : null}
          </TransactionState>
        </div>
      ) : null}

      {action.phase === "failed" ? (
        <FailureState
          error={action.error}
          context="register this batch on the blockchain"
          retryLabel="Prepare again"
          onRetry={action.retry}
          actions={
            <Button variant="secondary" onClick={abandon}>
              <Icon name="x" size={16} />
              Abandon the draft
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

/** The short form of a unit, for the field that shows the unit beside the number. */
function unitLabel(unit: string): string {
  if (unit.trim().length === 0) return "unit";
  return unit.replace(/s$/, "").toLowerCase();
}
