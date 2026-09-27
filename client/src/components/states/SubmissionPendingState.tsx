import type { ReactNode } from "react";
import { explorerTxUrl } from "../../lib/solana";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";

export interface SubmissionPendingStateProps {
  /** The transaction signature, once the wallet has signed and it was sent. */
  signature?: string | null;
  /** What is being recorded, in the participant's terms. */
  description?: string | null;
  children?: ReactNode;
}

/**
 * The interval between "signed" and "confirmed". Solana is not instant, so this
 * state exists rather than leaving a button spinning with no explanation. The
 * signature is offered as soon as there is one, because a reader can check it
 * on the explorer while the wait continues.
 */
export function SubmissionPendingState({
  signature,
  description,
  children,
}: SubmissionPendingStateProps) {
  const explorerUrl = explorerTxUrl(signature);

  return (
    <div className="transaction transaction--confirming" role="status" aria-live="polite">
      <div className="transaction__header">
        <Icon name="refresh" size={20} className="text-info" />
        <div className="transaction__status">
          <p className="transaction__title">Waiting for the blockchain</p>
          <p className="transaction__description">
            {description ?? "The transaction has been sent to Solana."} Solana confirms
            transactions in blocks, which usually takes a few seconds. This page will finish by
            itself; nothing needs to be signed again.
          </p>
        </div>
      </div>

      {signature === null || signature === undefined ? null : (
        <p className="transaction__detail">
          <span>Transaction signature</span>
          <span className="hash">{signature}</span>
        </p>
      )}

      <div className="transaction__actions">
        <Button variant="secondary" loading loadingLabel="Waiting for Solana to confirm">
          Confirming
        </Button>
        {explorerUrl === null ? null : (
          <a
            className="btn btn--quiet"
            href={explorerUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            <Icon name="externalLink" size={16} />
            View on Solana Explorer
            <span className="visually-hidden">, opens in a new tab</span>
          </a>
        )}
      </div>

      {children}
    </div>
  );
}
