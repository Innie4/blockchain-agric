import type { Prepared } from "../../api/types";
import { ApiError, messageForError } from "../../api/errors";
import { explorerTxUrl } from "../../lib/solana";
import { truncateAddress } from "../../lib/format";
import type { ReactNode } from "react";
import { Button } from "../ui/Button";
import { Icon, type IconName } from "../ui/Icon";

/**
 * Where a blockchain action has got to.
 *
 * The server never holds a private key, so every write to the chain is two
 * requests: the server prepares an unsigned transaction, the participant signs
 * it, and the server submits it and waits for real confirmation. This type is
 * the shared vocabulary for that sequence, so every page tells the same story in
 * the same words.
 */
export type TransactionPhase =
  | "idle"
  | "preparing"
  | "awaiting-signature"
  | "signature-rejected"
  | "submitted"
  | "confirming"
  | "confirmed"
  | "failed"
  | "timed-out";

export interface TransactionStateProps {
  phase: TransactionPhase;
  /** What the transaction will do, usually `prepared.description`. */
  description?: string | null;
  /** The prepared transaction, when one exists. */
  prepared?: Prepared | null;
  /** The signature, once the wallet has signed. */
  signature?: string | null;
  /** The slot the transaction confirmed in. */
  slot?: number | null;
  /** The failure, for the phases that carry one. */
  error?: unknown;
  onPrepare?: () => void;
  onSign?: () => void;
  onRetry?: () => void;
  onCancel?: () => void;
  /** Anything to show once the action has succeeded, such as a link onwards. */
  children?: ReactNode;
  prepareLabel?: string;
  signLabel?: string;
  retryLabel?: string;
  cancelLabel?: string;
  className?: string;
}

const STEP_LABELS = [
  "The server builds the transaction",
  "You sign it in your wallet",
  "Solana confirms it",
] as const;

/**
 * Which step the participant is on, as a 1-based index into the three steps
 * above, or one past the last once every step is behind them.
 *
 * It is the index of the step currently under way, not a count of completed
 * steps: while the server is building the transaction, step one is the current
 * step and is announced as such, and once Solana has confirmed, the value is one
 * past the end so all three read as completed.
 */
const STEP_REACHED: Record<TransactionPhase, number> = {
  idle: 0,
  preparing: 1,
  "awaiting-signature": 2,
  "signature-rejected": 2,
  submitted: 3,
  confirming: 3,
  confirmed: 4,
  failed: 3,
  "timed-out": 3,
};

interface PhaseCopy {
  title: string;
  body: string;
  icon: IconName;
}

function copyFor(phase: TransactionPhase, isTimeout: boolean): PhaseCopy {
  switch (phase) {
    case "idle":
      return {
        title: "Ready to record this on the blockchain",
        body:
          "Preparing asks the server to build the transaction. You will then see it in your " +
          "wallet, where you decide whether to sign. Nothing is written until you sign.",
        icon: "package",
      };
    case "preparing":
      return {
        title: "Building the transaction",
        body:
          "The server is assembling the transaction against a live Solana block. This usually " +
          "takes a second or two.",
        icon: "refresh",
      };
    case "awaiting-signature":
      return {
        title: "Waiting for you to sign",
        body:
          "Open your wallet and approve the transaction. The transaction is only valid for a " +
          "short time, because Solana blockhashes expire. If it expires, prepare it again.",
        icon: "user",
      };
    case "signature-rejected":
      return {
        title: "You declined to sign",
        body:
          "Nothing was written to the blockchain and the record is unchanged. You can prepare " +
          "the same action again whenever you are ready.",
        icon: "alertTriangle",
      };
    case "submitted":
      return {
        title: "Sent to Solana",
        body:
          "The signed transaction has been submitted to the cluster and is waiting for a slot. " +
          "This finishes on its own.",
        icon: "externalLink",
      };
    case "confirming":
      return {
        title: "Waiting for the blockchain",
        body:
          "Solana is confirming the transaction. Once it does, the server re-reads the on-chain " +
          "account and only then marks the record as complete.",
        icon: "refresh",
      };
    case "confirmed":
      return {
        title: "Confirmed on Solana",
        body:
          "The record is on the blockchain and matches the details held here. The signature " +
          "below can be checked by anyone.",
        icon: "check",
      };
    case "failed":
      return {
        title: isTimeout
          ? "Confirmation took too long"
          : "The blockchain write did not complete",
        body: isTimeout
          ? "The transaction reached Solana but was not confirmed in time. It may still settle, " +
            "so open the record before trying again."
          : "Nothing was recorded. Read the detail below, then prepare the action again.",
        icon: "warning",
      };
    case "timed-out":
      return {
        title: "The prepared transaction expired",
        body:
          "Solana transactions are only valid for a short window. Nothing was recorded. Prepare " +
          "the action again to get a fresh one, and sign it straight away.",
        icon: "warning",
      };
  }
}

/**
 * The one component every blockchain write renders.
 *
 * It shows the three steps, says plainly which one is happening, and offers
 * exactly the action that moves the sequence forward. A declined signature is
 * treated as a normal outcome rather than an error, because it is one.
 */
