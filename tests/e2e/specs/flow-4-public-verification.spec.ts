import { FARMER, registerBatch } from "../support/actors";
import { expect, test } from "../support/fixtures";

/**
 * FLOW 4 — a consumer with no wallet at all enters a batch identifier, the batch
 * is looked up both on the blockchain and in the database, the fingerprint is
 * verified, and the provenance is shown.
 *
 * "Done" means the public page says the batch matches its blockchain record,
 * shows the facts and the whole history, and says plainly that no account was
 * used. This test's own page has no wallet installed, so the header offers to
 * set one up rather than pretending somebody is connected.
 */
test("FLOW 4: a consumer with no wallet checks a batch identifier and is shown the verified provenance", async ({
  page,
  openAs,
}) => {
  const batchId = "AGT-SOYBE-2026-D4E5F6";

  /* Setup: a farmer registers a batch that a consumer can then check. */
  const farmer = await openAs(FARMER);
  await registerBatch(farmer.page, {
    productId: batchId,
    cropType: "soybean",
    quantity: "60",
    unit: "bags",
    farmLocation: "Ado farm, Ikom LGA, Cross River State",
    description: "Soybean, cleaned and bagged, no foreign matter over two percent.",
  });

  /* 1. The consumer is a member of the public: no wallet, and the interface says
   *    so rather than demanding one. */
  await page.goto("/verify");
  await expect(page.getByRole("link", { name: "Set up a wallet" })).toBeVisible();
  await expect(
    page.getByText("Enter the identifier printed on the packaging. Checking a batch needs no account, no wallet and no sign-in."),
  ).toBeVisible();

  /* 2. They type the identifier printed on the packaging and check it. The
   *    control is found by its role because the panel around it carries the
   *    same name. */
  await page.getByRole("textbox", { name: "Batch identifier" }).fill(batchId.toLowerCase());
  await page.getByRole("button", { name: "Check this batch" }).click();

  /* 3. The batch is looked up on the blockchain and in the database, and the
   *    fingerprint is compared. The result is stated first, in words. */
  await expect(
    page.getByRole("heading", { name: `Batch ${batchId}`, exact: true }),
  ).toBeVisible();
  await expect(page.getByText("This batch matches its blockchain record.")).toBeVisible();
  await expect(page.getByText("Verified", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Checked just now against the record anchored on the blockchain. No account was used, and none is needed.",
    ),
  ).toBeVisible();

  /* 4. The facts on record are displayed, including the fingerprint and the
   *    on-chain address a reader could check themselves. */
  const facts = page.getByRole("region", { name: "The facts on record", exact: true });
  await expect(facts).toContainText("soybean");
  await expect(facts).toContainText("60 bags");
  await expect(facts).toContainText("Ado farm, Ikom LGA, Cross River State");
  await expect(facts).toContainText("Farmer");
  await expect(facts).toContainText("Registered");
  await expect(facts).toContainText(
    "Soybean, cleaned and bagged, no foreign matter over two percent.",
  );
  await expect(facts).toContainText("Anchored fingerprint");
  await expect(facts).toContainText("On-chain address");
  const fingerprints = (await facts.textContent()) ?? "";
  expect(fingerprints).toMatch(/[0-9a-f]{64}/);

  /* 5. The provenance is displayed: the registration is on the timeline. The
   *    check recorded in step 6 is deliberately not in this list yet, because
   *    the page read the provenance before it recorded the check; step 7
   *    reloads to show that a recorded check does appear. */
  const history = page.getByRole("region", { name: "History", exact: true });
  await expect(history.getByRole("heading", { name: "Registered by farmer" })).toBeVisible();
  await expect(history).toContainText("Registration by FARMER");

  /* 6. The check itself is recorded on the server, so a regulator can see who
   *    looked at what. */
  await expect(page.getByText("This check was recorded on the server.")).toBeVisible();
  await expect(page.getByText(/Checks recorded for this batch: \d+/)).toBeVisible();

  /* 7. Reloading shows the recorded check on the timeline, which is how a
   *    regulator's review history builds up, and names who checked the batch. The
   *    who-last-checked line is read from the batch's own history, so it only
   *    knows about this check once the page has read it back. */
  await page.reload();
  const reloaded = page.getByRole("region", { name: "History", exact: true });
  await expect(reloaded).toContainText("Checked: verified");
  await expect(page.getByText("Checked by a member of the public, with no account.")).toBeVisible();

  await farmer.close();
});
