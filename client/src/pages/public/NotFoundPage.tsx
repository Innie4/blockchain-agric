import { Link } from "react-router-dom";
import { Panel } from "../../components/ui/Index";
import { useAuth } from "../../context/AuthContext";

export default function NotFoundPage() {
  const { status } = useAuth();
  const isSignedIn = status === "authenticated";

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__text">
          <h1 className="page-header__title">That page does not exist</h1>
          <p className="page-header__description">
            The address was not recognised. It may have been mistyped, or the page may have been
            moved. Nothing was changed, and nothing was lost.
          </p>
        </div>
      </header>

      <Panel title="What you can do instead">
        <div className="stack">
          <p className="measure text-secondary">
            If you were sent here from a label or a link on a pack, the identifier on that
            packaging is the thing to check. These are the pages that are always available.
          </p>
          <ul className="transaction__steps">
            <li className="transaction__step">
              <span className="transaction__step-marker" aria-hidden="true">
                1
              </span>
              <span>
                <Link to="/verify">Check a batch</Link> from the identifier printed on the
                packaging. No account needed.
              </span>
            </li>
            <li className="transaction__step">
              <span className="transaction__step-marker" aria-hidden="true">
                2
              </span>
              <span>
                <Link to="/search">Search the registry</Link> by crop type or farm location.
                Summary information only, and no account needed.
              </span>
            </li>
            <li className="transaction__step">
              <span className="transaction__step-marker" aria-hidden="true">
                3
              </span>
              <span>
                <Link to="/">Go to the start</Link> to read what this system records and who takes
                part in it.
              </span>
            </li>
            {isSignedIn ? (
              <li className="transaction__step" data-state="current">
                <span className="transaction__step-marker" aria-hidden="true">
                  4
                </span>
                <span>
                  <Link to="/app">Go to your dashboard</Link>, where the batches and transfers your
                  wallet holds are listed.
                </span>
              </li>
            ) : null}
          </ul>
        </div>
      </Panel>
    </div>
  );
}
