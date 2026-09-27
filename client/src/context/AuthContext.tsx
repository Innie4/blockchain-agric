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
import { readCsrfToken } from "../api/client";
import { ApiError, messageForError } from "../api/errors";
import { getNonce, getSession, logout, verifySignature } from "../api/endpoints";
import type { AuthChallenge, Role, SessionState, User, VerifiedSignIn } from "../api/types";
import { bytesToBase64, utf8ToBytes } from "../lib/bytes";
import { useWalletState, walletErrorToApiError } from "./WalletContext";

export type AuthStatus = "loading" | "authenticated" | "anonymous";

/** The longest a client will wait for the server's clock before signing. */
const MAX_NOT_BEFORE_WAIT_MS = 5000;

export interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  permissions: string[];
  csrfToken: string | null;
  error: string | null;
  /** True when the wallet still has to choose a business role. */
  needsRoleSelection: boolean;
  /** True when the wallet holds a business role but has no on-chain entry. */
  needsOnChainRegistration: boolean;
  requestChallenge(walletAddress: string): Promise<AuthChallenge>;
  signIn(walletAddress?: string): Promise<VerifiedSignIn>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
  hasPermission(permission: string): boolean;
  isRole(...roles: readonly Role[]): boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function waitUntil(isoTimestamp: string): Promise<void> {
  const target = new Date(isoTimestamp).getTime();
  if (Number.isNaN(target)) return;
  const delay = Math.min(Math.max(target - Date.now(), 0), MAX_NOT_BEFORE_WAIT_MS);
  if (delay === 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delay);
  });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { publicKey, signMessage } = useWalletState();

  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [csrfToken, setCsrfToken] = useState<string | null>(() => readCsrfToken());
  const [error, setError] = useState<string | null>(null);
  const hasLoaded = useRef(false);

  const applySession = useCallback((session: SessionState) => {
    if (session.authenticated && session.user !== null) {
      setUser(session.user);
      setPermissions(session.permissions);
      setStatus("authenticated");
    } else {
      setUser(null);
      setPermissions([]);
      setStatus("anonymous");
    }
    setCsrfToken(readCsrfToken());
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const session = await getSession();
      applySession(session);
      setError(null);
    } catch (cause) {
      // A session check that cannot reach the server is treated as signed out
      // rather than as an error, so a network blip does not block the landing
      // page. The message is still available if it matters.
      setUser(null);
      setPermissions([]);
      setStatus("anonymous");
      setError(messageForError(cause));
    }
  }, [applySession]);

  useEffect(() => {
    if (hasLoaded.current) return;
    hasLoaded.current = true;
    void refresh();
  }, [refresh]);

  const requestChallenge = useCallback(async (walletAddress: string): Promise<AuthChallenge> => {
    const address = walletAddress.trim();
    if (address.length === 0) {
      throw new ApiError({
        code: "WALLET_NOT_CONNECTED",
        status: 0,
        message: "Connect your wallet first, then sign in.",
      });
    }
    try {
      return await getNonce(address);
    } catch (cause) {
      const failure = messageForError(cause);
      setError(failure);
      throw cause;
    }
  }, []);

  const signIn = useCallback(
    async (walletAddress?: string): Promise<VerifiedSignIn> => {
      const address = (walletAddress ?? publicKey ?? "").trim();
      if (address.length === 0) {
        const failure = new ApiError({
          code: "WALLET_NOT_CONNECTED",
          status: 0,
          message: "Connect your wallet before signing in.",
        });
        setError(failure.message);
        throw failure;
      }

      try {
        // One: the server issues a single-use challenge.
        const challenge = await getNonce(address);
        // The challenge is not valid a moment before it was issued, so the
        // wallet is never asked to sign something the server will reject.
        await waitUntil(challenge.notBefore);
        // Two: the wallet signs the exact text the server produced.
        const signatureBytes = await signMessage(utf8ToBytes(challenge.message));
        // Three: the server verifies the signature and opens a session.
        const verified = await verifySignature({
          walletAddress: address,
          nonce: challenge.nonce,
          signature: bytesToBase64(signatureBytes),
        });

        setUser(verified.user);
        setStatus("authenticated");
        setCsrfToken(readCsrfToken());
        setError(null);
        void refresh();
        return verified;
      } catch (cause) {
        const failure = walletErrorToApiError(cause);
        const text = messageForError(failure);
        setError(text);
        throw failure;
      }
    },
    [publicKey, refresh, signMessage],
  );

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await logout();
      setError(null);
    } catch (cause) {
      // Local state is cleared either way: the participant asked to sign out,
      // and leaving the interface showing a signed-in account would be worse
      // than a session the server will expire on its own.
      setError(messageForError(cause));
    } finally {
      setUser(null);
      setPermissions([]);
      setStatus("anonymous");
      setCsrfToken(readCsrfToken());
    }
  }, []);

  const hasPermission = useCallback(
    (permission: string): boolean => permissions.includes(permission),
    [permissions],
  );

  const isRole = useCallback(
    (...roles: readonly Role[]): boolean =>
      user !== null && roles.includes(user.role),
    [user],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      permissions,
      csrfToken,
      error,
      needsRoleSelection: user !== null && user.role === "CONSUMER",
      needsOnChainRegistration:
        user !== null && user.role !== "CONSUMER" && !user.onChainRegistered,
      requestChallenge,
      signIn,
      signOut,
      refresh,
      hasPermission,
      isRole,
    }),
    [
      csrfToken,
      error,
      hasPermission,
      isRole,
      permissions,
      refresh,
      requestChallenge,
      signIn,
      signOut,
      status,
      user,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * The signed-in participant. Throws outside the provider rather than returning
 * a half-populated value that would fail somewhere less obvious.
 */
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error(
      "useAuth must be used inside <AuthProvider>. Mount AuthProvider above the router in " +
        "src/main.tsx; components rendered on their own, such as in a test, need their own " +
        "provider too.",
    );
  }
  return value;
}
