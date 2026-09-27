import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listComplianceReports } from "../../../api/endpoints";
import { REPORT_EXPORT_FORMATS, type ComplianceReport, type ReportListResponse } from "../../../api/types";
import { PageHeader } from "../../../components/layout/PageHeader";
import { ErrorState, LoadingState } from "../../../components/states";
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  Panel,
  Table,
  type TableColumn,
} from "../../../components/ui/Index";
import { formatDate, formatNumber } from "../../../lib/format";
import { usePageParam } from "../appData";
import { DatedTimeValue, PaginationControls } from "../appUi";

/**
 * The reports this regulator has generated.
 *
 * A report is a frozen copy of the registry taken at a moment, with the criteria
 * that were applied. The list is here so a regulator can find the one they need
 * and read it again later; the figures on it were true when it was made and are
 * not updated afterwards.
 */

const PAGE_SIZE = 12;

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly error: unknown }
  | { readonly phase: "ready"; readonly response: ReportListResponse };

const COLUMNS: readonly TableColumn<ComplianceReport>[] = [
  {
    key: "title",
    header: "Report",
    isRowHeader: true,
    render: (row) => (
      <span className="stack stack--tight">
        <Link to={`/app/compliance/reports/${encodeURIComponent(row.reportId)}`}>{row.title}</Link>
        <span className="table__secondary">
          <span className="hash">{row.reportId}</span>
        </span>
      </span>
    ),
  },
  { key: "generated", header: "Generated at", render: (row) => <DatedTimeValue value={row.generatedAt} /> },
  {
    key: "products",
    header: "Batches",
    align: "right",
    render: (row) => formatNumber(row.summary.productCount),
  },
  {
    key: "mismatches",
    header: "Mismatches",
    align: "right",
    render: (row) =>
      row.summary.mismatchCount === 0 ? (
        <span className="text-secondary">0</span>
      ) : (
        <Badge tone="danger" icon="alertTriangle">
          {formatNumber(row.summary.mismatchCount)}
        </Badge>
      ),
  },
  {
    key: "anomalies",
    header: "Anomalies",
    align: "right",
    render: (row) =>
      row.summary.anomalyCount === 0 ? (
        <span className="text-secondary">0</span>
      ) : (
        <Badge tone="warning" icon="flag">
          {formatNumber(row.summary.anomalyCount)}
        </Badge>
      ),
  },
  {
    key: "exports",
    header: "Exports",
    render: (row) =>
      row.exportMetadata.formats.length === 0 ? (
        <span className="text-secondary">Never exported</span>
      ) : (
        <span className="stack stack--tight">
          <span>{row.exportMetadata.formats.map((format) => format.toUpperCase()).join(", ")}</span>
          <span className="table__secondary">
            Downloaded {formatNumber(row.exportMetadata.downloadCount)}{" "}
            {row.exportMetadata.downloadCount === 1 ? "time" : "times"}
            {row.exportMetadata.lastExportedAt === null
              ? null
              : ` · last on ${formatDate(row.exportMetadata.lastExportedAt)}`}
          </span>
        </span>
      ),
  },
  {
    key: "action",
    header: "Open",
    render: (row) => (
      <Link
        className="btn btn--secondary btn--sm"
        to={`/app/compliance/reports/${encodeURIComponent(row.reportId)}`}
      >
        Open
        <span className="visually-hidden"> the report {row.title}</span>
      </Link>
    ),
  },
];

export default function ReportsPage() {
  const [page, setPage] = usePageParam();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  const load = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: "loading" });

    listComplianceReports({ page, pageSize: PAGE_SIZE }, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setState({ phase: "ready", response });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: "failed", error });
      });

    return () => controller.abort();
  }, [attempt, page]);

  const heading = (
    <PageHeader
      title="Compliance reports"
      description="Frozen copies of the registry, with the criteria that were applied when each was made. Every figure below comes from the report itself."
      actions={
        <Link className="btn btn--primary" to="/app/compliance/reports/new">
          <Icon name="fileText" size={16} />
          Generate a report
        </Link>
      }
    />
  );

  if (state.phase === "loading") {
    return (
      <div className="page">
        {heading}
        <LoadingState label="Reading your reports" rows={8} />
      </div>
    );
  }

  if (state.phase === "failed") {
    return (
      <div className="page">
        {heading}
        <ErrorState
          error={state.error}
          title="Your reports could not be read"
          retryLabel="Read them again"
          onRetry={load}
        />
      </div>
    );
  }

  const { reports, pagination } = state.response;

  if (reports.length === 0) {
    return (
      <div className="page">
        {heading}
        <EmptyState
          icon="fileText"
          title="You have not generated a report yet"
          description="A report is a copy of the registry at a moment in time, filtered to the batches you are asking about. It can be exported as a PDF for a file, or as CSV for a spreadsheet, and the criteria you applied are printed on it so a reader can see what was and was not included."
          action={
            <Link className="btn btn--primary" to="/app/compliance/reports/new">
              <Icon name="fileText" size={16} />
              Generate a report
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="page">
      {heading}

      <Panel
        title="Your reports"
        actions={
          <span className="text-xs text-muted">
            Export formats available: {REPORT_EXPORT_FORMATS.map((format) => format.toUpperCase()).join(", ")}
          </span>
        }
      >
        <p className="text-sm text-secondary" aria-live="polite">
          {pagination.total} {pagination.total === 1 ? "report" : "reports"} generated by you.
        </p>
        <Table
          caption="Compliance reports you have generated, newest first"
          columns={COLUMNS}
          rows={reports}
          rowKey={(row) => row.reportId}
          emptyState={
            <EmptyState
              icon="fileText"
              title="Nothing on this page"
              description="There is no report to show for this page of results."
            />
          }
        />
        <PaginationControls
          pagination={pagination}
          onPageChange={setPage}
          noun="reports"
        />
      </Panel>

      <Panel title="How to read a report">
        <div className="measure stack text-sm text-secondary">
          <p>
            A mismatch is a batch whose stored details no longer produce the fingerprint anchored
            on the blockchain. It is a fact about the record, not a judgement about the produce, and
            it is the single most important figure on a report.
          </p>
          <p>
            An anomaly is a blockchain write that confirmed on Solana but was not written to the
            database. The goods are real and the paperwork is missing; each one is finished from the
            reconciliation queue.
          </p>
          <p>
            A report is a snapshot. Opening one again tomorrow shows the same figures, because the
            registry has moved on but the report has not. Generate a new one for current figures.
          </p>
        </div>
      </Panel>

      <div className="cluster">
        <Button variant="quiet" onClick={load}>
          <Icon name="refresh" size={16} />
          Read this page again
        </Button>
        <Link className="btn btn--quiet" to="/app/compliance">
          <Icon name="shield" size={16} />
          Compliance overview
        </Link>
      </div>
    </div>
  );
}
