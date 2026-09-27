import { expect } from "vitest";
import { AppError, type ErrorCode } from "../../src/lib/errors.js";

/**
 * Runs `action`, requires it to throw an `AppError`, and checks the code.
 * Returns the error so the caller can also assert on its message or details.
 */
export function expectAppError(action: () => unknown, code: ErrorCode): AppError {
  let thrown: unknown;
  try {
    action();
  } catch (error: unknown) {
    thrown = error;
  }
  if (!AppError.isAppError(thrown)) {
    throw new Error(
      `Expected an AppError with code ${code} but got ${
        thrown instanceof Error ? thrown.name : String(thrown)
      }.`
    );
  }
  expect(thrown.code).toBe(code);
  return thrown;
}
