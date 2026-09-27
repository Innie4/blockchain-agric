import { FARMER, registerBatch } from "../support/actors";
import { readStoredProduct, tamperStoredDescription } from "../support/database";
import { expect, test } from "../support/fixtures";

/**
 * FLOW 5 — tampering is detected.
 *
 * A batch is registered, its description is then rewritten behind the
 * application's back (the API has no route that would allow it, which is the
 * point), and the batch is checked again from the public page.
 *
 * "Done" means the public page refuses to vouch for the batch: it names the
 * mismatch in a heading, in a badge and in a panel that shows all three hashes
 * side by side, and it marks the history as unverified. The test also reads the
 * stored record back, so the assertion is not only about what the page claims.
 */
test("FLOW 5: altering a registered batch is detected, and the public page says so unmistakably", async ({
  page,
  openAs,
}) => {
  const batchId = "AGT-GINGER-2026-E5F6G7";
  const honestDescription =
    "White ginger, washed and dried in the shade, from the 2025 harvest.";

  /* 1. A farmer registers the batch honestly. */
  const farmer = await openAs(FARMER);
  await registerBatch(farmer.page, {
    productId: batchId,
    cropType: "ginger",
    quantity: "250",
    unit: "bags",
    farmLocation: "Boki farm, Abia State",
    description: honestDescription,
  });

  const before = await readStoredProduct(batchId);
  expect(before?.chainState).toBe("CONFIRMED");
  expect(before?.description).toBe(honestDescription);
  expect(before?.onChainDataHash).toBe(before?.dataHash);

  /* 2. A first check passes, so the mismatch afterwards cannot be mistaken for a
   *    batch that was never anchored. */
  await page.goto(`/verify/${encodeURIComponent(batchId)}`);
  await expect(page.getByText("This batch matches its blockchain record.")).toBeVisible();
  const verifiedFacts = page.getByRole("region", { name: "The facts on record", exact: true });
  const anchoredBefore = ((await verifiedFacts.textContent()) ?? "").match(/[0-9a-f]{64}/)?.[0];
  expect(anchoredBefore).toBeDefined();

  /* 3. Somebody with direct database access rewrites the stored description.
   *    This is done from the test process over its own MongoDB connection,
   *    because the API deliberately offers no way to do it. */
  const tampered = await tamperStoredDescription(
    batchId,
    "White ginger, washed and dried in the shade, from the 2025 harvest. No inspection carried out."
  );
  expect(tampered.description).toContain("No inspection carried out");
  expect(tampered.dataHash).toBe(before?.dataHash);
  expect(tampered.onChainDataHash).toBe(before?.onChainDataHash);

  /* 4. The batch is checked again, and the interface refuses to vouch for it. */
  await page.goto(`/verify/${encodeURIComponent(batchId)}`);
  await expect(
    page.getByRole("heading", { name: "This batch does not match its blockchain record." }),
  ).toBeVisible();
  await expect(page.getByText("Details do not match", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Reason recorded: HASH_MISMATCH"),
  ).toBeVisible();

  /* 5. The three fingerprints that were compared are printed together, so a
   *    reader can do the comparison themselves: the anchored value and the value
   *    stored at registration agree, and the value the details now produce does
   *    not. */
  const comparison = page.getByRole("region", { name: "Why it does not match", exact: true });
  await expect(comparison).toContainText("On the blockchain");
  await expect(comparison).toContainText("Held in the records");
  await expect(comparison).toContainText("Recomputed now");

  const compared = ((await comparison.textContent()) ?? "").match(/[0-9a-f]{64}/g) ?? [];
  expect(compared).toHaveLength(3);
  expect(compared[0]).toBe(anchoredBefore);
  expect(compared[1]).toBe(anchoredBefore);
  expect(compared[2]).not.toBe(anchoredBefore);

  /* 6. The provenance is marked as a claim rather than a fact, in words. */
  await expect(page.getByText(/Shown for reference only/)).toBeVisible();
  const history = page.getByRole("region", { name: "History (unverified)", exact: true });
  await expect(history).toContainText("Not verified");
  await expect(history.getByRole("heading", { name: "Registered by farmer" })).toBeVisible();

  /* 7. The record itself now carries the finding, so it is visible to a
   *    regulator as well as to the consumer who checked it. */
  const after = await readStoredProduct(batchId);
  expect(after?.lastVerificationResult).toBe("MISMATCH");
  expect(after?.chainState).toBe("CONFIRMED");

  await farmer.close();
});
