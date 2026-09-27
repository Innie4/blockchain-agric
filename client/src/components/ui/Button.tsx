import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, blocks activation and marks the control busy. */
  loading?: boolean;
  /** Announced while busy, so the reason for the wait is not silent. */
  loadingLabel?: string;
  fullWidth?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

/**
 * The one button. It defaults to `type="button"` because an unspecified button
 * inside a form submits it, which is almost never what a dialog or a filter
 * row means.
 */
export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  loadingLabel,
  fullWidth = false,
  leadingIcon,
  trailingIcon,
  type = "button",
  disabled = false,
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    "btn",
    `btn--${variant}`,
    size === "sm" ? "btn--sm" : null,
    fullWidth ? "btn--full" : null,
    className,
  ]
    .filter((value): value is string => value !== null && value !== undefined && value.length > 0)
    .join(" ");

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={16} /> : leadingIcon}
      <span>{children}</span>
      {loading ? null : trailingIcon}
      {loading && loadingLabel !== undefined ? (
        <span className="visually-hidden" role="status">
          {loadingLabel}
        </span>
      ) : null}
    </button>
  );
}
