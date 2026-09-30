import { Suspense, useState } from "react";
import { Link, Outlet } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { LoadingState } from "../states/LoadingState";
import { Icon } from "../ui/Icon";
import { Footer } from "./Footer";
import { NotificationBell } from "./NotificationBell";
import { Sidebar } from "./Sidebar";
import { WalletButton } from "./WalletButton";

/**
 * The frame for the signed-in area.
 *
 * It carries the landmarks a screen reader needs to move around: a skip link
 * that jumps past the header and the navigation, a `banner` header, a `main`
 * region with a name, and a `contentinfo` footer.
 *
 * The navigation is a sidebar rather than a row of links across the top. There
 * are eleven destinations once a participant is signed in, which is past what fits
 * in a header on a laptop without wrapping or scrolling, and a wrapped header row
 * pushes the page content down by an unpredictable amount. A sidebar also gives
 * each destination room for an icon and keeps the current one identifiable while
 * scrolling a long page.
 */
export function AppShell() {
  const { needsRoleSelection, needsOnChainRegistration } = useAuth();
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="shell shell--sidebar">
      <a className="skip-link" href="#main-content">
        Skip to the main content
      </a>

      <header className="app-header">
        <div className="container app-header__inner">
          <button
            type="button"
            className="btn btn--quiet btn--sm app-header__nav-toggle"
            aria-expanded={navOpen}
            aria-controls="app-sidebar"
            onClick={() => setNavOpen((open) => !open)}
          >
            <Icon name={navOpen ? "x" : "menu"} size={18} />
            <span>Menu</span>
          </button>

          <Link className="wordmark" to="/app/dashboard">
            <Icon name="leaf" size={20} className="wordmark__mark" />
            <span>Agricultural Traceability</span>
          </Link>

          <div className="app-header__actions">
            <NotificationBell />
            <WalletButton />
          </div>
        </div>
      </header>

      <div className="shell__body">
        <Sidebar open={navOpen} onDismiss={() => setNavOpen(false)} />

        <main className="shell__main" id="main-content" tabIndex={-1}>
          <div className="container">
            {needsRoleSelection ? (
              <p className="notice notice--info notice--page-top">
                <Icon name="info" size={18} />
                <span className="notice__body">
                  <span className="notice__title">Your account is a consumer account</span>
                  Consumers can verify any batch publicly. If you are a farmer, processor, transporter,
                  retailer or regulator, choose your role and register on the blockchain so you can
                  take part in the chain.
                  <span className="cluster cluster--tight notice__actions">
                    <Link className="btn btn--secondary btn--sm" to="/app/profile">
                      Choose your role
                    </Link>
                  </span>
                </span>
              </p>
            ) : needsOnChainRegistration ? (
              <p className="notice notice--warning notice--page-top">
                <Icon name="warning" size={18} />
                <span className="notice__body">
                  <span className="notice__title">Your wallet is not yet on the blockchain</span>
                  Until it is registered as a participant, actions that write to the chain will be
                  refused. Registration takes one signature.
                  <span className="cluster cluster--tight notice__actions">
                    <Link className="btn btn--secondary btn--sm" to="/app/profile">
                      Register on the blockchain
                    </Link>
                  </span>
                </span>
              </p>
            ) : null}

            <Suspense fallback={<LoadingState label="Loading this page" />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>

      <Footer />
    </div>
  );
}
