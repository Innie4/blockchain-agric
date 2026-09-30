import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Transaction, type Connection, type PublicKey, type VersionedTransaction } from "@solana/web3.js";
import { ApiError, type ApiErrorCode } from "../api/errors";
import { base58ToBytes, base64ToBytes, bytesToBase64 } from "../lib/bytes";
import { isDemoDataEnabled } from "../demo/mode";
import { DEMO_USER } from "../demo/dataset";
import {
  CLUSTER_LABEL,
  SOLANA_CLUSTER,
  getRpcConnection,
  walletIsOnExpectedCluster,
  wrongNetworkMessage,
} from "../lib/solana";

/* ------------------------------------------------------------------ *
 * The injected standard wallet interface
 * ------------------------------------------------------------------ */

/**
 * The wallet standard every Solana extension implements.
 *
 * The application talks to this directly instead of going through
 * `wallet-adapter`, which would add a registry, a dependency tree and an
 * indirection for no behaviour this project needs. `window.phantom.solana` is
 * simply an object with these methods.
 */
export interface StandardWallet {
  isPhantom?: boolean;
  isBackpack?: boolean;
  isSolflare?: boolean;
  isMetaMask?: boolean;
  /** Some extensions expose their own name. */
  name?: string;
  publicKey?: PublicKey | null;
  connected?: boolean;
  connect(): Promise<PublicKey | void>;
  disconnect(): Promise<void>;
  /** Returns the raw bytes, or base58 from a few older implementations. */
  signMessage(message: Uint8Array, display?: string): Promise<Uint8Array | string>;
  /**
   * Some older wallets sign the transaction in place and return nothing, so
   * `void` is treated as a valid outcome.
   */
  signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T | void>;
  signAllTransactions?<T extends Transaction | VersionedTransaction>(
    transactions: T[],
  ): Promise<T[] | void>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  off?(event: string, handler: (...args: unknown[]) => void): void;
}

interface SolanaWindow extends Window {
  solana?: unknown;
  phantom?: unknown;
  backpack?: unknown;
  solflare?: unknown;
}

export interface DetectedWallet {
  provider: StandardWallet;
  name: string;
}

/** Injection points, most preferred first. */
const INJECTION_PATHS: ReadonlyArray<{ segments: readonly string[]; fallbackName: string }> = [
  { segments: ["phantom", "solana"], fallbackName: "Phantom" },
  { segments: ["solana"], fallbackName: "Solana wallet" },
  { segments: ["backpack", "solana"], fallbackName: "Backpack" },
  { segments: ["backpack"], fallbackName: "Backpack" },
  { segments: ["solflare"], fallbackName: "Solflare" },
];

function isStandardWallet(value: unknown): value is StandardWallet {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StandardWallet>;
  return (
    typeof candidate.connect === "function" &&
    typeof candidate.disconnect === "function" &&
    typeof candidate.signMessage === "function" &&
    typeof candidate.signTransaction === "function"
  );
}

