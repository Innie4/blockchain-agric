import {
  FARMER,
  PROCESSOR,
  recordProcessing,
  registerBatch,
  transferBatch,
} from "../support/actors";
import { expect, test } from "../support/fixtures";

/**
 * FLOW 2 — a farmer hands a batch to a processor, the processor sees the
 * transfer, records the processing that was done, and the history shows both.
 *
 * "Done" means the on-chain owner is the processor's wallet, the processor's own
 * screens show the incoming transfer and the processing entry, and the batch's
 * history lists the transfer and the processing while the record still matches
 * the fingerprint anchored on the blockchain.
 */
test("FLOW 2: a farmer transfers a batch to a processor, the processor records the processing, and the history shows both", async ({
  openAs,
  ledger,
}) => {
  const batchId = "AGT-MAIZE-2026-B2C3D4";

  /* 1. The processor exists first, because the picker only offers wallets that
   *    hold an on-chain participant registration, and the farmer registers a
   *    batch and hands it over. */
  const processor = await openAs(PROCESSOR);
  const farmer = await openAs(FARMER);
  await registerBatch(farmer.page, {
    productId: batchId,
    cropType: "maize",
    quantity: "800",
    unit: "bags",
    farmLocation: "Igbariam farm, Iseyin LGA, Oyo State",
    description: "Yellow maize, dried to fourteen percent moisture and stored in sacks.",
  });
  await transferBatch(farmer.page, batchId, PROCESSOR, processor.wallet.address);

  /* 2. The processor, in their own browser, sees the transfer waiting for them. */
  await processor.page.goto("/app/transfers");
  await expect(processor.page.getByRole("heading", { name: "Transfers" })).toBeVisible();

  const transfers = processor.page.getByRole("table", { name: "Transfers you sent or received" });
  await expect(transfers).toContainText(batchId);
  await expect(transfers).toContainText("You received it");
  await expect(transfers).toContainText("From a farmer");
  await expect(transfers).toContainText("Completed");
  await expect(
    processor.page.getByRole("button", { name: "Acknowledge receipt" }),
  ).toBeVisible();

  /* 3. The batch is the processor's to act on. */
  await processor.page.goto("/app/products");
  await expect(
    processor.page.getByRole("link", { name: `Open batch ${batchId}` }),
  ).toBeVisible();

  /* 4. The processor records the processing, which moves the batch on a stage and
   *    is therefore signed and confirmed before it counts. `recordProcessing`
   *    waits for the write and reads it back; the assertions here are the
   *    registry's own account of where the entry was recorded. */
  await recordProcessing(processor.page, batchId, {
    activity: "DRYING",
    activityDescription:
      "Sun dried for four days to eleven percent moisture, then graded and sacked.",
    newStatus: "PROCESSED",
  });

  const processing = processor.page.getByRole("table", {
    name: `Processing recorded against batch ${batchId}`,
  });
  await expect(processing).toContainText("DRYING");
  await expect(processing).toContainText("On the blockchain");
  await expect(processing).toContainText("Processed");

  await expect(
    processor.page.getByRole("region", { name: "Where this batch is now", exact: true }),
  ).toContainText("Processed");

  /* 5. The history shows the registration, the transfer and the processing, and
   *    the record still matches the anchored fingerprint. */
  await processor.page.goto(`/app/products/${encodeURIComponent(batchId)}/history`);
  await expect(
    processor.page.getByRole("heading", { name: `History of batch ${batchId}` }),
  ).toBeVisible();

  // Integrity is stated before anything else on the page, because it decides how
  // the rest of the page should be read.
  await expect(
    processor.page.getByRole("heading", { name: "The record still matches the blockchain" }),
  ).toBeVisible();
  await expect(processor.page.getByText("Integrity: Match")).toBeVisible();

  const record = processor.page.getByRole("region", { name: "The record, in order" });
  await expect(record.getByRole("heading", { name: "Registered by farmer" })).toBeVisible();
  await expect(
    record.getByRole("heading", { name: "Ownership passed to a processor" }),
  ).toBeVisible();
  await expect(record.getByRole("heading", { name: "DRYING" })).toBeVisible();

  /* 6. The mock cluster is holding the processor as the owner, with the transfer
   *    counted and the batch on its new stage. */
  const chain = await ledger();
  const onChain = chain.products.find((entry) => entry.productId === batchId);
  expect(onChain).toBeDefined();
  expect(onChain?.owner).toBe(processor.wallet.address);
  expect(onChain?.transferCount).toBe(1);
  expect(onChain?.status).toBe("PROCESSED");

  await farmer.close();
  await processor.close();
});
