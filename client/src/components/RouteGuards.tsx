import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import {
  Link,
  Navigate,
  Outlet,
  isRouteErrorResponse,
  useLocation,
  useNavigate,
  useRouteError,
  type Location,
} from "react-router-dom";
import { ApiError, messageForError } from "../api/errors";
import type { Role } from "../api/types";
import { useAuth } from "../context/AuthContext";
import { isDemoDataEnabled } from "../demo/mode";
import { useToast } from "../context/ToastContext";
import { useWalletState } from "../context/WalletContext";
import { AppShell } from "./layout/AppShell";
import { ForbiddenState } from "./states/ForbiddenState";
import { LoadingState } from "./states/LoadingState";
import { WalletRequiredState } from "./states/WalletRequiredState";
import { Button } from "./ui/Button";
import { EmptyState } from "./ui/EmptyState";
import { Icon } from "./ui/Icon";

/** Where the reader was heading, so signing in can return them there. */
export interface RedirectState {
  from: string;
}

function GuardFrame({ children }: { children: ReactNode }) {
  return (
    <div className="container" style={{ paddingBlock: "var(--space-10)" }}>
      {children}
    </div>
  );
}

function currentTarget(location: Location): string {
  return `${location.pathname}${location.search}`;
}

function SignInRequiredState({ from }: { from: string }) {
  const { signIn } = useAuth();
  const { push } = useToast();
  const navigate = useNavigate();
  const [isWorking, setIsWorking] = useState(false);

  return (
    <EmptyState
      icon="user"
      title="Sign in to continue"
      description="Your wallet is connected. Signing in proves you control it, and nothing more: this application never sees your private key, and no password is involved."
      action={
        <>
          <Button
            variant="primary"
            loading={isWorking}
            loadingLabel="Waiting for your wallet to sign the sign-in request"
            onClick={() => {
              setIsWorking(true);
              void signIn()
                .then(() => {
                  push({ tone: "success", title: "Signed in" });
                  navigate(from, { replace: true });
                })
                .catch((error: unknown) => {
                  push({
                    tone: "error",
                    title: "Could not sign in",
                    message: messageForError(error),
                  });
                })
                .finally(() => setIsWorking(false));
            }}
          >
            <Icon name="user" size={16} />
            Sign in with this wallet
          </Button>
          <Link className="btn btn--quiet" to="/connect">
            Wallet help
          </Link>
        </>
      }
    />
  );
}

/**
 * The two things a guard can say before a session exists, separated so a reader
 * is never asked to sign in with a wallet they have not connected yet.
 *
 * With no wallet installed at all there is nothing to offer here, so the reader
 * is sent to the setup page and returned to where they were afterwards.
 */
function UnauthenticatedGate() {
  const { publicKey, status: walletStatus, connect, connecting } = useWalletState();
  const { push } = useToast();
  const location = useLocation();
  const from = currentTarget(location);

  if (publicKey === null) {
    if (walletStatus === "detecting") {
      return (
        <GuardFrame>
          <LoadingState label="Looking for a wallet" />
        </GuardFrame>
      );
    }
    if (walletStatus === "unavailable") {
      return <Navigate to="/connect" state={{ from } satisfies RedirectState} replace />;
    }
    return (
      <GuardFrame>
        <WalletRequiredState
          purpose="sign in"
          isConnecting={connecting}
          onConnect={() => {
            void connect().catch((cause: unknown) => {
              push({
                tone: "error",
                title: "The wallet did not connect",
                message: messageForError(cause),
              });
            });
          }}
        />
      </GuardFrame>
    );
  }

  return (
    <GuardFrame>
      <SignInRequiredState from={from} />
    </GuardFrame>
  );
}

export interface RequireAuthProps {
  children?: ReactNode;
}

/**
 * Gates the signed-in area: nothing behind it renders until the session has been
 * checked and found.
 */
export function RequireAuth({ children }: RequireAuthProps = {}) {
  const { status } = useAuth();

  if (status === "loading") {
    return (
      <GuardFrame>
        <LoadingState label="Checking your session" />
      </GuardFrame>
    );
  }
  if (status !== "authenticated") return <UnauthenticatedGate />;
  return children === undefined ? <Outlet /> : children;
}

