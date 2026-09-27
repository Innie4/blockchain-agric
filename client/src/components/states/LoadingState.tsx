import { Skeleton, SkeletonLines } from "../ui/Skeleton";

export interface LoadingStateProps {
  /** Announced while the wait is on screen. */
  label?: string;
  /** Rendered as skeleton rows, for a table that is still arriving. */
  rows?: number;
  className?: string;
}

/**
 * The wait. It occupies the same space the content will, so a page that arrives
 * late does not shove everything down the screen.
 */
export function LoadingState({
  label = "Loading",
  rows = 0,
  className,
}: LoadingStateProps) {
  return (
    <div
      className={["stack", className]
        .filter((value): value is string => value !== null && value !== undefined)
        .join(" ")}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="visually-hidden">{label}</span>
      {rows > 0 ? (
        <div className="stack stack--tight" aria-hidden="true">
          {Array.from({ length: rows }, (_unused, index) => (
            <div className="cluster" key={index}>
              <Skeleton height={14} width="34%" />
              <Skeleton height={14} width="18%" />
              <Skeleton height={14} width="22%" />
            </div>
          ))}
        </div>
      ) : (
        <div aria-hidden="true">
          <SkeletonLines lines={3} />
        </div>
      )}
    </div>
  );
}
