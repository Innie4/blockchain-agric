import {
  isProductStatus,
  PROVENANCE_KIND_LABELS,
  type ProvenanceEvent,
  type ProvenanceKind,
} from "../../api/types";
import { actorName, formatDateTime, toIsoString, truncateAddress, truncateHash } from "../../lib/format";
import { explorerTxUrl } from "../../lib/solana";
import { Icon, type IconName } from "./Icon";
import { StatusBadge } from "./StatusBadge";

const KIND_ICONS: Record<ProvenanceKind, IconName> = {
  REGISTERED: "leaf",
  TRANSFER: "package",
  PROCESSING: "clipboard",
  TRANSPORT: "truck",
  STATUS: "flag",
  VERIFICATION: "shield",
  RETAIL: "store",
};

export interface TimelineProps {
  events: readonly ProvenanceEvent[];
  emptyLabel?: string;
  className?: string;
}

/**
 * The provenance record, oldest event first.
 *
 * It is an ordered list because it is a sequence, not a set. A flagged event
 * carries a written warning as well as a marker, so the concern is never
 * signalled by colour alone.
 */
export function Timeline({ events, emptyLabel, className }: TimelineProps) {
  if (events.length === 0) {
    return (
      <p className={["text-secondary text-sm", className].filter(isPresent).join(" ")}>
        {emptyLabel ?? "No history has been recorded for this batch yet."}
      </p>
    );
  }

  return (
    <ol className={["timeline", className].filter(isPresent).join(" ")}>
      {events.map((event) => {
        const occurredAt = toIsoString(event.occurredAt);
        const transactionUrl = explorerTxUrl(event.transactionSignature);
        return (
          <li
            key={`${event.sequence}-${event.occurredAt}-${event.kind}`}
            className={[
              "timeline__item",
              event.flagged ? "timeline__item--flagged" : null,
            ]
              .filter(isPresent)
              .join(" ")}
          >
            <span className="timeline__marker">
              <Icon name={event.flagged ? "flag" : KIND_ICONS[event.kind]} size={14} />
            </span>

            <div className="timeline__content">
              <div className="timeline__heading">
                <h4 className="timeline__title">{event.title}</h4>
                {occurredAt === undefined ? null : (
                  <time className="timeline__time" dateTime={occurredAt}>
                    {formatDateTime(event.occurredAt)}
                  </time>
                )}
              </div>

              {event.detail.trim().length === 0 ? null : (
                <p className="timeline__detail">{event.detail}</p>
              )}

              <div className="timeline__meta">
                <span>
                  {PROVENANCE_KIND_LABELS[event.kind]} by{" "}
                  {actorName(null, event.actorWallet, event.actorRole)}
                </span>
                {event.status !== null && isProductStatus(event.status) ? (
                  <StatusBadge status={event.status} />
                ) : null}
                {event.dataHash === null ? null : (
                  <span>
                    Hash <span className="hash">{truncateHash(event.dataHash)}</span>
                  </span>
                )}
                {transactionUrl === null ? null : (
                  <a href={transactionUrl} target="_blank" rel="noreferrer noopener">
                    View on Solana Explorer
                    <span className="visually-hidden">
                      {" "}
                      for {truncateAddress(event.transactionSignature)}, opens in a new tab
                    </span>
                  </a>
                )}
              </div>

              {event.flagged ? (
                <p className="timeline__flag">
                  <Icon name="warning" size={14} />
                  <span>
                    A regulator has raised a concern about this entry. Treat the details with care
                    until it is resolved.
                  </span>
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function isPresent(value: string | null | undefined): value is string {
  return value !== null && value !== undefined;
}