export interface RequireRoleProps {
  roles: readonly Role[];
  children?: ReactNode;
}

/**
 * Gates a page to particular participant roles. The server refuses the action
 * regardless; this keeps a reader from being sent to a page that could only
 * ever fail.
 */
export function RequireRole({ roles, children }: RequireRoleProps) {
  const { status, user, isRole } = useAuth();

  if (status === "loading") {
    return (
      <GuardFrame>
        <LoadingState label="Checking your session" />
      </GuardFrame>
    );
  }
  if (status !== "authenticated") return <UnauthenticatedGate />;

  // While fixture data is in use the role gate is opened, so every page can be
  // reviewed from one session. Against the real API the check below still runs
  // and the server refuses regardless, so this only widens a review build.
  if (!isDemoDataEnabled() && !isRole(...roles)) {
    return (
      <GuardFrame>
        <ForbiddenState currentRole={user?.role ?? null} allowedRoles={roles} />
      </GuardFrame>
    );
  }

  return children === undefined ? <Outlet /> : children;
}

/** The layout for `/app`: authenticated, inside the application frame. */
export function AppLayoutRoute() {
  return (
    <RequireAuth>
      <AppShell />
    </RequireAuth>
  );
}

interface PageBoundaryState {
  error: unknown;
}

/**
 * Catches a failure thrown while a route renders.
 *
 * A class component is required: `componentDidCatch` has no hook equivalent, and
 * without it one thrown error leaves a blank page with no way back.
 */
export class PageBoundary extends Component<{ children?: ReactNode }, PageBoundaryState> {
  override state: PageBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): PageBoundaryState {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The reader is told what happened on screen. This is the one place a
    // developer diagnosis belongs; the server logs the request side.
    if (import.meta.env.DEV) {
      console.error("A page failed to render.", error, info.componentStack);
    }
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children ?? null;

    return (
      <GuardFrame>
        <ThrownErrorState
          error={error}
          onRetry={() => {
            this.setState({ error: null });
            window.location.reload();
          }}
        />
      </GuardFrame>
    );
  }
}

/** The reader's view of a render failure, with a way out. */
export function ThrownErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  const routeResponse = isRouteErrorResponse(error)
    ? { status: error.status, data: error.data }
    : null;

  if (routeResponse !== null) {
    const notFound = routeResponse.status === 404;
    return (
      <>
        <EmptyState
          icon={notFound ? "search" : "alertTriangle"}
          tone={notFound ? "neutral" : "danger"}
          title={notFound ? "That page does not exist" : `This page could not be shown (${routeResponse.status})`}
          description={
            notFound
              ? "The address may be mistyped, or the page may have been moved. The links below will get you back on track."
              : typeof routeResponse.data === "string" && routeResponse.data.length > 0
                ? routeResponse.data
                : "The request was refused before the page could be built. Trying again often clears it."
          }
          action={
            <>
              <Link className="btn btn--primary" to="/app/dashboard">
                Go to the dashboard
              </Link>
              <Link className="btn btn--secondary" to="/">
                Go to the home page
              </Link>
            </>
          }
        />
      </>
    );
  }

  return (
    <>
      <EmptyState
        icon="alertTriangle"
        tone="danger"
        title="Something on this page failed"
        description={`${messageForError(error)} Nothing was changed. Reloading is usually enough; if it keeps happening, report the reference below.`}
        action={
          <>
            {onRetry === undefined ? null : (
              <Button variant="primary" onClick={onRetry}>
                <Icon name="refresh" size={16} />
                Reload the page
              </Button>
            )}
            <Link className="btn btn--secondary" to="/error">
              Report this problem
            </Link>
          </>
        }
      />
      {requestId === undefined ? null : (
        <p className="text-xs text-muted">
          Reference <span className="hash">{requestId}</span>
        </p>
      )}
    </>
  );
}

/**
 * The router's `errorElement`. It reads the error the router caught, which is a
 * different thing from an error thrown during render.
 */
export function RouteErrorElement() {
  const error = useRouteError();
  return (
    <GuardFrame>
      <ThrownErrorState
        error={error}
        onRetry={() => {
          window.location.reload();
        }}
      />
    </GuardFrame>
  );
}