function readPath(root: unknown, segments: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Names the wallet from its own flags, so the interface can say which one. */
export function walletDisplayName(provider: StandardWallet, fallback: string): string {
  if (provider.isPhantom === true) return "Phantom";
  if (provider.isBackpack === true) return "Backpack";
  if (provider.isSolflare === true) return "Solflare";
  if (provider.isMetaMask === true) return "MetaMask";
  if (typeof provider.name === "string" && provider.name.trim().length > 0) {
    return provider.name.trim();
  }
  return fallback;
}

/**
 * Finds the injected wallet, if the browser has one. Detection runs again on
 * demand because an extension can finish injecting after the page has loaded.
 */
export function detectStandardWallet(): DetectedWallet | null {
  if (typeof window === "undefined") return null;
  const seen: StandardWallet[] = [];
  for (const { segments, fallbackName } of INJECTION_PATHS) {
    const candidate = readPath(window as SolanaWindow, segments);
    if (!isStandardWallet(candidate)) continue;
    if (seen.includes(candidate)) continue;
    seen.push(candidate);
    return { provider: candidate, name: walletDisplayName(candidate, fallbackName) };
  }
  return null;
}

function readPublicKey(provider: StandardWallet | null): string | null {
  if (provider === null) return null;
  const key = provider.publicKey;
  if (key === null || key === undefined) return null;
  return key.toBase58();
}

/* ------------------------------------------------------------------ *
 * Wallet failures
 * ------------------------------------------------------------------ */

export type WalletFailureReason =
  | "NO_WALLET"
  | "UNSUPPORTED_WALLET"
  | "WALLET_LOCKED"
  | "CONNECTION_REJECTED"
  | "SIGNATURE_REJECTED"
  | "WRONG_NETWORK"
  | "NO_PUBLIC_KEY"
  | "UNKNOWN";

/** A failure that came from the wallet rather than from the application. */
export class WalletError extends Error {
  override readonly name = "WalletError";
  readonly reason: WalletFailureReason;
  readonly cause?: unknown;

  constructor(reason: WalletFailureReason, message: string, cause?: unknown) {
    super(message);
    this.reason = reason;
    this.cause = cause;
  }
}

const FAILURE_COPY: Record<WalletFailureReason, string> = {
  NO_WALLET:
    "No Solana wallet was found in this browser. Install Phantom or another Solana wallet, then reload this page.",
  UNSUPPORTED_WALLET:
    "This wallet does not offer everything the application needs. Try Phantom, Backpack or Solflare.",
  WALLET_LOCKED:
    "The wallet is locked. Unlock it, then try again. Nothing was signed and nothing was recorded.",
  CONNECTION_REJECTED:
    "The wallet connection was declined, so the application is still signed out.",
  SIGNATURE_REJECTED:
    "The signature request was declined, so nothing was written to the blockchain.",
  WRONG_NETWORK: "The wallet is on a different Solana network from this deployment.",
  NO_PUBLIC_KEY: "The wallet connected but did not share its address. Reconnect the wallet and try again.",
  UNKNOWN:
    "The wallet did not complete the request. Try again, and reopen the wallet if it is unresponsive.",
};

function messageForFailure(reason: WalletFailureReason): string {
  if (reason === "WRONG_NETWORK") return wrongNetworkMessage();
  return FAILURE_COPY[reason];
}

/** Maps each wallet failure onto the shared API error vocabulary. */
const FAILURE_API_CODES: Record<WalletFailureReason, ApiErrorCode> = {
  NO_WALLET: "UNSUPPORTED_WALLET",
  UNSUPPORTED_WALLET: "UNSUPPORTED_WALLET",
  WALLET_LOCKED: "WALLET_NOT_CONNECTED",
  CONNECTION_REJECTED: "WALLET_NOT_CONNECTED",
  SIGNATURE_REJECTED: "WALLET_SIGNATURE_REJECTED",
  WRONG_NETWORK: "UNSUPPORTED_WALLET",
  NO_PUBLIC_KEY: "WALLET_NOT_CONNECTED",
  UNKNOWN: "WALLET_NOT_CONNECTED",
};

/** Turns any wallet failure into an `ApiError` the rest of the app understands. */
export function walletErrorToApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof WalletError) {
    return new ApiError({
      code: FAILURE_API_CODES[error.reason],
      status: 0,
      message: error.message,
      cause: error,
    });
  }
  return new ApiError({
    code: "WALLET_NOT_CONNECTED",
    status: 0,
    message: messageForFailure("UNKNOWN"),
    cause: error,
  });
}

/** A provider error is rarely an `Error`, so its code is read defensively. */
function providerErrorCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : null;
}

function providerErrorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

function classifyConnectionError(error: unknown): WalletFailureReason {
  const code = providerErrorCode(error);
  const text = providerErrorText(error).toLowerCase();
  if (code === 4001 || text.includes("user rejected") || text.includes("user denied")) {
    return "CONNECTION_REJECTED";
  }
  if (code === 4041 || text.includes("network")) return "WRONG_NETWORK";
  if (text.includes("locked") || text.includes("unlock")) return "WALLET_LOCKED";
  // -32002 is "a request is already in progress", which is a refusal in all
  // but name as far as the participant is concerned.
  if (code === -32002 || text.includes("processing") || text.includes("pending")) {
    return "CONNECTION_REJECTED";
  }
  return "UNKNOWN";
}

