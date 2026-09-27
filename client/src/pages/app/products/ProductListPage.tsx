import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { listProducts } from "../../../api/endpoints";
import {
  CHAIN_STATES,
  CHAIN_STATE_LABELS,
  PRODUCT_STATUSES,
  STATUS_LABELS,
  type Product,
  type ProductListResponse,
  type ProductStatus,
} from "../../../api/types";
import { PageHeader } from "../../../components/layout/PageHeader";
import { ErrorState, LoadingState } from "../../../components/states";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Icon,
  Panel,
  Select,
  StatusBadge,
  Table,
  TextInput,
  type TableColumn,
} from "../../../components/ui/Index";
import { useAuth } from "../../../context/AuthContext";
import { formatDateTime, formatQuantity, toIsoString } from "../../../lib/format";
import { STATUS_OPTIONS, usePageParam, useScopeParam } from "../appData";
import { ChainStateBadge, PaginationControls } from "../appUi";

/**
 * The batches a participant can see.
 *
 * The scope is the honest question a participant actually asks: the batches I
 * am responsible for, or everything in the registry. It lives in the address, so
 * a filtered list can be shared or bookmarked as it stands.
 *
 * Filters are applied when the form is submitted, not on every keystroke, so a
 * half-typed crop name never sends a request.
 */

const PAGE_SIZE = 12;

interface Filters {
  search: string;
  status: ProductStatus | "";
  cropType: string;
}

const EMPTY_FILTERS: Filters = { search: "", status: "", cropType: "" };

function readFilters(params: URLSearchParams): Filters {
  const status = params.get("status") ?? "";
  return {
    search: params.get("search") ?? "",
    status: (PRODUCT_STATUSES as readonly string[]).includes(status)
      ? (status as ProductStatus)
      : "",
    cropType: params.get("cropType") ?? "",
  };
}

function filtersAreSet(filters: Filters): boolean {
  return (
    filters.search.trim().length > 0 ||
    filters.status !== "" ||
    filters.cropType.trim().length > 0
  );
}

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly error: unknown }
  | { readonly phase: "ready"; readonly response: ProductListResponse };

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

function RegisteredCell({ product }: { product: Product }) {
  if (product.chainState === "CONFIRMED") {
    return (
      <span className="stack stack--tight">
        <span>
          <time dateTime={toIsoString(product.onChainRegisteredAt)}>
            {formatDateTime(product.onChainRegisteredAt)}
          </time>
        </span>
        <span className="table__secondary">{CHAIN_STATE_LABELS.CONFIRMED}</span>
      </span>
    );
  }
  return (
    <span className="stack stack--tight">
      <ChainStateBadge state={product.chainState} />
      <span className="table__secondary">
        Saved{" "}
        <time dateTime={toIsoString(product.createdAt)}>{formatDateTime(product.createdAt)}</time>
        . Nothing is anchored on the blockchain yet.
      </span>
    </span>
  );
}

