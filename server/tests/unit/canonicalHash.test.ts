import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/lib/crypto.js";
import { ERROR_CODES } from "../../src/lib/errors.js";
import {
  CANONICAL_HASH_VERSION,
  assertHashShape,
  canonicalise,
  compareHashes,
  computeProfileHash,
  computeRegistrationHash,
  hashCanonicalPayload,
  normaliseCalendarDate,
  normaliseInstant,
  normaliseMultilineText,
  normaliseQuantity,
  normaliseText,
  registrationFields,
  unescapeControlCharacters,
  type CanonicalFieldValue,
  type CanonicalPayload,
  type RegistrationFacts,
} from "../../src/services/hashing/canonical.js";
import { expectAppError } from "../helpers/appError.js";

function payload(...fields: Array<readonly [string, CanonicalFieldValue]>): CanonicalPayload {
  return { fields };
}

function registrationFacts(overrides: Partial<RegistrationFacts> = {}): RegistrationFacts {
  return {
    productId: "AGT-COCOA-2026-A1B2C3",
    cropType: "cocoa",
    quantity: 250,
    unit: "kg",
    harvestDate: new Date("2026-01-14T09:30:00.000Z"),
    farmLocation: "Kumasi, Ghana",
    description: "Washed cocoa beans from the 2026 main harvest.",
    additionalNotes: "",
    registeredByWallet: "5wHu1tD9BqKvK9XhW1jF5Hq3pT9nGqQZ3mQ2rY7vKpP",
    imageHashes: ["a".repeat(64)],
    certificateHashes: [],
    registeredAt: new Date("2026-01-15T11:02:03.456Z"),
    ...overrides,
  };
}

