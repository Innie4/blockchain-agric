import { TRANSFER_RECIPIENT_ROLES, type Role } from "./roles.js";

/**
 * The product lifecycle. Ordinals and transition rules are identical to
 * `ProductStatus` in `programs/agri_trace/.../state.rs`; the backend test-suite
 * asserts the two agree so the chain and the API can never drift apart.
 */
export const PRODUCT_STATUSES = [
  "REGISTERED",
  "IN_PROCESSING",
  "PROCESSED",
  "IN_TRANSIT",
  "AT_RETAILER",
  "LISTED",
  "SOLD",
  "FLAGGED",
] as const;

export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

const STATUS_LABELS: Record<ProductStatus, string> = {
  REGISTERED: "Registered",
  IN_PROCESSING: "In processing",
  PROCESSED: "Processed",
  IN_TRANSIT: "In transit",
  AT_RETAILER: "At retailer",
  LISTED: "Listed for sale",
  SOLD: "Sold",
  FLAGGED: "Flagged by regulator",
};

export function statusLabel(status: ProductStatus): string {
  return STATUS_LABELS[status];
}

const SUCCESSORS: Record<ProductStatus, readonly ProductStatus[]> = {
  REGISTERED: ["IN_PROCESSING"],
  IN_PROCESSING: ["PROCESSED"],
  PROCESSED: ["IN_TRANSIT"],
  IN_TRANSIT: ["AT_RETAILER"],
  AT_RETAILER: ["LISTED"],
  LISTED: ["SOLD"],
  SOLD: [],
  FLAGGED: [],
};

/**
 * The status a batch takes on when ownership passes to a participant in the
 * given role. Mirrors the `match recipient_role` arm of the on-chain transfer.
 */
const STATUS_ON_RECEIPT: Partial<Record<Role, ProductStatus>> = {
  PROCESSOR: "IN_PROCESSING",
  TRANSPORTER: "IN_TRANSIT",
  RETAILER: "AT_RETAILER",
};

export function successors(status: ProductStatus): readonly ProductStatus[] {
  return SUCCESSORS[status];
}

export function canAdvance(status: ProductStatus, target: ProductStatus): boolean {
  return SUCCESSORS[status].includes(target);
}

export function isTerminal(status: ProductStatus): boolean {
  return status === "SOLD";
}

export function isFlagged(status: ProductStatus): boolean {
  return status === "FLAGGED";
}

export function statusOnTransferTo(role: Role): ProductStatus | null {
  return STATUS_ON_RECEIPT[role] ?? null;
}

export interface TransferEligibility {
  eligible: boolean;
  reason?: string;
  /** Statuses the recipient role would move the batch into. */
  resultingStatus?: ProductStatus;
}

/**
 * Decides whether the current owner may hand a batch to a recipient, applying
 * the same rules the program will enforce on-chain. Doing it here as well
 * gives the participant a clear explanation before they sign anything.
 */
export function evaluateTransfer(input: {
  currentStatus: ProductStatus;
  currentOwnerWallet: string;
  signerWallet: string;
  recipientWallet: string;
  recipientRole: Role | null;
  recipientRegistered: boolean;
}): TransferEligibility {
  const {
    currentStatus,
    currentOwnerWallet,
    signerWallet,
    recipientWallet,
    recipientRole,
    recipientRegistered,
  } = input;

  if (signerWallet !== currentOwnerWallet) {
    return {
      eligible: false,
      reason: "Only the wallet that currently owns this product may transfer it.",
    };
  }
  if (isFlagged(currentStatus)) {
    return {
      eligible: false,
      reason: "A regulator has withheld this product. It cannot be transferred until it is released.",
    };
  }
  if (isTerminal(currentStatus)) {
    return { eligible: false, reason: "This product has already been sold." };
  }
  if (recipientWallet === currentOwnerWallet) {
    return {
      eligible: false,
      reason: "Select a different recipient. A product cannot be transferred to its current owner.",
    };
  }
  if (!recipientRegistered || recipientRole === null) {
    return {
      eligible: false,
      reason:
        "That wallet is not a registered participant. They must register on-chain before they can receive a product.",
    };
  }
  if (!TRANSFER_RECIPIENT_ROLES.includes(recipientRole)) {
    return {
      eligible: false,
      reason: "A product may only be transferred to a processor, transporter or retailer.",
    };
  }
  return { eligible: true, resultingStatus: statusOnTransferTo(recipientRole) ?? undefined };
}

/**
 * The next status a batch may move to given who is acting. Regulators may
 * withhold or release; everyone else advances one step.
 */
export function nextStatusesFor(
  role: Role | "CONSUMER",
  currentStatus: ProductStatus
): readonly ProductStatus[] {
  if (role === "REGULATOR") {
    if (isFlagged(currentStatus)) {
      return [currentStatus, "REGISTERED", "IN_PROCESSING", "PROCESSED", "IN_TRANSIT", "AT_RETAILER", "LISTED", "SOLD"].filter(
        (s) => s !== "FLAGGED"
      ) as ProductStatus[];
    }
    return ["FLAGGED"];
  }
  if (isFlagged(currentStatus) || isTerminal(currentStatus)) return [];
  return SUCCESSORS[currentStatus];
}