function classifySignatureError(error: unknown): WalletFailureReason {
  const code = providerErrorCode(error);
  const text = providerErrorText(error).toLowerCase();
  if (code === 4001 || text.includes("user rejected") || text.includes("user denied")) {
    return "SIGNATURE_REJECTED";
  }
  if (text.includes("locked") || text.includes("unlock")) return "WALLET_LOCKED";
  if (text.includes("not supported") || text.includes("unsupported")) return "UNSUPPORTED_WALLET";
  return "UNKNOWN";
}

function toSignatureBytes(result: Uint8Array | string): Uint8Array | null {
  if (result instanceof Uint8Array) return result;
  if (typeof result !== "string" || result.length === 0) return null;
  try {
    return base58ToBytes(result);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * The two-phase transaction helpers
 * ------------------------------------------------------------------ */

/**
 * Rebuilds the transaction the server prepared.
 *
 * A legacy Solana transaction starts with its signature count in the first
 * byte. A versioned transaction sets the high bit of that byte instead, and the
 * server's submit path only accepts the legacy form, so the mismatch is
 * reported plainly rather than producing a confusing parse error.
 */
export function deserializeTransaction(base64: string): Transaction {
  const bytes = base64ToBytes(base64.trim());
  if (bytes.length === 0) {
    throw new WalletError(
      "UNSUPPORTED_WALLET",
      "The prepared transaction was empty. Prepare the action again to get a fresh one.",
    );
  }
  const versionByte = bytes[0];
  if ((versionByte & 0x80) !== 0) {
    throw new WalletError(
      "UNSUPPORTED_WALLET",
      "The prepared transaction uses Solana's newer transaction format, which this deployment " +
        "cannot submit. Report this to an administrator.",
    );
  }
  try {
    return Transaction.from(bytes);
  } catch (cause) {
    throw new WalletError(
      "UNSUPPORTED_WALLET",
      "The prepared transaction could not be read. Prepare the action again to get a fresh one.",
      cause,
    );
  }
}

/** The wire form the submit endpoint expects. */
export function serializeSignedTransaction(transaction: Transaction): string {
  return bytesToBase64(transaction.serialize());
}

export interface WalletContextValue {
  status: WalletConnectionStatus;
  publicKey: string | null;
  hasWallet: boolean;
  connecting: boolean;
  walletName: string | null;
  clusterLabel: string;
  failure: WalletFailureReason | null;
  error: string | null;
  connect(): Promise<string>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  signTransaction(transaction: Transaction): Promise<Transaction>;
  signAllTransactions(transactions: Transaction[]): Promise<Transaction[]>;
}

export type WalletConnectionStatus =
  | "detecting"
  | "unavailable"
  | "disconnected"
  | "connecting"
  | "connected"
  | "locked"
  | "error";

const WalletContext = createContext<WalletContextValue | null>(null);

const DETECTION_RETRY_MS = 250;
const DETECTION_WINDOW_MS = 4000;

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<StandardWallet | null>(null);
  const [walletName, setWalletName] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [hasFinishedDetecting, setHasFinishedDetecting] = useState(false);
  const [busy, setBusy] = useState<"connecting" | null>(null);
  const [failure, setFailure] = useState<WalletFailureReason | null>(null);

  const walletRef = useRef<StandardWallet | null>(null);
  const walletNameRef = useRef<string | null>(null);

  const adopt = useCallback((detected: DetectedWallet | null) => {
    const provider = detected?.provider ?? null;
    const name = detected?.name ?? null;
    walletRef.current = provider;
    walletNameRef.current = name;
    setWallet((current) => (current === provider ? current : provider));
    setWalletName((current) => (current === name ? current : name));
    setHasFinishedDetecting(true);
  }, []);

  // Detection runs on mount, retries briefly in case the extension finishes
  // injecting late, and re-checks whenever the tab regains focus.
  useEffect(() => {
    let cancelled = false;
    const detect = (): void => {
      if (cancelled) return;
      adopt(detectStandardWallet());
    };

    detect();
    const interval = window.setInterval(detect, DETECTION_RETRY_MS);
    const stopRetrying = window.setTimeout(() => {
      window.clearInterval(interval);
    }, DETECTION_WINDOW_MS);
    const onFocus = (): void => {
      setPublicKey(readPublicKey(walletRef.current));
    };
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearTimeout(stopRetrying);
      window.removeEventListener("focus", onFocus);
    };
  }, [adopt]);

  // Keep the visible address in step with the wallet's own idea of it.
  useEffect(() => {
    if (wallet === null) {
      setPublicKey(null);
      return;
    }
    setPublicKey(readPublicKey(wallet));
    if (typeof wallet.on !== "function") return;

    const sync = (): void => setPublicKey(readPublicKey(wallet));
    const events = ["connect", "disconnect", "accountChanged"] as const;
    for (const event of events) wallet.on?.(event, sync);
    return () => {
      for (const event of events) wallet.off?.(event, sync);
    };
  }, [wallet]);

  const requireProvider = useCallback((): StandardWallet => {
    const provider = walletRef.current;
    if (provider === null) {
      throw new WalletError("NO_WALLET", messageForFailure("NO_WALLET"));
    }
    return provider;
  }, []);

  const connect = useCallback(async (): Promise<string> => {
    setBusy("connecting");
    setFailure(null);
    const detected = detectStandardWallet();
    if (detected !== null) adopt(detected);
    const provider = detected?.provider ?? walletRef.current;
    if (provider === null) {
      const error = new WalletError("NO_WALLET", messageForFailure("NO_WALLET"));
      setBusy(null);
      setFailure("NO_WALLET");
      throw error;
    }

    try {
      await provider.connect();
      const address = readPublicKey(provider);
      if (address === null) {
        throw new WalletError("NO_PUBLIC_KEY", messageForFailure("NO_PUBLIC_KEY"));
      }
      if (!(await walletIsOnExpectedCluster())) {
        throw new WalletError("WRONG_NETWORK", messageForFailure("WRONG_NETWORK"));
      }
      setPublicKey(address);
      setFailure(null);
      return address;
    } catch (error) {
      const reason = error instanceof WalletError ? error.reason : classifyConnectionError(error);
      setFailure(reason);
      if (error instanceof WalletError) throw error;
      throw new WalletError(reason, messageForFailure(reason), error);
    } finally {
      setBusy(null);
    }
  }, [adopt]);

  const disconnect = useCallback(async (): Promise<void> => {
    setFailure(null);
    const provider = walletRef.current;
    if (provider === null) {
      setPublicKey(null);
      return;
    }
    try {
      await provider.disconnect();
      setPublicKey(null);
    } catch (cause) {
      setFailure("UNKNOWN");
      throw new WalletError(
        "UNKNOWN",
        "The wallet did not confirm the disconnect. Close its tab and reload to finish signing out.",
        cause,
      );
    }
  }, []);

  const signMessage = useCallback(
    async (message: Uint8Array): Promise<Uint8Array> => {
      try {
        const provider = requireProvider();
        const result = await provider.signMessage(message);
        const bytes = toSignatureBytes(result);
        if (bytes === null) {
          throw new WalletError(
            "UNSUPPORTED_WALLET",
            "This wallet returned a signature in a format the application cannot read. " +
              "Try Phantom, Backpack or Solflare.",
          );
        }
        return bytes;
      } catch (error) {
        const reason = error instanceof WalletError ? error.reason : classifySignatureError(error);
        setFailure(reason);
        if (error instanceof WalletError) throw error;
        throw new WalletError(reason, messageForFailure(reason), error);
      }
    },
    [requireProvider],
  );

  const signTransaction = useCallback(
    async (transaction: Transaction): Promise<Transaction> => {
      try {
        const provider = requireProvider();
        const result = await provider.signTransaction(transaction);
        // A wallet that signs in place returns nothing; the instance handed to
        // it is then the signed one.
        return result ?? transaction;
      } catch (error) {
        const reason = error instanceof WalletError ? error.reason : classifySignatureError(error);
        setFailure(reason);
        if (error instanceof WalletError) throw error;
        throw new WalletError(reason, messageForFailure(reason), error);
      }
    },
    [requireProvider],
  );

  const signAllTransactions = useCallback(
    async (transactions: Transaction[]): Promise<Transaction[]> => {
      try {
        const provider = requireProvider();
        if (typeof provider.signAllTransactions !== "function") {
          throw new WalletError(
            "UNSUPPORTED_WALLET",
            "This wallet cannot sign several transactions at once. Sign them one at a time.",
          );
        }
        const result = await provider.signAllTransactions(transactions);
        return result ?? transactions;
      } catch (error) {
        const reason = error instanceof WalletError ? error.reason : classifySignatureError(error);
        setFailure(reason);
        if (error instanceof WalletError) throw error;
        throw new WalletError(reason, messageForFailure(reason), error);
      }
    },
    [requireProvider],
  );

  const status = useMemo<WalletConnectionStatus>(() => {
    if (busy !== null) return busy;
    if (failure === "WALLET_LOCKED") return "locked";
    if (failure !== null) {
      if (failure === "NO_WALLET") return "unavailable";
      return "error";
    }
    if (wallet === null) return hasFinishedDetecting ? "unavailable" : "detecting";
    return publicKey === null ? "disconnected" : "connected";
  }, [busy, failure, hasFinishedDetecting, publicKey, wallet]);

  // While fixture data is in use there is no wallet to find, so the wallet is
  // reported as already connected to the prepared address. This is strictly a
  // fixture affordance: it needs `DEMO_DATA` on, and `mode.ts` refuses that
  // in a production build without an explicit acknowledgement. A real deployment
  // still requires a real signature, because nothing here is reachable unless the
  // flag is set.
  const demoConnected = isDemoDataEnabled();
  const effectiveStatus: WalletConnectionStatus = demoConnected ? "connected" : status;
  const effectivePublicKey = demoConnected ? DEMO_USER.walletAddress : publicKey;

  const value = useMemo<WalletContextValue>(
    () => ({
      status: effectiveStatus,
      publicKey: effectivePublicKey,
      hasWallet: demoConnected || wallet !== null,
      connecting: busy === "connecting",
      walletName,
      clusterLabel: CLUSTER_LABEL[SOLANA_CLUSTER],
      failure,
      error: failure === null ? null : messageForFailure(failure),
      connect,
      disconnect,
      signMessage,
      signTransaction,
      signAllTransactions,
    }),
    [
      busy,
      connect,
      demoConnected,
      disconnect,
      effectivePublicKey,
      effectiveStatus,
      failure,
      signAllTransactions,
      signMessage,
      signTransaction,
      wallet,
      walletName,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

function useWalletContext(hookName: string): WalletContextValue {
  const value = useContext(WalletContext);
  if (value === null) {
    throw new Error(
      `${hookName} must be used inside <WalletProvider>. Mount WalletProvider above the router ` +
        "in src/main.tsx; components rendered on their own, such as in a test, need their own " +
        "provider too.",
    );
  }
  return value;
}

/**
 * The wallet, in the shape the rest of the application uses. Throws a clear
 * error when the provider is missing rather than failing later with an
 * unhelpful `null`.
 */
export function useWalletState(): WalletContextValue {
  return useWalletContext("useWalletState");
}

/** An alias of `useWalletState`, for call sites that read better this way. */
export function useWallet(): WalletContextValue {
  return useWalletContext("useWallet");
}

/**
 * Signs a prepared transaction and returns the base64 the submit endpoint
 * expects. This is step two of the two-phase flow: the server prepares, the
 * wallet signs, the server submits and confirms.
 */
export function useSignAndSerialize(): (transaction: Transaction) => Promise<string> {
  const { signTransaction } = useWalletState();
  return useCallback(
    async (transaction: Transaction): Promise<string> => {
      const signed = await signTransaction(transaction);
      return serializeSignedTransaction(signed);
    },
    [signTransaction],
  );
}

/**
 * A read-only connection, for the rare page that must ask the cluster something
 * itself. Everything else goes through the server, which owns the endpoint.
 */
export function useSolanaConnection(): Connection {
  return useMemo(() => getRpcConnection(), []);
}
