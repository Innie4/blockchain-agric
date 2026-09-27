import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getHealth } from "../../api/endpoints";
import { messageForError, recoveryHintFor } from "../../api/errors";
import type { HealthReport } from "../../api/types";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  Icon,
  Panel,
  Spinner,
  type IconName,
} from "../../components/ui/Index";
import { CLUSTER_LABEL, SOLANA_CLUSTER, SOLANA_CLUSTERS, type SolanaCluster } from "../../lib/solana";

/* ------------------------------------------------------------------ *
 * The six categories of participant the record is built for
 * ------------------------------------------------------------------ */

interface ParticipantCategory {
  readonly role: string;
  readonly icon: IconName;
  readonly description: string;
}

const PARTICIPANTS: readonly ParticipantCategory[] = [
  {
    role: "Farmer",
    icon: "leaf",
    description:
      "Registers the batch at harvest: the crop, the quantity, the farm location and the harvest date, then signs the record that anchors those details.",
  },
  {
    role: "Processor",
    icon: "clipboard",
    description:
      "Records what was done to the batch after harvest, with the date, the activity and any supporting document, so the change can be checked later.",
  },
  {
    role: "Transporter",
    icon: "truck",
    description:
      "Records each leg of the journey, the route taken and the delivery status, so a delay or a substitution in transit has somewhere to show.",
  },
  {
    role: "Retailer",
    icon: "store",
    description:
      "Lists the batch for sale, records the asking price and marks it sold. The record stays afterwards, so a buyer can still check what happened to it.",
  },
  {
    role: "Consumer",
    icon: "user",
    description:
      "Checks any batch from the identifier printed on the packaging. No account, no wallet and no sign-in are needed to do this.",
  },
  {
    role: "Regulator",
    icon: "shield",
    description:
      "Reviews every mismatch, withholds a batch that should not move, and exports the record of who checked what and when.",
  },
];

/* ------------------------------------------------------------------ *
 * What a buyer is actually able to confirm
 * ------------------------------------------------------------------ */

const CHECKABLE_FACTS: readonly string[] = [
  "The product type recorded at registration",
  "The quantity and the unit it is counted in",
  "The farm location, as the farmer recorded it",
  "The harvest date",
  "The date the batch was registered",
  "Every processing event, with its date and description",
  "Every transport event, from origin to destination",
  "Every change of ownership, and which category of business took it on",
  "The certificates attached to the batch, with the body that issued each one",
  "Who has checked the batch before, and what they found",
];

/* ------------------------------------------------------------------ *
 * The honest network indicator
 * ------------------------------------------------------------------ */

type NetworkState =
  | { readonly phase: "checking" }
  | { readonly phase: "reachable"; readonly label: string }
  | { readonly phase: "unreachable"; readonly message: string; readonly hint: string | null };

/**
 * The cluster name is taken from the server's own report when it names one this
 * build recognises, so the interface never claims a network the deployment is
 * not actually using.
 */
function clusterLabelFor(report: HealthReport): string {
  const reported = report.runtime["solanaNetwork"];
  if (typeof reported === "string" && (SOLANA_CLUSTERS as readonly string[]).includes(reported)) {
    return CLUSTER_LABEL[reported as SolanaCluster];
  }
  return CLUSTER_LABEL[SOLANA_CLUSTER];
}

