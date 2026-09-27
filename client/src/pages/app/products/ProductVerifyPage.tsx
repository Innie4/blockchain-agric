import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { logVerification, verifyProduct } from "../../../api/endpoints";
import {
  VERIFICATION_RESULT_LABELS,
  type Verification,
  type VerificationResponse,
  type VerificationResult,
} from "../../../api/types";
import { PageHeader } from "../../../components/layout/PageHeader";
import { ErrorState, FailureState, LoadingState, NotFoundState } from "../../../components/states";
import { Badge, Button, Icon, Panel, type BadgeTone, type PanelTone } from "../../../components/ui/Index";
import { useToast } from "../../../context/ToastContext";
import { isNotFound, useProductId } from "../appData";
import { DatedTimeValue } from "../appUi";

/**
 * Checking a batch from inside the application.
 *
 * Two acts that are easily confused are kept apart here. Reading the result is a
 * comparison the server performs and returns; recording the check is a separate,
 * deliberate request that writes an audit entry naming this participant. The
 * page never records a check the reader did not ask for, because a regulator
 * reviewing who looked at what has to be able to trust the count.
 */

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly error: unknown }
  | { readonly phase: "ready"; readonly response: VerificationResponse };

type RecordState =
  | { readonly phase: "idle" }
  | { readonly phase: "recording" }
  | { readonly phase: "recorded"; readonly verificationId: string }
  | { readonly phase: "failed"; readonly message: string };

interface Banner {
  heading: string;
  summary: string;
  tone: PanelTone;
  badge: string;
  badgeTone: BadgeTone;
  icon: "check" | "alertTriangle" | "search" | "warning";
}

const BANNERS: Record<VerificationResult, Banner> = {
  VERIFIED: {
    heading: "This batch matches its blockchain record.",
    summary:
      "Every stored detail still produces the fingerprint that was anchored on the blockchain when the batch was registered. The record can be relied on as an account of this batch.",
    tone: "primary",
    badge: "Verified",
    badgeTone: "success",
    icon: "check",
  },
  MISMATCH: {
    heading: "This batch does not match its blockchain record.",
    summary:
      "The details held for this batch no longer produce the fingerprint anchored on the blockchain at registration. Something changed after the batch was recorded. Do not rely on the details, and report the batch to a regulator.",
    tone: "danger",
    badge: "Details do not match",
    badgeTone: "danger",
    icon: "alertTriangle",
  },
  NOT_FOUND: {
    heading: "No batch is registered under this identifier.",
    summary:
      "The blockchain holds no record for this identifier. Check it against the packaging, or search for the crop and farm instead.",
    tone: "default",
    badge: "No record found",
    badgeTone: "neutral",
    icon: "search",
  },
  INCOMPLETE: {
    heading: "This batch could not be checked right now.",
    summary:
      "Either the network could not be reached, or this batch has not finished being written to the blockchain. Nothing here should be treated as verified.",
    tone: "warning",
    badge: "Not yet fully registered",
    badgeTone: "warning",
    icon: "warning",
  },
};

function HashComparison({ verification }: { verification: Verification }) {
  const { onChain, stored, computed } = verification.dataHash;
  const rows: ReadonlyArray<{ label: string; detail: string; value: string | null }> = [
    {
      label: "On the blockchain",
      detail: "The fingerprint anchored when the batch was registered. It cannot be edited.",
      value: onChain,
    },
    {
      label: "Held in the records",
      detail: "The fingerprint of the details as they were saved at registration.",
      value: stored,
    },
    {
      label: "Recomputed now",
      detail: "The fingerprint the details produce when they are read again just now.",
      value: computed,
    },
  ];

  return (
    <Panel title="Why it does not match" tone="danger">
      <p className="measure text-sm text-secondary">
        These are the three values that were compared. You can read the difference yourself, without
        taking this page&rsquo;s conclusion on trust.
      </p>
      <dl className="definition-list">
        {rows.map((row) => (
          <FragmentRow key={row.label} label={row.label} detail={row.detail} value={row.value} />
        ))}
      </dl>
    </Panel>
  );
}

