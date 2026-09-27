import type { ReactNode } from "react";
import { EmptyState } from "../ui/EmptyState";

export { EmptyState } from "../ui/EmptyState";

export interface NotFoundStateProps {
  title?: string;
  description?: string;
  action?: ReactNode;
}

/** The record does not exist, or the link is out of date. */
export function NotFoundState({
  title = "That record does not exist",
  description = "The batch, transfer or report may have been removed, or the link may be out of date. Check the identifier, or search for the crop and farm instead.",
  action,
}: NotFoundStateProps) {
  return (
    <EmptyState
      icon="search"
      title={title}
      description={description}
      {...(action === undefined ? {} : { action })}
    />
  );
}
