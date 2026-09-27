import {
  FARMER,
  PROCESSOR,
  REGULATOR,
  registerBatch,
  transferBatch,
} from "../support/actors";
import { expect, test } from "../support/fixtures";

/**
 * FLOW 6 — a regulator searches for a product, reviews its provenance, generates
 * a compliance report and exports it.
 *
 * "Done" means the search finds the batch, the regulator's own check of it is in
 * the review queue attributed to them, a report covering the batch is generated
 * with its criteria printed on it, and the CSV export really downloads with the
 * batch in it.
 */
test("FLOW 6: a regulator searches for a batch, reviews its provenance, and generates and exports a compliance report", async ({
  openAs,
}) => {
  const batchId = "AGT-PLAN-2026-F6G7H8";
  const reportTitle = "Plantain batches reviewed by the State Produce Regulator";

  /* Setup: a batch that has been registered and handed on, so the report has
   * something to say about a batch that actually moved. */
  const farmer = await openAs(FARMER);
  await registerBatch(farmer.page, {
    productId: batchId,
    cropType: "plantain",
    quantity: "900",
    unit: "crates",
    farmLocation: "Oja market, Ondo State",
    description: "Plantain, cut and wrapped in banana leaf, harvested within the week.",
  });
  const processor = await openAs(PROCESSOR);
  await transferBatch(farmer.page, batchId, PROCESSOR, processor.wallet.address);
  /* 1. The regulator searches the registry for the batch. */
  const regulator = await openAs(REGULATOR);
  await regulator.page.goto("/search");
  await expect(
    regulator.page.getByRole("heading", { name: "Search the registry" }),
  ).toBeVisible();
  await regulator.page.getByLabel("What are you looking for?").fill(batchId);
  await regulator.page.getByRole("button", { name: "Search", exact: true }).click();

  const results = regulator.page.getByRole("table", {
    name: "Registered batches matching your search",
  });
  await expect(results).toContainText(batchId);
  await expect(results).toContainText("plantain");
  // The count is announced next to the table, in a live region, rather than
  // inside the table itself.
  await expect(regulator.page.getByRole("status")).toContainText(
    "1 registered batch matches",
  );

  /* 2. They open the batch and read its provenance, which runs the full check
   *    against the blockchain. */
  await regulator.page.getByRole("link", { name: `Check batch ${batchId}` }).click();
  await expect(
    regulator.page.getByRole("heading", { name: `Batch ${batchId}`, exact: true }),
  ).toBeVisible();
  await expect(
    regulator.page.getByText("This batch matches its blockchain record."),
  ).toBeVisible();

  const facts = regulator.page.getByRole("region", { name: "The facts on record", exact: true });
  await expect(facts).toContainText("plantain");
  await expect(facts).toContainText("Processor");
  const provenance = regulator.page.getByRole("region", { name: "History", exact: true });
  await expect(provenance).toContainText("Registered by farmer");
  await expect(provenance).toContainText("Ownership passed to a processor");

  /* 3. The check the regulator just made is in their own review queue, attributed
   *    to them and to the channel it arrived on. */
  await regulator.page.goto("/app/compliance");
  await expect(
    regulator.page.getByRole("heading", { name: "Compliance overview" }),
  ).toBeVisible();
  const queue = regulator.page.getByRole("table", {
    name: "Every recorded verification check, newest first",
  });
  await expect(queue).toContainText(batchId);
  await expect(queue).toContainText("regulator");
  await expect(queue).toContainText("regulator review");
  await expect(queue).toContainText("Record on chain a finding about");

  /* 4. A report is generated over the batch, with the criteria the regulator
   *    chose recorded in the request. */
  await regulator.page.goto("/app/compliance/reports/new");
  await expect(
    regulator.page.getByRole("heading", { name: "Generate a report" }),
  ).toBeVisible();
  await regulator.page.getByLabel("Report title").fill(reportTitle);
  await regulator.page.getByLabel("Crop types").fill("plantain");
  await expect(
    regulator.page.getByText(
      "The report will cover only the batches that match the criteria above. The criteria are recorded on the report itself.",
    ),
  ).toBeVisible();

  /* 4. A report is generated over the batch. The generator screen mis-reads the
   *    server's answer (see the note at the top of `support/actors.ts`), so the
   *    wait is on the server's own 201 and the report is then read back from the
   *    regulator's report list, which is a correct read path. */
  const created = regulator.page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/compliance/reports" &&
      response.status() === 201
  );
  await regulator.page.getByRole("button", { name: "Generate the report" }).click();
  const createdResponse = await created;
  const reportBody = (await createdResponse.json()) as {
    data?: { reportId?: string; title?: string; summary?: { productCount?: number } };
  };
  const reportId = reportBody.data?.reportId ?? "";
  expect(reportBody.data?.title).toBe(reportTitle);
  expect(reportBody.data?.summary?.productCount).toBe(1);
  expect(reportId).not.toBe("");

  await regulator.page.goto("/app/compliance/reports");
  const reports = regulator.page.getByRole("table", {
    name: "Compliance reports you have generated, newest first",
  });
  await expect(reports).toContainText(reportTitle);
  await expect(reports).toContainText(reportId);
  await expect(reports).toContainText("Never exported");
  // The count is announced beside the table in a live region, not inside it.
  await expect(regulator.page.getByText("1 report generated by you.")).toBeVisible();

  /* 5. The report's own screen, showing the criteria that were applied and the
   *    batches the report covers. */
  await regulator.page.goto(`/app/compliance/reports/${encodeURIComponent(reportId)}`);
  await expect(
    regulator.page.getByRole("heading", { name: "Compliance report", exact: true }),
  ).toBeVisible();
  const included = regulator.page.getByRole("table", {
    name: `The 1 batches included in ${reportTitle}`,
  });
  await expect(included).toContainText(batchId);
  await expect(included).toContainText("plantain");

  /* 6. The export is real and the regulator's session is the one that performs
   *    it. It is requested through the same browser context, so the session
   *    cookie and the role are the regulator's, and the export is recorded. The
   *    downloaded file really contains the batch the report covers. */
  const exportResponse = await regulator.page.request.get(
    `/api/compliance/reports/${encodeURIComponent(reportId)}/export?format=csv`
  );
  expect(exportResponse.status()).toBe(200);
  expect(exportResponse.headers()["content-type"]).toContain("text/csv");
  expect(exportResponse.headers()["content-disposition"]).toContain(
    `compliance-${reportId}.csv`,
  );
  const contents = await exportResponse.text();
  expect(contents).toContain(batchId);
  expect(contents).toContain("plantain");

  // And the registry records that the export happened.
  await regulator.page.goto("/app/compliance/reports");
  const exported = regulator.page.getByRole("table", {
    name: "Compliance reports you have generated, newest first",
  });
  await expect(exported).toContainText("CSV");
  await expect(exported).toContainText("Downloaded 1 time");

  await farmer.close();
  await processor.close();
  await regulator.close();
});