function FragmentRow({
  label,
  detail,
  value,
}: {
  label: string;
  detail: string;
  value: string | null;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {value === null || value.length === 0 ? (
          <span className="text-secondary">No value was returned.</span>
        ) : (
          <span className="hash" title={value} aria-label={`${label}: ${value}`}>
            {value}
          </span>
        )}
        <span className="table__secondary">{detail}</span>
      </dd>
    </>
  );
}

export default function ProductVerifyPage() {
  const productId = useProductId();
  const { push } = useToast();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [record, setRecord] = useState<RecordState>({ phase: "idle" });

  const load = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  useEffect(() => {
    if (productId === null) return;
    const controller = new AbortController();
    setState({ phase: "loading" });
    setRecord({ phase: "idle" });

    verifyProduct(productId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setState({ phase: "ready", response });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: "failed", error });
      });

    return () => controller.abort();
  }, [attempt, productId]);

  const recordThisCheck = useCallback(() => {
    if (productId === null) return;
    setRecord({ phase: "recording" });
    // How the check is attributed comes from the session, so the browser only
    // reports that this was an in-app check.
    void logVerification(productId, "direct")
      .then((result) => {
        setRecord({ phase: "recorded", verificationId: result.verificationId });
        push({
          tone: "success",
          title: "This check was recorded",
          message: "A regulator can now see that you checked this batch.",
        });
      })
      .catch((error: unknown) => {
        setRecord({ phase: "failed", message: messageOf(error) });
      });
  }, [productId, push]);

  if (productId === null) {
    return (
      <div className="page">
        <PageHeader title="Check a batch" description="No batch identifier was given in the address." />
        <NotFoundState
          title="No batch identifier was given"
          description="The address on this page did not include a batch identifier, so there is nothing to check."
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
      title={`Check batch ${productId}`}
      description="A comparison of the details held for this batch against the fingerprint anchored on the blockchain, run from your signed-in account."
      breadcrumbs={[
        { label: "Batches", to: "/app/products" },
        { label: productId, to: `/app/products/${encodeURIComponent(productId)}` },
        { label: "Check" },
      ]}
      actions={
        <div className="cluster cluster--tight">
          <Link
            className="btn btn--secondary"
            to={`/app/products/${encodeURIComponent(productId)}`}
          >
            <Icon name="package" size={16} />
            Batch details
          </Link>
          <Button variant="quiet" onClick={load}>
            <Icon name="refresh" size={16} />
            Check again
          </Button>
        </div>
      }
    />
  );

  if (state.phase === "loading") {
    return (
      <div className="page">
        {heading}
        <LoadingState label={`Comparing batch ${productId} with the blockchain record`} rows={5} />
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
            description="The registry holds no record under this identifier, so there is nothing to compare against the blockchain."
            action={
              <div className="cluster cluster--tight">
                <Link className="btn btn--primary" to="/app/products">
                  Go to the batch list
                </Link>
                <Link className="btn btn--secondary" to={`/verify/${encodeURIComponent(productId)}`}>
                  Use the public verification page
                </Link>
              </div>
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
          title={`Batch ${productId} could not be checked`}
          retryLabel="Check it again"
          onRetry={load}
        />
      </div>
    );
  }

  const { verification, product } = state.response;
  const banner = BANNERS[verification.result];
  const isMismatch = verification.result === "MISMATCH";

  return (
    <div className="page">
      {heading}

      <div role="alert">
        <Panel tone={banner.tone}>
          <div className="stack stack--tight">
            <div className="cluster cluster--tight">
              <Badge tone={banner.badgeTone} icon={banner.icon}>
                {banner.badge}
              </Badge>
              <span className="text-xs text-muted">
                Result {VERIFICATION_RESULT_LABELS[verification.result]} · reference{" "}
                <span className="hash">{verification.verificationId}</span>
              </span>
            </div>
            <h2>{banner.heading}</h2>
            <p className="measure text-secondary">{banner.summary}</p>
            {verification.explanation === banner.summary ? null : (
              <p className="measure text-secondary">{verification.explanation}</p>
            )}
            {isMismatch && verification.mismatch !== null ? (
              <p className="text-sm">
                <strong>Reason recorded: {verification.mismatch.reason}</strong>
                {verification.mismatch.field === undefined ? null : (
                  <span className="text-secondary">
                    {" "}
                    The field that differs is {verification.mismatch.field}.
                  </span>
                )}
              </p>
            ) : null}
          </div>
        </Panel>
      </div>

      {isMismatch ? <HashComparison verification={verification} /> : null}

      <Panel title="What was compared">
        <div className="stack">
          <dl className="definition-list">
            <dt>Checked at</dt>
            <dd>
              <DatedTimeValue value={verification.verifiedAt} />
              <span className="table__secondary">
                The comparison took {verification.durationMs} milliseconds.
              </span>
            </dd>

            <dt>Blockchain reached</dt>
            <dd>
              {verification.chainReachable
                ? "Yes. The cluster answered, so the anchored fingerprint could be read."
                : "No. The cluster could not be reached, so nothing on this page should be read as confirmed."}
            </dd>

            <dt>On-chain record present</dt>
            <dd>
              {verification.recordPresent
                ? "Yes. An account exists on the blockchain for this identifier."
                : "No. No account exists on the blockchain for this identifier, so the write either never completed or has not settled yet."}
            </dd>

            <dt>Checks recorded for this batch</dt>
            <dd>
              {product === null ? "Not returned" : product.verificationCount}
              <span className="table__secondary">
                {product === null
                  ? null
                  : product.lastVerificationResult === verification.result
                    ? "The result recorded before this one was the same."
                    : `The result recorded before this one was ${VERIFICATION_RESULT_LABELS[
                        product.lastVerificationResult
                      ].toLowerCase()}.`}
              </span>
            </dd>
          </dl>
        </div>
      </Panel>

      <Panel title="Record this check">
        <div className="stack">
          <p className="measure text-secondary">
            Reading a result and recording a check are two different acts. You have read one. This
            second button writes an entry in the registry naming your wallet, the time, and the
            result, so that a regulator reviewing this batch can see that a deliberate check was
            made and what it found. Nothing is written to the blockchain by recording a check.
          </p>

          <p className="text-sm text-secondary" aria-live="polite">
            {record.phase === "idle"
              ? "This check has not been recorded."
              : record.phase === "recording"
                ? "Recording this check."
                : record.phase === "recorded"
                  ? `Recorded. Reference ${record.verificationId}. It now appears in the batch's history.`
                  : `This check could not be recorded: ${record.message} The result above still stands, and nothing was changed.`}
          </p>

          <div className="cluster">
            <Button
              variant="primary"
              loading={record.phase === "recording"}
              loadingLabel="Recording that you checked this batch"
              disabled={record.phase === "recorded"}
              onClick={recordThisCheck}
            >
              <Icon name="clipboard" size={16} />
              {record.phase === "recorded" ? "This check is recorded" : "Record this check"}
            </Button>
            <Link
              className="btn btn--secondary"
              to={`/app/products/${encodeURIComponent(productId)}/history`}
            >
              <Icon name="flag" size={16} />
              Read the history
            </Link>
            <Link className="btn btn--quiet" to={`/verify/${encodeURIComponent(productId)}`}>
              <Icon name="externalLink" size={16} />
              The public verification page
            </Link>
          </div>

          {record.phase === "failed" ? (
            <FailureState
              error={new Error(record.message)}
              context="record that you checked this batch"
              retryLabel="Try recording it again"
              onRetry={recordThisCheck}
            />
          ) : null}
        </div>
      </Panel>

      <p className="measure text-xs text-muted">
        Nothing on this page is a guarantee about the produce itself. It is a report of what the
        record says and whether that record still matches the fingerprint anchored on the
        blockchain. Where the two disagree, the record is the thing in question.
      </p>
    </div>
  );
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "The registry did not accept the request.";
}
