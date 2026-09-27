import { describe, expect, it } from "vitest";
import {
  CONSUMER_ROLE,
  ON_CHAIN_ROLES,
  PARTICIPANT_ROLE_VALUES,
  PERMISSIONS,
  ROLES,
  TRANSFER_RECIPIENT_ROLES,
  canUpdateStatus,
  hasPermission,
  isParticipantRole,
  isRole,
  isTransferRecipientRole,
  onChainRoleOrdinal,
  permissionsFor,
  roleLabel,
  type ParticipantRoleValue,
} from "../../src/lib/roles.js";

const PRIVILEGED_PERMISSIONS = [
  "transfer:create",
  "product:register",
  "product:record-processing",
  "product:record-transport",
  "product:list-for-sale",
  "compliance:read",
  "compliance:report-generate",
] as const;

describe("role vocabulary", () => {
  it("knows exactly the five business roles plus the consumer", () => {
    expect(ROLES).toEqual(["FARMER", "PROCESSOR", "TRANSPORTER", "RETAILER", "REGULATOR"]);
    expect(PARTICIPANT_ROLE_VALUES).toEqual([...ROLES, CONSUMER_ROLE]);
  });

  it("recognises every declared role and rejects anything else", () => {
    for (const role of PARTICIPANT_ROLE_VALUES) {
      expect(isParticipantRole(role)).toBe(true);
    }
    expect(isParticipantRole("FARMER ")).toBe(false);
    expect(isParticipantRole("farmer")).toBe(false);
    expect(isParticipantRole("DISTRIBUTOR")).toBe(false);
    expect(isParticipantRole("")).toBe(false);
  });

  it("does not treat a consumer as an on-chain business role", () => {
    expect(isRole(CONSUMER_ROLE)).toBe(false);
    expect(isParticipantRole(CONSUMER_ROLE)).toBe(true);
  });
});

describe("on-chain role ordinals", () => {
  it("pins the five business roles to the ordinals 0 to 4 in the order the Rust ParticipantRole enum declares", () => {
    expect(ROLES.map((role) => onChainRoleOrdinal(role))).toEqual([0, 1, 2, 3, 4]);
    expect(onChainRoleOrdinal("FARMER")).toBe(0);
    expect(onChainRoleOrdinal("PROCESSOR")).toBe(1);
    expect(onChainRoleOrdinal("TRANSPORTER")).toBe(2);
    expect(onChainRoleOrdinal("RETAILER")).toBe(3);
    expect(onChainRoleOrdinal("REGULATOR")).toBe(4);
  });

  it("has no ordinal for a consumer, who has no on-chain registry entry", () => {
    expect(onChainRoleOrdinal(CONSUMER_ROLE)).toBeNull();
  });

  it("registers only the five business roles on-chain", () => {
    expect(ON_CHAIN_ROLES).toEqual(ROLES);
    expect(ON_CHAIN_ROLES).not.toContain(CONSUMER_ROLE);
    expect(ON_CHAIN_ROLES).toHaveLength(5);
  });
});

describe("transfer recipient roles", () => {
  it("accepts a processor, a transporter and a retailer", () => {
    for (const role of TRANSFER_RECIPIENT_ROLES) {
      expect(isTransferRecipientRole(role)).toBe(true);
    }
    expect(TRANSFER_RECIPIENT_ROLES).toEqual(["PROCESSOR", "TRANSPORTER", "RETAILER"]);
  });

  it("rejects a farmer, a regulator and a consumer as transfer recipients", () => {
    expect(isTransferRecipientRole("FARMER")).toBe(false);
    expect(isTransferRecipientRole("REGULATOR")).toBe(false);
    expect(isTransferRecipientRole(CONSUMER_ROLE)).toBe(false);
  });

  it("rejects an arbitrary or mis-cased string", () => {
    expect(isTransferRecipientRole("")).toBe(false);
    expect(isTransferRecipientRole("processor")).toBe(false);
    expect(isTransferRecipientRole("DISTRIBUTOR")).toBe(false);
    expect(isTransferRecipientRole("PROCESSOR ")).toBe(false);
  });
});

