import { CLUSTER_LABEL, SOLANA_CLUSTER } from "../../lib/solana";

/** The site footer. Deliberately factual: what this is, and what it is not. */
export function Footer() {
  return (
    <footer className="app-footer">
      <div className="container">
        <div className="app-footer__inner">
          <div className="stack stack--tight">
            <p className="text-primary text-sm" style={{ fontWeight: 500 }}>
              Agricultural Traceability
            </p>
            <p className="app-footer__note text-sm">
              A decentralised record of where a batch of produce came from and what has happened to
              it since. Registration, transfers and lifecycle changes are written to{" "}
              {CLUSTER_LABEL[SOLANA_CLUSTER]} and can be checked by anyone.
            </p>
          </div>

          <nav className="app-footer__links" aria-label="Footer">
            <a className="text-sm" href="/verify">
              Verify a batch
            </a>
            <a className="text-sm" href="/search">
              Search produce
            </a>
            <a className="text-sm" href="/app">
              Sign in
            </a>
            <a className="text-sm" href="/connect">
              Wallet help
            </a>
          </nav>
        </div>

        <p className="app-footer__legal">
          This application never holds a private key. Every action is signed by the participant's
          own wallet, and the session it opens expires on its own. Records are public once written.
        </p>
      </div>
    </footer>
  );
}
