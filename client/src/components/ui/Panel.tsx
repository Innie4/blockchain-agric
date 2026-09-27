import { useId, type ReactNode } from "react";

export type PanelTone = "default" | "sunken" | "primary" | "info" | "warning" | "danger";

export interface PanelProps {
  children: ReactNode;
  /** When given, the panel becomes a labelled landmark region. */
  title?: string;
  /** Buttons or links shown on the same line as the title. */
  actions?: ReactNode;
  tone?: PanelTone;
  className?: string;
}

const TONE_CLASSES: Record<PanelTone, string | null> = {
  default: null,
  sunken: "panel--sunken",
  primary: "panel--primary",
  info: "panel--info",
  warning: "panel--warning",
  danger: "panel--danger",
};

/**
 * A titled region. The title is wired to the region with `aria-labelledby`, so a
 * screen reader can be told which part of the page it has landed in.
 */
export function Panel({
  children,
  title,
  actions,
  tone = "default",
  className,
}: PanelProps) {
  const generatedId = useId();
  const titleId = title === undefined ? undefined : `panel-${generatedId}`;
  const classes = ["panel", TONE_CLASSES[tone], className]
    .filter((value): value is string => value !== null && value !== undefined)
    .join(" ");

  const content = (
    <>
      {title === undefined && actions === undefined ? null : (
        <div className="panel__header">
          {title === undefined ? (
            <span />
          ) : (
            <h2 className="panel__title" id={titleId}>
              {title}
            </h2>
          )}
          {actions === undefined ? null : <div className="cluster cluster--tight">{actions}</div>}
        </div>
      )}
      <div className="panel__body">{children}</div>
    </>
  );

  if (titleId === undefined) return <div className={classes}>{content}</div>;

  return (
    <section className={classes} aria-labelledby={titleId}>
      {content}
    </section>
  );
}
