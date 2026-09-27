import { expect, type Page } from "@playwright/test";

import { setParticipantRole } from "./database";
import { installTestWallet, type TestWallet, type WalletOptions } from "./wallet";

/**
 * The participant journeys the seven flows share, expressed the way a person
 * would perform them: click this, read that.
 *
 * Every step here goes through the interface. The single exception is the
 * participant's business role, which is written straight to the database,
 * because the application has no screen that sets it: a wallet that has never
 * signed in is created as a consumer, and the header of the signed-in area
 * offers a "Choose your role" link to `/app/profile`, which explains that only an
 * administrator can change a participant's role. That gap is reported rather
 * than papered over with production code; see the suite's final report.
 */

export interface ParticipantProfile {
  readonly fullName: string;
  readonly organisation: string;
  /** The business role this wallet acts as. */
  readonly role: "FARMER" | "PROCESSOR" | "TRANSPORTER" | "RETAILER" | "REGULATOR";
}

/** The businesses the flows use. Their names appear in the interface verbatim. */
export const FARMER: ParticipantProfile = {
  fullName: "Ada Okafor",
  organisation: "Okafor Cocoa Farm",
  role: "FARMER",
};

export const PROCESSOR: ParticipantProfile = {
  fullName: "Bello Danjuma",
  organisation: "Ibadan Processing Depot",
  role: "PROCESSOR",
};

export const TRANSPORTER: ParticipantProfile = {
  fullName: "Chioma Eze",
  organisation: "Ondo Haulage",
  role: "TRANSPORTER",
};

export const RETAILER: ParticipantProfile = {
  fullName: "Ibrahim Sanni",
  organisation: "Ikeja Fresh Market",
  role: "RETAILER",
};

export const REGULATOR: ParticipantProfile = {
  fullName: "Amina Yusuf",
  organisation: "State Produce Regulator",
  role: "REGULATOR",
};

/** The visible signal that the wallet is connected: the address menu in the header. */
const WALLET_MENU = /Wallet menu for/;

/**
 * How the interface shortens a wallet for display, as `7xKX…gAsU`.
 *
 * Written out here rather than imported so the suite can find a row by the text a
 * participant actually sees, and so a change to the interface's formatting shows
 * up as a test that says so.
 */
function shortenWallet(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Connects the wallet if the current page has not already. A full page load
 * resets the stubbed provider, so every navigation needs this before a page
 * that requires a connected wallet is used.
 *
 * The wait is for one of the two states the header can be in — still looking for
 * a wallet, offering to connect, or already connected — so a slow page load
 * cannot be mistaken for "already connected".
 */
export async function ensureWalletConnected(page: Page): Promise<void> {
  // Scoped to the header, because a page that needs a wallet also offers a
  // "Connect wallet" button of its own in the middle of the content.
  const header = page.getByRole("banner");
  const connectButton = header.getByRole("button", { name: "Connect wallet", exact: true });
  const walletMenu = header.getByRole("button", { name: WALLET_MENU });

  await expect(
    connectButton
      .or(walletMenu)
      .or(header.getByRole("button", { name: "Looking for a wallet" }))
      .first(),
  ).toBeVisible();

  if (await connectButton.isVisible()) {
    await connectButton.click();
  }
  await expect(walletMenu).toBeVisible();
}

/**
 * Installs the stubbed wallet and connects it on `/connect`. Connecting asks the
 * wallet for its address and signs nothing.
 */
export async function connectWallet(
  page: Page,
  wallet: TestWallet,
  options: WalletOptions = {}
): Promise<void> {
  await installTestWallet(page, wallet, options);
  await page.goto("/connect");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("banner").getByRole("button", { name: WALLET_MENU })).toBeVisible();
}

/**
 * Signs in: the server issues a single-use challenge and the wallet signs those
 * exact bytes, so the session belongs to this wallet and to nobody else.
 *
 * The wait is on the server's own answer, because the connected panel is on
 * screen before sign-in starts and would otherwise be mistaken for it.
 */
export async function signInWithWallet(page: Page): Promise<void> {
  const verified = page.waitForResponse(
    (response) =>
      response.url().includes("/api/auth/verify") && response.status() === 200
  );
  await page.getByRole("button", { name: "Sign in with this wallet" }).click();
  await verified;
  await expect(
    page.getByRole("heading", { name: "One more step: prove you control the wallet" }),
  ).toHaveCount(0);
}