function NetworkStatus() {
  const [state, setState] = useState<NetworkState>({ phase: "checking" });
  const controllerRef = useRef<AbortController | null>(null);

  const check = useCallback(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ phase: "checking" });
    getHealth(controller.signal)
      .then((report) => {
        if (controller.signal.aborted) return;
        if (report.status.trim().toLowerCase() !== "ok") {
          setState({
            phase: "unreachable",
            message: "The records service did not report itself as healthy.",
            hint: "Wait a moment and try again. Checking a batch is unavailable until it does.",
          });
          return;
        }
        setState({ phase: "reachable", label: clusterLabelFor(report) });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          phase: "unreachable",
          message: messageForError(error),
          hint: recoveryHintFor(error),
        });
      });
  }, []);

  useEffect(() => {
    check();
    return () => controllerRef.current?.abort();
  }, [check]);

  return (
    <div aria-live="polite" aria-busy={state.phase === "checking"}>
      {state.phase === "checking" ? (
        <p className="cluster cluster--tight text-sm text-secondary">
          <Spinner size={16} />
          <span>Checking whether the record can be reached.</span>
        </p>
      ) : state.phase === "reachable" ? (
        <p className="cluster cluster--tight text-sm">
          <Badge tone="success" icon="check">
            Connected to {state.label}
          </Badge>
          <span className="text-secondary">
            A batch can be checked from its identifier right now, with no account.
          </span>
        </p>
      ) : (
        <div className="notice notice--danger">
          <Icon name="alertTriangle" size={18} />
          <div className="notice__body">
            <p className="notice__title">Blockchain not reachable — checking is unavailable right now.</p>
            <p className="text-sm text-secondary">{state.message}</p>
            {state.hint === null ? null : (
              <p className="text-sm text-secondary">What to do: {state.hint}</p>
            )}
            <p className="notice__actions">
              <button type="button" className="btn btn--secondary btn--sm" onClick={check}>
                <Icon name="refresh" size={16} />
                Check again
              </button>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function LandingPage() {
  return (
    <div className="page">
      <section aria-labelledby="landing-hero" className="stack">
        <div className="stack stack--tight measure">
          <h1>Trace the batch, not the story</h1>
          <p className="text-secondary">
            When a farmer registers a batch, the details they enter are reduced to a single
            fingerprint and written to the Solana network. This application keeps the full record
            in its own store and publishes only what a buyer needs. Anyone can put the two side by
            side and see whether they still agree.
          </p>
        </div>

        <div className="cluster">
          <Link className="btn btn--primary" to="/verify">
            <Icon name="search" size={16} />
            Check a batch
          </Link>
          <Link className="btn btn--secondary" to="/connect">
            <Icon name="link" size={16} />
            Connect your wallet
          </Link>
        </div>

        <NetworkStatus />
      </section>

      <hr className="divider" />

      <section aria-labelledby="how-a-batch-is-checked" className="stack">
        <h2 id="how-a-batch-is-checked">How a batch is checked</h2>
        <div className="measure text-secondary">
          <p>
            The network does not store the crop, the weight or the farm. It stores a fingerprint of
            those details, taken once, at the moment the farmer signed the registration. The
            details themselves stay in the application's own records.
          </p>
          <p>
            When you enter a batch identifier, the server does three things: it reads the anchored
            fingerprint from the network, it rebuilds a fingerprint from the details as they are
            stored now, and it compares the two. You see both values and the verdict.
          </p>
          <p>
            If the two fingerprints agree, the details are the ones the farmer signed. If they do
            not, something changed after registration — a correction, an edit, or a substitution —
            and the application cannot tell which. So the batch is reported as unverified, the
            stored history is not presented as trustworthy, and the check is written to the record
            so a regulator can see it. A fingerprint is not a judgement about the produce; it is
            evidence about the paperwork.
          </p>
        </div>
      </section>

      <section aria-labelledby="who-takes-part" className="stack">
        <h2 id="who-takes-part">Who takes part</h2>
        <p className="measure text-secondary">
          Six kinds of participant hold the record. Each one adds something different, and each
          one signs their own entry.
        </p>

        <Panel>
          <div className="grid grid--3">
            {PARTICIPANTS.map((participant) => (
              <Card key={participant.role} quiet>
                <CardHeader>
                  <h3 className="card__title cluster cluster--tight">
                    <Icon name={participant.icon} size={18} />
                    {participant.role}
                  </h3>
                </CardHeader>
                <CardBody>
                  <p className="text-sm text-secondary">{participant.description}</p>
                </CardBody>
              </Card>
            ))}
          </div>
        </Panel>
      </section>

      <section aria-labelledby="what-a-buyer-can-check" className="stack">
        <h2 id="what-a-buyer-can-check">What a buyer can check</h2>
        <p className="measure text-secondary">
          From a batch identifier alone, with no account and no wallet, these are the facts the
          application will show you and the fingerprint check will cover:
        </p>

        <div className="grid grid--2">
          <Panel title="Recorded at registration">
            <ul className="stack stack--tight">
              {CHECKABLE_FACTS.slice(0, 5).map((fact) => (
                <li key={fact} className="cluster cluster--tight text-sm">
                  <Icon name="check" size={16} className="text-success" />
                  <span>{fact}</span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Added along the chain">
            <ul className="stack stack--tight">
              {CHECKABLE_FACTS.slice(5).map((fact) => (
                <li key={fact} className="cluster cluster--tight text-sm">
                  <Icon name="check" size={16} className="text-success" />
                  <span>{fact}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <div className="cluster">
          <Link className="btn btn--primary" to="/verify">
            <Icon name="search" size={16} />
            Check a batch
          </Link>
          <Link className="btn btn--quiet" to="/search">
            Search the registry instead
          </Link>
        </div>
      </section>
    </div>
  );
}