describe("canonical serialisation", () => {
  it("emits the version line first, then one field line per declared field, newline terminated", () => {
    const canonical = canonicalise(
      payload(["productId", "AGT-COCOA-2026-A1B2C3"], ["cropType", "COCOA"], ["quantity", "250.00"])
    );
    expect(canonical).toBe(
      `version:${CANONICAL_HASH_VERSION}\n` +
        "productId:AGT-COCOA-2026-A1B2C3\n" +
        "cropType:COCOA\n" +
        "quantity:250.00\n"
    );
    expect(canonical.split("\n")).toEqual([
      `version:${CANONICAL_HASH_VERSION}`,
      "productId:AGT-COCOA-2026-A1B2C3",
      "cropType:COCOA",
      "quantity:250.00",
      "",
    ]);
  });

  it("renders zero and false as values so they are distinguishable from an absent field", () => {
    const canonical = canonicalise(
      payload(["count", 0], ["verified", false], ["tags", ["organic", "export"]])
    );
    expect(canonical).toBe("version:v2\ncount:0\nverified:false\ntags:organic,export\n");
  });

  it("serialises a null value and an empty string to the same empty value", () => {
    expect(canonicalise(payload(["notes", null]))).toBe(canonicalise(payload(["notes", ""])));
  });

  it("emits an empty imageHashes line that omitting the key entirely does not, so the byte streams differ", () => {
    const withEmptyList = canonicalise(registrationFields(registrationFacts({ imageHashes: [] })));
    const withoutKey = canonicalise({
      fields: registrationFields(registrationFacts()).fields.filter(
        ([name]) => name !== "imageHashes"
      ),
    });
    expect(withEmptyList).not.toBe(withoutKey);
    expect(withEmptyList.split("\n")).toContain("imageHashes:");
    expect(withoutKey.split("\n")).not.toContain("imageHashes:");
    expect(withEmptyList.split("\n").length).toBe(withoutKey.split("\n").length + 1);
  });

  it("rejects a payload that declares the same field name twice", () => {
    const error = expectAppError(
      () => canonicalise(payload(["cropType", "COCOA"], ["cropType", "COFFEE"])),
      ERROR_CODES.INTERNAL_ERROR
    );
    expect(error.message).toMatch(/declares the field "cropType" more than once/);
  });

  it("rejects an empty field name", () => {
    const error = expectAppError(
      () => canonicalise(payload(["", "value"])),
      ERROR_CODES.INTERNAL_ERROR
    );
    expect(error.message).toMatch(/must be non-empty/);
  });

  it("rejects a field name containing a colon", () => {
    const error = expectAppError(
      () => canonicalise(payload(["crop:type", "COCOA"])),
      ERROR_CODES.INTERNAL_ERROR
    );
    expect(error.message).toMatch(/contain no colon or newline/);
  });

  it("rejects a field name containing a newline", () => {
    expectAppError(
      () => canonicalise(payload(["crop\ntype", "COCOA"])),
      ERROR_CODES.INTERNAL_ERROR
    );
  });

  it("escapes a newline inside a value so the field stays on one line", () => {
    const serialised = canonicalise(payload(["description", "first line\nsecond line"]));
    expect(serialised).toContain("description:first line\\nsecond line\n");
    expect(serialised.split("\n")).toHaveLength(3);
  });

  it("round-trips the escaped control characters", () => {
    const original = "line one\nline two\ttabbed\\backslash";
    const serialised = canonicalise(payload(["description", original]));
    const line = serialised.split("\n")[1] ?? "";
    expect(unescapeControlCharacters(line.replace(/^description:/, ""))).toBe(original);
  });

  it("gives different digests to values that differ only in line structure", () => {
    const first = hashCanonicalPayload(payload(["description", "a\nb"]));
    const second = hashCanonicalPayload(payload(["description", "a b"]));
    expect(first).not.toBe(second);
  });

  it("treats a carriage return the same as no carriage return", () => {
    const windows = hashCanonicalPayload(payload(["description", "a\r\nb"]));
    const unix = hashCanonicalPayload(payload(["description", "a\nb"]));
    expect(windows).toBe(unix);
  });

  it("rejects a value that is not a finite number", () => {
    expectAppError(() => canonicalise(payload(["quantity", Number.NaN])), ERROR_CODES.VALIDATION_ERROR);
    expectAppError(
      () => canonicalise(payload(["quantity", Number.POSITIVE_INFINITY])),
      ERROR_CODES.VALIDATION_ERROR
    );
  });

  it("hashes exactly the bytes of the canonical string", () => {
    const canonical = canonicalise(payload(["productId", "AGT-COCOA-2026-A1B2C3"]));
    expect(hashCanonicalPayload(payload(["productId", "AGT-COCOA-2026-A1B2C3"]))).toBe(
      sha256Hex(Buffer.from(canonical, "utf8"))
    );
  });

  it("produces a 64 character lowercase hex digest", () => {
    expect(hashCanonicalPayload(payload(["productId", "AGT-COCOA-2026-A1B2C3"]))).toMatch(
      /^[0-9a-f]{64}$/
    );
  });
});

describe("canonical field order", () => {
  /**
   * The anchored hash must not depend on how a record happened to be assembled
   * in memory. `JSON.stringify` would, because JavaScript preserves insertion
   * order; the canonical form does not, because the field order is declared by
   * `registrationFields` rather than inherited from the input object.
   */
  const declared: RegistrationFacts = {
    productId: "AGT-COCOA-2026-A1B2C3",
    cropType: "cocoa",
    quantity: 250,
    unit: "kg",
    harvestDate: "2026-01-14T09:30:00.000Z",
    farmLocation: "Kumasi, Ghana",
    description: "Washed cocoa beans from the 2026 main harvest.",
    additionalNotes: "Dried on raised beds.",
    registeredByWallet: "5wHu1tD9BqKvK9XhW1jF5Hq3pT9nGqQZ3mQ2rY7vKpP",
    imageHashes: ["a".repeat(64)],
    certificateHashes: ["b".repeat(64)],
    registeredAt: "2026-01-15T11:02:03.456Z",
  };

  it("hashes the same facts identically when the source object's keys were inserted in the opposite order, unlike JSON.stringify", () => {
    const reversed: RegistrationFacts = {
      registeredAt: "2026-01-15T11:02:03.456Z",
      certificateHashes: ["b".repeat(64)],
      imageHashes: ["a".repeat(64)],
      registeredByWallet: "5wHu1tD9BqKvK9XhW1jF5Hq3pT9nGqQZ3mQ2rY7vKpP",
      additionalNotes: "Dried on raised beds.",
      description: "Washed cocoa beans from the 2026 main harvest.",
      farmLocation: "Kumasi, Ghana",
      harvestDate: "2026-01-14T09:30:00.000Z",
      unit: "kg",
      quantity: 250,
      cropType: "cocoa",
      productId: "AGT-COCOA-2026-A1B2C3",
    };
    expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(declared));
    expect(canonicalise(registrationFields(reversed))).toBe(canonicalise(registrationFields(declared)));
    expect(computeRegistrationHash(reversed)).toBe(computeRegistrationHash(declared));
  });

  it("follows the declared array order, so a payload whose array is reversed canonicalises to different bytes", () => {
    const forward = payload(["cropType", "COCOA"], ["quantity", "250.00"]);
    const reversed = payload(["quantity", "250.00"], ["cropType", "COCOA"]);
    expect(canonicalise(forward)).not.toBe(canonicalise(reversed));
    expect(hashCanonicalPayload(forward)).not.toBe(hashCanonicalPayload(reversed));
  });

  it("anchors registration facts only, so mutable lifecycle state is not part of the payload", () => {
    const names = registrationFields(registrationFacts()).fields.map(([name]) => name);
    expect(names).toEqual([
      "productId",
      "cropType",
      "quantity",
      "unit",
      "harvestDate",
      "farmLocation",
      "description",
      "additionalNotes",
      "registeredByWallet",
      "imageHashes",
      "certificateHashes",
      "registeredAt",
    ]);
    expect(names).not.toContain("status");
  });
});