/**
 * Gives the wallet its business role and reloads so the session is read again.
 * This is the one step that does not go through the interface; see the note at
 * the top of this file.
 */
export async function assignBusinessRole(
  page: Page,
  wallet: TestWallet,
  profile: ParticipantProfile
): Promise<void> {
  await setParticipantRole(wallet.address, profile.role);
  await page.goto("/app/settings");
  await ensureWalletConnected(page);
}

/** Connect, sign in, take the business role: everything before any record. */
export async function connectAndSignIn(
  page: Page,
  wallet: TestWallet,
  profile: ParticipantProfile,
  options: WalletOptions = {}
): Promise<void> {
  await connectWallet(page, wallet, options);
  await signInWithWallet(page);
  await assignBusinessRole(page, wallet, profile);
  await expect(
    page.getByRole("region", { name: "On-chain participant registration" }),
  ).toBeVisible();
}

/**
 * Asserts the interface told the participant something.
 *
 * Scoped to the notifications region, because a confirmation message often
 * repeats wording that also appears as a heading or a section title elsewhere on
 * the page, and an unscoped text match would then be ambiguous.
 */
export async function expectTold(page: Page, message: string): Promise<void> {
  await expect(
    page.getByRole("region", { name: "Notifications" }).getByText(message)
  ).toBeVisible();
}

/** Fills in the participant's own details on the settings screen. */
export async function saveParticipantDetails(
  page: Page,
  profile: ParticipantProfile
): Promise<void> {
  await page.getByLabel("Full name").fill(profile.fullName);
  await page.getByLabel("Organisation").fill(profile.organisation);
  await page.getByRole("button", { name: "Save my details" }).click();
  await expectTold(page, "Your details were saved");
}

/**
 * A client defect that these flows caught, and that is now fixed
 * --------------------------------------------------------------------------
 * Several *second-phase* endpoints in `client/src/api/endpoints.ts` declared a
 * wrapper the server does not send. They unwrapped a field that was not there,
 * so `useChainAction` caught a `TypeError` and reported the misleading "The
 * wallet did not complete the request" — *after* the blockchain write had
 * already been submitted, confirmed and stored by the server. A participant was
 * told their farmer, processor, transporter or retailer write had failed when it
 * had in fact succeeded.
 *
 * The endpoint return types now match the payloads the server really sends, and
 * these helpers assert the interface's own confirmation panel. A write is only
 * considered done when the participant is told it is done, and the read-back
 * assertions below then confirm the effect independently.
 */

/** The stage a batch takes when ownership passes to a participant in a role. */
const STAGE_AFTER_TRANSFER: Readonly<Record<ParticipantProfile["role"], string>> = {
  FARMER: "Registered",
  PROCESSOR: "In processing",
  TRANSPORTER: "In transit",
  RETAILER: "At retailer",
  REGULATOR: "Registered",
};

/**
 * Performs a two-phase blockchain write and waits for the server's answer to the
 * second phase, which is the moment the signed transaction has been submitted,
 * confirmed and written through. `start` presses the interface's own button.
 */
async function awaitChainWrite(
  page: Page,
  submitPath: RegExp,
  start: () => Promise<void>
): Promise<void> {
  const written = page.waitForResponse(
    (response) => submitPath.test(new URL(response.url()).pathname) && response.status() === 200
  );
  await start();
  await written;
}


/**
 * Writes the participant's on-chain registry entry: one signature, and the
 * interface's own "Prepare the registration" button drives both phases.
 */
export async function registerOnChain(page: Page): Promise<void> {
  await awaitChainWrite(
    page,
    /\/api\/participant\/register\/submit$/,
    async () => {
      await page.getByRole("button", { name: "Prepare the registration" }).click();
    }
  );

  // The participant is told the write landed.
  await expectTold(page, "Your wallet is registered on the blockchain");

  // And the registry independently reports it.
  await page.reload();
  await ensureWalletConnected(page);
  await expect(page.getByText("This wallet is registered on the blockchain")).toBeVisible();
}

/** Everything a participant needs before they can hold a batch. */
export async function becomeParticipant(
  page: Page,
  wallet: TestWallet,
  profile: ParticipantProfile,
  options: WalletOptions = {}
): Promise<void> {
  await connectAndSignIn(page, wallet, profile, options);
  await saveParticipantDetails(page, profile);
  await registerOnChain(page);
}

