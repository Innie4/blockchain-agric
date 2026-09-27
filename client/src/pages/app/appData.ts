import { useCallback, useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useToast } from "../../context/ToastContext";
import { ApiError } from "../../api/errors";
import type { BadgeTone } from "../../components/ui/Index";
import {
  CHAIN_STATE_LABELS,
  PRODUCT_STATUSES,
  ROLE_LABELS,
  STATUS_LABELS,
  isChainState,
  isProductStatus,
  isRole,
  type ChainState,
  type Pagination,
  type ProductStatus,
  type Role,
} from "../../api/types";
import { formatNumber } from "../../lib/format";

/**
 * The small amount of vocabulary the authenticated pages share: reading a route
 * parameter, phrasing a participant role for a person rather than a form, and
 * turning the server's numeric and status values into something readable.
 *
 * It is kept apart from the components so that nothing in here is a React
 * component, and a page file only ever exports its own default component.
 */

/* ------------------------------------------------------------------ *
 * Route parameters
 * ------------------------------------------------------------------ */

/** Reads a route parameter, decoded, or `null` when the address gave none. */
export function decodeParam(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const decoded = decodeURIComponent(trimmed).trim();
    return decoded.length === 0 ? null : decoded;
  } catch {
    return trimmed;
  }
}

/** The batch identifier this page is about, or `null` when there is none. */
export function useProductId(): string | null {
  const { productId } = useParams();
  return useMemo(() => decodeParam(productId), [productId]);
}

