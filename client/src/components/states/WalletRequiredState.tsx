import { CLUSTER_LABEL, SOLANA_CLUSTER } from "../../lib/solana";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { EmptyState } from "../ui/EmptyState";

export interface WalletRequiredStateProps {
  /** True while the wallet's own approval prompt is open. */
  isConnecting?: boolean;
  onConnect?: () => void;
  /** True when the browser has no injected wallet at all. */
  noWalletDetected?: boolean;
  /** What the participant was trying to do, so the message stays specific. */
  purpose?: string;
}

/**
 * Shown wherever a wallet is needed. It distinguishes the three cases that look
 * the same from the outside: no wallet installed, a wallet that is locked, and
 * a wallet that is simply not connected yet.
 */
export function WalletRequiredState({
  isConnecting = false,
  onConnect,
  noWalletDetected = false,
  purpose,
}: WalletRequiredStateProps) {
  const reason = purpose === undefined ? "" : ` to ${purpose}`;

  if (noWalletDetected) {
    return (
      <EmptyState
        icon="package"
        title="No Solana wallet found in this browser"
        description={
          `This application records its actions with a Solana wallet, and needs one${reason}. ` +
          "Install Phantom, Backpack or Solflare from your browser's extension store, then " +
          "reload this page. Nothing is sent anywhere and no key is stored by this site."
        }
        action={
          <Button
            variant="secondary"
            onClick={() => {
              if (typeof window !== "undefined") window.location.reload();
            }}
          >
            <Icon name="refresh" size={16} />
            Reload the page
          </Button>
        }
      />
    );
  }

  return (
    <EmptyState
      icon="user"
      title="Connect your wallet"
      description={
        `Everything recorded here is signed by the wallet that holds the batch, ` +
        `so signing is what proves it is yours${reason}. The application never sees your ` +
        `private key, and the session it opens ends on its own. This deployment uses ` +
        `${CLUSTER_LABEL[SOLANA_CLUSTER]}.`
      }
      action={
        onConnect === undefined ? null : (
          <Button variant="primary" loading={isConnecting} loadingLabel="Opening your wallet" onClick={onConnect}>
            <Icon name="link" size={16} />
            Connect wallet
          </Button>
        )
      }
    />
  );
}
