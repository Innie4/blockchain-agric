/**
 * Presentation helpers.
 *
 * Every value a participant reads passes through here, so dates, quantities and
 * hashes are written the same way on every screen. These are deliberately plain:
 * no relative-time guessing, no locale surprises, no clever parsing.
 */

/** Shortens a wallet address for display: `7xKX…gAsU`. */
export function truncateAddress(address: string | null | undefined, lead = 4, tail = 4): string {
  if (address === null || address === undefined) return "Not recorded";
  if (address.length === 0) return "Not recorded";
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/** The same, for a hash: long enough to compare, short enough to read. */
export function truncateHash(hash: string | null | undefined): string {
  if (hash === null || hash === undefined || hash.length === 0) return "Not recorded";
  if (hash.length <= 20) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }
  if (value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** A date with no time, e.g. `14 March 2026`. */
export function formatDate(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  if (date === null) return "Not recorded";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

/** A date with the time, e.g. `14 March 2026 at 09:42`. */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  if (date === null) return "Not recorded";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** The machine-readable value for a `<time dateTime>` attribute. */
export function toIsoString(value: string | number | Date | null | undefined): string | undefined {
  const date = toDate(value);
  return date === null ? undefined : date.toISOString();
}

/** A number with no trailing zeros: `1200` becomes `1,200`, `1.5` stays `1.5`. */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 4 }).format(value);
}

/** A quantity with its unit, e.g. `1,200 kg`. */
export function formatQuantity(
  value: number | null | undefined,
  unit: string | null | undefined,
): string {
  const amount = formatNumber(value);
  if (unit === null || unit === undefined || unit.trim().length === 0) return amount;
  return `${amount} ${unit}`;
}

/** An amount of money, e.g. `₦45,000.00`. */
export function formatCurrency(
  value: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const code = currency === null || currency === undefined || currency.length === 0
    ? "NGN"
    : currency;
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: code }).format(value);
  } catch {
    return `${formatNumber(value)} ${code}`;
  }
}

/** A file size in the largest unit that keeps the number readable. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return "Unknown size";
  }
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(value)} ${
    units[unitIndex] ?? "KB"
  }`;
}

/** The value a date input needs: `2026-03-14`. */
export function toDateInputValue(
  value: string | number | Date | null | undefined,
): string {
  const date = toDate(value);
  if (date === null) return "";
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Reads a date input's value as ISO, for a JSON body. */
export function fromDateInputValue(value: string): string | undefined {
  if (value.trim().length === 0) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

/** The current instant as a date input value, for sensible defaults. */
export function todayInputValue(): string {
  return toDateInputValue(new Date());
}

/** A display name for a participant, falling back to the address. */
export function participantName(
  fullName: string | null | undefined,
  walletAddress: string | null | undefined,
): string {
  if (fullName !== null && fullName !== undefined && fullName.trim().length > 0) {
    return fullName.trim();
  }
  return truncateAddress(walletAddress);
}

/** A display name for an actor that may be a wallet, a name, or absent. */
export function actorName(
  name: string | null | undefined,
  walletAddress: string | null | undefined,
  role: string | null | undefined,
): string {
  if (name !== null && name !== undefined && name.trim().length > 0) return name.trim();
  if (walletAddress === null || walletAddress === undefined || walletAddress.length === 0) {
    return role !== null && role !== undefined && role.length > 0 ? role : "An unnamed actor";
  }
  return role !== null && role !== undefined && role.length > 0
    ? `${truncateAddress(walletAddress)} (${role})`
    : truncateAddress(walletAddress);
}

/** Turns a value into a form field that can be appended to `FormData`. */
export function appendIfPresent(form: FormData, name: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  form.append(name, value);
}

/** Triggers a browser download for a blob the server has already produced. */
export function downloadBlob(blob: Blob, fileName: string): void {
  if (typeof document === "undefined") return;
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}