describe("permissions by role", () => {
  it("grants a consumer no privileged permission at all", () => {
    const permissions = permissionsFor(CONSUMER_ROLE);
    expect(permissions).not.toContain("transfer:create");
    expect(permissions).not.toContain("product:register");
    for (const permission of PRIVILEGED_PERMISSIONS) {
      expect(permissions).not.toContain(permission);
    }
    expect(permissions).toEqual(["product:read:any", "verification:log"]);
  });

  it("lets a farmer register a product and create a transfer", () => {
    expect(hasPermission("FARMER", "product:register")).toBe(true);
    expect(hasPermission("FARMER", "transfer:create")).toBe(true);
  });

  it("does not let a farmer record processing, transport or retail", () => {
    expect(hasPermission("FARMER", "product:record-processing")).toBe(false);
    expect(hasPermission("FARMER", "product:record-transport")).toBe(false);
    expect(hasPermission("FARMER", "product:list-for-sale")).toBe(false);
  });

  it("lets a processor record processing but not register a product or list it for sale", () => {
    expect(hasPermission("PROCESSOR", "product:record-processing")).toBe(true);
    expect(hasPermission("PROCESSOR", "product:register")).toBe(false);
    expect(hasPermission("PROCESSOR", "product:list-for-sale")).toBe(false);
  });

  it("lets a transporter record transport but not record processing", () => {
    expect(hasPermission("TRANSPORTER", "product:record-transport")).toBe(true);
    expect(hasPermission("TRANSPORTER", "product:record-processing")).toBe(false);
    expect(hasPermission("TRANSPORTER", "product:list-for-sale")).toBe(false);
  });

  it("lets a retailer list a product for sale but not record processing or transport", () => {
    expect(hasPermission("RETAILER", "product:list-for-sale")).toBe(true);
    expect(hasPermission("RETAILER", "product:record-processing")).toBe(false);
    expect(hasPermission("RETAILER", "product:record-transport")).toBe(false);
  });

  it("lets a regulator read and generate compliance reports", () => {
    expect(hasPermission("REGULATOR", "compliance:read")).toBe(true);
    expect(hasPermission("REGULATOR", "compliance:report-generate")).toBe(true);
  });

  it("does not let a regulator register a product, transfer one or take custody of one", () => {
    expect(hasPermission("REGULATOR", "product:register")).toBe(false);
    expect(hasPermission("REGULATOR", "transfer:create")).toBe(false);
    expect(hasPermission("REGULATOR", "product:record-processing")).toBe(false);
    expect(hasPermission("REGULATOR", "product:list-for-sale")).toBe(false);
  });

  it("confines compliance permissions to the regulator alone", () => {
    for (const role of PARTICIPANT_ROLE_VALUES) {
      const expected = role === "REGULATOR";
      expect(hasPermission(role, "compliance:read")).toBe(expected);
      expect(hasPermission(role, "compliance:report-generate")).toBe(expected);
    }
  });

  it("confines product registration to the farmer alone", () => {
    for (const role of PARTICIPANT_ROLE_VALUES) {
      expect(hasPermission(role, "product:register")).toBe(role === "FARMER");
    }
  });

  it("grants only declared permissions and duplicates none", () => {
    for (const role of PARTICIPANT_ROLE_VALUES) {
      const permissions = permissionsFor(role);
      expect(new Set(permissions).size).toBe(permissions.length);
      for (const permission of permissions) {
        expect(PERMISSIONS).toContain(permission);
      }
    }
  });
});

describe("hasPermission", () => {
  it("agrees with permissionsFor for every role and permission pair", () => {
    for (const role of PARTICIPANT_ROLE_VALUES) {
      const granted = permissionsFor(role);
      for (const permission of PERMISSIONS) {
        expect(hasPermission(role, permission)).toBe(granted.includes(permission));
      }
    }
  });

  it("is the exact inverse of membership in the permission list", () => {
    expect(hasPermission("RETAILER", "product:list-for-sale")).toBe(
      permissionsFor("RETAILER").includes("product:list-for-sale")
    );
    expect(hasPermission("CONSUMER", "transfer:create")).toBe(
      permissionsFor("CONSUMER").includes("transfer:create")
    );
    expect(hasPermission("REGULATOR", "certificate:attach")).toBe(
      permissionsFor("REGULATOR").includes("certificate:attach")
    );
  });
});

describe("status update rights", () => {
  it("lets every business role move a batch forward but never a consumer", () => {
    for (const role of ROLES) {
      expect(canUpdateStatus(role)).toBe(true);
    }
    expect(canUpdateStatus(CONSUMER_ROLE)).toBe(false);
  });
});

describe("role labels", () => {
  it("gives every participant role a human label", () => {
    for (const role of PARTICIPANT_ROLE_VALUES) {
      expect(roleLabel(role)).toMatch(/^[A-Z][a-z]+$/);
    }
  });

  it("labels a consumer as well as the business roles", () => {
    expect(roleLabel("CONSUMER")).toBe("Consumer");
    expect(roleLabel("FARMER")).toBe("Farmer");
    expect(roleLabel("REGULATOR")).toBe("Regulator");
  });

  it("labels each role differently", () => {
    const labels = PARTICIPANT_ROLE_VALUES.map((role) => roleLabel(role));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("has no label for a role it does not declare", () => {
    expect(roleLabel("DISTRIBUTOR" as ParticipantRoleValue)).toBeUndefined();
  });
});
