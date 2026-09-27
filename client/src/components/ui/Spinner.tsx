export interface SpinnerProps {
  /** Diameter in pixels. */
  size?: number;
  /** Announced to assistive technology. Omit when the state is already spoken. */
  label?: string;
  /** For a spinner on the page background rather than inside a control. */
  onSurface?: boolean;
  className?: string;
}

/**
 * An indeterminate progress indicator.
 *
 * The animation is switched off under `prefers-reduced-motion`, where the ring
 * becomes a static, lighter circle so the control still reads as busy.
 */
export function Spinner({ size = 18, label, onSurface = false, className }: SpinnerProps) {
  const classes = ["spinner", onSurface ? "spinner--on-surface" : null, className]
    .filter((value): value is string => value !== null && value !== undefined)
    .join(" ");

  if (label === undefined) {
    return (
      <span
        className={classes}
        style={{ width: size, height: size }}
        aria-hidden="true"
        data-testid="spinner"
      >
        <span className="spinner__circle" />
      </span>
    );
  }

  return (
    <span
      className={classes}
      style={{ width: size, height: size }}
      role="status"
      data-testid="spinner"
    >
      <span className="spinner__circle" aria-hidden="true" />
      <span className="visually-hidden">{label}</span>
    </span>
  );
}
