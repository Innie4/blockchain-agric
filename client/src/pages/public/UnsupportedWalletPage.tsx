import { Link } from "react-router-dom";
import { Icon, Panel } from "../../components/ui/Index";

const INSTALL_STEPS: readonly { readonly title: string; readonly detail: string }[] = [
  {
    title: "Open your browser's extension store",
    detail:
      "In Chrome, Edge, Brave or Opera this is the extensions page. In Firefox, Solana support comes from an add-on rather than an extension.",
  },
  {
    title: "Find Phantom",
    detail:
      "Look for the extension named Phantom, published by Phantom Technologies, and check that the name and the publisher are what you expect before installing it.",
  },
  {
    title: "Install it, then create a wallet in the extension",
    detail:
      "The extension asks you to create a new wallet or to import an existing one. Keep the recovery phrase the extension shows you: it is the only way to restore the wallet, and nobody, including this application, can recover it for you.",
  },
  {
    title: "Reload this page",
    detail:
      "A browser injects the wallet into the page, so a page loaded before the wallet was installed cannot see it. Reload once the extension is installed and this page will find it.",
  },
  {
    title: "Connect it on the connect page",
    detail:
      "Use the connect button there. Approving a connection shares your public address and signs nothing at all.",
  },
];

export default function UnsupportedWalletPage() {
  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__text">
          <h1 className="page-header__title">This page needs a Solana wallet</h1>
          <p className="page-header__description">
            Registering a batch, transferring it, recording processing or transport, and reviewing
            mismatches all have to be signed by a wallet, so this browser needs one installed
            before it can do any of that.
          </p>
        </div>
      </header>

      <div className="notice notice--info">
        <Icon name="info" size={18} />
        <div className="notice__body">
          <p className="notice__title">This page will not install anything for you</p>
          <p className="text-sm text-secondary">
            A wallet is a browser extension that you install yourself, from your browser's own
            store. There is no download link here, because a wallet arriving from anywhere other
            than the browser's store cannot be trusted. Nothing has been installed, downloaded or
            requested by loading this page.
          </p>
        </div>
      </div>

      <Panel title="What is supported">
        <div className="measure stack text-sm text-secondary">
          <p>
            <strong>Phantom</strong> is the supported option, and the steps below are written for
            it. It is a browser extension available for Chrome, Edge, Brave, Opera and Firefox.
          </p>
          <p>
            Backpack and Solflare expose the same interface and connect from this application too,
            but Phantom is the one that is guaranteed to work here.
          </p>
        </div>
      </Panel>

      <section aria-labelledby="install-steps" className="stack">
        <h2 id="install-steps">Installing Phantom, step by step</h2>
        <Panel>
          <ol className="stack">
            {INSTALL_STEPS.map((step, index) => (
              <li key={step.title} className="transaction__step" data-state="current">
                <span className="transaction__step-marker" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="stack stack--tight">
                  <span className="text-primary text-sm">{step.title}</span>
                  <span className="text-secondary text-sm">{step.detail}</span>
                </span>
              </li>
            ))}
          </ol>
        </Panel>
      </section>

      <div className="notice notice--warning">
        <Icon name="shield" size={18} />
        <div className="notice__body">
          <p className="notice__title">Nobody legitimate will ask for your recovery phrase</p>
          <p className="text-sm text-secondary">
            Your wallet extension will never ask you to type the phrase that created it, and this
            application has no field that accepts one. If a page, a message or a person asks you
            for it, they are trying to take the wallet, not to help you.
          </p>
        </div>
      </div>

      <Panel title="You do not need a wallet to check a batch">
        <div className="stack">
          <p className="measure text-secondary">
            Verifying produce is a public action. The identifier printed on the packaging is enough
            to see the record and whether it still matches the blockchain, and no account, wallet
            or signature is involved at any point.
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
    </div>
  );
}
