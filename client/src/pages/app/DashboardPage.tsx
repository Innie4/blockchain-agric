import { Fragment, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  getDashboard,
  prepareParticipantRegistration,
  type ParticipantRegistrationConfirmed,
  submitParticipantRegistration,
} from "../../api/endpoints";
import {
  ROLE_LABELS,
  type DashboardQuickAction,
  type DashboardResponse,
  type DashboardRow,
  type DashboardSection,
  type Prepared,
  type User,
} from "../../api/types";
import { PageHeader } from "../../components/layout/PageHeader";
import { ErrorState, LoadingState, TransactionState } from "../../components/states";
import { Button, EmptyState, Icon, Panel, Table, type TableColumn } from "../../components/ui/Index";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { cellText, describeRole, humaniseKey } from "./appData";
import { MetricRow, MetricTile } from "./appUi";
import { useChainAction } from "./useChainAction";

/**
 * The role-aware landing screen.
 *
 * Every figure, section and action on this page is built by the server from
 * stored records and sent as a payload. Nothing is counted here, and nothing is
 * shown as zero before the payload has arrived: an absent figure is a wait, not
 * a measurement.
 */

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly error: unknown }
  | { readonly phase: "ready"; readonly payload: DashboardResponse };

const DASHBOARD_TITLES: Record<string, string> = {
  FARMER: "Your farm",
  PROCESSOR: "Your processing",
  TRANSPORTER: "Your journeys",
  RETAILER: "Your batches",
  REGULATOR: "Your regulatory view",
  CONSUMER: "Checking a batch",
};

/* ------------------------------------------------------------------ *
 * The server-built sections
 * ------------------------------------------------------------------ */

interface ServerColumn {
  key: string;
  header: string;
  read: (row: DashboardRow) => string;
}

/**
 * Turns a server section into table columns.
 *
 * The server sends the column headers in order and the rows as objects, so a
 * header is matched to a row key by position. The order belongs to the server;
 * this function only reads it.
 */
function columnsFor(section: DashboardSection): readonly ServerColumn[] {
  const headers = section.columns ?? [];
  const first = section.items[0];
  const keys = first === undefined ? [] : Object.keys(first);

  if (headers.length === 0) {
    return keys.map((key) => ({
      key,
      header: humaniseKey(key),
      read: (row: DashboardRow) => cellText(row[key]),
    }));
  }

  return headers.map((header, index) => {
    const key = keys[index] ?? "";
    return {
      key: key.length > 0 ? key : `column-${index}`,
      header,
      read: (row: DashboardRow) => cellText(row[key]),
    };
  });
}

/** One label and value from a server list row. */
function ListRow({ row }: { row: DashboardRow }) {
  return (
    <>
      {Object.entries(row).map(([key, value]) => (
        <Fragment key={key}>
          <dt>{humaniseKey(key)}</dt>
          <dd>{cellText(value)}</dd>
        </Fragment>
      ))}
    </>
  );
}

function SectionEmpty({ section }: { section: DashboardSection }) {
  return (
    <EmptyState
      icon="package"
      title={section.emptyMessage}
      {...(section.emptyAction === undefined
        ? {}
        : {
            action: (
              <Link className="btn btn--primary" to={section.emptyAction.to}>
                {section.emptyAction.label}
              </Link>
            ),
          })}
    />
  );
}

function ServerSection({ section }: { section: DashboardSection }) {
  if (section.kind === "list") {
    return (
      <Panel title={section.title}>
        {section.items.length === 0 ? (
          <SectionEmpty section={section} />
        ) : (
          <dl className="definition-list">
            {section.items.map((row, index) => (
              <ListRow key={`row-${index}`} row={row} />
            ))}
          </dl>
        )}
      </Panel>
    );
  }

  const serverColumns = columnsFor(section);
  const columns: readonly TableColumn<DashboardRow>[] = serverColumns.map((column, index) => ({
    key: column.key,
    header: column.header,
    isRowHeader: index === 0,
    render: (row) => column.read(row),
  }));

  return (
    <Panel
      title={section.title}
      actions={
        <span className="text-xs text-muted">
          {section.items.length} {section.items.length === 1 ? "row" : "rows"}
        </span>
      }
    >
      <Table
        caption={`${section.title}, as reported by the registry`}
        captionHidden
        columns={columns}
        rows={section.items}
        rowKey={(row, index) => `row-${index}-${Object.values(row).join("-")}`}
        compact
        emptyState={<SectionEmpty section={section} />}
      />
    </Panel>
  );
}

