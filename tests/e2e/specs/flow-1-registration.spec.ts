import {
  FARMER,
  assignBusinessRole,
  connectWallet,
  ensureWalletConnected,
  registerBatch,
  registerOnChain,
  saveParticipantDetails,
  signInWithWallet,
} from "../support/actors";
import { readStoredProduct } from "../support/database";
import { expect, test } from "../support/fixtures";
import { readWalletAddress } from "../support/wallet";

/**
 * FLOW 1 — a farmer connects a wallet, registers a batch, the write is confirmed
 * on the blockchain, the record appears on the dashboard, and a QR code is
 * available to print.
 *
 * "Done" means every one of those is visible on screen, and the fingerprint the
 * record quotes is the one the mock cluster is actually holding.
 */
test("FLOW 1: a farmer connects a wallet, registers a batch, and sees the blockchain confirmation, the dashboard record and a QR code", async ({
  page,
  newWallet,
  ledger,
}) => {
  const batchId = "AGT-COCOA-2026-A1B2C3";
  const wallet = newWallet("FLOW 1 farmer");

  /* 1. The farmer connects. Connecting only asks the wallet for its address, so
   *    nothing is signed by this step and the interface says so. */
  await connectWallet(page, wallet);
  await expect(page.getByText("is connected to")).toBeVisible();
  expect(await readWalletAddress(page)).toBe(wallet.address);

  /* 2. The farmer signs in, which is a real signature over a real challenge
   *    issued by the server. */
  await signInWithWallet(page);

  /* 3. The wallet takes a business role, records its details, and writes its
   *    on-chain participant registration. */
  await assignBusinessRole(page, wallet, FARMER);
  await saveParticipantDetails(page, FARMER);
  await registerOnChain(page);

  /* 4. The batch is registered. The page follows the wallet through both phases
   *    of the write: prepare, sign, submit, confirm. */
  await registerBatch(page, {
    productId: batchId,
    cropType: "cocoa",
    quantity: "1200",
    unit: "kg",
    farmLocation: "Oke Awo village, Iseyin LGA, Oyo State",
    description:
      "Forastero cocoa, fermented in wooden boxes for six days and sun dried on raised beds.",
  });

  /* 5. The confirmation the farmer is shown. The anchored fingerprint and the
   *    transaction that wrote it are both printed, so either can be checked
   *    without taking the interface's word for it. */
  const confirmationName = `Batch ${batchId} is on the blockchain`;
  await expect(page.getByRole("heading", { name: confirmationName, exact: true })).toBeVisible();
  const confirmation = page.getByRole("region", { name: confirmationName, exact: true });
  await expect(confirmation).toContainText(/[0-9a-f]{64}/);
  await expect(confirmation).toContainText(/[1-9A-HJ-NP-Za-km-z]{80,90}/);
  await expect(confirmation.getByText("Confirmed in slot")).toBeVisible();

  /* 6. The QR code the farmer prints on the packaging is there, and it names
   *    the batch it belongs to. */
  const qr = page.getByRole("img", { name: `Verification QR code for batch ${batchId}` });
  await expect(qr).toBeVisible();
  await expect(page.getByRole("link", { name: "Download code" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open the verification page" }),
  ).toHaveAttribute("href", new RegExp(`/verify/${batchId}$`));

  /* 7. The record is stored, and the mock cluster is holding the same account
   *    the record was written against. */
  const stored = await readStoredProduct(batchId);
  expect(stored).not.toBeNull();
  expect(stored?.chainState).toBe("CONFIRMED");
  expect(stored?.description).toContain("Forastero cocoa");
  expect(stored?.lastVerificationResult).toBe("VERIFIED");

  const chain = await ledger();
  const onChain = chain.products.find((entry) => entry.productId === batchId);
  expect(onChain).toBeDefined();
  expect(onChain?.status).toBe("REGISTERED");
  expect(onChain?.owner).toBe(wallet.address);
  expect(onChain?.transferCount).toBe(0);

  /* 8. The batch appears on the farmer's dashboard. */
  await page.goto("/app/dashboard");
  await expect(page.getByRole("heading", { name: "Your farm" })).toBeVisible();
  const dashboard = page.getByRole("region", { name: "Recently registered", exact: true });
  await expect(dashboard).toContainText(batchId);
  await expect(dashboard).toContainText("cocoa");
  await expect(dashboard).toContainText("On the blockchain");

  /* 9. And it is in the registry's batch list, not only in the figures. */
  await page.goto("/app/products");
  await ensureWalletConnected(page);
  await expect(page.getByRole("heading", { name: "Batches", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: `Open batch ${batchId}` })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Batches in the registry", exact: true }),
  ).toContainText(batchId);
});
