import { ApiError, messageForError, recoveryHintFor } from "../../api/errors";
import type { ReactNode } from "react";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";

export interface FailureStateProps {
  /** The failure. Its message, code and recovery step are all shown. */
  error: unknown;
  /** What was being attempted, e.g. "register this batch on the blockchain". */
  context?: string;
  onRetry?: () => void;
  retryLabel?: string;
  /** Extra actions, such as going back or contacting a regulator. */
  actions?: ReactNode;
  className?: string;
}

/**
 * A failure with its cause stated plainly.
 *
 * The stable error code is printed because a regulator or an administrator will
 * need it, and the recovery step is printed because a participant needs
 * something to do. Neither replaces the server's own explanation.
 */
export function FailureState({
  error,
  context,
  onRetry,
  retryLabel = "Try again",
  actions,
  className,
}: FailureStateProps) {
  const code = error instanceof ApiError ? error.code : "UNEXPECTED";
  const hint = recoveryHintFor(error);
  const requestId = error instanceof ApiError ? error.requestId : undefined;

  return (
    <div
      className={["state", "state--danger", className]
        .filter((value): value is string => value !== null && value !== undefined)
        .join(" ")}
      role="alert"
    >
      <Icon name="alertTriangle" size={28} className="state__icon" />
      <p className="state__title">
        {context === undefined ? "This action did not complete" : `Could not ${context}`}
      </p>
      <p className="state__body">{messageForError(error)}</p>

      {hint === null ? null : (
        <p className="state__body text-sm">
          <strong>What to do:</strong> {hint}
        </p>
      )}

      <p className="text-xs text-muted">
        Error code <span className="hash">{code}</span>
        {requestId === undefined ? null : (
          <>
            {" · "}
            Reference <span className="hash">{requestId}</span>
          </>
        )}
      </p>

      {onRetry === undefined && actions === undefined ? null : (
        <div className="state__actions">
          {onRetry === undefined ? null : (
            <Button variant="primary" onClick={onRetry}>
              <Icon name="refresh" size={16} />
              {retryLabel}
            </Button>
          )}
          {actions}
        </div>
      )}
    </div>
  );
}
