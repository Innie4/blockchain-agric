import { Fragment, useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { exportComplianceReport, getComplianceReport } from "../../../api/endpoints";
import {
  REPORT_EXPORT_FORMATS,
  VERIFICATION_RESULT_LABELS,
  isVerificationResult,
  type ComplianceReport,
  type ReportExportFormat,
  type ReportProductRow,
} from "../../../api/types";
import { PageHeader } from "../../../components/layout/PageHeader";
import { ErrorState, FailureState, LoadingState, NotFoundState } from "../../../components/states";
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  Panel,
  StatusBadge,
  Table,
  type TableColumn,
} from "../../../components/ui/Index";
import { downloadBlob, formatNumber, truncateAddress, truncateHash } from "../../../lib/format";
import { explorerTxUrl } from "../../../lib/solana";
import { decodeParam, isNotFound, useCopyToClipboard } from "../appData";
import { DatedTimeValue, MetricRow, MetricTile } from "../appUi";

/**
 * One report, and the batches it includes.
 *
 * The criteria are printed before the figures, because a figure without the
 * question it answers is not evidence of anything. Every number on this page is
 * the one the report was generated with, and the page says so rather than
 * offering a live figure next to a frozen one.
 */

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly error: unknown }
  | { readonly phase: "ready"; readonly report: ComplianceReport };

type ExportState =
  | { readonly phase: "idle" }
  | { readonly phase: "working"; readonly format: ReportExportFormat }
  | { readonly phase: "failed"; readonly error: unknown };

const COLUMNS: readonly TableColumn<ReportProductRow>[] = [
  {
    key: "batch",
    header: "Batch",
    isRowHeader: true,
    render: (row) => (
      <span className="stack stack--tight">
        <Link className="hash" to={`/app/products/${encodeURIComponent(row.productId)}`}>
          {row.productId}
        </Link>
        <span className="table__secondary">Registered by {truncateAddress(row.registeredByWallet)}</span>
      </span>
    ),
  },
  { key: "product", header: "Product", render: (row) => row.cropType },
  {
    key: "quantity",
    header: "Quantity",
    align: "right",
    render: (row) => (row.quantity === null ? "Not recorded" : formatNumber(row.quantity)),
  },
  { key: "stage", header: "Stage", render: (row) => <StatusBadge status={row.status} /> },
  {
    key: "owner",
    header: "Current owner",
    render: (row) => (
      <span className="stack stack--tight">
        <span className="hash" title={row.ownerWallet}>
          {truncateAddress(row.ownerWallet, 6, 6)}
        </span>
        <span className="table__secondary">
          {row.ownerWallet === row.registeredByWallet
            ? "The same wallet that registered it"
            : "A later owner"}
        </span>
      </span>
    ),
  },
  {
    key: "checked",
    header: "Last check",
    render: (row) =>
      row.lastVerificationResult === null ? (
        <span className="text-secondary">Never checked</span>
      ) : (
        <Badge tone={row.lastVerificationResult === "MISMATCH" ? "danger" : "neutral"}>
          {VERIFICATION_RESULT_LABELS[row.lastVerificationResult]}
        </Badge>
      ),
  },
  {
    key: "verifications",
    header: "Checks",
    align: "right",
    render: (row) => formatNumber(row.verificationCount),
  },
  {
    key: "mismatches",
    header: "Mismatches",
    align: "right",
    render: (row) =>
      row.mismatchCount === 0 ? (
        <span className="text-secondary">0</span>
      ) : (
        <Badge tone="danger" icon="alertTriangle">
          {formatNumber(row.mismatchCount)}
        </Badge>
      ),
  },
  {
    key: "transfers",
    header: "Transfers",
    align: "right",
    render: (row) => formatNumber(row.transferCount),
  },
  {
    key: "fingerprint",
    header: "Fingerprint",
    render: (row) =>
      row.dataHash === null ? (
        <span className="text-secondary">Not anchored</span>
      ) : (
        <span className="hash" title={row.dataHash}>
          {truncateHash(row.dataHash)}
        </span>
      ),
  },
  {
    key: "registration",
    header: "Registration transaction",
    render: (row) => {
      const url = explorerTxUrl(row.onChainTxHash);
      if (row.onChainTxHash === null) {
        return <span className="text-secondary">Not confirmed on-chain</span>;
      }
      return url === null ? (
        <span className="hash">{truncateAddress(row.onChainTxHash, 6, 6)}</span>
      ) : (
        <a href={url} target="_blank" rel="noreferrer noopener">
          View on Solana Explorer
          <span className="visually-hidden">, opens in a new tab</span>
        </a>
      );
    },
  },
];

