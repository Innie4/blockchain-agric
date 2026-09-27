import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getProductHistory } from "../../../api/endpoints";
import {
  type HistoryIntegrity,
  type ProductHistoryResponse,
  type ProductStatus,
} from "../../../api/types";
import { PageHeader } from "../../../components/layout/PageHeader";
import { ErrorState, LoadingState, NotFoundState } from "../../../components/states";
import { Badge, Button, Icon, Panel, Timeline } from "../../../components/ui/Index";
import { formatNumber } from "../../../lib/format";
import { explorerAddressUrl, explorerTxUrl } from "../../../lib/solana";
import { isNotFound, isProductStatusOrNull, useCopyToClipboard, useProductId } from "../appData";
import { ChainStateBadge, DatedTimeValue, MetricRow, MetricTile, SignatureValue } from "../appUi";

/**
 * The provenance record, and the integrity check that makes it worth reading.
 *
 * The integrity result is given the most prominent place on the page, because it
 * decides how everything else on it should be read. A match means the history is
 * the record the supply chain agreed on; a mismatch means something changed after
 * registration, and the history below has to be read as a claim rather than a
 * fact.
 */

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly error: unknown }
  | { readonly phase: "ready"; readonly history: ProductHistoryResponse };

interface IntegrityPresentation {
  title: string;
  tone: "primary" | "danger" | "warning";
  badge: string;
  badgeTone: "success" | "danger" | "warning";
  icon: "check" | "alertTriangle" | "warning";
  reading: string;
}

function presentIntegrity(integrity: HistoryIntegrity): IntegrityPresentation {
  if (integrity.status === "MATCH") {
    return {
      title: "The record still matches the blockchain",
      tone: "primary",
      badge: "Match",
      badgeTone: "success",
      icon: "check",
      reading:
        "The fingerprint held for this batch is the same one anchored on the blockchain at registration. Nothing in the record has changed since. The history below is the agreed account of what happened to this batch, and a buyer can rely on it.",
    };
  }
  if (integrity.status === "MISMATCH") {
    return {
      title: "The record no longer matches the blockchain",
      tone: "danger",
      badge: "Mismatch",
      badgeTone: "danger",
      icon: "alertTriangle",
      reading:
        "The fingerprint held for this batch differs from the one anchored on the blockchain. Something changed after the batch was registered, or the record was tampered with. Treat every detail below as unverified, do not rely on it to decide whether to buy, and report the batch to a regulator.",
    };
  }
  return {
    title: "The blockchain record could not be read",
    tone: "warning",
    badge: "Not checked",
    badgeTone: "warning",
    icon: "warning",
    reading:
      "The on-chain account for this batch could not be read, so its fingerprint could not be compared. That may be a network problem or a registration that never completed. Nothing on this page should be read as confirmed. Try again shortly.",
  };
}

function CountTile({ label, value }: { label: string; value: number }) {
  return <MetricTile label={label} value={formatNumber(value)} />;
}

