import { useCallback, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { createComplianceReport } from "../../../api/endpoints";
import { fieldErrorFor } from "../../../api/errors";
import {
  PRODUCT_STATUSES,
  STATUS_LABELS,
  VERIFICATION_RESULTS,
  VERIFICATION_RESULT_LABELS,
  type ProductStatus,
  type ReportFilterInput,
  type VerificationResult,
} from "../../../api/types";
import { PageHeader } from "../../../components/layout/PageHeader";
import { FailureState } from "../../../components/states";
import {
  Button,
  Field,
  Icon,
  Panel,
  TextArea,
  TextInput,
  DateInput,
} from "../../../components/ui/Index";
import { useToast } from "../../../context/ToastContext";
import { todayInputValue, fromDateInputValue } from "../../../lib/format";

/**
 * Building a report.
 *
 * A report is a copy of the registry, filtered. That makes the criteria the most
 * important part of the form: a reader has to be able to see what was asked for,
 * and a regulator has to be able to see that nothing was quietly widened or
 * narrowed after the fact. Every filter is optional, and leaving them all blank
 * means the whole registry.
 */

interface ReportForm {
  title: string;
  dateFrom: string;
  dateTo: string;
  cropTypes: string;
  statuses: ProductStatus[];
  participants: string;
  verificationResults: VerificationResult[];
  productIds: string;
}

type FormErrors = Partial<Record<keyof ReportForm, string>>;

function emptyForm(): ReportForm {
  return {
    title: "",
    dateFrom: "",
    dateTo: "",
    cropTypes: "",
    statuses: [],
    participants: "",
    verificationResults: [],
    productIds: "",
  };
}

/** Splits a comma or newline separated list into trimmed, non-empty entries. */
function splitList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function validate(form: ReportForm): FormErrors {
  const errors: FormErrors = {};

  if (form.title.trim().length < 3) {
    errors.title = "Give the report a title a reader will recognise in a list, in at least three characters.";
  }
  if (form.dateFrom.trim().length > 0 && form.dateTo.trim().length > 0) {
    if (form.dateFrom > form.dateTo) {
      errors.dateTo = "The end of the range has to be on or after the start of it.";
    }
  }
  if (splitList(form.productIds).length > 200) {
    errors.productIds = "Two hundred specific batches is the most that can be listed. Narrow the report by crop or stage instead.";
  }
  if (splitList(form.participants).length > 200) {
    errors.participants = "Two hundred participants is the most that can be listed. Narrow the report by crop or stage instead.";
  }

  return errors;
}
/* ------------------------------------------------------------------ *
 * A group of checkboxes
 * ------------------------------------------------------------------ */

function ChoiceGroup<T extends string>({
  legend,
  hint,
  name,
  options,
  selected,
  onToggle,
  error,
}: {
  legend: string;
  hint: string;
  name: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  selected: readonly T[];
  onToggle: (value: T) => void;
  error?: string;
}) {
  return (
    <div className="field" role="group" aria-labelledby={`${name}-legend`}>
      <span className="field__label" id={`${name}-legend`}>
        {legend}
        <span className="field__optional">(optional)</span>
      </span>
      <div className="stack stack--tight">
        {options.map((option) => {
          const id = `${name}-${option.value}`;
          return (
            <label className="checkbox-row" key={option.value} htmlFor={id}>
              <input
                id={id}
                name={name}
                type="checkbox"
                checked={selected.includes(option.value)}
                aria-invalid={error === undefined ? undefined : true}
                onChange={() => { onToggle(option.value); }}
              />
              <span>{option.label}</span>
            </label>
          );
        })}
      </div>
      <p className="field__hint">{hint}</p>
      {error === undefined ? null : (
        <p className="field__error" id={`${name}-error`}>
          <Icon name="alertTriangle" size={14} />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function NewReportPage() {
  const navigate = useNavigate();
  const { push } = useToast();
  const [form, setForm] = useState<ReportForm>(emptyForm);
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  const update = useCallback(
    <K extends keyof ReportForm>(key: K, value: ReportForm[K]) => {
      setForm((current) => ({ ...current, [key]: value }));
      setErrors((current) => ({ ...current, [key]: undefined }));
    },
    [],
  );

  const toggleStatus = useCallback((status: ProductStatus) => {
    setForm((current) => ({
      ...current,
      statuses: current.statuses.includes(status)
        ? current.statuses.filter((entry) => entry !== status)
        : [...current.statuses, status],
    }));
  }, []);

  const toggleResult = useCallback((result: VerificationResult) => {
    setForm((current) => ({
      ...current,
      verificationResults: current.verificationResults.includes(result)
        ? current.verificationResults.filter((entry) => entry !== result)
        : [...current.verificationResults, result],
    }));
  }, []);

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const found = validate(form);
      setErrors(found);
      if (Object.values(found).some((message) => message !== undefined)) return;

      const dateFrom = fromDateInputValue(form.dateFrom);
      const dateTo = form.dateTo.trim().length === 0 ? undefined : fromDateInputValue(form.dateTo);

      const input: ReportFilterInput = {
        title: form.title.trim(),
        ...(dateFrom === undefined ? {} : { dateFrom }),
        ...(dateTo === undefined ? {} : { dateTo }),
        ...(form.cropTypes.trim().length === 0
          ? {}
          : { cropTypes: splitList(form.cropTypes) }),
        ...(form.statuses.length === 0 ? {} : { statuses: form.statuses }),
        ...(form.participants.trim().length === 0
          ? {}
          : { participants: splitList(form.participants) }),
        ...(form.verificationResults.length === 0
          ? {}
          : { verificationResults: form.verificationResults }),
        ...(form.productIds.trim().length === 0
          ? {}
          : { productIds: splitList(form.productIds) }),
      };

      setIsSubmitting(true);
      setFailure(null);
      void createComplianceReport(input)
        .then((result) => {
          push({
            tone: "success",
            title: "The report is ready",
            message: `${result.title} covers ${result.summary.productCount} batches.`,
          });
          navigate(`/app/compliance/reports/${encodeURIComponent(result.reportId)}`);
        })
        .catch((error: unknown) => {
          setFailure(error);
          setErrors({
            title: fieldErrorFor(error, "title"),
            dateFrom: fieldErrorFor(error, "dateFrom"),
            dateTo: fieldErrorFor(error, "dateTo"),
            cropTypes: fieldErrorFor(error, "cropTypes"),
            statuses: fieldErrorFor(error, "statuses"),
            participants: fieldErrorFor(error, "participants"),
            verificationResults: fieldErrorFor(error, "verificationResults"),
          });
          setIsSubmitting(false);
        });
    },
    [form, navigate, push],
  );

  const everything =
    form.dateFrom.trim().length === 0 &&
    form.dateTo.trim().length === 0 &&
    form.cropTypes.trim().length === 0 &&
    form.statuses.length === 0 &&
    form.participants.trim().length === 0 &&
    form.verificationResults.length === 0 &&
    form.productIds.trim().length === 0;

  return (
    <div className="page">
      <PageHeader
        title="Generate a report"
        description="A report is a copy of the registry taken now, narrowed by the criteria you choose. Every figure on it comes from the stored records."
        breadcrumbs={[
          { label: "Reports", to: "/app/compliance/reports" },
          { label: "Generate a report" },
        ]}
        actions={
          <Button variant="quiet" onClick={() => { setForm(emptyForm()); setErrors({}); setFailure(null); }}>
            <Icon name="x" size={16} />
            Start again
          </Button>
        }
      />

      <Panel title="What the report will contain">
        <p className="measure text-secondary">
          The batches in the registry that match what you ask for, with each one&rsquo;s stage,
          current owner, number of verifications, number of mismatches and number of transfers, and
          the fingerprint that was anchored when it was registered. The criteria you apply are
          printed on the report, so a reader can see what was and was not included.
        </p>
      </Panel>

      <form onSubmit={submit} noValidate className="stack">
        <Panel title="Name it">
          <Field
            id="report-title"
            label="Report title"
            required
            error={errors["title"]}
            hint="For example: cocoa batches registered in Ondo State, March 2026."
          >
            <TextInput
              name="title"
              value={form.title}
              maxLength={200}
              autoComplete="off"
              onChange={(event) => { update("title", event.target.value); }}
            />
          </Field>
        </Panel>

        <Panel title="When the batches were registered">
          <div className="stack">
            <p className="measure text-secondary">
              A range of registration dates. Leave both blank to include every batch regardless of
              when it was registered.
            </p>
            <div className="grid grid--2">
              <Field
                id="report-date-from"
                label="Registered from"
                optional
                error={errors["dateFrom"] ?? fieldErrorFor(failure, "dateFrom")}
              >
                <DateInput
                  name="dateFrom"
                  value={form.dateFrom}
                  max={todayInputValue()}
                  onChange={(event) => { update("dateFrom", event.target.value); }}
                />
              </Field>
              <Field
                id="report-date-to"
                label="Registered up to"
                optional
                error={errors["dateTo"] ?? fieldErrorFor(failure, "dateTo")}
              >
                <DateInput
                  name="dateTo"
                  value={form.dateTo}
                  max={todayInputValue()}
                  onChange={(event) => { update("dateTo", event.target.value); }}
                />
              </Field>
            </div>
          </div>
        </Panel>

        <Panel title="Narrow it down">
          <div className="stack">
            <ChoiceGroup
              name="report-statuses"
              legend="Stages"
              hint="Tick every stage to include. Ticking none includes all of them."
              options={PRODUCT_STATUSES.map((status) => ({
                value: status,
                label: STATUS_LABELS[status],
              }))}
              selected={form.statuses}
              onToggle={toggleStatus}
              {...(errors["statuses"] === undefined ? {} : { error: errors["statuses"] })}
            />

            <ChoiceGroup
              name="report-results"
              legend="Verification results"
              hint="Include only batches whose last check gave the result ticked here."
              options={VERIFICATION_RESULTS.map((result) => ({
                value: result,
                label: VERIFICATION_RESULT_LABELS[result],
              }))}
              selected={form.verificationResults}
              onToggle={toggleResult}
              {...(errors["verificationResults"] === undefined
                ? {}
                : { error: errors["verificationResults"] })}
            />

            <Field
              id="report-crop-types"
              label="Crop types"
              optional
              error={errors["cropTypes"] ?? fieldErrorFor(failure, "cropTypes")}
              hint="Separate each with a comma, or put one on each line. For example: cocoa, cashew."
            >
              <TextArea
                name="cropTypes"
                value={form.cropTypes}
                rows={3}
                maxLength={2000}
                placeholder="cocoa, cashew"
                onChange={(event) => { update("cropTypes", event.target.value); }}
              />
            </Field>

            <Field
              id="report-participants"
              label="Participants"
              optional
              error={errors["participants"] ?? fieldErrorFor(failure, "participants")}
              hint="Wallet addresses, separated by commas or newlines. Use this to see only the batches held by, or registered by, particular businesses."
            >
              <TextArea
                name="participants"
                value={form.participants}
                rows={3}
                maxLength={8000}
                spellCheck={false}
                onChange={(event) => { update("participants", event.target.value); }}
              />
            </Field>

            <Field
              id="report-product-ids"
              label="Specific batches"
              optional
              error={errors["productIds"] ?? fieldErrorFor(failure, "productIds")}
              hint="Batch identifiers, separated by commas or new lines, for example AGT-COCOA-2026-A1B2C3."
            >
              <TextArea
                name="productIds"
                value={form.productIds}
                rows={3}
                maxLength={6400}
                spellCheck={false}
                onChange={(event) => { update("productIds", event.target.value); }}
              />
            </Field>
          </div>
        </Panel>

        <Panel title="Generate">
          <div className="stack">
            <p className="measure text-secondary" aria-live="polite">
              {everything
                ? "No filter has been set, so the report will cover every batch in the registry. That is a legitimate report, but a wide one: check that it is what you want before generating it."
                : "The report will cover only the batches that match the criteria above. The criteria are recorded on the report itself."}
            </p>
            <div className="cluster">
              <Button
                type="submit"
                variant="primary"
                loading={isSubmitting}
                loadingLabel="Reading the registry and building the report"
              >
                <Icon name="fileText" size={16} />
                Generate the report
              </Button>
              <Button variant="quiet" disabled={isSubmitting} onClick={() => { setForm(emptyForm()); setErrors({}); }}>
                Clear the criteria
              </Button>
            </div>
          </div>
        </Panel>
      </form>

      {failure !== null && !isSubmitting ? (
        <FailureState
          error={failure}
          context="generate this report"
          retryLabel="Read the criteria again"
          onRetry={() => { setFailure(null); }}
          actions={
            <Button
              variant="secondary"
              onClick={() => {
                setForm(emptyForm());
                setErrors({});
                setFailure(null);
              }}
            >
              <Icon name="x" size={16} />
              Start again
            </Button>
          }
        />
      ) : null}

      <p className="measure text-xs text-muted">
        A report is a snapshot and is not refreshed. If the figures you need have moved on, come back
        and generate a new one.
      </p>
    </div>
  );
}