function QuickActionCard({ action }: { action: DashboardQuickAction }) {
  return (
    <Link className="card" to={action.to}>
      <span className="card__body stack stack--tight">
        <span className="card__title">
          <span className="cluster cluster--tight">
            <Icon name="link" size={16} />
            {action.label}
          </span>
        </span>
        <span className="text-sm text-secondary">{action.description}</span>
      </span>
    </Link>
  );
}

/* ------------------------------------------------------------------ *
 * On-chain participant registration, offered from the dashboard
 * ------------------------------------------------------------------ */

function RegistrationRequired({ user }: { user: User }) {
  const { refresh } = useAuth();
  const { push } = useToast();
  const [isRegistering, setIsRegistering] = useState(false);

  const action = useChainAction<Prepared, ParticipantRegistrationConfirmed>({
    prepare: async () => {
      const response = await prepareParticipantRegistration({
        role: user.role,
        fullName: user.fullName,
        contactEmail: user.contactInfo.email,
        contactPhone: user.contactInfo.phone,
        organisation: user.organisation,
      });
      return { prepared: response.prepared, record: response.prepared };
    },
    submit: async ({ signedTransaction }) => submitParticipantRegistration(signedTransaction),
    signatureOf: (result) => result.transactionSignature,
    onConfirmed: () => {
      void refresh();
    },
  });

  const finish = useCallback(() => {
    setIsRegistering(false);
    action.reset();
    push({
      tone: "success",
      title: "Your wallet is now a registered participant",
      message: "Registering a batch, and receiving one, are both available to you now.",
    });
  }, [action, push]);

  if (!isRegistering) {
    return (
      <Panel tone="warning" title="Your wallet is not yet registered on the blockchain">
        <div className="stack">
          <p className="measure text-secondary">
            Every record in this application is signed by the wallet that holds the batch, and the
            blockchain has to know that wallet first. Until your wallet is registered on-chain you
            cannot register a batch of your own, and no farmer, processor or retailer can hand one
            to you. Registration takes one signature and cannot be undone.
          </p>
          <div className="cluster">
            <Button
              variant="primary"
              onClick={() => {
                setIsRegistering(true);
                action.run();
              }}
            >
              <Icon name="shield" size={16} />
              Register this wallet now
            </Button>
            <Link className="btn btn--secondary" to="/app/settings">
              Review my details first
            </Link>
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <TransactionState
      phase={action.phase}
      description={action.prepared?.description ?? null}
      prepared={action.prepared}
      signature={action.signature}
      slot={action.slot}
      error={action.error}
      onPrepare={action.run}
      onSign={action.sign}
      onRetry={action.retry}
      onCancel={() => {
        action.cancel();
        setIsRegistering(false);
      }}
      prepareLabel="Prepare the registration"
      signLabel="Sign in my wallet"
      retryLabel="Prepare again"
      cancelLabel="Not now"
      className="transaction--awaiting-signature"
    >
      {action.phase === "confirmed" ? (
        <div className="cluster">
          <Button variant="primary" onClick={finish}>
            <Icon name="check" size={16} />
            Continue
          </Button>
          <Link className="btn btn--quiet" to="/app/products">
            Go to my batches
          </Link>
        </div>
      ) : null}
    </TransactionState>
  );
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function DashboardPage() {
  const { user } = useAuth();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  const load = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: "loading" });

    getDashboard(controller.signal)
      .then((payload) => {
        if (controller.signal.aborted) return;
        setState({ phase: "ready", payload });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: "failed", error });
      });

    return () => controller.abort();
  }, [attempt]);

  const title =
    state.phase === "ready"
      ? (DASHBOARD_TITLES[state.payload.role] ?? "Your workspace")
      : "Your workspace";

  const heading = (
    <PageHeader
      title={title}
      description={
        state.phase === "ready"
          ? state.payload.introduction
          : "Reading your records from the registry. Nothing on this page is calculated in the browser."
      }
      actions={
        <Link className="btn btn--secondary" to="/app/activity">
          <Icon name="flag" size={16} />
          Recent activity
        </Link>
      }
    />
  );

  if (state.phase === "loading") {
    return (
      <div className="page">
        {heading}
        <LoadingState label="Reading your dashboard from the registry" rows={5} />
      </div>
    );
  }

  if (state.phase === "failed") {
    return (
      <div className="page">
        {heading}
        <ErrorState
          error={state.error}
          title="Your dashboard could not be read"
          retryLabel="Read it again"
          onRetry={load}
          actions={
            <Link className="btn btn--secondary" to="/app/products">
              Go to my batches
            </Link>
          }
        />
      </div>
    );
  }

  const { role, metrics, sections, quickActions, onChainRegistrationRequired } = state.payload;
  const isConsumer = role === "CONSUMER";
  const hasFigures = metrics.length > 0;
  const hasSections = sections.length > 0;

  return (
    <div className="page">
      {heading}

      <p className="measure text-sm text-secondary">{describeRole(role)}</p>

      {onChainRegistrationRequired && user !== null ? (
        <RegistrationRequired user={user} />
      ) : null}

      {isConsumer ? (
        <Panel title="There is nothing to manage here">
          <div className="stack">
            <p className="measure text-secondary">
              {state.payload.introduction} A consumer account holds no batches and signs nothing,
              so there is no set of figures to show: a consumer checks a batch, and that is the
              whole of the work involved.
            </p>
            <p className="measure text-secondary">
              If you are a farmer, processor, transporter, retailer or regulator and need to record
              produce, register your wallet as a participant. Your role decides which records you
              are able to sign for, and only an administrator can change it afterwards.
            </p>
            <div className="cluster">
              <Link className="btn btn--primary" to="/verify">
                <Icon name="shield" size={16} />
                Check a batch
              </Link>
              <Link className="btn btn--secondary" to="/search">
                <Icon name="search" size={16} />
                Search the registry
              </Link>
              <Link className="btn btn--quiet" to="/app/profile">
                Register as a participant
              </Link>
            </div>
          </div>
        </Panel>
      ) : null}

      {hasFigures ? (
        <section aria-labelledby="dashboard-figures">
          <h2 className="visually-hidden" id="dashboard-figures">
            Figures from the registry
          </h2>
          <MetricRow>
            {metrics.map((metric) => (
              <MetricTile
                key={metric.label}
                label={metric.label}
                value={metric.value}
                {...(metric.hint === undefined ? {} : { hint: metric.hint })}
                {...(metric.tone === undefined ? {} : { tone: metric.tone })}
              />
            ))}
          </MetricRow>
          <p className="measure text-xs text-muted">
            Each figure is a count of records the server holds against your wallet. Nothing here is
            estimated, and no figure is carried over from an earlier session.
          </p>
        </section>
      ) : null}

      {hasSections ? (
        sections.map((section) => <ServerSection key={section.title} section={section} />)
      ) : null}

      {!hasFigures && !isConsumer ? (
        <EmptyState
          icon="clipboard"
          tone="info"
          title="The registry has no figures for your account yet"
          description="That usually means nothing has been recorded against your wallet. As soon as you register a batch, or one is sent to you, the figures above will fill in."
          action={
            <Link className="btn btn--primary" to="/app/products">
              <Icon name="package" size={16} />
              Go to my batches
            </Link>
          }
        />
      ) : null}

      {quickActions.length > 0 ? (
        <Panel title="What you can do next">
          <div className="grid grid--3">
            {quickActions.map((action) => (
              <QuickActionCard key={`${action.to}-${action.label}`} action={action} />
            ))}
          </div>
        </Panel>
      ) : null}

      {role === "REGULATOR" ? (
        <Panel title="Compliance and operations">
          <div className="stack">
            <p className="measure text-secondary">
              As a regulator you also have the compliance overview, the report builder and the
              reconciliation queue, which is where a transaction that confirmed on-chain but never
              reached the database is finished by hand.
            </p>
            <div className="cluster">
              <Link className="btn btn--secondary" to="/app/compliance">
                <Icon name="shield" size={16} />
                Open the compliance overview
              </Link>
              <Link className="btn btn--secondary" to="/app/operations/reconciliation">
                <Icon name="refresh" size={16} />
                Reconciliation queue
              </Link>
            </div>
          </div>
        </Panel>
      ) : null}

      <p className="measure text-xs text-muted">
        Signed in as {ROLE_LABELS[role]}. Everything on this screen was read from the registry
        using your session. Nothing here is written to the blockchain, and nothing is held in this
        browser between visits.
      </p>
    </div>
  );
}