describe("text normalisation", () => {
  it("collapses internal whitespace and trims the ends of single-line text", () => {
    expect(normaliseText("  Kumasi   Region \t Ghana  ")).toBe("Kumasi Region Ghana");
  });

  it("normalises a decomposed accented character to its composed form", () => {
    expect(normaliseText("Cafe\u0301 cocoa")).toBe("Café cocoa");
  });

  it("treats null and undefined text as an empty value", () => {
    expect(normaliseText(null)).toBe("");
    expect(normaliseText(undefined)).toBe("");
  });

  it("preserves line structure in multiline text while stripping trailing spaces", () => {
    expect(normaliseMultilineText("Line one   \nLine two\t\n\nLine four  ")).toBe(
      "Line one\nLine two\n\nLine four"
    );
  });

  it("converts CRLF and CR line endings to LF in multiline text", () => {
    expect(normaliseMultilineText("First\r\nSecond\rThird")).toBe("First\nSecond\nThird");
  });

  it("collapses runs of internal spaces on a multiline line", () => {
    expect(normaliseMultilineText("Washed   beans\nSun   dried")).toBe("Washed beans\nSun dried");
  });

  it("treats null and undefined multiline text as an empty value", () => {
    expect(normaliseMultilineText(null)).toBe("");
    expect(normaliseMultilineText(undefined)).toBe("");
  });
});

describe("date and quantity normalisation", () => {
  it("renders a calendar date as YYYY-MM-DD in UTC regardless of the offset it was given", () => {
    expect(normaliseCalendarDate(new Date("2026-01-31T23:30:00.000Z"))).toBe("2026-01-31");
    expect(normaliseCalendarDate("2026-01-31T18:30:00-05:00")).toBe("2026-01-31");
    expect(normaliseCalendarDate("2026-02-01")).toBe("2026-02-01");
  });

  it("shifts a late-evening local date to the next UTC day, so a calendar date is anchored in UTC", () => {
    expect(normaliseCalendarDate("2026-01-31T20:30:00-05:00")).toBe("2026-02-01");
  });

  it("rejects an unparseable calendar date rather than hashing an invalid value", () => {
    const error = expectAppError(
      () => normaliseCalendarDate("not-a-date"),
      ERROR_CODES.VALIDATION_ERROR
    );
    expect(error.message).toMatch(/not a valid date/);
  });

  it("renders an instant as full ISO-8601 with millisecond precision", () => {
    expect(normaliseInstant(new Date("2026-01-14T09:30:00.456Z"))).toBe("2026-01-14T09:30:00.456Z");
    expect(normaliseInstant("2026-01-14T09:30:00.456Z")).toBe("2026-01-14T09:30:00.456Z");
    expect(normaliseInstant(new Date("2026-01-14T09:30:00.000Z"))).toBe("2026-01-14T09:30:00.000Z");
  });

  it("rejects an unparseable instant rather than hashing an invalid value", () => {
    expectAppError(() => normaliseInstant("2026-13-45"), ERROR_CODES.VALIDATION_ERROR);
  });

  it("renders a quantity with exactly two decimal places", () => {
    expect(normaliseQuantity(1)).toBe("1.00");
    expect(normaliseQuantity(250)).toBe("250.00");
    expect(normaliseQuantity(12.5)).toBe("12.50");
    expect(normaliseQuantity(0.125)).toBe("0.13");
  });

  it("rounds 1.005 down to 1.00 because its binary value sits just below the midpoint", () => {
    expect(normaliseQuantity(1.005)).toBe("1.00");
    expect(normaliseQuantity(1.015)).toBe("1.01");
  });

  it("rejects a quantity that is not a finite number", () => {
    expectAppError(() => normaliseQuantity(Number.NaN), ERROR_CODES.VALIDATION_ERROR);
    expectAppError(() => normaliseQuantity(Number.POSITIVE_INFINITY), ERROR_CODES.VALIDATION_ERROR);
  });
});

