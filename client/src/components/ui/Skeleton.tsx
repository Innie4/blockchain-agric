export interface SkeletonProps {
  width?: string;
  /** A fixed height by default, so a loading table does not shift the layout. */
  height?: number | string;
  radius?: "sm" | "md" | "lg" | "full";
  className?: string;
  /** Announced to assistive technology when the skeleton stands in for text. */
  label?: string;
}

const RADII: Record<NonNullable<SkeletonProps["radius"]>, string> = {
  sm: "var(--radius-sm)",
  md: "var(--radius-md)",
  lg: "var(--radius-lg)",
  full: "9999px",
};

/**
 * A placeholder block. It is decorative, so it is hidden from assistive
 * technology; the surrounding region carries the announcement instead.
 */
export function Skeleton({
  width = "100%",
  height = 16,
  radius = "sm",
  className,
  label,
}: SkeletonProps) {
  return (
    <span
      className={["skeleton", className]
        .filter((value): value is string => value !== null && value !== undefined)
        .join(" ")}
      style={{ width, height, borderRadius: RADII[radius] }}
      {...(label === undefined ? { "aria-hidden": true } : { role: "status" })}
    >
      {label === undefined ? null : <span className="visually-hidden">{label}</span>}
    </span>
  );
}

/** A block of stacked lines, for a paragraph that is still loading. */
export function SkeletonLines({
  lines = 3,
  className,
  label,
}: {
  lines?: number;
  className?: string;
  label?: string;
}) {
  return (
    <span
      className={["stack", "stack--tight", className]
        .filter((value): value is string => value !== null && value !== undefined)
        .join(" ")}
      {...(label === undefined ? { "aria-hidden": true } : { role: "status" })}
    >
      {Array.from({ length: Math.max(1, lines) }, (_unused, index) => (
        <Skeleton
          key={index}
          height={14}
          width={index === lines - 1 ? "62%" : "100%"}
        />
      ))}
      {label === undefined ? null : <span className="visually-hidden">{label}</span>}
    </span>
  );
}
