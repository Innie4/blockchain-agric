import { ROLE_LABELS, type Role } from "../../api/types";
import type { ReactNode } from "react";
import { EmptyState } from "../ui/EmptyState";

export interface ForbiddenStateProps {
  /** The role the participant holds. */
  currentRole?: Role | null;
  /** The roles that may do this, when the page can say so. */
  allowedRoles?: readonly Role[];
  action?: ReactNode;
}

/**
 * The account is real but the role does not cover this action. It names the
 * roles that do, because "you do not have permission" on its own leaves the
 * participant with nothing to do next.
 */
export function ForbiddenState({
  currentRole,
  allowedRoles,
  action,
}: ForbiddenStateProps) {
  const held =
    currentRole === undefined || currentRole === null
      ? null
      : `You are signed in as a ${ROLE_LABELS[currentRole].toLowerCase()}.`;
  const permitted =
    allowedRoles === undefined || allowedRoles.length === 0
      ? "This page is limited to particular participant roles."
      : `This page is for ${allowedRoles.map((role) => ROLE_LABELS[role].toLowerCase()).join(" or ")} accounts.`;

  return (
    <EmptyState
      icon="shield"
      tone="warning"
      title="This section is not open to your role"
      description={[held, permitted]
        .filter((part): part is string => part !== null)
        .join(" ")}
      {...(action === undefined ? {} : { action })}
    />
  );
}
