import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { searchProducts } from "../../api/endpoints";
import {
  VERIFICATION_RESULT_LABELS,
  type SearchResult,
  type VerificationResult,
} from "../../api/types";
import { ErrorState, LoadingState } from "../../components/states";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Icon,
  Panel,
  StatusBadge,
  Table,
  TextInput,
  type BadgeTone,
  type TableColumn,
} from "../../components/ui/Index";
import { formatQuantity } from "../../lib/format";
import { verificationPath } from "../../lib/solana";

const MINIMUM_TERM_LENGTH = 2;
const MAXIMUM_TERM_LENGTH = 200;
const SEARCH_FIELD_ID = "search-term";

const SEARCH_HELP =
  "Searchable by batch identifier, by product type such as cocoa or maize, or by the farm " +
  "location as it was recorded. At least two characters are needed.";

const RESULT_TONES: Record<VerificationResult, BadgeTone> = {
  VERIFIED: "success",
  MISMATCH: "danger",
  NOT_FOUND: "neutral",
  INCOMPLETE: "warning",
};

const COLUMNS: readonly TableColumn<SearchResult>[] = [
  {
    key: "batch",
    header: "Batch",
    isRowHeader: true,
    render: (row) => (
      <span>
        <span className="hash">{row.productId}</span>
        <span className="table__secondary">{row.cropType}</span>
      </span>
    ),
  },
  {
    key: "product",
    header: "Product",
    render: (row) => row.cropType,
  },
  {
    key: "quantity",
    header: "Quantity",
    align: "right",
    render: (row) => formatQuantity(row.quantity, row.unit),
  },
  {
    key: "stage",
    header: "Stage",
    render: (row) => (
      <span className="stack stack--tight">
        <StatusBadge status={row.status} />
        <span className="table__secondary">{row.statusLabel}</span>
      </span>
    ),
  },
  {
    key: "lastChecked",
    header: "Last checked",
    render: (row) => (
      <Badge tone={RESULT_TONES[row.lastVerificationResult]}>
        {VERIFICATION_RESULT_LABELS[row.lastVerificationResult]}
      </Badge>
    ),
  },
  {
    key: "action",
    header: "Check",
    render: (row) => (
      <Link className="btn btn--secondary btn--sm" to={verificationPath(row.productId)}>
        <Icon name="shield" size={16} />
        Check
        <span className="visually-hidden"> batch {row.productId}</span>
      </Link>
    ),
  },
];

type SearchState =
  | { readonly phase: "idle" }
  | { readonly phase: "searching"; readonly term: string }
  | { readonly phase: "failed"; readonly term: string; readonly error: unknown }
  | { readonly phase: "done"; readonly term: string; readonly results: readonly SearchResult[] };

