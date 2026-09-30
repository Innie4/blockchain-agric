import { Suspense, type ReactNode } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { CLUSTER_LABEL, SOLANA_CLUSTER } from "../../lib/solana";
import { LoadingState } from "../states/LoadingState";
import { Icon } from "../ui/Icon";
import { WalletButton } from "./WalletButton";

const PUBLIC_LINKS: ReadonlyArray<{ to: string; label: string }> = [
  { to: "/verify", label: "Verify a batch" },
  { to: "/search", label: "Search produce" },
];

/**
 * The frame for the pages anyone may open: the landing page, public
 * verification and public search. It is deliberately lighter than the signed-in
 * shell — no role navigation, no notices, and a footer that stays out of the way.
 *
 * `children` is used by the catch-all route, which renders this frame around a
 * single page rather than around nested routes.
 */
export function PublicShell({ children }: { children?: ReactNode }) {
  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to the main content
      </a>

      <header className="app-header">
        <div className="container app-header__inner">
          <Link className="wordmark" to="/">
            <Icon name="leaf" size={20} className="wordmark__mark" />
            <span>
              Agricultural Traceability
              <span className="wordmark__sub"> &nbsp;farm to shelf, on the record</span>
            </span>
          </Link>

          <nav className="app-nav app-nav--inline" aria-label="Public">
            <ul className="app-nav__list app-nav__list--inline">
              {PUBLIC_LINKS.map((link) => (
                <li key={link.to} className="app-nav__item">
                  <NavLink className="app-nav__link" to={link.to}>
                    {link.label}
                  </NavLink>
                </li>
              ))}
              <li className="app-nav__item">
                <NavLink className="app-nav__link" to="/app">
                  Participant sign in
                </NavLink>
              </li>
            </ul>
          </nav>

          <div className="app-header__actions">
            <WalletButton />
          </div>
        </div>
      </header>

      <main className="shell__main" id="main-content" tabIndex={-1}>
        <div className="container">
          <Suspense fallback={<LoadingState label="Loading this page" />}>
            {children ?? <Outlet />}
          </Suspense>
        </div>
      </main>

      <footer className="app-footer">
        <div className="container app-footer__legal">
          Records are written to {CLUSTER_LABEL[SOLANA_CLUSTER]} and can be checked by anyone. This
          application never holds a private key.
        </div>
      </footer>
    </div>
  );
}