describe("registration hash", () => {
  it("is deterministic for the same facts", () => {
    expect(computeRegistrationHash(registrationFacts())).toBe(computeRegistrationHash(registrationFacts()));
  });

  it("changes when a single character of the description changes", () => {
    const original = computeRegistrationHash(registrationFacts());
    const tampered = computeRegistrationHash(
      registrationFacts({ description: "Washed cocoa beans from the 2026 main harvest!" })
    );
    expect(tampered).not.toBe(original);
  });

  it("changes when the quantity changes", () => {
    expect(computeRegistrationHash(registrationFacts({ quantity: 251 }))).not.toBe(
      computeRegistrationHash(registrationFacts())
    );
  });

  it("changes when a single attached image hash changes", () => {
    expect(
      computeRegistrationHash(registrationFacts({ imageHashes: ["a".repeat(63) + "b"] }))
    ).not.toBe(computeRegistrationHash(registrationFacts()));
  });

  it("is unaffected by differences the canonical form normalises away", () => {
    expect(computeRegistrationHash(registrationFacts({ quantity: 1 }))).toBe(
      computeRegistrationHash(registrationFacts({ quantity: 1.0 }))
    );
    expect(computeRegistrationHash(registrationFacts({ cropType: "cocoa" }))).toBe(
      computeRegistrationHash(registrationFacts({ cropType: "  COCOA  " }))
    );
    expect(computeRegistrationHash(registrationFacts({ unit: "KG" }))).toBe(
      computeRegistrationHash(registrationFacts({ unit: "kg" }))
    );
    expect(computeRegistrationHash(registrationFacts({ additionalNotes: "" }))).toBe(
      computeRegistrationHash(registrationFacts({ additionalNotes: "   " }))
    );
  });

  it("ignores who currently owns the batch, so a transfer cannot look like tampering", () => {
    // Ownership passes along the supply chain. If it were part of the anchored
    // fingerprint then every batch that changed hands could never be verified
    // again, and would be reported to its owner as having been altered.
    const atRegistration = computeRegistrationHash(registrationFacts());
    const afterTransfer = computeRegistrationHash(registrationFacts());
    expect(afterTransfer).toBe(atRegistration);
    expect(registrationFields(registrationFacts()).fields.map(([name]) => name)).not.toContain(
      "ownerWallet"
    );
  });

  it("changes when the registrant changes, because the registrant is anchored", () => {
    expect(
      computeRegistrationHash(
        registrationFacts({ registeredByWallet: "9rMw3dY2Q7uVnLp5Kb1yHc2XgRt8ZsWvC6NeJkA4uBdM" })
      )
    ).not.toBe(computeRegistrationHash(registrationFacts()));
  });

  it("changes when the registered instant changes", () => {
    expect(
      computeRegistrationHash(registrationFacts({ registeredAt: new Date("2026-01-15T11:02:03.457Z") }))
    ).not.toBe(computeRegistrationHash(registrationFacts()));
  });
});