export default function ProductHistoryPage() {
  const productId = useProductId();
  const copy = useCopyToClipboard();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  useEffect(() => {
    if (productId === null) return;
    const controller = new AbortController();
    setState({ phase: "loading" });

    getProductHistory(productId, controller.signal)
      .then((history) => {
        if (controller.signal.aborted) return;
        setState({ phase: "ready", history });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: "failed", error });
      });

    return () => controller.abort();
  }, [attempt, productId]);

  if (productId === null) {
    return (
      <div className="page">
        <PageHeader title="Provenance" description="No batch identifier was given in the address." />
        <NotFoundState
          title="No batch identifier was given"
          description="The address on this page did not include a batch identifier, so there is no history to read."
          action={
            <Link className="btn btn--primary" to="/app/products">
              Go to the batch list
            </Link>
          }
        />
      </div>
    );
  }

  const heading = (
    <PageHeader
      title={`History of batch ${productId}`}
      description="Every event recorded against this batch, in the order it happened, with the integrity of the record stated first."
      breadcrumbs={[
        { label: "Batches", to: "/app/products" },
        { label: productId, to: `/app/products/${encodeURIComponent(productId)}` },
        { label: "History" },
      ]}
      actions={
        <div className="cluster cluster--tight">
          <Link
            className="btn btn--secondary"
            to={`/app/products/${encodeURIComponent(productId)}/verify`}
          >
            <Icon name="shield" size={16} />
            Check it now
          </Link>
          <Link
            className="btn btn--secondary"
            to={`/app/products/${encodeURIComponent(productId)}`}
          >
            <Icon name="package" size={16} />
            Batch details
          </Link>
        </div>
      }
    />
  );

  if (state.phase === "loading") {
    return (
      <div className="page">
        {heading}
        <LoadingState label={`Reading the history of batch ${productId}`} rows={8} />
      </div>
    );
  }

  if (state.phase === "failed") {
    if (isNotFound(state.error)) {
      return (
        <div className="page">
          {heading}
          <NotFoundState
            title={`No batch is registered as ${productId}`}
            description="The registry holds no record under this identifier, so there is no history to read."
            action={
              <Link className="btn btn--primary" to="/app/products">
                Go to the batch list
              </Link>
            }
          />
        </div>
      );
    }
    return (
      <div className="page">
        {heading}
        <ErrorState
          error={state.error}
          title={`The history of batch ${productId} could not be read`}
          retryLabel="Read it again"
          onRetry={retry}
        />
      </div>
    );
  }

  const { integrity, counts, provenance, dataHash, onChainDataHash, onChainTxHash, onChainAddress, status, chainState } =
    state.history;
  const presentation = presentIntegrity(integrity);
  const flagged = provenance.filter((event) => event.flagged);
  const addressUrl = explorerAddressUrl(onChainAddress);
  const transactionUrl = explorerTxUrl(onChainTxHash);
  const currentStatus: ProductStatus | null = isProductStatusOrNull(status);

  return (
    <div className="page">
      {heading}

      <div role="alert">
        <Panel tone={presentation.tone} title={presentation.title}>
          <div className="stack">
            <div className="cluster cluster--tight">
              <Badge tone={presentation.badgeTone} icon={presentation.icon}>
                Integrity: {presentation.badge}
              </Badge>
              {currentStatus === null ? null : (
                <span className="text-xs text-muted">
                  Current stage is {state.history.statusLabel.toLowerCase()}
                </span>
              )}
              <ChainStateBadge state={chainState} />
            </div>
            <p className="measure text-secondary">{integrity.detail}</p>
            <p className="measure text-secondary">{presentation.reading}</p>
            {presentation.tone === "danger" ? (
              <p className="measure text-sm">
                <strong>What to do:</strong> report this batch to a regulator. Do not buy it, do not
                process it and do not rely on any detail below until a regulator has reviewed it.
              </p>
            ) : null}
          </div>
        </Panel>
      </div>

      <Panel title="What the record contains">
        <MetricRow>
          <CountTile label="Transfers" value={counts.transfers} />
          <CountTile label="Processing entries" value={counts.processingEvents} />
          <CountTile label="Journeys" value={counts.transportEvents} />
          <CountTile label="Certificates" value={counts.certificates} />
          <CountTile label="Checks recorded" value={counts.verifications} />
        </MetricRow>
        <p className="measure text-xs text-muted">
          Each figure is a count of stored records for this batch, read from the records service just
          now. None of it is estimated.
        </p>
      </Panel>

      <Panel
        title="The fingerprints that were compared"
        actions={
          <Badge
            tone={
              integrity.status === "MATCH"
                ? "success"
                : integrity.status === "MISMATCH"
                  ? "danger"
                  : "warning"
            }
            icon={presentation.icon}
          >
            {presentation.badge}
          </Badge>
        }
      >
        <div className="stack">
          <p className="measure text-secondary">
            Two values decide whether this record can be trusted. A reader can compare them without
            trusting this interface&rsquo;s conclusion.
          </p>
          <dl className="definition-list">
            <dt>Anchored on the blockchain</dt>
            <dd>
              {onChainDataHash === null || onChainDataHash.length === 0 ? (
                <span className="text-secondary">
                  Nothing is anchored, so there is no fingerprint to compare against.
                </span>
              ) : (
                <span className="stack stack--tight">
                  <span className="hash">{onChainDataHash}</span>
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={() => { copy(onChainDataHash, "Anchored fingerprint"); }}
                  >
                    <Icon name="clipboard" size={16} />
                    Copy the anchored fingerprint
                  </Button>
                </span>
              )}
            </dd>

            <dt>Held in the records</dt>
            <dd>
              <span className="stack stack--tight">
                <span className="hash">{dataHash}</span>
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => { copy(dataHash, "Stored fingerprint"); }}
                >
                  <Icon name="clipboard" size={16} />
                  Copy the stored fingerprint
                </Button>
              </span>
            </dd>

            <dt>Result of comparing them</dt>
            <dd>
              {integrity.status === "MATCH"
                ? "They are the same value."
                : integrity.status === "MISMATCH"
                  ? "They are different values, so the record has been changed since registration."
                  : "No comparison was possible, because the blockchain record could not be read."}
            </dd>
          </dl>
        </div>
      </Panel>

      <Panel title="Where this record lives on the blockchain">
        <dl className="definition-list">
          <dt>On-chain account</dt>
          <dd>
            {onChainAddress === null || onChainAddress.length === 0 ? (
              <span className="text-secondary">
                No account address has been returned, so this record cannot be opened on the
                explorer.
              </span>
            ) : (
              <span className="stack stack--tight">
                <span className="hash">{onChainAddress}</span>
                {addressUrl === null ? null : (
                  <a href={addressUrl} target="_blank" rel="noreferrer noopener">
                    Open this account on Solana Explorer
                    <span className="visually-hidden">, opens in a new tab</span>
                  </a>
                )}
              </span>
            )}
          </dd>

          <dt>Registration transaction</dt>
          <dd>
            <SignatureValue signature={onChainTxHash} />
            {transactionUrl === null ? null : (
              <span className="text-xs text-muted">
                Every event in the history below carries its own transaction reference, and links to
                the explorer from there.
              </span>
            )}
          </dd>
        </dl>
      </Panel>

      <Panel
        title="The record, in order"
        actions={
          flagged.length === 0 ? null : (
            <Badge tone="warning" icon="flag">
              {flagged.length} flagged {flagged.length === 1 ? "entry" : "entries"}
            </Badge>
          )
        }
      >
        {flagged.length > 0 ? (
          <div className="notice notice--warning">
            <Icon name="flag" size={18} />
            <div className="notice__body">
              <p className="notice__title">
                {flagged.length} {flagged.length === 1 ? "entry has" : "entries have"} been flagged
              </p>
              <p className="text-sm text-secondary">
                A regulator has raised a concern about {flagged.length === 1 ? "this entry" : "these entries"}
                . Each one is marked in the list below with a written warning, not colour alone.
                Read its detail with care until the concern is resolved.
              </p>
            </div>
          </div>
        ) : null}

        <Timeline
          events={provenance}
          emptyLabel="Nothing has been recorded against this batch yet. A batch's first entry is its registration, which is written when the farmer signs."
        />
      </Panel>

      {notesForStatus(status).map((note) => (
        <Panel key={note.key} tone="warning" title={note.title}>
          <p className="measure text-secondary">{note.body}</p>
        </Panel>
      ))}

      <Panel title="Reading this record">
        <div className="measure stack text-sm text-secondary">
          <p>
            Every entry in the list was written by the participant named on it, and each one carries
            the fingerprint of its own contents. Where an entry changed the stage of the batch, it
            also carries the Solana transaction that did it, so the change can be checked on the
            explorer by anyone.
          </p>
          <p>
            The checks recorded against this batch are deliberate ones: somebody opened the
            verification page and the attempt was logged, so a regulator can see who looked at what.
            A check that found a mismatch is marked in the list, and a mismatch is a fact about the
            record rather than about the produce.
          </p>
          <p>
            {provenance.length === 0 ? (
              "Nothing has been recorded against this batch yet."
            ) : (
              <>
                The last entry above is dated{" "}
                <DatedTimeValue value={provenance.at(-1)?.occurredAt ?? null} />. The kinds of event
                recorded so far are{" "}
                {[
                  ...new Set(provenance.map((event) => event.kind.replace(/_/g, " ").toLowerCase())),
                ].join(", ")}
                .
              </>
            )}
          </p>
        </div>
      </Panel>
    </div>
  );
}

/** Notes about the batch's stage that are worth saying in their own right. */
function notesForStatus(status: ProductStatus): ReadonlyArray<{ key: string; title: string; body: string }> {
  if (status === "FLAGGED") {
    return [
      {
        key: "flagged",
        title: "A regulator has withheld this batch",
        body: "A regulator has marked this batch as withheld. It cannot be transferred, processed or sold, and the batch owner has been told. It stays on the record permanently: the concern, and its resolution, are both part of the history above.",
      },
    ];
  }
  return [];
}
