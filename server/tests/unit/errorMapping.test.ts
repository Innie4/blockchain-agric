import { describe, expect, it } from "vitest";
import { AppError, ERROR_CODES, type ErrorCode } from "../../src/lib/errors.js";
import {
  PROGRAM_ERROR_CODES,
  extractErrorName,
  extractProgramErrorCode,
  normaliseBlockchainError,
  programErrorName,
  type ProgramErrorName,
} from "../../src/services/solana/errorMapping.js";

const CONTEXT = "register product AGT-COCOA-2026-A1B2C3";

const EXPECTED_PROGRAM_CODES: Record<ProgramErrorName, ErrorCode> = {
  DuplicateProduct: ERROR_CODES.PRODUCT_ALREADY_EXISTS,
  UnauthorizedOwner: ERROR_CODES.TRANSFER_NOT_ALLOWED,
  InvalidRecipient: ERROR_CODES.RECIPIENT_NOT_REGISTERED,
  InvalidStateTransition: ERROR_CODES.PRODUCT_STATE_INVALID,
  RecipientRoleNotAllowed: ERROR_CODES.RECIPIENT_ROLE_NOT_ALLOWED,
  RegulatorOnly: ERROR_CODES.ROLE_NOT_ALLOWED,
  ProductFlagged: ERROR_CODES.PRODUCT_STATE_INVALID,
  ProductClosed: ERROR_CODES.PRODUCT_STATE_INVALID,
  ParticipantNotRegistered: ERROR_CODES.PARTICIPANT_NOT_REGISTERED,
  InvalidTimestamp: ERROR_CODES.VALIDATION_ERROR,
  ParticipantAlreadyRegistered: ERROR_CODES.PARTICIPANT_ALREADY_REGISTERED,
  RegistrantRoleNotAllowed: ERROR_CODES.ROLE_NOT_ALLOWED,
  MalformedIdentifier: ERROR_CODES.VALIDATION_ERROR,
};

/** The shape a Solana RPC error takes when the program's custom error fires. */
function instructionError(code: number, instructionIndex = 0): unknown {
  return { err: { InstructionError: [instructionIndex, { Custom: code }] } };
}

function codeOf(error: unknown, context = CONTEXT): ErrorCode {
  const normalised = normaliseBlockchainError(error, context);
  if (!AppError.isAppError(normalised)) {
    throw new Error("normaliseBlockchainError did not return an AppError.");
  }
  return normalised.code;
}

