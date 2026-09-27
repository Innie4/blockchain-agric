import { describe, expect, it } from "vitest";
import { TRANSFER_RECIPIENT_ROLES, type Role } from "../../src/lib/roles.js";
import {
  PRODUCT_STATUSES,
  canAdvance,
  evaluateTransfer,
  isFlagged,
  isTerminal,
  nextStatusesFor,
  statusLabel,
  statusOnTransferTo,
  successors,
  type ProductStatus,
} from "../../src/lib/statusMachine.js";

const OWNER = "5wHu1tD9BqKvK9XhW1jF5Hq3pT9nGqQZ3mQ2rY7vKpP";
const RECIPIENT = "9rMw3dY2Q7uVnLp5Kb1yHc2XgRt8ZsWvC6NeJkA4uBdM";
const THIRD_PARTY = "3nXq7VhT1cLbZ9kWpDsJfA5mYgR4uEoH2vXtC6qLnMz";

/** The single forward path through the lifecycle, in order. */
const LINEAR_PROGRESSION: ProductStatus[] = [
  "REGISTERED",
  "IN_PROCESSING",
  "PROCESSED",
  "IN_TRANSIT",
  "AT_RETAILER",
  "LISTED",
  "SOLD",
];

function transfer(overrides: Partial<Parameters<typeof evaluateTransfer>[0]> = {}) {
  return evaluateTransfer({
    currentStatus: "REGISTERED",
    currentOwnerWallet: OWNER,
    signerWallet: OWNER,
    recipientWallet: RECIPIENT,
    recipientRole: "PROCESSOR",
    recipientRegistered: true,
    ...overrides,
  });
}

