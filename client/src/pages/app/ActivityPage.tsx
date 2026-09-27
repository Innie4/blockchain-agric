import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getActivity } from "../../api/endpoints";
import {
  PROVENANCE_KIND_LABELS,
  type ActivityEntry,
  type ActivityFeed,
  type ProvenanceKind,
} from "../../api/types";
import { PageHeader } from "../../components/layout/PageHeader";
import { ErrorState, LoadingState } from "../../components/states";
import { Button, EmptyState, Icon, Panel, Table, type TableColumn } from "../../components/ui/Index";
import { DatedTimeValue, PaginationControls } from "./appUi";
import { usePageParam } from "./appData";

/**
 * What this participant has done, newest first.
 *
 * The feed is the participant's own audit trail, so it is read rather than
 * acted on. Each row comes from a stored record, and the outcome column repeats
 * the server's own verdict rather than colouring it.
 */

const PAGE_SIZE = 8;

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly error: unknown }
  | { readonly phase: "ready"; readonly feed: ActivityFeed };

const COLUMNS: readonly TableColumn<ActivityEntry>[] = [
  {
    key: "what",
    header: "What happened",
    isRowHeader: true,
    render: (row) => (
      <span className="stack stack--tight">
        <span>{row.title}</span>
        <span className="table__secondary">
          {row.detail}
          <span className="table__secondary">
            {PROVENANCE_KIND_LABELS[row.kind as ProvenanceKind] ?? row.kind}
          </span>
        </span>
      </span>
    ),
  },
  {
    key: "batch",
    header: "Batch",
    render: (row) =>
      row.productId === null ? (
        <span className="text-secondary">Not batch specific</span>
      ) : (
        <Link className="hash" to={`/app/products/${encodeURIComponent(row.productId)}`}>
          {row.productId}
        </Link>
      ),
  },
  {
    key: "actor",
    header: "Recorded against",
    render: (row) => row.actorWallet ?? "The registry",
  },
  {
    key: "when",
    header: "When",
    render: (row) => <DatedTimeValue value={row.occurredAt} />,
  },
];

export default function ActivityPage() {
  const [page, setPage] = usePageParam();
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  const load = useCallback(() => {
    setState({ phase: "loading" });
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    getActivity({ page, pageSize: PAGE_SIZE }, controller.signal)
      .then((feed) => {
        if (controller.signal.aborted) return;
        setState({ phase: "ready", feed });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: "failed", error });
      });

    return () => controller.abort();
  }, [page]);

  const heading = (
    <PageHeader
      title="Your activity"
      description="Every registration, transfer, processing entry, journey and check recorded against your wallet, newest first."
      actions={
        <Link className="btn btn--secondary" to="/app/products">
          <Icon name="package" size={16} />
          Go to my batches
        </Link>
      }
    />
  );

  if (state.phase === "loading") {
    return (
      <div className="page">
        {heading}
        <LoadingState label="Reading your activity" rows={8} />
      </div>
    );
  }

  if (state.phase === "failed") {
    return (
      <div className="page">
        {heading}
        <ErrorState
          error={state.error}
          title="Your activity could not be read"
          retryLabel="Read it again"
          onRetry={load}
        />
      </div>
    );
  }

  const entries = state.feed.entries;
  const pagination = state.feed.pagination;

  if (entries.length === 0) {
    return (
      <div className="page">
        {heading}
        <EmptyState
          icon="flag"
          title="Nothing has been recorded against your wallet yet"
          description="Your activity appears here as soon as you register a batch, send or receive a transfer, record processing or a journey, or run a deliberate check. Nothing is inferred and nothing is filled in."
          action={
            <div className="cluster cluster--tight">
              <Link className="btn btn--primary" to="/app/products/register">
                <Icon name="leaf" size={16} />
                Register a batch
              </Link>
              <Link className="btn btn--secondary" to="/app/products">
                See the batches you hold
              </Link>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="page">
      {heading}

      <Panel
        title="Recorded actions"
        actions={
          <span className="text-xs text-muted">
            {pagination.total} in total
          </span>
        }
      >
        <Table
          caption="Actions recorded against your wallet, newest first"
          columns={COLUMNS}
          rows={entries}
          rowKey={(row) => row.id}
          emptyState={
            <EmptyState
              icon="flag"
              title="Nothing on this page"
              description="There is no activity to show for this page of the feed."
            />
          }
        />
        <PaginationControls
          pagination={pagination}
          onPageChange={setPage}
          noun="recorded actions"
        />
      </Panel>

      <Panel title="How this list is built">
        <div className="measure stack text-sm text-secondary">
          <p>
            Every row here is a stored record: a batch you registered, a transfer you sent or
            received, a processing entry or journey you recorded, or a check you asked for. The
            page shows what the registry holds and nothing else.
          </p>
          <p>
            A check made from the public verification page by somebody with no account is not in
            this list, because it was not made by you. A regulator sees the whole network&rsquo;s
            checks on the compliance dashboard.
          </p>
        </div>
      </Panel>

      <div className="cluster">
        <Button variant="quiet" onClick={load}>
          <Icon name="refresh" size={16} />
          Read this page again
        </Button>
      </div>
    </div>
  );
}
