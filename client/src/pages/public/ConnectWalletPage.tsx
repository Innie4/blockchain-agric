import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { messageForError, recoveryHintFor } from "../../api/errors";
import { ROLE_LABELS } from "../../api/types";
import { ErrorState, LoadingState } from "../../components/states";
import {
  Badge,
  Button,
  Icon,
  Panel,
  Spinner,
} from "../../components/ui/Index";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { useWalletState } from "../../context/WalletContext";
import { truncateAddress } from "../../lib/format";
import { wrongNetworkMessage } from "../../lib/solana";

/** What signing in actually does, in the order it happens. */
const SIGN_IN_STEPS: readonly string[] = [
  "The server issues a single-use challenge addressed to your wallet.",
  "Your wallet signs that exact text. Nothing else is ever sent for signing.",
  "The server checks the signature and opens a session for this browser only.",
];

export default function ConnectWalletPage() {
  const {
    status,
    publicKey,
    hasWallet,
    connecting,
    walletName,
    clusterLabel,
    failure,
    error: walletError,
    connect,
    disconnect,
  } = useWalletState();
  const { status: authStatus, user, signIn } = useAuth();
  const { push } = useToast();

  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [localFailure, setLocalFailure] = useState<unknown>(null);

  const isConsumer = user !== null && user.role === "CONSUMER";

  const onConnect = useCallback(() => {
    setLocalFailure(null);
    void connect().catch((error: unknown) => {
      setLocalFailure(error);
      push({
        tone: "error",
        title: "The wallet did not connect",
        message: messageForError(error),
      });
    });
  }, [connect, push]);

  const onSignIn = useCallback(() => {
    if (publicKey === null) return;
    setIsSigningIn(true);
    setLocalFailure(null);
    void signIn(publicKey)
      .then((result) => {
        push({
          tone: "success",
          title: "Signed in",
          message: result.needsOnChainRegistration
            ? "Your wallet is signed in. It still has to be registered on the blockchain before you can record anything."
            : "Your wallet is signed in.",
        });
      })
      .catch((error: unknown) => {
        setLocalFailure(error);
        push({
          tone: "error",
          title: "Could not sign in",
          message: messageForError(error),
        });
      })
      .finally(() => setIsSigningIn(false));
  }, [publicKey, push, signIn]);

  const onDisconnect = useCallback(() => {
    setIsDisconnecting(true);
    setLocalFailure(null);
    void disconnect()
      .then(() => {
        push({ tone: "info", title: "Wallet disconnected" });
      })
      .catch((error: unknown) => {
        setLocalFailure(error);
        push({
          tone: "warning",
          title: "The wallet did not confirm the disconnect",
          message: messageForError(error),
        });
      })
      .finally(() => setIsDisconnecting(false));
  }, [disconnect, push]);

  function copyAddress(): void {
    if (publicKey === null) return;
    void navigator.clipboard
      ?.writeText(publicKey)
      .then(() => {
        push({ tone: "info", title: "Address copied to the clipboard" });
      })
      .catch(() => {
        push({
          tone: "warning",
          title: "The address could not be copied",
          message: "Select the address and copy it manually.",
        });
      });
  }

  /* ---------------------------------------------------------------- *
   * What the wallet is doing right now
   * ---------------------------------------------------------------- */

  function connectionPanel() {
    if (status === "detecting") {
      return <LoadingState label="Looking for a Solana wallet in this browser" />;
    }

    if (status === "unavailable" || !hasWallet) {
      return (
        <div className="notice notice--warning">
          <Icon name="package" size={18} />
          <div className="notice__body">
            <p className="notice__title">No Solana wallet was found in this browser</p>
            <p className="text-sm text-secondary">
              Everything recorded in this application is signed by a wallet, so there has to be
              one installed. Install Phantom from your browser's extension store, then reload
              this page. Nothing was installed or sent anywhere.
            </p>
            <p className="notice__actions cluster cluster--tight">
              <Link className="btn btn--primary btn--sm" to="/auth/unsupported-wallet">
                <Icon name="fileText" size={16} />
                How to install Phantom
              </Link>
              <Button variant="secondary" size="sm" onClick={onConnect}>
                <Icon name="refresh" size={16} />
                Look again
              </Button>
            </p>
          </div>
        </div>
      );
    }

    if (status === "connected" && publicKey !== null) {
      return (
        <div className="stack">
          <div className="notice notice--success">
            <Icon name="check" size={18} />
            <div className="notice__body">
              <p className="notice__title">
                {walletName ?? "Your wallet"} is connected to {clusterLabel}
              </p>
              <p className="text-sm text-secondary">
                The address below is the identity this application records against. It was shared
                by the wallet itself; no key left it.
              </p>
            </div>
          </div>

          <dl className="definition-list">
            <dt>Connected address</dt>
            <dd>
              <span className="cluster cluster--tight">
                <span className="hash" title={publicKey} aria-label={`Wallet address ${publicKey}`}>
                  {truncateAddress(publicKey)}
                </span>
                <Button variant="quiet" size="sm" onClick={copyAddress}>
                  <Icon name="clipboard" size={16} />
                  Copy
                  <span className="visually-hidden"> the full wallet address</span>
                </Button>
              </span>
            </dd>

            <dt>Network</dt>
            <dd>{clusterLabel}</dd>

            <dt>Participant role</dt>
            <dd>{user === null ? "Not signed in yet" : ROLE_LABELS[user.role]}</dd>
          </dl>

          <div className="cluster">
            <Button
              variant="secondary"
              loading={isDisconnecting}
              loadingLabel="Asking the wallet to disconnect"
              onClick={onDisconnect}
            >
              <Icon name="x" size={16} />
              Disconnect
            </Button>
            <Link className="btn btn--quiet" to="/app">
              Open the participant dashboard
            </Link>
          </div>
        </div>
      );
    }

    if (connecting || status === "connecting") {
      return (
        <div className="stack" aria-live="polite" aria-busy="true">
          <p className="cluster cluster--tight text-secondary">
            <Spinner size={18} />
            <span>
              Approve the connection in {walletName ?? "your wallet"}. This page waits until the
              wallet answers, and nothing is signed while you wait.
            </span>
          </p>
        </div>
      );
    }

    if (failure === "WRONG_NETWORK") {
      return (
        <div className="notice notice--danger">
          <Icon name="warning" size={18} />
          <div className="notice__body">
            <p className="notice__title">The wallet is on the wrong network</p>
            <p className="text-sm text-secondary">{wrongNetworkMessage()}</p>
            <p className="text-sm text-secondary">
              This deployment reads from <strong>{clusterLabel}</strong>. Open your wallet's
              settings, choose the network selector, pick {clusterLabel}, and connect again.
            </p>
            <p className="notice__actions">
              <Button variant="primary" size="sm" onClick={onConnect}>
                <Icon name="refresh" size={16} />
                Try connecting again
              </Button>
            </p>
          </div>
        </div>
      );
    }

    if (status === "locked" || (failure !== null && walletError !== null)) {
      return (
        <ErrorState
          error={walletError}
          title="The wallet did not complete the request"
          retryLabel="Try again"
          onRetry={onConnect}
          actions={
            <Link className="btn btn--secondary" to="/auth/unsupported-wallet">
              Wallet help
            </Link>
          }
        />
      );
    }

    return (
      <div className="stack">
        <p className="text-secondary">
          {walletName ?? "A Solana wallet"} is installed in this browser but is not connected.
          Connecting only asks the wallet to share its public address; nothing is signed at this
          point.
        </p>
        <div className="cluster">
          <Button variant="primary" onClick={onConnect}>
            <Icon name="link" size={16} />
            Connect
          </Button>
          <Link className="btn btn--quiet" to="/auth/unsupported-wallet">
            Wallet help
          </Link>
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- *
   * The page
   * ---------------------------------------------------------------- */

  const showSignIn =
    status === "connected" && publicKey !== null && authStatus !== "authenticated";

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__text">
          <h1 className="page-header__title">Connect your wallet</h1>
          <p className="page-header__description">
            This application uses a Solana wallet as a participant's identity, so that every
            registration, transfer and lifecycle change is signed by the business that actually
            holds the batch.
          </p>
        </div>
      </header>

      <div className="notice notice--success">
        <Icon name="shield" size={18} />
        <div className="notice__body">
          <p className="notice__title">This application never asks for your seed phrase</p>
          <p className="text-sm text-secondary">
            There is no field anywhere in this application for a recovery phrase or a private key,
            and nothing you type here is sent to the network. Your wallet holds the key; this page
            only asks the wallet to sign, and only when you press a button that needs signing.
            Anyone who asks you for your seed phrase is not this application.
          </p>
        </div>
      </div>

      <Panel title="This browser">{connectionPanel()}</Panel>

      {showSignIn ? (
        <Panel title="One more step: prove you control the wallet">
          <div className="stack">
            <p className="measure text-secondary">
              The wallet is connected, which only means it shared its address. Signing in asks the
              wallet to sign one piece of text, so the server can be sure the person at the
              keyboard holds the wallet. It performs three steps:
            </p>

            <ol className="transaction__steps">
              {SIGN_IN_STEPS.map((step, index) => (
                <li key={step} className="transaction__step" data-state={index === 0 ? "current" : undefined}>
                  <span className="transaction__step-marker" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span>
                    <span className="visually-hidden">Step {index + 1}. </span>
                    {step}
                  </span>
                </li>
              ))}
            </ol>

            <div className="cluster">
              <Button
                variant="primary"
                loading={isSigningIn}
                loadingLabel="Waiting for your wallet to sign the sign-in request"
                onClick={onSignIn}
              >
                <Icon name="user" size={16} />
                Sign in with this wallet
              </Button>
              <Link className="btn btn--quiet" to="/app">
                Open the dashboard instead
              </Link>
            </div>
          </div>
        </Panel>
      ) : null}

      {isConsumer ? (
        <Panel title="Checking a batch needs no wallet">
          <div className="stack">
            <p className="measure text-secondary">
              You can verify any batch from the identifier printed on its packaging, with no
              account and no signature. Connecting a wallet only helps if you intend to register,
              transfer or record something yourself, which a consumer account does not do.
            </p>
            <div className="cluster">
              <Link className="btn btn--primary" to="/verify">
                <Icon name="shield" size={16} />
                Check a batch
              </Link>
              <Link className="btn btn--secondary" to="/search">
                <Icon name="search" size={16} />
                Search the registry
              </Link>
            </div>
          </div>
        </Panel>
      ) : null}

      {localFailure === null ? null : (
        <div className="stack stack--tight">
          <p className="text-sm text-danger">{messageForError(localFailure)}</p>
          {recoveryHintFor(localFailure) === null ? null : (
            <p className="text-sm text-secondary">What to do: {recoveryHintFor(localFailure)}</p>
          )}
        </div>
      )}

      <Panel title="What each network name means">
        <div className="measure stack text-sm text-secondary">
          <p>
            This deployment reads from <strong>{clusterLabel}</strong>. Devnet and testnet hold no
            real value and are reset periodically; a record written there is a working record, not
            a permanent one.
          </p>
          <p>
            <Badge tone="info" icon="info">
              Never share a recovery phrase
            </Badge>
          </p>
          <p>
            A wallet extension asks you to approve a connection and to sign a transaction. It never
            asks for the phrase that created it, and neither does this application. If a page
            claims otherwise, close it.
          </p>
        </div>
      </Panel>
    </div>
  );
}