/** A one-based page number from the query string, never below one. */
export function usePageParam(): [number, (page: number) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const page = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const current = Number.isFinite(page) && page > 0 ? page : 1;

  const setPage = useCallback(
    (next: number) => {
      setSearchParams(
        (previous) => {
          const updated = new URLSearchParams(previous);
          if (next <= 1) updated.delete("page");
          else updated.set("page", String(next));
          return updated;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return [current, setPage];
}

/** Which list the participant is looking at: their own batches, or all of them. */
export function useScopeParam(): ["mine" | "all", (scope: "mine" | "all") => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const scope: "mine" | "all" = searchParams.get("scope") === "mine" ? "mine" : "all";

  const setScope = useCallback(
    (next: "mine" | "all") => {
      setSearchParams(
        (previous) => {
          const updated = new URLSearchParams(previous);
          if (next === "all") updated.delete("scope");
          else updated.set("scope", "mine");
          updated.delete("page");
          return updated;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return [scope, setScope];
}

/* ------------------------------------------------------------------ *
 * Plain language
 * ------------------------------------------------------------------ */

/** What a role means in practice, for a page that has to explain it. */
const ROLE_EXPLANATIONS: Record<Role, string> = {
  FARMER:
    "A farmer registers harvested batches on the blockchain and keeps them until they are sold or transferred onward.",
  PROCESSOR:
    "A processor takes batches from farmers and records the processing they carry out, such as sorting, drying or fermenting.",
  TRANSPORTER: "A transporter carries batches between participants and records each journey.",
  RETAILER: "A retailer takes delivery of batches, lists them for sale and records the price asked.",
  REGULATOR:
    "A regulator reviews batches across the network, checks records against the blockchain, flags concerns and produces compliance reports.",
  CONSUMER:
    "A consumer buys produce. A consumer account registers nothing and owns no batches; it exists so a person can be identified when they check a batch.",
};

/** The role's name and what it can actually do, in two sentences. */
export function describeRole(role: Role): string {
  return `${ROLE_LABELS[role]} — ${ROLE_EXPLANATIONS[role]}`;
}

export function roleLabelOrRaw(value: string | null | undefined): string {
  if (value === null || value === undefined) return "Not recorded";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "Not recorded";
  return isRole(trimmed) ? ROLE_LABELS[trimmed] : trimmed;
}

/* ------------------------------------------------------------------ *
 * Status and chain state
 * ------------------------------------------------------------------ */

const CHAIN_STATE_TONES: Record<ChainState, BadgeTone> = {
  NOT_STARTED: "neutral",
  AWAITING_SIGNATURE: "warning",
  SUBMITTED: "info",
  CONFIRMED: "success",
  FAILED: "danger",
  CANCELLED: "neutral",
  NEEDS_RECONCILIATION: "danger",
};

export function chainStateTone(state: ChainState): BadgeTone {
  return CHAIN_STATE_TONES[state];
}

export function chainStateLabel(state: ChainState): string {
  return CHAIN_STATE_LABELS[state];
}

export function chainStateFromWire(value: string): ChainState {
  const normalised = value.trim().toUpperCase();
  return isChainState(normalised) ? normalised : "NOT_STARTED";
}

/** What the next stage would be for a processor, or `null` when there is none. */
export function nextProcessingStage(current: ProductStatus): ProductStatus | null {
  if (current === "REGISTERED") return "IN_PROCESSING";
  if (current === "IN_PROCESSING") return "PROCESSED";
  return null;
}

export function isProductStatusOrNull(value: string | null | undefined): ProductStatus | null {
  if (value === null || value === undefined) return null;
  return isProductStatus(value) ? value : null;
}

/** Every stage, as a value and a label, for a select. */
export const STATUS_OPTIONS = PRODUCT_STATUSES.map((status) => ({
  value: status,
  label: STATUS_LABELS[status],
}));

/* ------------------------------------------------------------------ *
 * Server rows
 * ------------------------------------------------------------------ */

/** A cell from a server-built row, as text. */
export function cellText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return formatNumber(value);
  const trimmed = value.trim();
  return trimmed.length === 0 ? "—" : trimmed;
}

/** Turns a row key such as `stageChange` into the label a person reads. */
export function humaniseKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim();
  if (spaced.length === 0) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* ------------------------------------------------------------------ *
 * Verification results
 * ------------------------------------------------------------------ */

/** A tone for a verification result, used where a badge stands for the result. */
export const VERIFICATION_TONES: Record<string, BadgeTone> = {
  VERIFIED: "success",
  MISMATCH: "danger",
  NOT_FOUND: "neutral",
  INCOMPLETE: "warning",
};

/* ------------------------------------------------------------------ *
 * Pagination
 * ------------------------------------------------------------------ */

/** "Showing 21 to 40 of 137", or an honest "Nothing to show" at the ends. */
export function describeRange(pagination: Pagination): string {
  const { page, pageSize, total } = pagination;
  if (total === 0) return "Nothing to show";
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  return `Showing ${formatNumber(first)} to ${formatNumber(last)} of ${formatNumber(total)}`;
}

/* ------------------------------------------------------------------ *
 * The clipboard
 * ------------------------------------------------------------------ */

/**
 * Copies a value and says so.
 *
 * A clipboard write can be refused by the browser, so the failure is reported
 * as a warning with a manual fallback rather than silently doing nothing.
 */
export function useCopyToClipboard(): (value: string, what?: string) => void {
  const { push } = useToast();

  return useCallback(
    (value: string, what = "Value") => {
      const clipboard = navigator.clipboard;
      if (clipboard === undefined) {
        push({
          tone: "warning",
          title: "This browser will not let the page copy to the clipboard",
          message: "Select the value and copy it manually.",
        });
        return;
      }
      void clipboard.writeText(value).then(
        () => {
          push({ tone: "info", title: `${what} copied to the clipboard` });
        },
        () => {
          push({
            tone: "warning",
            title: `${what} could not be copied`,
            message: "Select the value and copy it manually.",
          });
        },
      );
    },
    [push],
  );
}

/* ------------------------------------------------------------------ *
 * Client-side validation helpers
 * ------------------------------------------------------------------ */

/** The shape a batch identifier must have, mirrored from the server. */
export function describeProductIdShape(): string {
  return "An identifier looks like AGT-COCOA-2026-A1B2C3: the prefix AGT, a crop code of three to six characters, the year of harvest, and a six character batch code.";
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailLike(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

/** A Solana address is base58, 32 to 44 characters. */
const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isWalletAddressLike(value: string): boolean {
  return WALLET_PATTERN.test(value.trim());
}

/* ------------------------------------------------------------------ *
 * Failures
 * ------------------------------------------------------------------ */

/** True when the failure means the record does not exist, rather than a fault. */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.code === "NOT_FOUND");
}

/** True when the server refused on the grounds of who is asking. */
export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.code === "FORBIDDEN");
}

/* ------------------------------------------------------------------ *
 * Hash comparison
 * ------------------------------------------------------------------ */

export type HashAgreement = "match" | "mismatch" | "unavailable";

/** Compares the two fingerprints a record holds, without inventing a verdict. */
export function compareHashes(
  onChain: string | null | undefined,
  stored: string | null | undefined,
): HashAgreement {
  if (onChain === null || onChain === undefined || onChain.length === 0) return "unavailable";
  if (stored === null || stored === undefined || stored.length === 0) return "unavailable";
  return onChain === stored ? "match" : "mismatch";
}
