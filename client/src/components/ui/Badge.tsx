import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "earth";

export interface BadgeProps {
  /**
   * The label. Required on purpose: a badge is never colour on its own, because
   * colour alone is invisible to a reader who cannot see it.
   */
  children: ReactNode;
  tone?: BadgeTone;
  /** A small glyph beside the label. Decoration only. */
  icon?: IconName;
  className?: string;
  title?: string;
}

export function Badge({
  children,
  tone = "neutral",
  icon,
  className,
  title,
}: BadgeProps) {
  const classes = ["badge", `badge--${tone}`, className]
    .filter((value): value is string => value !== null && value !== undefined)
    .join(" ");

  return (
    <span className={classes} {...(title === undefined ? {} : { title })}>
      {icon === undefined ? null : <Icon name={icon} size={13} className="badge__icon" />}
      {children}
    </span>
  );
}