describe("status vocabulary", () => {
  it("gives every status a non-empty human label", () => {
    for (const status of PRODUCT_STATUSES) {
      expect(statusLabel(status).length).toBeGreaterThan(0);
    }
  });

  it("gives no two statuses the same label", () => {
    const labels = PRODUCT_STATUSES.map((status) => statusLabel(status));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("knows exactly the eight statuses the on-chain program defines", () => {
    expect(PRODUCT_STATUSES).toEqual([
      "REGISTERED",
      "IN_PROCESSING",
      "PROCESSED",
      "IN_TRANSIT",
      "AT_RETAILER",
      "LISTED",
      "SOLD",
      "FLAGGED",
    ]);
  });
});

describe("successors", () => {
  it("follows the linear progression REGISTERED through SOLD", () => {
    expect(LINEAR_PROGRESSION.slice(0, -1).map((status) => successors(status)[0])).toEqual(
      LINEAR_PROGRESSION.slice(1)
    );
  });

  it("gives every status on the linear path exactly one successor", () => {
    for (const status of LINEAR_PROGRESSION.slice(0, -1)) {
      expect(successors(status)).toHaveLength(1);
    }
  });

  it("leaves SOLD and FLAGGED with no successors at all", () => {
    expect(successors("SOLD")).toEqual([]);
    expect(successors("FLAGGED")).toEqual([]);
  });

  it("never offers FLAGGED as a successor, because only a regulator withholds a batch", () => {
    for (const status of PRODUCT_STATUSES) {
      expect(successors(status)).not.toContain("FLAGGED");
    }
  });
});

describe("canAdvance", () => {
  it("allows the next step of the linear progression from every non-terminal status", () => {
    for (const status of LINEAR_PROGRESSION.slice(0, -1)) {
      const next = successors(status)[0];
      expect(canAdvance(status, next as ProductStatus)).toBe(true);
    }
  });

  it("rejects skipping a step", () => {
    expect(canAdvance("REGISTERED", "PROCESSED")).toBe(false);
    expect(canAdvance("REGISTERED", "SOLD")).toBe(false);
    expect(canAdvance("IN_TRANSIT", "LISTED")).toBe(false);
  });

  it("rejects going backwards", () => {
    expect(canAdvance("PROCESSED", "IN_PROCESSING")).toBe(false);
    expect(canAdvance("SOLD", "LISTED")).toBe(false);
    expect(canAdvance("AT_RETAILER", "REGISTERED")).toBe(false);
  });

  it("rejects a status staying where it is", () => {
    for (const status of PRODUCT_STATUSES) {
      expect(canAdvance(status, status)).toBe(false);
    }
  });

  it("rejects any move out of a terminal status", () => {
    for (const target of PRODUCT_STATUSES) {
      expect(canAdvance("SOLD", target)).toBe(false);
    }
  });

  it("rejects any move out of a flagged status", () => {
    for (const target of PRODUCT_STATUSES) {
      expect(canAdvance("FLAGGED", target)).toBe(false);
    }
  });
});

describe("terminal and flagged states", () => {
  it("treats SOLD as the only terminal status", () => {
    const terminal = PRODUCT_STATUSES.filter((status) => isTerminal(status));
    expect(terminal).toEqual(["SOLD"]);
  });

  it("treats FLAGGED as the only flagged status", () => {
    const flagged = PRODUCT_STATUSES.filter((status) => isFlagged(status));
    expect(flagged).toEqual(["FLAGGED"]);
  });

  it("does not treat FLAGGED as terminal, because a regulator can release it", () => {
    expect(isTerminal("FLAGGED")).toBe(false);
    expect(isFlagged("SOLD")).toBe(false);
  });
});

describe("status on transfer to a role", () => {
  it("puts a batch in processing when a processor receives it", () => {
    expect(statusOnTransferTo("PROCESSOR")).toBe("IN_PROCESSING");
  });

  it("puts a batch in transit when a transporter receives it", () => {
    expect(statusOnTransferTo("TRANSPORTER")).toBe("IN_TRANSIT");
  });

  it("puts a batch at the retailer when a retailer receives it", () => {
    expect(statusOnTransferTo("RETAILER")).toBe("AT_RETAILER");
  });

  it("has no resulting status for a farmer or a regulator", () => {
    expect(statusOnTransferTo("FARMER")).toBeNull();
    expect(statusOnTransferTo("REGULATOR")).toBeNull();
  });

  it("has a resulting status for every role permitted to take ownership", () => {
    for (const role of TRANSFER_RECIPIENT_ROLES) {
      expect(statusOnTransferTo(role)).not.toBeNull();
    }
  });
});

describe("evaluateTransfer", () => {
  it("rejects a transfer when the signer is not the current owner", () => {
    const result = transfer({ signerWallet: THIRD_PARTY });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("Only the wallet that currently owns this product may transfer it.");
    expect(result.resultingStatus).toBeUndefined();
  });

  it("rejects a transfer of a batch a regulator has flagged", () => {
    const result = transfer({ currentStatus: "FLAGGED" });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe(
      "A regulator has withheld this product. It cannot be transferred until it is released."
    );
  });

  it("rejects a transfer of a batch that has already been sold", () => {
    const result = transfer({ currentStatus: "SOLD" });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("This product has already been sold.");
  });

  it("rejects a transfer to the wallet that already owns the batch", () => {
    const result = transfer({ recipientWallet: OWNER, recipientRole: "RETAILER" });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe(
      "Select a different recipient. A product cannot be transferred to its current owner."
    );
  });

  it("rejects a transfer to a wallet with no on-chain participant registration", () => {
    const result = transfer({ recipientRegistered: false });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe(
      "That wallet is not a registered participant. They must register on-chain before they can receive a product."
    );
  });

  it("rejects a transfer to a wallet with no role at all", () => {
    const result = transfer({ recipientRole: null });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/not a registered participant/);
  });

  it("rejects a transfer to a farmer, because a farmer only ever originates a batch", () => {
    const result = transfer({ recipientRole: "FARMER" });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe(
      "A product may only be transferred to a processor, transporter or retailer."
    );
  });

  it("rejects a transfer to a regulator, because a regulator supervises rather than takes custody", () => {
    const result = transfer({ recipientRole: "REGULATOR" });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe(
      "A product may only be transferred to a processor, transporter or retailer."
    );
  });

  it("allows a transfer to a processor and moves the batch into processing", () => {
    const result = transfer({ recipientRole: "PROCESSOR" });
    expect(result).toEqual({ eligible: true, resultingStatus: "IN_PROCESSING" });
    expect(result.reason).toBeUndefined();
  });

  it("allows a transfer to a transporter and moves the batch into transit", () => {
    expect(transfer({ recipientRole: "TRANSPORTER" })).toEqual({
      eligible: true,
      resultingStatus: "IN_TRANSIT",
    });
  });

  it("allows a transfer to a retailer and moves the batch to the retailer", () => {
    expect(transfer({ recipientRole: "RETAILER" })).toEqual({
      eligible: true,
      resultingStatus: "AT_RETAILER",
    });
  });

  it("allows a transfer of a batch at any stage that is neither sold nor flagged", () => {
    for (const status of LINEAR_PROGRESSION.slice(0, -1)) {
      expect(transfer({ currentStatus: status }).eligible).toBe(true);
    }
  });

  it("prefers the ownership check over every other rejection reason", () => {
    const result = transfer({
      signerWallet: THIRD_PARTY,
      currentStatus: "FLAGGED",
      recipientRole: "FARMER",
      recipientRegistered: false,
    });
    expect(result.reason).toMatch(/currently owns/);
  });
});

describe("nextStatusesFor", () => {
  it("offers a farmer the single next step of the progression", () => {
    expect(nextStatusesFor("FARMER", "REGISTERED")).toEqual(["IN_PROCESSING"]);
    expect(nextStatusesFor("PROCESSOR", "IN_TRANSIT")).toEqual(["AT_RETAILER"]);
    expect(nextStatusesFor("RETAILER", "AT_RETAILER")).toEqual(["LISTED"]);
  });

  it("offers a regulator only FLAGGED for a batch that is not already withheld", () => {
    for (const status of LINEAR_PROGRESSION) {
      expect(nextStatusesFor("REGULATOR", status)).toEqual(["FLAGGED"]);
    }
  });

  it("offers a regulator every status it may release a flagged batch into, never FLAGGED again", () => {
    const offered = nextStatusesFor("REGULATOR", "FLAGGED");
    expect(offered).not.toContain("FLAGGED");
    expect(offered).toEqual([
      "REGISTERED",
      "IN_PROCESSING",
      "PROCESSED",
      "IN_TRANSIT",
      "AT_RETAILER",
      "LISTED",
      "SOLD",
    ]);
  });

  it("offers a non-regulator nothing for a flagged batch", () => {
    for (const role of ["FARMER", "PROCESSOR", "TRANSPORTER", "RETAILER", "CONSUMER"] as const) {
      expect(nextStatusesFor(role, "FLAGGED")).toEqual([]);
    }
  });

  it("offers a non-regulator nothing for a sold batch", () => {
    for (const role of ["FARMER", "PROCESSOR", "TRANSPORTER", "RETAILER", "CONSUMER"] as const) {
      expect(nextStatusesFor(role, "SOLD")).toEqual([]);
    }
  });

  it("offers a non-regulator on a normal batch the same single successor the machine allows", () => {
    const roles: readonly Role[] = ["FARMER", "PROCESSOR", "TRANSPORTER", "RETAILER"];
    for (const role of roles) {
      for (const status of LINEAR_PROGRESSION.slice(0, -1)) {
        expect(nextStatusesFor(role, status)).toEqual(successors(status));
      }
    }
  });

  it("treats a consumer like any other non-regulator role, leaving the permission check to the route guard", () => {
    expect(nextStatusesFor("CONSUMER", "REGISTERED")).toEqual(["IN_PROCESSING"]);
    expect(nextStatusesFor("CONSUMER", "LISTED")).toEqual(["SOLD"]);
  });
});
