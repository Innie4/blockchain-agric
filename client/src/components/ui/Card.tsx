import type { ReactNode } from "react";

export interface CardProps {
  children: ReactNode;
  className?: string;
  /** Removes the shadow, for a card sitting inside another surface. */
  quiet?: boolean;
  /** Hides the corners, for a card that holds a table. */
  flush?: boolean;
}

/** A bordered surface. The default container for one record or one task. */
export function Card({ children, className, quiet = false, flush = false }: CardProps) {
  const classes = [
    "card",
    quiet ? "card--quiet" : null,
    flush ? "card--flush" : null,
    className,
  ]
    .filter((value): value is string => value !== null && value !== undefined)
    .join(" ");
  return <div className={classes}>{children}</div>;
}

export interface CardSectionProps {
  children: ReactNode;
  className?: string;
}

export function CardHeader({ children, className }: CardSectionProps) {
  return <div className={["card__header", className].filter(isPresent).join(" ")}>{children}</div>;
}

export function CardBody({ children, className }: CardSectionProps) {
  return <div className={["card__body", className].filter(isPresent).join(" ")}>{children}</div>;
}

export function CardFooter({ children, className }: CardSectionProps) {
  return (
    <div className={["card__footer", className].filter(isPresent).join(" ")}>{children}</div>
  );
}

function isPresent(value: string | null | undefined): value is string {
  return value !== null && value !== undefined;
}
