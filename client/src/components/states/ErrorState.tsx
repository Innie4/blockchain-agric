import type { ReactNode } from "react";
import { messageForError } from "../../api/errors";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";

export interface ErrorStateProps {
  /** Anything that was thrown. The message is taken from it. */
  error?: unknown;
  title?: string;
  /** When present, a retry button is offered. */
  onRetry?: () => void;
  retryLabel?: string;
  /** Extra actions, shown beside the retry button. */
  actions?: ReactNode;
  className?: string;
}

/**
 * A failure the reader can act on. It always says what happened and, when the
 * caller knows how, offers the one action that resolves it.
 */
export function ErrorState({
  error,
  title = "That did not work",
  onRetry,
  retryLabel = "Try again",
  actions,
  className,
}: ErrorStateProps) {
  return (
    <div
      className={["state", "state--danger", className]
        .filter((value): value is string => value !== null && value !== undefined)
        .join(" ")}
      role="alert"
    >
      <Icon name="alertTriangle" size={28} className="state__icon" />
      <p className="state__title">{title}</p>
      <p className="state__body">{messageForError(error)}</p>
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