export interface RegisterBatchInput {
  productId: string;
  cropType: string;
  quantity: string;
  unit: string;
  farmLocation: string;
  description: string;
}

/**
 * The farmer's registration form, filled and submitted, with the wallet
 * signature and the server's confirmation both waited for.
 */
export async function registerBatch(page: Page, input: RegisterBatchInput): Promise<void> {
  await page.goto("/app/products/register");
  await ensureWalletConnected(page);

  await expect(page.getByRole("heading", { name: "Register a batch", level: 1 })).toBeVisible();
  await page.getByLabel("Batch identifier").fill(input.productId);
  await page.getByLabel("Crop or product type").fill(input.cropType);
  await page.getByLabel("Quantity").fill(input.quantity);
  await page.getByLabel("Unit").selectOption(input.unit);
  await page.getByLabel("Farm location").fill(input.farmLocation);
  await page.getByLabel("Description").fill(input.description);

  await page.getByRole("button", { name: "Register this batch" }).click();
  await expect(page.getByRole("heading", { name: "Batch registered" })).toBeVisible();
}

/**
 * Hands a batch to another participant through the transfer page. The recipient
 * is chosen from the list of participants registered on the blockchain, so the
 * assertion is that the picker offers them, that the transfer is signed and
 * confirmed, and that the batch has moved to the stage the recipient's role
 * gives it.
 */
export async function transferBatch(
  page: Page,
  productId: string,
  recipient: ParticipantProfile,
  recipientWallet: string
): Promise<void> {
  await page.goto(`/app/products/${encodeURIComponent(productId)}/transfer`);
  await ensureWalletConnected(page);
  await expect(page.getByRole("heading", { name: "Hand this batch on", level: 1 })).toBeVisible();

  // Chosen by wallet rather than by name. A person's name is not a unique key:
  // two businesses may share one, and a batch must go to a specific wallet, so
  // the row is identified the way the interface itself identifies it.
  const row = page.getByRole("row", { name: new RegExp(shortenWallet(recipientWallet)) });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(recipient.fullName);
  await row.getByRole("button").click();

  // The wallet that ends up in the form is the one that was asked for.
  await expect(page.getByLabel("Recipient wallet address")).toHaveValue(recipientWallet);

  await awaitChainWrite(page, /\/api\/transfers\/[^/]+\/submit$/, async () => {
    await page.getByRole("button", { name: "Prepare transfer" }).click();
  });

  // The confirmation the recipient's ownership move produces, in the interface.
  await expect(
    page.getByRole("region", { name: "The batch now belongs to the recipient" })
  ).toBeVisible();

  // And the registry independently reports the stage the recipient's role gives it.
  await page.reload();
  await ensureWalletConnected(page);
  const summary = page.getByRole("region", {
    name: "The batch you are handing on",
    exact: true,
  });
  await expect(summary).toContainText(STAGE_AFTER_TRANSFER[recipient.role]);
}

/** The option labels the processing form offers, written out rather than derived. */
const PROCESSING_STAGE_LABELS: Readonly<Record<"IN_PROCESSING" | "PROCESSED", string>> = {
  IN_PROCESSING: "In processing (In processing)",
  PROCESSED: "Processed (Processed)",
};

/** The option labels the transport form offers. */
const DELIVERY_STATUS_LABELS: Readonly<Record<TransportEntry["deliveryStatus"], string>> = {
  SCHEDULED: "Scheduled",
  IN_TRANSIT: "In transit",
  DELIVERED: "Delivered",
  DELAYED: "Delayed",
  CANCELLED: "Cancelled",
};

export interface ProcessingEntry {
  activity: string;
  activityDescription: string;
  /** The stage to move the batch to; omitted records the entry without a move. */
  newStatus?: "IN_PROCESSING" | "PROCESSED";
}