/* ------------------------------------------------------------------ *
 * The criteria, as they were applied
 * ------------------------------------------------------------------ */

interface Criterion {
  label: string;
  value: string;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function criteriaFor(report: ComplianceReport): Criterion[] {
  const filters = report.filters;
  const criteria: Criterion[] = [
    { label: "Title", value: report.title },
    {
      label: "Registered between",
      value:
        typeof filters["dateFrom"] === "string" || typeof filters["dateTo"] === "string"
          ? `${typeof filters["dateFrom"] === "string" ? filters["dateFrom"] : "the beginning"} and ${
              typeof filters["dateTo"] === "string" ? filters["dateTo"] : "today"
            }`
          : "Any registration date",
    },
  ];

  const crops = readStringArray(filters["cropTypes"]);
  criteria.push({
    label: "Crop types",
    value: crops.length === 0 ? "All crops" : crops.join(", "),
  });

  const stages = readStringArray(filters["statuses"]);
  criteria.push({
    label: "Stages",
    value: stages.length === 0 ? "All stages" : stages.map((stage) => stage.replace(/_/g, " ").toLowerCase()).join(", "),
  });

  const results = readStringArray(filters["verificationResults"]);
  criteria.push({
    label: "Verification results",
    value:
      results.length === 0
        ? "Any result"
        : results
            .map((result) => (isVerificationResult(result) ? VERIFICATION_RESULT_LABELS[result] : result))
            .join(", "),
  });

  const participants = readStringArray(filters["participants"]);
  criteria.push({
    label: "Participants",
    value:
      participants.length === 0
        ? "Every participant"
        : `${participants.length} wallet ${participants.length === 1 ? "address" : "addresses"}`,
  });

  const productIds = readStringArray(filters["productIds"]);
  criteria.push({
    label: "Named batches",
    value: productIds.length === 0 ? "Every batch that matched" : `${productIds.length} named directly`,
  });

  return criteria;
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function ReportDetailPage() {
  const { reportId: rawParam } = useParams();
  const reportId = decodeParam(rawParam);
  const copy = useCopyToClipboard();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [exporting, setExporting] = useState<ExportState>({ phase: "idle" });
  const [downloaded, setDownloaded] = useState<string | null>(null);

  const load = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  useEffect(() => {
    if (reportId === null) return;
    const controller = new AbortController();
    setState({ phase: "loading" });

    getComplianceReport(reportId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setState({ phase: "ready", report: response });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: "failed", error });
      });

    return () => controller.abort();
  }, [attempt, reportId]);

  const runExport = useCallback(
    (format: ReportExportFormat) => {
      if (reportId === null) return;
      setExporting({ phase: "working", format });
      void exportComplianceReport(reportId, format)
        .then((blob) => {
          downloadBlob(blob, `compliance-${reportId}.${format}`);
          setDownloaded(format);
          setExporting({ phase: "idle" });
          load();
        })
        .catch((error: unknown) => {
          setExporting({ phase: "failed", error });
        });
    },
    [load, reportId],
  );

  if (reportId === null) {
    return (
      <div className="page">
        <PageHeader title="Report" description="No report identifier was given in the address." />
        <NotFoundState
          title="No report identifier was given"
          description="The address on this page did not include a report identifier, so there is no report to read."
          action={
            <Link className="btn btn--primary" to="/app/compliance/reports">
              Go to my reports
            </Link>
          }
        />
      </div>
    );
  }

  const heading = (
    <PageHeader
      title="Compliance report"
      description="A copy of the registry taken when this report was made, filtered to the criteria below. The figures do not change."
      breadcrumbs={[
        { label: "Reports", to: "/app/compliance/reports" },
        { label: "Report" },
      ]}
    />
  );

  if (state.phase === "loading") {
    return (
      <div className="page">
        {heading}
        <LoadingState label="Reading the report" rows={8} />
      </div>
    );
  }

  if (state.phase === "failed") {
    if (isNotFound(state.error)) {
      return (
        <div className="page">
          {heading}
          <NotFoundState
            title="No report exists with that identifier"
            description="The registry holds no such report. It may have been generated by a different regulator, or the link may be out of date."
            action={
              <Link className="btn btn--primary" to="/app/compliance/reports">
                Go to my reports
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
          title="The report could not be read"
          retryLabel="Read it again"
          onRetry={load}
        />
      </div>
    );
  }

  const { report } = state;
  const criteria = criteriaFor(report);
  const { summary } = report;

  return (
    <div className="page">
      {heading}

      <Panel
        title={report.title}
        actions={
          <span className="cluster cluster--tight">
            <Badge tone={summary.mismatchCount === 0 ? "success" : "danger"} icon={summary.mismatchCount === 0 ? "check" : "alertTriangle"}>
              {summary.mismatchCount === 0
                ? "No mismatches in this report"
                : `${formatNumber(summary.mismatchCount)} ${summary.mismatchCount === 1 ? "mismatch" : "mismatches"} in this report`}
            </Badge>
          </span>
        }
      >
        <div className="stack">
          <dl className="definition-list">
            <dt>Report identifier</dt>
            <dd>
              <span className="cluster cluster--tight">
                <span className="hash">{report.reportId}</span>
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => { copy(report.reportId, "Report identifier"); }}
                >
                  <Icon name="clipboard" size={16} />
                  Copy the identifier
                </Button>
              </span>
            </dd>

            <dt>Generated by</dt>
            <dd>
              {report.generatedByName.trim().length > 0 ? report.generatedByName : "A regulator"}
              <span className="table__secondary">
                <span className="hash">{report.generatedBy}</span>
              </span>
            </dd>

            <dt>Generated at</dt>
            <dd>
              <DatedTimeValue value={report.generatedAt} />
            </dd>
          </dl>
          <p className="measure text-sm text-secondary">
            Every figure below is the one this report was generated with. The registry has moved on
            since; a report is a record of a moment, not a live view.
          </p>
        </div>
      </Panel>

      <Panel title="The criteria that were applied">
        <p className="measure text-secondary">
          A figure is only meaningful against the question it answers. These are the criteria the
          report was built from, exactly as they were recorded.
        </p>
        <dl className="definition-list">
          {criteria.map((criterion) => (
            <Fragment key={criterion.label}>
              <dt>{criterion.label}</dt>
              <dd>{criterion.value}</dd>
            </Fragment>
          ))}
        </dl>
      </Panel>

      <Panel title="The figures">
        <MetricRow>
          <MetricTile label="Batches in this report" value={formatNumber(summary.productCount)} />
          <MetricTile
            label="Last check passed"
            value={formatNumber(summary.verifiedCount)}
            tone={summary.verifiedCount === 0 ? "neutral" : "success"}
          />
          <MetricTile
            label="Last check found a mismatch"
            value={formatNumber(summary.mismatchCount)}
            tone={summary.mismatchCount === 0 ? "success" : "danger"}
          />
          <MetricTile
            label="No record on-chain"
            value={formatNumber(summary.notFoundCount)}
            tone={summary.notFoundCount === 0 ? "success" : "warning"}
          />
          <MetricTile
            label="Not yet fully registered"
            value={formatNumber(summary.incompleteCount)}
            tone={summary.incompleteCount === 0 ? "success" : "warning"}
          />
          <MetricTile label="Transfers recorded" value={formatNumber(summary.transferCount)} />
          <MetricTile
            label="Anomalies"
            value={formatNumber(summary.anomalyCount)}
            tone={summary.anomalyCount === 0 ? "success" : "danger"}
          />
        </MetricRow>

        {Object.keys(summary.byStatus).length > 0 ? (
          <div className="stack stack--tight">
            <p className="text-sm text-secondary">By stage:</p>
            <ul className="stack stack--tight">
              {Object.entries(summary.byStatus).map(([stage, count]) => (
                <li className="cluster cluster--between" key={`status-${stage}`}>
                  <span className="text-sm">{stage.replace(/_/g, " ").toLowerCase()}</span>
                  <span className="text-sm text-secondary">{formatNumber(count)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {Object.keys(summary.byCropType).length > 0 ? (
          <div className="stack stack--tight">
            <p className="text-sm text-secondary">By crop:</p>
            <ul className="stack stack--tight">
              {Object.entries(summary.byCropType).map(([crop, count]) => (
                <li className="cluster cluster--between" key={`crop-${crop}`}>
                  <span className="text-sm">{crop}</span>
                  <span className="text-sm text-secondary">{formatNumber(count)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Panel>

      <Panel
        title="Anomalies in this report"
        actions={
          report.anomalies.length === 0 ? null : (
            <Badge tone="danger" icon="alertTriangle">
              {report.anomalies.length} to investigate
            </Badge>
          )
        }
      >
        {report.anomalies.length === 0 ? (
          <EmptyState
            icon="check"
            title="No anomalies in this report"
            description="Nothing in the batches this report covers has a mismatched fingerprint, a blockchain write that never finished, or an owner that is not a registered participant."
          />
        ) : (
          <Table
            caption="Anomalies found among the batches in this report"
            columns={[
              {
                key: "batch",
                header: "Batch",
                isRowHeader: true,
                render: (row: ComplianceReport["anomalies"][number]) => (
                  <Link className="hash" to={`/app/products/${encodeURIComponent(row.productId)}`}>
                    {row.productId}
                  </Link>
                ),
              },
              {
                key: "kind",
                header: "Kind",
                render: (row) => (
                  <Badge tone="danger" icon="alertTriangle">
                    {row.kind.replace(/_/g, " ").toLowerCase()}
                  </Badge>
                ),
              },
              { key: "detail", header: "Detail", render: (row) => <span className="measure">{row.detail}</span> },
              { key: "when", header: "Detected", render: (row) => <DatedTimeValue value={row.detectedAt} /> },
            ]}
            rows={report.anomalies}
            rowKey={(row) => `${row.productId}-${row.kind}-${row.detectedAt}`}
          />
        )}
      </Panel>

      <Panel
        title="The batches this report includes"
        actions={
          <span className="text-xs text-muted">
            {report.includedProducts.length}{" "}
            {report.includedProducts.length === 1 ? "batch" : "batches"}
          </span>
        }
      >
        {report.includedProducts.length === 0 ? (
          <EmptyState
            icon="package"
            title="No batch matched the criteria"
            description="The report was generated, but nothing in the registry matched what it asked for. That is a real answer, and it is worth checking the criteria before drawing a conclusion from it."
            action={
              <Link className="btn btn--primary" to="/app/compliance/reports/new">
                <Icon name="fileText" size={16} />
                Generate another report
              </Link>
            }
          />
        ) : (
          <Table
            caption={`The ${report.includedProducts.length} batches included in ${report.title}`}
            columns={COLUMNS}
            rows={report.includedProducts}
            rowKey={(row) => row.productId}
            emptyState={
              <EmptyState
                icon="package"
                title="No batch is included"
                description="Nothing matched the criteria this report was built from."
              />
            }
          />
        )}
      </Panel>

      <Panel title="Export">
        <div className="stack">
          <p className="measure text-secondary">
            The report can be exported as a PDF for a file or an official submission, or as CSV for a
            spreadsheet. The file is produced by the server from the same figures shown above, and
            the export is recorded so that usage is visible.
          </p>

          <p className="text-sm text-secondary" aria-live="polite">
            {downloaded === null
              ? "This report has not been exported from this browser."
              : `The ${downloaded.toUpperCase()} export has been downloaded.`}
          </p>

          <div className="cluster">
            {REPORT_EXPORT_FORMATS.map((format) => (
              <Button
                key={format}
                variant={format === "pdf" ? "primary" : "secondary"}
                loading={exporting.phase === "working" && exporting.format === format}
                loadingLabel={`Producing the ${format.toUpperCase()} file`}
                onClick={() => { runExport(format); }}
              >
                <Icon name="download" size={16} />
                Download as {format.toUpperCase()}
              </Button>
            ))}
          </div>

          <dl className="definition-list">
            <dt>Formats exported</dt>
            <dd>
              {report.exportMetadata.formats.length === 0
                ? "Never exported."
                : report.exportMetadata.formats.map((format) => format.toUpperCase()).join(", ")}
            </dd>

            <dt>Last exported</dt>
            <dd>
              <DatedTimeValue value={report.exportMetadata.lastExportedAt} />
              {report.exportMetadata.lastExportedFormat === null
                ? null
                : ` as ${report.exportMetadata.lastExportedFormat.toUpperCase()}`}
            </dd>

            <dt>Downloads recorded</dt>
            <dd>{formatNumber(report.exportMetadata.downloadCount)}</dd>
          </dl>
        </div>
      </Panel>

      {exporting.phase === "failed" ? (
        <FailureState
          error={exporting.error}
          context={`export this report as ${REPORT_EXPORT_FORMATS.join(" or ")}`}
          retryLabel="Try the export again"
          onRetry={() => { runExport("pdf"); }}
          actions={
            <Button
              variant="secondary"
              onClick={() => {
                setExporting({ phase: "idle" });
              }}
            >
              <Icon name="x" size={16} />
              Dismiss
            </Button>
          }
        />
      ) : null}

      <Panel title="Where this report came from">
        <div className="measure stack text-sm text-secondary">
          <p>
            The figures are read from the records service, which holds the same batch records the
            blockchain anchors. The registration transaction of every batch is shown in the table
            above, so any figure here can be traced back to a transaction that anybody can read.
          </p>
          <p>
            A report cannot be edited after it is generated. If the criteria were wrong, generate a
            new one; the two reports together show what changed and when.
          </p>
        </div>
      </Panel>
    </div>
  );
}