const COLUMNS: readonly TableColumn<Product>[] = [
  {
    key: "batch",
    header: "Batch",
    isRowHeader: true,
    render: (row) => (
      <span className="stack stack--tight">
        <span className="hash">{row.productId}</span>
        <span className="table__secondary">{row.farmLocation}</span>
      </span>
    ),
  },
  { key: "product", header: "Product", render: (row) => row.cropType },
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
        <span className="table__secondary">{STATUS_LABELS[row.status]}</span>
      </span>
    ),
  },
  {
    key: "registered",
    header: "Registration",
    render: (row) => <RegisteredCell product={row} />,
  },
  {
    key: "checked",
    header: "Last check",
    render: (row) =>
      row.lastVerifiedAt === null ? (
        <span className="text-secondary">Never checked</span>
      ) : (
        <time dateTime={toIsoString(row.lastVerifiedAt)}>
          {formatDateTime(row.lastVerifiedAt)}
        </time>
      ),
  },
  {
    key: "action",
    header: "Open",
    render: (row) => (
      <Link
        className="btn btn--secondary btn--sm"
        to={`/app/products/${encodeURIComponent(row.productId)}`}
      >
        Open
        <span className="visually-hidden"> batch {row.productId}</span>
      </Link>
    ),
  },
];

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function ProductListPage() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = usePageParam();
  const [scope, setScope] = useScopeParam();

  // The applied filters are read from the address on every render, and the form
  // starts from them. This page is a leaf route, so a fresh arrival from a quick
  // action elsewhere in the application mounts it again and picks the new address
  // up without any synchronising effect.
  const applied = readFilters(searchParams);
  const [draft, setDraft] = useState<Filters>(() => readFilters(searchParams));
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: "loading" });

    listProducts(
      {
        scope,
        ...(applied.search.trim().length > 0 ? { search: applied.search.trim() } : {}),
        ...(applied.status === "" ? {} : { status: applied.status }),
        ...(applied.cropType.trim().length > 0 ? { cropType: applied.cropType.trim() } : {}),
        page,
        pageSize: PAGE_SIZE,
      },
      controller.signal,
    )
      .then((response) => {
        if (controller.signal.aborted) return;
        setState({ phase: "ready", response });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: "failed", error });
      });

    return () => controller.abort();
  }, [applied.cropType, applied.search, applied.status, attempt, page, scope]);

  const applyFilters = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setSearchParams(
        (previous) => {
          const updated = new URLSearchParams(previous);
          if (draft.search.trim().length === 0) updated.delete("search");
          else updated.set("search", draft.search.trim());
          if (draft.status === "") updated.delete("status");
          else updated.set("status", draft.status);
          if (draft.cropType.trim().length === 0) updated.delete("cropType");
          else updated.set("cropType", draft.cropType.trim());
          updated.delete("page");
          return updated;
        },
        { replace: true },
      );
    },
    [draft, setSearchParams],
  );

  const clearFilters = useCallback(() => {
    setSearchParams(
      (previous) => {
        const updated = new URLSearchParams(previous);
        updated.delete("search");
        updated.delete("status");
        updated.delete("cropType");
        updated.delete("page");
        return updated;
      },
      { replace: true },
    );
    setDraft(EMPTY_FILTERS);
  }, [setSearchParams]);

  const canRegister = user !== null && (user.role === "FARMER" || user.role === "REGULATOR");
  const hasFilters = filtersAreSet(applied);
  const products: readonly Product[] | null =
    state.phase === "ready" ? state.response.products : null;
  const pagination = state.phase === "ready" ? state.response.pagination : null;

  const heading = (
    <PageHeader
      title="Batches"
      description={
        scope === "mine"
          ? "Batches you registered or currently hold. A batch appears here as soon as you register it, and moves to the batch you hand it to."
          : "Every batch recorded in the registry. Anything here is public information: what the batch is, how much there is, and which stage it has reached."
      }
      actions={
        canRegister ? (
          <Link className="btn btn--primary" to="/app/products/register">
            <Icon name="leaf" size={16} />
            Register a batch
          </Link>
        ) : undefined
      }
    />
  );

  return (
    <div className="page">
      {heading}

      <div className="cluster" role="group" aria-label="Which batches to show">
        <Button
          variant={scope === "mine" ? "primary" : "secondary"}
          size="sm"
          aria-pressed={scope === "mine"}
          onClick={() => { setScope("mine"); }}
        >
          Batches I hold
        </Button>
        <Button
          variant={scope === "all" ? "primary" : "secondary"}
          size="sm"
          aria-pressed={scope === "all"}
          onClick={() => { setScope("all"); }}
        >
          All batches
        </Button>
        {scope === "mine" ? (
          <span className="text-xs text-muted">
            Signed in as {user === null ? "a participant" : user.fullName || "a participant"}.
          </span>
        ) : null}
      </div>

      <Panel title="Filters">
        <form onSubmit={applyFilters} noValidate>
          <div className="filters">
            <div className="filters__field">
              <Field
                id="products-search"
                label="Search"
                optional
                hint="A batch identifier, a crop, or the farm location as it was recorded."
              >
                <TextInput
                  name="search"
                  type="search"
                  value={draft.search}
                  maxLength={200}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="cocoa"
                  onChange={(event) => { setDraft((c) => ({ ...c, search: event.target.value })); }}
                />
              </Field>
            </div>

            <div className="filters__field">
              <Field id="products-status" label="Stage" optional>
                <Select
                  name="status"
                  value={draft.status}
                  placeholder="Any stage"
                  options={STATUS_OPTIONS}
                  onChange={(event) => {
                    setDraft((c) => ({ ...c, status: event.target.value as ProductStatus | "" }));
                  }}
                />
              </Field>
            </div>

            <div className="filters__field">
              <Field
                id="products-crop"
                label="Crop type"
                optional
                hint="The whole crop name, for example cocoa."
              >
                <TextInput
                  name="cropType"
                  value={draft.cropType}
                  maxLength={120}
                  autoComplete="off"
                  onChange={(event) => { setDraft((c) => ({ ...c, cropType: event.target.value })); }}
                />
              </Field>
            </div>

            <div className="cluster">
              <Button type="submit" variant="primary">
                <Icon name="search" size={16} />
                Apply filters
              </Button>
              {hasFilters ? (
                <Button variant="quiet" onClick={clearFilters}>
                  <Icon name="x" size={16} />
                  Clear filters
                </Button>
              ) : null}
            </div>
          </div>
        </form>
        <p className="text-xs text-muted">
          Filters are applied when you press apply, not as you type. They stay in the address, so
          this exact list can be bookmarked or shared.
        </p>
      </Panel>

      {state.phase === "loading" ? <LoadingState label="Reading batches" rows={8} /> : null}

      {state.phase === "failed" ? (
        <ErrorState
          error={state.error}
          title="The batch list could not be read"
          retryLabel="Read it again"
          onRetry={() => { setAttempt((current) => current + 1); }}
        />
      ) : null}

      {state.phase === "ready" && products !== null && pagination !== null ? (
        <div className="stack">
          {products.length === 0 ? (
            <EmptyState
              icon="package"
              title={describeEmptyTitle(scope, hasFilters)}
              description={describeEmptyBody(scope, hasFilters)}
              action={
                hasFilters ? (
                  <div className="cluster cluster--tight">
                    <Button variant="primary" onClick={clearFilters}>
                      <Icon name="x" size={16} />
                      Clear the filters
                    </Button>
                    {scope === "mine" ? (
                      <Button variant="secondary" onClick={() => { setScope("all"); }}>
                        Show all batches instead
                      </Button>
                    ) : null}
                  </div>
                ) : canRegister ? (
                  <Link className="btn btn--primary" to="/app/products/register">
                    <Icon name="leaf" size={16} />
                    Register a batch
                  </Link>
                ) : (
                  <Link className="btn btn--secondary" to="/verify">
                    <Icon name="shield" size={16} />
                    Check a batch by identifier
                  </Link>
                )
              }
            />
          ) : (
            <Panel
              title={
                scope === "mine"
                  ? "Batches you are responsible for"
                  : "Batches in the registry"
              }
              actions={
                awaitingSignature(products) === 0 ? null : (
                  <Badge tone="warning" icon="warning">
                    {awaitingSignature(products)} waiting for a wallet signature
                  </Badge>
                )
              }
            >
              <p className="text-sm text-secondary" aria-live="polite">
                {pagination.total} matching {pagination.total === 1 ? "batch" : "batches"}.
                {awaitingSignature(products) === 0
                  ? null
                  : ` ${awaitingSignature(products)} ${
                      awaitingSignature(products) === 1 ? "is" : "are"
                    } saved but still waiting for a wallet signature, so nothing is anchored on the blockchain yet.`}
              </p>
              <Table
                caption={
                  scope === "mine"
                    ? "Batches you registered or currently hold"
                    : "Every batch recorded in the registry"
                }
                captionHidden
                columns={COLUMNS}
                rows={products}
                rowKey={(row) => row.productId}
                emptyState={
                  <EmptyState
                    icon="package"
                    title="No batches on this page"
                    description="There is nothing to show for this page of results."
                  />
                }
              />
              <PaginationControls
                pagination={pagination}
                onPageChange={setPage}
                noun="batches"
              />
            </Panel>
          )}
        </div>
      ) : null}

      <Panel title="What the registration column means">
        <div className="measure stack text-sm text-secondary">
          <p>
            A batch exists in two places at once: in these records, and as an account on Solana. A
            batch whose registration reads <em>waiting for a wallet signature</em> has its details
            saved here, but the blockchain copy does not exist yet, so nobody checking it from the
            public page will see it.
          </p>
          <p>{CHAIN_STATE_EXPLANATION}</p>
        </div>
      </Panel>
    </div>
  );
}

/** How many of these batches are saved but not yet anchored on the blockchain. */
function awaitingSignature(products: readonly Product[]): number {
  return products.filter((product) => product.chainState === "AWAITING_SIGNATURE").length;
}

const CHAIN_STATE_EXPLANATION =
  `The chain states are: ${CHAIN_STATES.map((state) => CHAIN_STATE_LABELS[state]).join("; ")}.`;

function describeEmptyTitle(scope: "mine" | "all", hasFilters: boolean): string {
  if (hasFilters) return "No batch matches these filters";
  return scope === "mine"
    ? "You are not responsible for any batch yet"
    : "No batch is registered yet";
}

function describeEmptyBody(scope: "mine" | "all", hasFilters: boolean): string {
  if (hasFilters) {
    return "The crop, stage or text you searched for does not appear in the batches you can see. Widen the filters, or clear them and start again.";
  }
  return scope === "mine"
    ? "A batch appears here once you register it, or once a farmer, processor or retailer hands you one. Until then there is nothing for you to act on."
    : "Nothing has been registered in this registry yet. The first batch a farmer registers will appear here.";
}