/** Records a processing entry and, when it moves the stage, signs for it. */
export async function recordProcessing(
  page: Page,
  productId: string,
  entry: ProcessingEntry
): Promise<void> {
  await page.goto(`/app/products/${encodeURIComponent(productId)}/processing`);
  await ensureWalletConnected(page);
  await expect(page.getByRole("heading", { name: "Record processing", level: 1 })).toBeVisible();

  await page.getByLabel("Activity").selectOption(entry.activity);
  await page.getByLabel("What was done").fill(entry.activityDescription);
  if (entry.newStatus !== undefined) {
    await page
      .getByLabel("Stage after this entry")
      .selectOption({ label: PROCESSING_STAGE_LABELS[entry.newStatus] });
  }

  await awaitChainWrite(page, /\/processing\/submit$/, async () => {
    await page.getByRole("button", { name: "Record this entry" }).click();
  });

  // The entry is on the blockchain, and the participant is told so.
  if (entry.newStatus !== undefined) {
    await expectTold(page, "The processing entry was recorded");
  }

  // The registry independently reports where the entry was recorded.
  await page.reload();
  await ensureWalletConnected(page);
  const table = page.getByRole("table", {
    name: `Processing recorded against batch ${productId}`,
  });
  await expect(table).toContainText(entry.activity);
  await expect(table).toContainText(entry.activityDescription);
  if (entry.newStatus !== undefined) {
    await expect(table).toContainText("On the blockchain");
  }
}

export interface TransportEntry {
  origin: string;
  destination: string;
  routeDetails: string;
  vehicleDescription: string;
  deliveryStatus: "SCHEDULED" | "IN_TRANSIT" | "DELIVERED" | "DELAYED" | "CANCELLED";
}

/** Records a journey and signs for the stage change it makes. */
export async function recordTransport(
  page: Page,
  productId: string,
  entry: TransportEntry
): Promise<void> {
  await page.goto(`/app/products/${encodeURIComponent(productId)}/transport`);
  await ensureWalletConnected(page);
  await expect(page.getByRole("heading", { name: "Record a journey", level: 1 })).toBeVisible();

  await page.getByLabel("Origin").fill(entry.origin);
  await page.getByLabel("Destination").fill(entry.destination);
  await page.getByLabel("Route details").fill(entry.routeDetails);
  await page.getByLabel("Vehicle").fill(entry.vehicleDescription);
  await page
    .getByLabel("Delivery status")
    .selectOption({ label: DELIVERY_STATUS_LABELS[entry.deliveryStatus] });

  await awaitChainWrite(page, /\/transport\/submit$/, async () => {
    await page.getByRole("button", { name: "Record this journey" }).click();
  });

  // The journey is on the blockchain whenever it moved the batch's stage.
  if (entry.deliveryStatus === "DELIVERED") {
    await expectTold(page, "The journey was recorded");
  }

  // The registry independently reports where the journey was recorded.
  await page.reload();
  await ensureWalletConnected(page);
  const journeys = page.getByRole("table", {
    name: `Journeys recorded against batch ${productId}`,
  });
  await expect(journeys).toContainText(`${entry.origin} to ${entry.destination}`);
  await expect(journeys).toContainText(DELIVERY_STATUS_LABELS[entry.deliveryStatus]);
  if (entry.deliveryStatus === "DELIVERED") {
    await expect(journeys).toContainText("On the blockchain");
  }
}

/**
 * Sets the retailer's commercial listing. A price is a business decision held in
 * the records service, so this step needs no signature at all.
 */
export async function setRetailListing(
  page: Page,
  productId: string,
  askingPrice: string,
  note: string
): Promise<void> {
  await page.goto(`/app/products/${encodeURIComponent(productId)}/sale`);
  await ensureWalletConnected(page);
  await expect(page.getByRole("heading", { name: "Listing and price", level: 1 })).toBeVisible();

  // Offering the batch is a deliberate choice, so the tick is part of listing it
  // rather than something the price implies.
  await page.getByLabel("Yes, list this batch for sale").check();
  await page.getByLabel("Asking price").fill(askingPrice);
  await page.getByLabel("Note").fill(note);
  await page.getByRole("button", { name: "Save the listing" }).click();

  // The retailer is told the listing was saved.
  await expectTold(page, "The batch is listed for sale");

  // And the registry independently reports it: the summary says it is on offer,
  // and the price is still in the form the retailer filled in.
  await page.reload();
  await ensureWalletConnected(page);
  const summary = page.getByRole("region", { name: "This batch", exact: true });
  await expect(summary).toContainText("Listed");
  await expect(page.getByLabel("Asking price")).toHaveValue(askingPrice);
}
