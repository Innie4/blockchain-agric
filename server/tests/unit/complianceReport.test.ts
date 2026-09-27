import { describe, expect, it, vi } from "vitest";
import type { ComplianceReportView } from "../../src/services/compliance/complianceService.js";

/**
 * `complianceService` pulls in the database models and the PDF renderer, and the
 * configuration module it imports validates the environment at import time, so
 * the values a unit test needs are set before the module is loaded. The PDF
 * engine is stubbed out because only the pure `csvFor` renderer is exercised
 * here; no database is contacted and no document is produced.
 */
vi.mock("pdfkit", () => ({
  default: class PdfDocumentStub {
    on(): this {
      return this;
    }
    font(): this {
      return this;
    }
    fontSize(): this {
      return this;
    }
    text(): this {
      return this;
    }
    moveDown(): this {
      return this;
    }
  },
}));

process.env["NODE_ENV"] = "test";
process.env["MONGODB_URI"] = "mongodb://127.0.0.1:27017/agri_trace_test";
process.env["MONGODB_DB_NAME"] = "agri_trace_test";
process.env["SOLANA_NETWORK"] = "devnet";
process.env["SOLANA_RPC_URL"] = "http://127.0.0.1:8899";
process.env["SOLANA_WS_URL"] = "ws://127.0.0.1:8900";
process.env["SOLANA_PROGRAM_ID"] = "AgriTrace418FNVcjry6EMUbiqx5DLTahpw4CKSZgov3";
process.env["SESSION_SECRET"] = "unit-test-session-secret-of-sufficient-length";
process.env["LOG_LEVEL"] = "silent";

const { csvFor } = await import("../../src/services/compliance/complianceService.js");

type ReportProduct = ComplianceReportView["includedProducts"][number];

const FARMER = "5wHu1tD9BqKvK9XhW1jF5Hq3pT9nGqQZ3mQ2rY7vKpP";
const PROCESSOR = "9rMw3dY2Q7uVnLp5Kb1yHc2XgRt8ZsWvC6NeJkA4uBdM";
const DATA_HASH = "a1b2".repeat(16);
const TX_HASH = "5Zj7mQ2pVxR8sKfL3nTbW9yHcD6uAeG1iOrN4vXtQ7Lm2Pk9Zs3Wc8Yb6Nd1HtJf5Rg";
const REGULATOR = "3nXq7VhT1cLbZ9kWpDsJfA5mYgR4uEoH2vXtC6qLnMz";

const HEADER =
  "productId,cropType,quantity,unit,status,statusLabel,currentOwner,registeredBy," +
  "registeredAt,lastVerificationResult,verificationCount,mismatchCount,transferCount,dataHash,onChainTxHash";

function product(overrides: Partial<ReportProduct> = {}): ReportProduct {
  return {
    productId: "AGT-COCOA-2026-A1B2C3",
    cropType: "Cocoa",
    quantity: 250,
    unit: "kg",
    status: "IN_TRANSIT",
    statusLabel: "In transit",
    ownerWallet: FARMER,
    registeredByWallet: FARMER,
    registeredAt: "2026-01-15T11:02:03.000Z",
    lastVerificationResult: "VERIFIED",
    verificationCount: 2,
    mismatchCount: 0,
    transferCount: 1,
    onChainTxHash: TX_HASH,
    dataHash: DATA_HASH,
    ...overrides,
  };
}

function report(overrides: Partial<ComplianceReportView> = {}): ComplianceReportView {
  return {
    reportId: "6d0f0f3e-1f1a-4a4a-9a0e-1c2b3d4e5f60",
    title: "Q1 2026 cocoa compliance report",
    generatedBy: REGULATOR,
    generatedByName: "Ama Mensah",
    filters: {},
    generatedAt: "2026-04-01T09:00:00.000Z",
    summary: {
      productCount: 2,
      verifiedCount: 2,
      mismatchCount: 0,
      notFoundCount: 0,
      incompleteCount: 0,
      byStatus: { IN_TRANSIT: 1, LISTED: 1 },
      byCropType: { Cocoa: 1, Maize: 1 },
      transferCount: 1,
      anomalyCount: 0,
    },
    anomalies: [],
    includedProducts: [
      product(),
      product({
        productId: "AGT-MAIZE-2026-Z9Y8X7",
        cropType: "Maize",
        quantity: 40,
        status: "LISTED",
        statusLabel: "Listed for sale",
        ownerWallet: PROCESSOR,
        transferCount: 0,
      }),
    ],
    exportMetadata: {
      formats: [],
      lastExportedAt: null,
      lastExportedFormat: null,
      downloadCount: 0,
    },
    ...overrides,
  };
}

function lines(csv: string): string[] {
  return csv.split("\n");
}

