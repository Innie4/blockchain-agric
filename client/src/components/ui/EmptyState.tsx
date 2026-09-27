import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** Decoration. The title carries the meaning. */
  icon?: IconName;
  action?: ReactNode;
  className?: string;
  tone?: "neutral" | "info" | "warning" | "danger";
}

/**
 * The answer to "there is nothing here". Every list in the application uses
 * this rather than a blank area, so an empty result is never mistaken for a
 * page that failed to load.
 */
export function EmptyState({
  title,
  description,
  icon = "package",
  action,
  className,
  tone = "neutral",
}: EmptyStateProps) {
  const classes = [
    "state",
    tone === "neutral" ? null : `state--${tone}`,
    className,
  ]
    .filter((value): value is string => value !== null && value !== undefined)
    .join(" ");

  return (
    <div className={classes}>
      <Icon name={icon} size={28} className="state__icon" />
      <p className="state__title">{title}</p>
      {description === undefined ? null : <p className="state__body">{description}</p>}
      {action === undefined ? null : <div className="state__actions">{action}</div>}
    </div>
  );
}