describe("program error codes", () => {
  it("assigns Anchor's 6000 + index numbering to every variant without gaps or collisions", () => {
    const codes = Object.values(PROGRAM_ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    expect(Math.min(...codes)).toBe(6000);
    expect(Math.max(...codes)).toBe(6012);
  });

  it("covers every program error code in the expected mapping table", () => {
    expect(Object.keys(EXPECTED_PROGRAM_CODES).sort()).toEqual(
      Object.keys(PROGRAM_ERROR_CODES).sort()
    );
  });

  it.each(Object.entries(EXPECTED_PROGRAM_CODES) as Array<[ProgramErrorName, ErrorCode]>)(
    "maps the on-chain %s error to the documented API code",
    (name, expected) => {
      expect(codeOf(instructionError(PROGRAM_ERROR_CODES[name]))).toBe(expected);
    }
  );

  it("maps an error raised by the second instruction of a transaction", () => {
    expect(codeOf(instructionError(PROGRAM_ERROR_CODES.UnauthorizedOwner, 1))).toBe(
      ERROR_CODES.TRANSFER_NOT_ALLOWED
    );
  });

  it("records the program error code and the context so a support ticket can be traced", () => {
    const error = normaliseBlockchainError(
      instructionError(PROGRAM_ERROR_CODES.DuplicateProduct),
      CONTEXT
    );
    expect(error.details).toEqual({
      programErrorCode: PROGRAM_ERROR_CODES.DuplicateProduct,
      context: CONTEXT,
    });
  });

  it("gives every mapped program error a human-readable message that carries no stack trace", () => {
    for (const name of Object.keys(EXPECTED_PROGRAM_CODES) as ProgramErrorName[]) {
      const error = normaliseBlockchainError(
        instructionError(PROGRAM_ERROR_CODES[name]),
        CONTEXT
      );
      expect(error.message.length).toBeGreaterThan(10);
      expect(error.message).not.toMatch(/\n\s+at /);
      expect(error.message).not.toMatch(/at Object|Error: /);
    }
  });
});

describe("framework error names", () => {
  it("maps AccountNotInitialized to a recipient that has no registration", () => {
    expect(codeOf({ name: "AccountNotInitialized", message: "Account does not exist" })).toBe(
      ERROR_CODES.RECIPIENT_NOT_REGISTERED
    );
  });

  it("maps ConstraintAlreadyInUse to a product that already exists", () => {
    expect(codeOf({ name: "ConstraintAlreadyInUse", message: "PDAs must have unique seeds" })).toBe(
      ERROR_CODES.PRODUCT_ALREADY_EXISTS
    );
  });

  it("maps AccountDiscriminatorMismatch to a recipient that has no registration", () => {
    expect(codeOf({ name: "AccountDiscriminatorMismatch" })).toBe(
      ERROR_CODES.RECIPIENT_NOT_REGISTERED
    );
  });

  it("maps an Anchor constraint failure to a generic transaction failure", () => {
    expect(codeOf({ name: "ConstraintSigner" })).toBe(ERROR_CODES.BLOCKCHAIN_TRANSACTION_FAILED);
  });

  it("records the framework error name in the details", () => {
    const error = normaliseBlockchainError({ name: "AccountNotInitialized" }, CONTEXT);
    expect(error.details).toEqual({ programErrorName: "AccountNotInitialized", context: CONTEXT });
  });

  it("does not mistake a web3.js client error code for an on-chain program error", () => {
    expect(codeOf({ code: -32002, message: "User rejected the request" })).toBe(
      ERROR_CODES.WALLET_SIGNATURE_REJECTED
    );
  });
});

describe("rpc message hints", () => {
  it("reports the RPC endpoint as unavailable when the fetch itself fails", () => {
    expect(codeOf(new Error("fetch failed"))).toBe(ERROR_CODES.BLOCKCHAIN_RPC_UNAVAILABLE);
  });

  it("reports the RPC endpoint as unavailable when the connection is refused", () => {
    expect(codeOf(new Error("connect ECONNREFUSED 127.0.0.1:8899"))).toBe(
      ERROR_CODES.BLOCKCHAIN_RPC_UNAVAILABLE
    );
  });

  it("reports the RPC endpoint as unavailable when a transaction log hints at a transport failure", () => {
    expect(codeOf({ message: "boom", logs: ["Program data: aborted", "socket hang up"] })).toBe(
      ERROR_CODES.BLOCKCHAIN_RPC_UNAVAILABLE
    );
  });

  it("reports a declined wallet signature when the user rejects the request", () => {
    expect(codeOf(new Error("User rejected the request."))).toBe(
      ERROR_CODES.WALLET_SIGNATURE_REJECTED
    );
  });

  it("reports a confirmation timeout when the block height is exceeded", () => {
    expect(codeOf(new Error("TransactionExpiredBlockheightExceededError: block height exceeded"))).toBe(
      ERROR_CODES.BLOCKCHAIN_CONFIRMATION_TIMEOUT
    );
  });

  it("reports a confirmation timeout when the request times out", () => {
    expect(codeOf(new Error("Transaction simulation timed out"))).toBe(
      ERROR_CODES.BLOCKCHAIN_CONFIRMATION_TIMEOUT
    );
  });

  it("reports a generic transaction failure for a failure it does not recognise", () => {
    const error = normaliseBlockchainError(new Error("something nobody predicted"), CONTEXT);
    expect(error.code).toBe(ERROR_CODES.BLOCKCHAIN_TRANSACTION_FAILED);
    expect(error.message).toContain(CONTEXT);
  });

  it("names the context in the message of a generic transaction failure", () => {
    expect(normaliseBlockchainError("raw string failure", "transfer batch").message).toBe(
      "The Solana transaction could not be completed (transfer batch)."
    );
  });
});

describe("pass through", () => {
  it("returns an existing AppError unchanged rather than re-wrapping it", () => {
    const original = new AppError(ERROR_CODES.PRODUCT_NOT_FOUND, { message: "Gone for good." });
    expect(normaliseBlockchainError(original, CONTEXT)).toBe(original);
    expect(normaliseBlockchainError(original, CONTEXT).message).toBe("Gone for good.");
  });
});

describe("extractProgramErrorCode", () => {
  it("finds a code nested inside err.InstructionError", () => {
    expect(extractProgramErrorCode(instructionError(6005))).toBe(6005);
  });

  it("finds a code nested several levels deep behind cause", () => {
    const wrapped = { cause: { cause: instructionError(6009) } };
    expect(extractProgramErrorCode(wrapped)).toBe(6009);
  });

  it("finds a code carried directly on the error object", () => {
    expect(extractProgramErrorCode({ code: 6003, message: "failed" })).toBe(6003);
  });

  it("finds a code carried in a transaction log line", () => {
    expect(
      extractProgramErrorCode({ logs: ["Program log: Custom program error: 0x1775"] })
    ).toBe(6005);
  });

  it("returns null when there is no program error code at all", () => {
    expect(extractProgramErrorCode(new Error("fetch failed"))).toBeNull();
    expect(extractProgramErrorCode({ code: -32002, message: "rejected" })).toBeNull();
    expect(extractProgramErrorCode("just a string")).toBeNull();
    expect(extractProgramErrorCode(null)).toBeNull();
    expect(extractProgramErrorCode(undefined)).toBeNull();
  });

  it("returns the code from an InstructionError the mapping table does not define, and falls back to a generic failure", () => {
    expect(extractProgramErrorCode(instructionError(6999))).toBe(6999);
    expect(codeOf(instructionError(6999))).toBe(ERROR_CODES.BLOCKCHAIN_TRANSACTION_FAILED);
  });

  it("terminates on a self-referential error graph instead of looping forever", () => {
    const looping: Record<string, unknown> = { message: "loop" };
    looping["cause"] = looping;
    expect(extractProgramErrorCode(looping)).toBeNull();
  });
});

describe("extractErrorName", () => {
  it("finds the name on the error itself", () => {
    expect(extractErrorName({ name: "AccountNotInitialized" })).toBe("AccountNotInitialized");
  });

  it("finds the name nested behind cause", () => {
    expect(extractErrorName({ cause: { err: { name: "ConstraintAlreadyInUse" } } })).toBe(
      "ConstraintAlreadyInUse"
    );
  });

  it("returns null when no name is present", () => {
    expect(extractErrorName({ message: "fetch failed" })).toBeNull();
    expect(extractErrorName({ name: "" })).toBeNull();
    expect(extractErrorName(null)).toBeNull();
  });

  it("reports the class name of a plain Error, which the framework table does not match", () => {
    expect(extractErrorName(new Error("fetch failed"))).toBe("Error");
    expect(codeOf(new Error("fetch failed"))).toBe(ERROR_CODES.BLOCKCHAIN_RPC_UNAVAILABLE);
  });
});

describe("programErrorName", () => {
  it("maps 6000 to DuplicateProduct", () => {
    expect(programErrorName(6000)).toBe("DuplicateProduct");
  });

  it("maps every declared code back to its name", () => {
    for (const [name, code] of Object.entries(PROGRAM_ERROR_CODES) as Array<
      [ProgramErrorName, number]
    >) {
      expect(programErrorName(code)).toBe(name);
    }
  });

  it("returns null for a code the program does not define", () => {
    expect(programErrorName(5999)).toBeNull();
    expect(programErrorName(6013)).toBeNull();
    expect(programErrorName(0)).toBeNull();
  });
});
