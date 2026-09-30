import { useState } from "react";
import { Link } from "react-router-dom";
import { messageForError } from "../../api/errors";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { useWalletState } from "../../context/WalletContext";
import { truncateAddress } from "../../lib/format";
import { useMenuDismiss } from "../../lib/useMenuDismiss";
import { isDemoDataEnabled } from "../../demo/mode";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";

const NO_WALLET_GUIDANCE =
  "No Solana wallet was found in this browser. Phantom, Backpack and Solflare are supported. " +
  "Open the setup page for instructions.";

/**
 * Shown instead, while placeholder data is in use.
 *
 * Asking someone to install a wallet they do not need in order to review the
 * product would be sending them off to do work for a demonstration. Saying
 * plainly that no wallet is needed here is more useful and more honest than
 * repeating an instruction that does not apply.
 */
const DEMO_WALLET_GUIDANCE =
  "No wallet is connected, and none is needed: these screens are showing placeholder data, " +
  "so nothing here is signed and nothing is written to a blockchain.";

/**
 * Connect, show the connected address, and sign out.
 *
 * The four states a wallet can be in are distinguished on purpose: still
 * looking, none installed, connected, and connected but being asked to approve.
 * They look identical from outside the browser extension, and collapsing them
 * is what makes wallet UIs frustrating.
 */
export function WalletButton() {
  const {
    status,
    publicKey,
    connect,
    disconnect,
    connecting,
    walletName,
    clusterLabel,
    error: walletError,
  } = useWalletState();
  const { signOut } = useAuth();
  const { push } = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const menuRef = useMenuDismiss<HTMLDivElement>(menuOpen, () => setMenuOpen(false));

  if (status === "detecting") {
    return (
      <Button variant="secondary" disabled>
        Looking for a wallet
      </Button>
    );
  }

  if (status === "unavailable") {
    // While placeholder data is in use there is nothing to sign, so the button
    // offers the wallet setup page as an aside rather than as a requirement.
    if (isDemoDataEnabled()) {
      return (
        <div className="cluster cluster--tight">
          <span className="badge badge--info" title={DEMO_WALLET_GUIDANCE}>
            <Icon name="info" size={16} />
            No wallet needed
            <span className="visually-hidden">. {DEMO_WALLET_GUIDANCE}</span>
          </span>
        </div>
      );
    }
    return (
      <div ref={menuRef} className="cluster cluster--tight">
        <Link className="btn btn--primary" to="/connect" title={NO_WALLET_GUIDANCE}>
          <Icon name="link" size={16} />
          Set up a wallet
          <span className="visually-hidden">. {NO_WALLET_GUIDANCE}</span>
        </Link>
      </div>
    );
  }

  if (publicKey === null) {
    return (
      <Button
        variant="primary"
        loading={connecting || status === "connecting"}
        loadingLabel="Waiting for your wallet"
        {...(walletError === null ? {} : { title: walletError })}
        onClick={() => {
          void connect()
            .then((address) => {
              push({
                tone: "success",
                title: "Wallet connected",
                message: `Connected as ${truncateAddress(address)}. Sign in to open your records.`,
              });
            })
            .catch((cause: unknown) => {
              // The header keeps the standing explanation; the toast says what
              // just happened, which is the part that changes.
              push({
                tone: "error",
                title: "The wallet did not connect",
                message: messageForError(cause),
              });
            });
        }}
      >
        <Icon name="link" size={16} />
        Connect wallet
      </Button>
    );
  }

  return (
    <div ref={menuRef} className="cluster cluster--tight" style={{ position: "relative" }}>
      <button
        type="button"
        className="btn btn--secondary btn--sm"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <span className="wallet-button__address">{truncateAddress(publicKey)}</span>
        <Icon name="chevronRight" size={14} className="rotate-90" />
        <span className="visually-hidden">Wallet menu for {publicKey}</span>
      </button>

      {menuOpen ? (
        <div className="menu" role="menu" aria-label="Wallet">
          <div className="menu__header">
            <span>{walletName ?? "Wallet"}</span>
            <span className="text-xs text-muted">{clusterLabel}</span>
          </div>
          <div className="menu__item">
            <span className="text-xs text-muted">Connected address</span>
            <span className="hash text-xs">{publicKey}</span>
          </div>
          <div className="menu__item">
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(publicKey)
                  .then(() =>
                    push({ tone: "info", title: "Address copied to the clipboard" }),
                  )
                  .catch(() =>
                    push({
                      tone: "warning",
                      title: "The address could not be copied",
                      message: "Select the address and copy it manually.",
                    }),
                  );
                setMenuOpen(false);
              }}
            >
              <Icon name="clipboard" size={16} />
              Copy address
            </button>
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              disabled={isSigningOut}
              onClick={() => {
                setIsSigningOut(true);
                void disconnect()
                  .catch(() => {
                    push({
                      tone: "warning",
                      title: "The wallet did not confirm the disconnect",
                    });
                  })
                  .then(() => signOut())
                  .catch(() => {
                    push({
                      tone: "error",
                      title: "Could not sign out",
                      message: "Reload the page to end the session on the server.",
                    });
                  })
                  .finally(() => {
                    setIsSigningOut(false);
                    setMenuOpen(false);
                  });
              }}
            >
              Disconnect wallet
            </button>
          </div>
          <div className="menu__item">
            <Link className="btn btn--quiet btn--sm" to="/app/profile" onClick={() => setMenuOpen(false)}>
              View participant profile
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
