import { Link, isRouteErrorResponse, useNavigate, useRouteError } from "react-router-dom";
import { messageForError, recoveryHintFor } from "../../api/errors";
import { ErrorState } from "../../components/states";
import { Button, Icon, Panel } from "../../components/ui/Index";

/**
 * The generic failure page.
 *
 * It is reached in two ways: the router hands it whatever it caught, and it can
 * also be opened directly at `/error`. Either way it says what happened in plain
 * language, offers a way back, and never shows a stack trace — that belongs in a
 * log the person reading this page will never have access to.
 */
export default function ErrorPage() {
  const error = useRouteError();
  const navigate = useNavigate();

  const routeResponse = isRouteErrorResponse(error)
    ? { status: error.status, detail: typeof error.data === "string" ? error.data : "" }
    : null;

  const heading =
    routeResponse === null
      ? "Something on this page did not work"
      : routeResponse.status === 404
        ? "That page is not here"
        : `This page could not be shown (${routeResponse.status})`;

  const explanation =
    routeResponse === null
      ? messageForError(error)
      : routeResponse.detail.length > 0
        ? routeResponse.detail
        : "The request was refused before this page could be built. Trying again often clears it.";

  const hint = recoveryHintFor(error);

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__text">
          <h1 className="page-header__title">Something went wrong</h1>
          <p className="page-header__description">
            Nothing was changed. The options below will get you back to somewhere useful, and a
            batch can always be checked without an account.
          </p>
        </div>
      </header>

      <ErrorState
        error={new Error(explanation)}
        title={heading}
        retryLabel="Try again"
        onRetry={() => {
          navigate(0);
        }}
        actions={
          <>
            <Link className="btn btn--primary" to="/">
              <Icon name="leaf" size={16} />
              Go to the start
            </Link>
            <Link className="btn btn--secondary" to="/verify">
              <Icon name="shield" size={16} />
              Check a batch
            </Link>
          </>
        }
      />

      {hint === null ? null : (
        <p className="text-sm text-secondary measure">
          <strong>What to do:</strong> {hint}
        </p>
      )}

      <Panel title="Where you can go from here">
        <div className="stack">
          <p className="text-sm text-secondary">
            If the same failure keeps happening, note the time you saw it and report it. The
            application records failures on the server with a reference, so the time and the page
            are enough to find it.
          </p>
          <div className="cluster">
            <Button variant="secondary" onClick={() => navigate(0)}>
              <Icon name="refresh" size={16} />
              Reload this page
            </Button>
            <Link className="btn btn--secondary" to="/search">
              <Icon name="search" size={16} />
              Search the registry
            </Link>
            <Link className="btn btn--quiet" to="/">
              Go to the start
            </Link>
          </div>
        </div>
      </Panel>
    </div>
  );
}
