import {
  FARMER,
  assignBusinessRole,
  connectWallet,
  ensureWalletConnected,
  registerOnChain,
  saveParticipantDetails,
  signInWithWallet,
} from "../support/actors";
import { readStoredProduct } from "../support/database";
import { expect, test } from "../support/fixtures";
import { setTransactionRejection } from "../support/wallet";

/**
 * FLOW 7 — the wallet declines to sign part-way through a blockchain write.
 *
 * "Done" means the interface says in words that the participant declined, that it
 * is not an error but an ordinary outcome, that it offers a way to try again,
 * that nothing has been written, and that the record is not marked as confirmed
 * either in the registry or on the mock cluster. The retry is then exercised, so
 * "try again" is a real affordance rather than a label.
 */
test("FLOW 7: a wallet that declines to sign leaves a clear failure state with a retry, and nothing is recorded as confirmed", async ({
  page,
  newWallet,
  ledger,
}) => {
  const declinedId = "AGT-RICE-2026-G7H8J9";
  const wallet = newWallet("FLOW 7 farmer");

  /* Setup: the farmer is connected, signed in and registered on the blockchain,
   * with the wallet signing normally. */
  await connectWallet(page, wallet);
  await signInWithWallet(page);
  await assignBusinessRole(page, wallet, FARMER);
  await saveParticipantDetails(page, FARMER);
  await registerOnChain(page);

  /* 1. The farmer fills the registration form. */
  await page.goto("/app/products/register");
  await ensureWalletConnected(page);
  await expect(page.getByRole("heading", { name: "Register a batch" })).toBeVisible();
  await page.getByLabel("Batch identifier").fill(declinedId);
  await page.getByLabel("Crop or product type").fill("rice");
  await page.getByLabel("Quantity").fill("240");
  await page.getByLabel("Unit").selectOption("bags");
  await page.getByLabel("Farm location").fill("Epe farm, Lagos State");
  await page
    .getByLabel("Description")
    .fill("Ofada rice, parboiled and dried, from the 2025 harvest.");

  /* 2. They submit, and the wallet declines the signature. This is a real
   *    refusal: the provider raises the same `4001` a real extension raises when
   *    a participant presses "Reject". */
  await setTransactionRejection(page, true);
  await page.getByRole("button", { name: "Register this batch" }).click();

  /* 3. The interface says what happened, says it is not a failure, and offers a
   *    way to try again. */
  await expect(page.getByText("You declined to sign")).toBeVisible();
  await expect(
    page.getByText("Nothing was written to the blockchain and the record is unchanged. You can prepare the same action again whenever you are ready."),
  ).toBeVisible();
  await expect(
    page.getByText("The signature request was declined, so nothing was written to the blockchain."),
  ).toBeVisible();
  await expect(
    page.getByText(/You declined the signature, so nothing has been written and the record is unchanged\./),
  ).toBeVisible();

  const retry = page.getByRole("button", { name: "Prepare again" });
  await expect(retry).toBeVisible();
  await expect(page.getByText("Batch registered")).toHaveCount(0);

  /* 4. Nothing is recorded as confirmed: not in the registry, and not on the
   *    cluster the transaction would have gone to. */
  const draft = await readStoredProduct(declinedId);
  expect(draft).not.toBeNull();
  expect(draft?.chainState).not.toBe("CONFIRMED");
  expect(draft?.chainState).toBe("AWAITING_SIGNATURE");
  expect(draft?.status).toBe("REGISTERED");

  const chainWhileDeclined = await ledger();
  expect(chainWhileDeclined.products.some((entry) => entry.productId === declinedId)).toBe(false);

  await page.goto("/app/products");
  await ensureWalletConnected(page);
  const batchList = page.getByRole("region", { name: "Batches in the registry", exact: true });
  await expect(batchList).toContainText(declinedId);
  await expect(batchList).toContainText("waiting for a wallet signature");
  await expect(
    page.getByText("1 is saved but still waiting for a wallet signature, so nothing is anchored on the blockchain yet."),
  ).toBeVisible();

  /* 5. The retry works: the participant accepts the signature this time, and the
   *    batch is confirmed. */
  await setTransactionRejection(page, false);
  await page.goto("/app/products/register");
  await ensureWalletConnected(page);
  await page.getByLabel("Batch identifier").fill(declinedId);
  await page.getByLabel("Crop or product type").fill("rice");
  await page.getByLabel("Quantity").fill("240");
  await page.getByLabel("Unit").selectOption("bags");
  await page.getByLabel("Farm location").fill("Epe farm, Lagos State");
  await page
    .getByLabel("Description")
    .fill("Ofada rice, parboiled and dried, from the 2025 harvest.");
  await page.getByRole("button", { name: "Register this batch" }).click();

  await expect(page.getByRole("heading", { name: "Batch registered" })).toBeVisible();
  const confirmed = await readStoredProduct(declinedId);
  expect(confirmed?.chainState).toBe("CONFIRMED");

  const chainAfterRetry = await ledger();
  expect(chainAfterRetry.products.some((entry) => entry.productId === declinedId)).toBe(true);
});