export default function SearchPage() {
  const [term, setTerm] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [state, setState] = useState<SearchState>({ phase: "idle" });
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  const runSearch = useCallback((rawTerm: string) => {
    const trimmed = rawTerm.trim();
    const problem =
      trimmed.length < MINIMUM_TERM_LENGTH
        ? `Enter at least ${MINIMUM_TERM_LENGTH} characters to search.`
        : trimmed.length > MAXIMUM_TERM_LENGTH
          ? `Keep the search to ${MAXIMUM_TERM_LENGTH} characters or fewer.`
          : null;
    if (problem !== null) {
      setFieldError(problem);
      return;
    }

    setFieldError(null);
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ phase: "searching", term: trimmed });

    searchProducts(trimmed, undefined, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setState({ phase: "done", term: trimmed, results: response.results });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: "failed", term: trimmed, error });
      });
  }, []);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    runSearch(term);
  }

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__text">
          <h1 className="page-header__title">Search the registry</h1>
          <p className="page-header__description">
            Searching returns a summary of every registered batch that matches — nothing more, and
            with no account. Open a result to run a full check against the blockchain record.
          </p>
        </div>
      </header>

      <Panel title="Search">
        <form onSubmit={onSubmit} noValidate>
          <div className="stack">
            <Field
              id={SEARCH_FIELD_ID}
              label="What are you looking for?"
              hint={SEARCH_HELP}
              error={fieldError}
              required
            >
              <TextInput
                name="q"
                type="search"
                value={term}
                onChange={(event) => {
                  const next = event.target.value;
                  setTerm(next);
                  if (fieldError !== null) {
                    setFieldError(
                      next.trim().length < MINIMUM_TERM_LENGTH
                        ? `Enter at least ${MINIMUM_TERM_LENGTH} characters to search.`
                        : null,
                    );
                  }
                }}
                placeholder="cocoa"
                autoComplete="off"
                spellCheck={false}
                maxLength={MAXIMUM_TERM_LENGTH}
              />
            </Field>

            <div className="cluster">
              <Button type="submit" variant="primary">
                <Icon name="search" size={16} />
                Search
              </Button>
              <Link className="btn btn--secondary" to="/verify">
                Check a batch identifier instead
              </Link>
            </div>
          </div>
        </form>
      </Panel>

      <div aria-busy={state.phase === "searching"}>
        {state.phase === "idle" ? (
          <EmptyState
            icon="search"
            title="Nothing searched yet"
            description="Enter a batch identifier, a crop or a farm location above. Results show the batch, its stage and the outcome of the last check."
            action={
              <Link className="btn btn--primary" to="/verify">
                <Icon name="shield" size={16} />
                Check a batch identifier
              </Link>
            }
          />
        ) : null}

        {state.phase === "searching" ? (
          <LoadingState label={`Searching for ${state.term}`} rows={4} />
        ) : null}

        {state.phase === "failed" ? (
          <ErrorState
            error={state.error}
            title={`The search for "${state.term}" could not be completed`}
            retryLabel="Search again"
            onRetry={() => {
              runSearch(state.term);
            }}
            actions={
              <Link className="btn btn--secondary" to="/verify">
                Check a batch identifier
              </Link>
            }
          />
        ) : null}

        {state.phase === "done" ? (
          state.results.length === 0 ? (
            <div className="stack">
              <p role="status" className="text-sm text-secondary">
                No registered batch matches {state.term}.
              </p>
              <EmptyState
                icon="search"
                tone="info"
                title={`Nothing registered matches "${state.term}"`}
                description="No batch has been registered under that identifier, crop or farm location. Check the spelling, try a shorter term, or check the batch by its identifier."
                action={
                  <div className="cluster cluster--tight">
                    <Link className="btn btn--primary" to="/verify">
                      <Icon name="shield" size={16} />
                      Check a batch identifier
                    </Link>
                    <Button variant="secondary" onClick={() => runSearch(state.term)}>
                      <Icon name="refresh" size={16} />
                      Search again
                    </Button>
                  </div>
                }
              />
            </div>
          ) : (
            <Panel
              title="Matches"
              actions={
                <Badge tone="neutral">
                  {state.results.length} {state.results.length === 1 ? "batch" : "batches"}
                </Badge>
              }
            >
              <p role="status" className="text-sm text-secondary">
                {state.results.length} registered{" "}
                {state.results.length === 1 ? "batch matches" : "batches match"} {state.term}.
                Open one to run the full check.
              </p>
              <Table
                caption="Registered batches matching your search"
                columns={COLUMNS}
                rows={state.results}
                rowKey={(row) => row.productId}
                compact
                emptyState={
                  <EmptyState
                    icon="search"
                    title={`Nothing registered matches "${state.term}"`}
                    description="No batch has been registered under that identifier, crop or farm location."
                  />
                }
              />
            </Panel>
          )
        ) : null}
      </div>

      <p className="text-xs text-muted measure">
        A search shows summary information only: what each batch is, how much of it there is, what
        stage it has reached and how the last check ended. Opening a batch is what runs the full
        comparison, and that too needs no account.{" "}
        <Link to="/connect">Connect a wallet</Link> only if you intend to register, transfer or
        record something yourself.
      </p>
    </div>
  );
}