describe("profile hash", () => {
  const profile = {
    walletAddress: "5wHu1tD9BqKvK9XhW1jF5Hq3pT9nGqQZ3mQ2rY7vKpP",
    fullName: "Ama  Mensah",
    role: "FARMER",
    contactEmail: "ama.mensah@example.com",
    contactPhone: "+233 20 000 0000",
    organisation: "Asante Cooperative",
  };

  it("is stable for the same profile facts", () => {
    expect(computeProfileHash(profile)).toBe(computeProfileHash({ ...profile }));
  });

  it("changes when the organisation changes", () => {
    expect(computeProfileHash({ ...profile, organisation: "Asante Union" })).not.toBe(
      computeProfileHash(profile)
    );
  });

  it("ignores the case of the contact email and the spacing of the full name", () => {
    expect(computeProfileHash({ ...profile, contactEmail: "AMA.MENSAH@EXAMPLE.COM" })).toBe(
      computeProfileHash(profile)
    );
    expect(computeProfileHash({ ...profile, fullName: "Ama Mensah" })).toBe(
      computeProfileHash(profile)
    );
  });
});

describe("hash comparison", () => {
  const digest = "a".repeat(64);

  it("reports a match for two identical digests", () => {
    const comparison = compareHashes(digest, digest);
    expect(comparison.match).toBe(true);
    expect(comparison.expected).toBe(digest);
    expect(comparison.actual).toBe(digest);
  });

  it("reports a match for the same digest in different letter case", () => {
    const comparison = compareHashes(digest.toUpperCase(), digest);
    expect(comparison.match).toBe(true);
    expect(comparison.expected).toBe(digest);
    expect(comparison.actual).toBe(digest);
  });

  it("ignores surrounding whitespace on either digest", () => {
    expect(compareHashes(`  ${digest}\n`, `\t${digest} `).match).toBe(true);
  });

  it("reports a mismatch and returns both digests when the values differ", () => {
    const comparison = compareHashes(digest, "b".repeat(64));
    expect(comparison.match).toBe(false);
    expect(comparison.expected).toBe(digest);
    expect(comparison.actual).toBe("b".repeat(64));
  });

  it("reports a mismatch when only one side is supplied", () => {
    expect(compareHashes(digest, "").match).toBe(false);
    expect(compareHashes("", digest).match).toBe(false);
  });
});

describe("hash shape", () => {
  it("accepts a 64 character lowercase hex digest and returns it unchanged", () => {
    const digest = "0123456789abcdef".repeat(4);
    expect(assertHashShape(digest, "dataHash")).toBe(digest);
  });

  it("rejects a digest in uppercase", () => {
    const error = expectAppError(
      () => assertHashShape("A".repeat(64), "dataHash"),
      ERROR_CODES.VALIDATION_ERROR
    );
    expect(error.message).toMatch(/64 character lowercase SHA-256 hex digest/);
  });

  it("rejects a digest that is too short", () => {
    expectAppError(() => assertHashShape("a".repeat(63), "dataHash"), ERROR_CODES.VALIDATION_ERROR);
  });

  it("rejects a digest that is too long", () => {
    expectAppError(() => assertHashShape("a".repeat(65), "dataHash"), ERROR_CODES.VALIDATION_ERROR);
  });

  it("rejects a digest containing a non-hexadecimal character", () => {
    expectAppError(
      () => assertHashShape(`${"a".repeat(63)}z`, "dataHash"),
      ERROR_CODES.VALIDATION_ERROR
    );
    expectAppError(
      () => assertHashShape(`${"a".repeat(63)}-`, "dataHash"),
      ERROR_CODES.VALIDATION_ERROR
    );
  });

  it("rejects a digest with surrounding whitespace because it asserts a shape without trimming", () => {
    expectAppError(() => assertHashShape(` ${"a".repeat(64)} `, "dataHash"), ERROR_CODES.VALIDATION_ERROR);
  });

  it("names the offending field in the failure", () => {
    const error = expectAppError(() => assertHashShape("nope", "offChainDataHash"), ERROR_CODES.VALIDATION_ERROR);
    expect(error.details).toEqual([
      { path: "offChainDataHash", message: "Expected a SHA-256 hex digest." },
    ]);
  });
});