export function TransactionState({
  phase,
  description,
  prepared,
  signature,
  slot,
  error,
  onPrepare,
  onSign,
  onRetry,
  onCancel,
  children,
  prepareLabel = "Prepare the transaction",
  signLabel = "Sign and submit",
  retryLabel = "Prepare again",
  cancelLabel = "Cancel",
  className,
}: TransactionStateProps) {
  const reached = STEP_REACHED[phase];
  const isTimeout =
    phase === "failed" &&
    error instanceof ApiError &&
    error.code === "BLOCKCHAIN_CONFIRMATION_TIMEOUT";
  const copy = copyFor(phase, isTimeout);
  const explorerUrl = explorerTxUrl(signature);

  const classes = ["transaction", `transaction--${phase}`, className]
    .filter((value): value is string => value !== null && value !== undefined)
    .join(" ");

  return (
    <div className={classes} role="status" aria-live="polite" aria-busy={isBusy(phase)}>
      <div className="transaction__header">
        <Icon
          name={copy.icon}
          size={20}
          className={
            phase === "confirmed"
              ? "text-success"
              : phase === "failed" || phase === "signature-rejected" || phase === "timed-out"
                ? "text-danger"
                : "text-info"
          }
        />
        <div className="transaction__status">
          <p className="transaction__title">{copy.title}</p>
          <p className="transaction__description">
            {description !== null && description !== undefined && description.length > 0
              ? `${description} `
              : null}
            {copy.body}
          </p>
        </div>
      </div>

      <ol className="transaction__steps">
        {STEP_LABELS.map((label, index) => {
          const step = index + 1;
          const state = step < reached ? "done" : step === reached ? "current" : "todo";
          return (
            <li className="transaction__step" key={label} data-state={state}>
              <span className="transaction__step-marker" aria-hidden="true">
                {state === "done" ? <Icon name="check" size={12} /> : step}
              </span>
              <span>
                <span className="visually-hidden">
                  {state === "done" ? "Completed: " : state === "current" ? "Now: " : "Not yet: "}
                </span>
                {label}
              </span>
            </li>
          );
        })}
      </ol>

      {error === undefined || error === null ? null : (
        <p className="transaction__detail">
          <span>{messageForError(error)}</span>
        </p>
      )}

      {prepared === null || prepared === undefined ? null : (
        <p className="transaction__detail">
          <span>
            Valid for about {prepared.validForSeconds} seconds · acting on{" "}
            {truncateAddress(prepared.targetAddress)} · block{" "}
            {prepared.lastValidBlockHeight}
          </span>
        </p>
      )}

      {signature === null || signature === undefined || signature.length === 0 ? null : (
        <p className="transaction__detail">
          <span>Transaction signature</span>
          <span className="hash">{signature}</span>
        </p>
      )}

      <div className="transaction__actions">{renderActions()}</div>

      {explorerUrl === null ? null : (
        <div className="transaction__links">
          <a href={explorerUrl} target="_blank" rel="noreferrer noopener">
            View this transaction on Solana Explorer
            <span className="visually-hidden">, opens in a new tab</span>
          </a>
          {slot === null || slot === undefined ? null : (
            <span className="text-secondary text-sm">Slot {slot}</span>
          )}
        </div>
      )}

      {children}
    </div>
  );

  function renderActions(): ReactNode {
    switch (phase) {
      case "idle":
        return (
          <Button
            variant="primary"
            disabled={onPrepare === undefined}
            onClick={onPrepare}
          >
            <Icon name="package" size={16} />
            {prepareLabel}
          </Button>
        );
      case "preparing":
        return (
          <Button variant="primary" loading loadingLabel="Building the transaction">
            Preparing
          </Button>
        );
      case "awaiting-signature":
        return (
          <>
            <Button
              variant="primary"
              disabled={onSign === undefined}
              onClick={onSign}
            >
              <Icon name="user" size={16} />
              {signLabel}
            </Button>
            {onCancel === undefined ? null : (
              <Button variant="quiet" onClick={onCancel}>
                {cancelLabel}
              </Button>
            )}
          </>
        );
      case "signature-rejected":
        return (
          <>
            <Button
              variant="primary"
              disabled={onPrepare === undefined}
              onClick={onPrepare}
            >
              <Icon name="refresh" size={16} />
              {retryLabel}
            </Button>
            {onCancel === undefined ? null : (
              <Button variant="quiet" onClick={onCancel}>
                {cancelLabel}
              </Button>
            )}
          </>
        );
      case "submitted":
      case "confirming":
        return (
          <Button variant="secondary" loading loadingLabel="Waiting for Solana to confirm">
            Confirming
          </Button>
        );
      case "confirmed":
        return null;
      case "failed":
      case "timed-out":
        return (
          <Button
            variant="primary"
            disabled={onRetry === undefined && onPrepare === undefined}
            onClick={onRetry ?? onPrepare}
          >
            <Icon name="refresh" size={16} />
            {retryLabel}
          </Button>
        );
    }
  }
}

function isBusy(phase: TransactionPhase): boolean | undefined {
  return phase === "preparing" || phase === "submitted" || phase === "confirming"
    ? true
    : undefined;
}
