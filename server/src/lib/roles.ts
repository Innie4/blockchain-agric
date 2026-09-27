/**
 * Participant roles. These mirror `ParticipantRole` in the on-chain program.
 *
 * `CONSUMER` is deliberately absent from the program's registry because a
 * consumer never needs to write to the ledger; consumers verify publicly
 * without an account. The ordinals of the five business roles must stay in
 * step with `programs/agri_trace/.../state.rs`.
 */
export const ROLES = [
  "FARMER",
  "PROCESSOR",
  "TRANSPORTER",
  "RETAILER",
  "REGULATOR",
] as const;

export type Role = (typeof ROLES)[number];

export const CONSUMER_ROLE = "CONSUMER" as const;
export type ParticipantRoleValue = Role | typeof CONSUMER_ROLE;

export const PARTICIPANT_ROLE_VALUES: readonly ParticipantRoleValue[] = [
  ...ROLES,
  CONSUMER_ROLE,
];

/** Roles that may be registered in the on-chain participant registry. */
export const ON_CHAIN_ROLES: readonly Role[] = ROLES;

const ROLE_LABELS: Record<ParticipantRoleValue, string> = {
  FARMER: "Farmer",
  PROCESSOR: "Processor",
  TRANSPORTER: "Transporter",
  RETAILER: "Retailer",
  REGULATOR: "Regulator",
  CONSUMER: "Consumer",
};

export function roleLabel(role: ParticipantRoleValue): string {
  return ROLE_LABELS[role];
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function isParticipantRole(value: string): value is ParticipantRoleValue {
  return (PARTICIPANT_ROLE_VALUES as readonly string[]).includes(value);
}

/**
 * Maps a role to its ordinal in the on-chain `ParticipantRole` enum. Used by
 * the instruction encoder. Returns `null` for consumers, who have no on-chain
 * registry entry.
 */
export function onChainRoleOrdinal(role: ParticipantRoleValue): number | null {
  const index = ROLES.indexOf(role as Role);
  return index === -1 ? null : index;
}

/** Roles permitted to take ownership of a batch. Mirrors the program. */
export const TRANSFER_RECIPIENT_ROLES: readonly Role[] = [
  "PROCESSOR",
  "TRANSPORTER",
  "RETAILER",
];

export function isTransferRecipientRole(role: string): role is Role {
  return TRANSFER_RECIPIENT_ROLES.includes(role as Role);
}

/**
 * What each role is allowed to do. The server consults this table; the client
 * uses it only to decide what to show. Neither is trusted for security on its
 * own — the ownership and role checks that matter are re-applied against
 * database records and the on-chain program.
 */
export const PERMISSIONS = [
  "product:register",
  "product:read:any",
  "product:read:own",
  "product:update-status",
  "product:record-processing",
  "product:record-transport",
  "product:list-for-sale",
  "transfer:create",
  "transfer:review",
  "certificate:attach",
  "verification:log",
  "compliance:read",
  "compliance:report-generate",
  "profile:manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<ParticipantRoleValue, readonly Permission[]> = {
  FARMER: [
    "product:register",
    "product:read:own",
    "product:read:any",
    "transfer:create",
    "transfer:review",
    "certificate:attach",
    "verification:log",
    "profile:manage",
  ],
  PROCESSOR: [
    "product:read:own",
    "product:read:any",
    "product:update-status",
    "product:record-processing",
    "transfer:create",
    "transfer:review",
    "certificate:attach",
    "verification:log",
    "profile:manage",
  ],
  TRANSPORTER: [
    "product:read:own",
    "product:read:any",
    "product:update-status",
    "product:record-transport",
    "transfer:create",
    "transfer:review",
    "certificate:attach",
    "verification:log",
    "profile:manage",
  ],
  RETAILER: [
    "product:read:own",
    "product:read:any",
    "product:update-status",
    "product:list-for-sale",
    "transfer:create",
    "transfer:review",
    "certificate:attach",
    "verification:log",
    "profile:manage",
  ],
  CONSUMER: ["product:read:any", "verification:log"],
  REGULATOR: [
    "product:read:any",
    "verification:log",
    "compliance:read",
    "compliance:report-generate",
    "profile:manage",
  ],
};

export function permissionsFor(role: ParticipantRoleValue): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function hasPermission(
  role: ParticipantRoleValue,
  permission: Permission
): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Roles permitted to move a batch forward in its lifecycle, by hand. */
export const STATUS_UPDATE_ROLES: readonly ParticipantRoleValue[] = [
  "PROCESSOR",
  "TRANSPORTER",
  "RETAILER",
  "FARMER",
  "REGULATOR",
];

export function canUpdateStatus(role: ParticipantRoleValue): boolean {
  return STATUS_UPDATE_ROLES.includes(role);
}