describe("compliance report CSV", () => {
  it("writes the header row followed by exactly one row per included product", () => {
    const rows = lines(csvFor(report()));
    expect(rows[0]).toBe(HEADER);
    expect(rows).toHaveLength(4);
    expect(rows[3]).toBe("");
  });

  it("puts the product identifier in the first cell of every data row", () => {
    const rows = lines(csvFor(report()));
    expect(rows[1]?.split(",")[0]).toBe("AGT-COCOA-2026-A1B2C3");
    expect(rows[2]?.split(",")[0]).toBe("AGT-MAIZE-2026-Z9Y8X7");
  });

  it("writes a product row with every cell in the declared header order", () => {
    const rows = lines(csvFor(report({ includedProducts: [product()] })));
    expect(rows[1]).toBe(
      `AGT-COCOA-2026-A1B2C3,Cocoa,250,kg,IN_TRANSIT,In transit,${FARMER},${FARMER},` +
        `2026-01-15T11:02:03.000Z,VERIFIED,2,0,1,${DATA_HASH},${TX_HASH}`
    );
  });

  it("writes an empty cell for a product that has no registration date or transaction hash", () => {
    const rows = lines(
      csvFor(
        report({
          includedProducts: [
            product({ registeredAt: null, onChainTxHash: null, lastVerificationResult: "NOT_FOUND" }),
          ],
        })
      )
    );
    expect(rows[1]).toBe(
      `AGT-COCOA-2026-A1B2C3,Cocoa,250,kg,IN_TRANSIT,In transit,${FARMER},${FARMER},,NOT_FOUND,2,0,1,${DATA_HASH},`
    );
  });

  it("writes a quantity exactly as recorded, without rounding or thousands separators", () => {
    const rows = lines(
      csvFor(report({ includedProducts: [product({ quantity: 0 })] }))
    );
    expect(rows[1]?.split(",")[2]).toBe("0");
    const fractional = lines(csvFor(report({ includedProducts: [product({ quantity: 12.5 })] })));
    expect(fractional[1]?.split(",")[2]).toBe("12.5");
  });

  it("writes only the header row for a report with no products", () => {
    const csv = csvFor(report({ includedProducts: [], anomalies: [] }));
    expect(csv).toBe(`${HEADER}\n`);
    expect(lines(csv)).toEqual([HEADER, ""]);
  });
});

describe("compliance report CSV quoting", () => {
  it("quotes a value containing a comma and doubles the double quotes inside it", () => {
    const csv = csvFor(
      report({
        includedProducts: [product({ cropType: 'Cocoa, "Grade 1" beans' })],
      })
    );
    expect(csv).toContain('"Cocoa, ""Grade 1"" beans"');
  });

  it("quotes a value containing a newline so the record stays one cell", () => {
    const csv = csvFor(report({ includedProducts: [product({ unit: "kg\nper crate" })] }));
    expect(csv).toContain('250,"kg\nper crate",IN_TRANSIT');
  });

  it("leaves a value with no comma, quote or newline unquoted", () => {
    const csv = csvFor(report({ includedProducts: [product()] }));
    expect(csv).not.toContain('"');
  });

  it("quotes an anomaly detail that contains a comma", () => {
    const csv = csvFor(
      report({
        includedProducts: [product()],
        anomalies: [
          {
            productId: "AGT-COCOA-2026-A1B2C3",
            kind: "HASH_MISMATCH",
            detail: "2 verifications found a mismatch, and 1 was incomplete",
            detectedAt: "2026-04-01T09:00:00.000Z",
          },
        ],
      })
    );
    expect(csv).toContain('"2 verifications found a mismatch, and 1 was incomplete"');
  });
});

describe("compliance report CSV anomalies section", () => {
  const anomaly = {
    productId: "AGT-COCOA-2026-A1B2C3",
    kind: "HASH_MISMATCH",
    detail: "1 verification found that the stored details did not match the blockchain record.",
    detectedAt: "2026-04-01T09:00:00.000Z",
  };

  it("appends a blank line, a section title, its own header and one row per anomaly", () => {
    const csv = csvFor(report({ includedProducts: [product()], anomalies: [anomaly] }));
    expect(csv).toBe(
      `${HEADER}\n` +
        `AGT-COCOA-2026-A1B2C3,Cocoa,250,kg,IN_TRANSIT,In transit,${FARMER},${FARMER},` +
        `2026-01-15T11:02:03.000Z,VERIFIED,2,0,1,${DATA_HASH},${TX_HASH}\n` +
        "\n" +
        "anomalies\n" +
        "productId,kind,detail,detectedAt\n" +
        "AGT-COCOA-2026-A1B2C3,HASH_MISMATCH," +
        "1 verification found that the stored details did not match the blockchain record.," +
        "2026-04-01T09:00:00.000Z\n"
    );
  });

  it("writes no anomalies section when the report has no anomalies", () => {
    const csv = csvFor(report({ anomalies: [] }));
    expect(csv).not.toContain("anomalies");
    expect(lines(csv)).toHaveLength(4);
  });

  it("keeps the anomalies section separate from the product rows", () => {
    const rows = lines(csvFor(report({ includedProducts: [product()], anomalies: [anomaly] })));
    expect(rows[2]).toBe("");
    expect(rows[3]).toBe("anomalies");
    expect(rows[4]).toBe("productId,kind,detail,detectedAt");
    expect(rows[5]?.split(",")[0]).toBe("AGT-COCOA-2026-A1B2C3");
  });

  it("writes one anomaly row per anomaly", () => {
    const rows = lines(
      csvFor(
        report({
          includedProducts: [product()],
          anomalies: [anomaly, { ...anomaly, kind: "RECONCILIATION_REQUIRED" }],
        })
      )
    );
    expect(rows.filter((row) => row.startsWith("AGT-COCOA-2026-A1B2C3,"))).toHaveLength(3);
  });
});

describe("compliance report CSV line endings", () => {
  it("ends with a trailing newline", () => {
    expect(csvFor(report()).endsWith("\n")).toBe(true);
    expect(csvFor(report({ includedProducts: [] })).endsWith("\n")).toBe(true);
    expect(
      csvFor(
        report({
          includedProducts: [product()],
          anomalies: [
            {
              productId: "AGT-COCOA-2026-A1B2C3",
              kind: "HASH_MISMATCH",
              detail: "mismatch",
              detectedAt: "2026-04-01T09:00:00.000Z",
            },
          ],
        })
      ).endsWith("\n")
    ).toBe(true);
  });

  it("uses LF line endings throughout, so the export is byte identical on every platform", () => {
    expect(csvFor(report()).includes("\r")).toBe(false);
  });
});
