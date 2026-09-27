import type { NextFunction, Request, Response } from "express";
import { AppError, ERROR_CODES } from "../lib/errors.js";
import { hasPermission, type ParticipantRoleValue, type Permission } from "../lib/roles.js";
import { writeAudit } from "../services/auth/authService.js";

/**
 * Requires the authenticated participant to hold a permission.
 *
 * The role is always read from the database record attached to the session, so
 * a caller cannot reach a privileged route by sending a different role.
 */
export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = req.session;
    if (session === undefined) {
      next(new AppError(ERROR_CODES.UNAUTHORIZED));
      return;
    }
    const role = session.user.role;
    if (!hasPermission(role, permission)) {
      void writeAudit({
        action: `permission.denied.${permission}`,
        actorWallet: session.walletAddress,
        actorRole: role,
        outcome: "DENIED",
        resourceType: "route",
        resourceId: req.originalUrl,
        requestId: req.requestId,
        ipAddress: req.ip,
      });
      res.status(403);
      next(
        new AppError(ERROR_CODES.ROLE_NOT_ALLOWED, {
          message: `Your role (${role.toLowerCase()}) may not perform this action. This action is limited to ${describePermission(permission)}.`,
        })
      );
      return;
    }
    next();
  };
}

/** Requires the participant to hold one of the listed roles. */
export function requireRole(...allowed: ParticipantRoleValue[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = req.session;
    if (session === undefined) {
      next(new AppError(ERROR_CODES.UNAUTHORIZED));
      return;
    }
    if (!allowed.includes(session.user.role)) {
      void writeAudit({
        action: "role.denied",
        actorWallet: session.walletAddress,
        actorRole: session.user.role,
        outcome: "DENIED",
        resourceType: "route",
        resourceId: req.originalUrl,
        requestId: req.requestId,
        ipAddress: req.ip,
      });
      res.status(403);
      next(
        new AppError(ERROR_CODES.ROLE_NOT_ALLOWED, {
          message: `This action is limited to ${allowed.map((r) => r.toLowerCase()).join(", ")}. Your role is ${String(session.user.role).toLowerCase()}.`,
        })
      );
      return;
    }
    next();
  };
}

function describePermission(permission: Permission): string {
  const descriptions: Record<Permission, string> = {
    "product:register": "farmers",
    "product:read:any": "participants who can review any product",
    "product:read:own": "participants who hold a product",
    "product:update-status": "the current owner of a product",
    "product:record-processing": "processors",
    "product:record-transport": "transporters",
    "product:list-for-sale": "retailers",
    "transfer:create": "the current owner of a product",
    "transfer:review": "participants involved in a transfer",
    "certificate:attach": "participants handling a product",
    "verification:log": "participants who may record a verification",
    "compliance:read": "regulators",
    "compliance:report-generate": "regulators",
    "profile:manage": "signed-in participants",
  };
  return descriptions[permission];
}
