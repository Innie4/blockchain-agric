import {
  FARMER,
  PROCESSOR,
  RETAILER,
  TRANSPORTER,
  recordTransport,
  registerBatch,
  setRetailListing,
  transferBatch,
} from "../support/actors";
import { expect, test } from "../support/fixtures";

/**
 * FLOW 3 — a batch travels processor to transporter, the journey is recorded, the
 * retailer receives it and sets a listing.
 *
 * "Done" means each hand-over was confirmed on the blockchain, the transporter's
 * journey is on the chain, the retailer is named as the owner and is offered the
 * listing control, and the listing is saved and shown on the public record.
 */
test("FLOW 3: a processor hands a batch to a transporter, the transporter records the journey, and the retailer receives it and lists it", async ({
  openAs,
  ledger,
}) => {
  const batchId = "AGT-CASHEW-2026-C3D4E5";

  /* 1. Every participant exists before any hand-over, because the recipient
   *    picker only offers wallets that hold an on-chain registration. */
  const farmer = await openAs(FARMER);
  const processor = await openAs(PROCESSOR);
  const transporter = await openAs(TRANSPORTER);
  const retailer = await openAs(RETAILER);

  /* 2. A farmer registers the batch and passes it to the processor. */
  await registerBatch(farmer.page, {
    productId: batchId,
    cropType: "cashew",
    quantity: "450",
    unit: "bags",
    farmLocation: "Aiyetoro market, Ilaro, Ogun State",
    description: "Raw cashew nuts, sun dried and sorted, ready for roasting.",
  });
  await transferBatch(farmer.page, batchId, PROCESSOR, processor.wallet.address);

  /* 3. The processor takes it on to the transporter. */
  await transferBatch(processor.page, batchId, TRANSPORTER, transporter.wallet.address);

  /* 4. The transporter records the journey as delivered. Because delivering it
   *    moves the batch's stage, this is an on-chain write and is signed.
   *    `recordTransport` waits for the write and reads the entry back. */
  await recordTransport(transporter.page, batchId, {
    origin: "Ibadan processing depot",
    destination: "Ikeja Fresh Market, Lagos",
    routeDetails: "Ibadan to Lagos through Ijebu Ode, in one covered truck.",
    vehicleDescription: "Three tonne covered truck, Lagos registration",
    deliveryStatus: "DELIVERED",
  });

  const journeys = transporter.page.getByRole("table", {
    name: `Journeys recorded against batch ${batchId}`,
  });
  await expect(journeys).toContainText("Ibadan processing depot");
  await expect(journeys).toContainText("Ikeja Fresh Market, Lagos");
  await expect(journeys).toContainText("Delivered");
  await expect(journeys).toContainText("On the blockchain");

  /* 5. The transporter hands the batch to the retailer. */
  await transferBatch(transporter.page, batchId, RETAILER, retailer.wallet.address);

  /* 6. The retailer sees the transfer waiting for them, and the batch page names
   *    the retailer's own wallet as the current owner. */
  await retailer.page.goto("/app/transfers");
  const received = retailer.page.getByRole("table", { name: "Transfers you sent or received" });
  await expect(received).toContainText(batchId);
  await expect(received).toContainText("You received it");
  await expect(received).toContainText("From a transporter");

  await retailer.page.goto(`/app/products/${encodeURIComponent(batchId)}`);
  await expect(
    retailer.page.getByRole("heading", { name: `Batch ${batchId}`, exact: true }),
  ).toBeVisible();
  const holders = retailer.page.getByRole("region", { name: "Who holds it", exact: true });
  // The owner is shown shortened, with the full address available to copy, which
  // is what the interface offers a reader. Asserted as the shortened form a
  // person sees, and the copy control that carries the whole address.
  await expect(holders).toContainText(`${retailer.wallet.address.slice(0, 4)}…`);
  await expect(holders).toContainText("Copy the owner wallet address");
  await expect(holders).toContainText("3");

  const status = retailer.page.getByRole("region", {
    name: "This batch is on the blockchain",
    exact: true,
  });
  await expect(status).toContainText("At retailer");

  /* 7. The retailer sets a listing. A price is a business decision held in the
   *    records service, so this step needs no signature. `setRetailListing`
   *    waits for the save and reads the listing back. */
  await setRetailListing(
    retailer.page,
    batchId,
    "485000",
    "Roasted on site each morning. Bulk orders of twenty bags or more."
  );
  const listed = retailer.page.getByRole("region", { name: "This batch", exact: true });
  await expect(listed).toContainText("Listed");

  /* 8. The public record carries the whole journey and the listing, for anyone
   *    who checks it without an account. */
  await retailer.page.goto(`/verify/${encodeURIComponent(batchId)}`);
  await expect(
    retailer.page.getByText("This batch matches its blockchain record."),
  ).toBeVisible();
  const provenance = retailer.page.getByRole("region", { name: "History", exact: true });
  await expect(provenance).toContainText("Registered by farmer");
  await expect(provenance).toContainText("Ownership passed to a processor");
  await expect(provenance).toContainText("Ownership passed to a transporter");
  await expect(provenance).toContainText("Ownership passed to a retailer");
  await expect(provenance).toContainText("Ibadan processing depot");
  await expect(provenance).toContainText("Listed for sale");

  /* 9. The mock cluster agrees: the retailer owns the batch after three
   *    transfers, and the batch is at the retailer. */
  const chain = await ledger();
  const onChain = chain.products.find((entry) => entry.productId === batchId);
  expect(onChain).toBeDefined();
  expect(onChain?.owner).toBe(retailer.wallet.address);
  expect(onChain?.transferCount).toBe(3);
  expect(onChain?.status).toBe("AT_RETAILER");

  await farmer.close();
  await processor.close();
  await transporter.close();
  await retailer.close();
});
