/**
 * Generates the demo dataset for the interface.
 *
 * The registration fingerprints are computed by the server's own canonical
 * module, so a demo batch carries a digest that genuinely matches its details. A
 * fixture with a made-up hash would make the verification screen look right while
 * proving nothing, which is the opposite of what that screen is for.
 *
 * Run with: npx tsx scripts/generate-demo-data.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeRegistrationHash } from "../src/services/hashing/canonical.js";
import { getProductAddress, FALLBACK_PROGRAM_ID } from "../src/services/solana/pda.js";
import { PublicKey } from "@solana/web3.js";

/** Fixed instants, so regenerating produces the same file. */
const T = {
  cocoaRegistered: "2026-08-14T07:12:04.000Z",
  soyRegistered: "2026-08-21T06:40:18.000Z",
  cashewRegistered: "2026-08-28T08:05:51.000Z",
  plantainRegistered: "2026-09-02T05:58:33.000Z",
  tomatoRegistered: "2026-09-08T09:22:10.000Z",
  maizeRegistered: "2026-09-11T06:31:47.000Z",
  gingerRegistered: "2026-09-15T07:44:29.000Z",
} as const;

const WALLET = {
  farmer: "5wHu1tD9BqKvK9XhW1jF5Hq3pT9nGqQZ3mQ2rY7vKpP",
  processor: "3nVb8KqL4mRt2YwP9xCd7EfGh1JkMn5QpRs8TvUwX2Za",
  transporter: "7pQr4StUv9Wx2YzAb5Cd8EfGh1JkMn3QpRs6TyUwX4Ze",
  retailer: "9mNb3KqL7mRt5YwP2xCd9EfGh4JkMn6QpRs1TvUwX8Zb",
  regulator: "4tYu6Hj9Kl0MnBvCx2Za7SdFg1QwErTy8UiOp3As5Df",
} as const;

/** Deterministic-looking signatures. They are not real, and nothing signs with them. */

const programId = new PublicKey(FALLBACK_PROGRAM_ID);

interface BatchSeed {
  productId: string;
  cropType: string;
  quantity: number;
  unit: string;
  harvestDate: string;
  farmLocation: string;
  description: string;
  additionalNotes: string;
  registeredAt: string;
  registeredBy: string;
  registrantRole: string;
  status: string;
  owner: string;
  ownerRole: string;
  imageHashes: string[];
  certificateHashes: string[];
  retail?: { listed: boolean; listedAt: string | null; askingPrice: number | null; currency: string; soldAt: string | null; note: string };
  flagged?: boolean;
  preFlagStatus?: string;
  transferCount: number;
}

const seeds: BatchSeed[] = [
  {
    productId: "AGT-COCOA-2026-A1B2C3",
    cropType: "cocoa",
    quantity: 250,
    unit: "kg",
    harvestDate: "2026-08-13",
    farmLocation: "Kumasi, Ashanti Region, Ghana",
    description: "Washed cocoa beans from the 2026 main harvest, sun dried on raised beds.",
    additionalNotes: "Moisture content 6.8 percent at packing.",
    registeredAt: T.cocoaRegistered,
    registeredBy: WALLET.farmer,
    registrantRole: "FARMER",
    status: "REGISTERED",
    owner: WALLET.farmer,
    ownerRole: "FARMER",
    imageHashes: [],
    certificateHashes: [],
    retail: { listed: false, listedAt: null, askingPrice: null, currency: "NGN", soldAt: null, note: "" },
    transferCount: 0,
  },
  {
    productId: "AGT-SOYBEAN-2026-C4D5E6",
    cropType: "soybean",
    quantity: 60,
    unit: "bags",
    harvestDate: "2026-08-20",
    farmLocation: "Ado farm, Ikom LGA, Cross River State",
    description: "Soybean, cleaned and bagged, no foreign matter over two percent.",
    additionalNotes: "",
    registeredAt: T.soyRegistered,
    registeredBy: WALLET.farmer,
    registrantRole: "FARMER",
    status: "IN_PROCESSING",
    owner: WALLET.processor,
    ownerRole: "PROCESSOR",
    imageHashes: [],
    certificateHashes: [],
    retail: { listed: false, listedAt: null, askingPrice: null, currency: "NGN", soldAt: null, note: "" },
    transferCount: 1,
  },
  {
    productId: "AGT-CASHEW-2026-C3D4E5",
    cropType: "cashew",
    quantity: 450,
    unit: "bags",
    harvestDate: "2026-08-27",
    farmLocation: "Aiyetoro market, Ilaro, Ogun State",
    description: "Raw cashew nuts, sun dried and sorted, ready for roasting.",
    additionalNotes: "Grading confirmed at the depot.",
    registeredAt: T.cashewRegistered,
    registeredBy: WALLET.farmer,
    registrantRole: "FARMER",
    status: "IN_TRANSIT",
    owner: WALLET.transporter,
    ownerRole: "TRANSPORTER",
    imageHashes: [],
    certificateHashes: [],
    retail: { listed: false, listedAt: null, askingPrice: null, currency: "NGN", soldAt: null, note: "" },
    transferCount: 2,
  },
  {
    productId: "AGT-PLANTAIN-2026-F6G7H8",
    cropType: "plantain",
    quantity: 900,
    unit: "crates",
    harvestDate: "2026-09-01",
    farmLocation: "Oja market, Ondo State",
    description: "Plantain, cut and wrapped in banana leaf, harvested within the week.",
    additionalNotes: "Ripeness graded A and B, kept separate.",
    registeredAt: T.plantainRegistered,
    registeredBy: WALLET.farmer,
    registrantRole: "FARMER",
    status: "AT_RETAILER",
    owner: WALLET.retailer,
    ownerRole: "RETAILER",
    imageHashes: [],
    certificateHashes: ["c".repeat(64)],
    retail: { listed: false, listedAt: null, askingPrice: null, currency: "NGN", soldAt: null, note: "" },
    transferCount: 3,
  },
  {
    productId: "AGT-TOMATO-2026-H9J0K1",
    cropType: "tomato",
    quantity: 320,
    unit: "crates",
    harvestDate: "2026-09-07",
    farmLocation: "Ikom LGA, Cross River State",
    description: "Ripe tomato, two day shade dried, packed in ventilated crates.",
    additionalNotes: "Best before 21 September 2026.",
    registeredAt: T.tomatoRegistered,
    registeredBy: WALLET.farmer,
    registrantRole: "FARMER",
    status: "LISTED",
    owner: WALLET.retailer,
    ownerRole: "RETAILER",
    imageHashes: [],
    certificateHashes: [],
    retail: {
      listed: true,
      listedAt: "2026-09-10T10:05:00.000Z",
      askingPrice: 485000,
      currency: "NGN",
      soldAt: null,
      note: "Bulk orders of twenty crates or more.",
    },
    transferCount: 3,
  },
  {
    productId: "AGT-MAIZE-2026-K2L3M4",
    cropType: "maize",
    quantity: 1200,
    unit: "kg",
    harvestDate: "2026-09-10",
    farmLocation: "Katsina, Nigeria",
    description: "Yellow maize, dried to 13 percent moisture, cleaned and sacked.",
    additionalNotes: "Aflatoxin screening certificate attached.",
    registeredAt: T.maizeRegistered,
    registeredBy: WALLET.farmer,
    registrantRole: "FARMER",
    status: "SOLD",
    owner: WALLET.retailer,
    ownerRole: "RETAILER",
    imageHashes: [],
    certificateHashes: ["d".repeat(64)],
    retail: {
      listed: true,
      listedAt: "2026-09-12T08:20:00.000Z",
      askingPrice: 720000,
      currency: "NGN",
      soldAt: "2026-09-14T15:47:00.000Z",
      note: "Sold to a miller on forward delivery.",
    },
    transferCount: 3,
  },
  {
    productId: "AGT-GINGER-2026-M5N6P7",
    cropType: "ginger",
    quantity: 180,
    unit: "bags",
    harvestDate: "2026-09-14",
    farmLocation: "Okeho, Kwara State",
    description: "White ginger, washed and sun dried.",
    additionalNotes: "Held pending a regulator's inspection.",
    registeredAt: T.gingerRegistered,
    registeredBy: WALLET.farmer,
    registrantRole: "FARMER",
    status: "FLAGGED",
    preFlagStatus: "AT_RETAILER",
    owner: WALLET.retailer,
    ownerRole: "RETAILER",
    imageHashes: [],
    certificateHashes: [],
    retail: { listed: false, listedAt: null, askingPrice: null, currency: "NGN", soldAt: null, note: "" },
    flagged: true,
    transferCount: 3,
  },
];

const rows = seeds.map((seed) => {
  const dataHash = computeRegistrationHash({
    productId: seed.productId,
    cropType: seed.cropType,
    quantity: seed.quantity,
    unit: seed.unit,
    harvestDate: seed.harvestDate,
    farmLocation: seed.farmLocation,
    description: seed.description,
    additionalNotes: seed.additionalNotes,
    registeredByWallet: seed.registeredBy,
    imageHashes: seed.imageHashes,
    certificateHashes: seed.certificateHashes,
    registeredAt: seed.registeredAt,
  });

  return {
    seed,
    dataHash,
    onChainAddress: getProductAddress(programId, seed.productId).toBase58(),
  };
});

const target = resolve(process.cwd(), "..", "client", "src", "demo", "generated.ts");
writeFileSync(
  target,
  `/**
 * Demo data, generated. Do not edit by hand.
 *
 * Produced by \`server/scripts/generate-demo-data.ts\`, which computes the
 * registration fingerprints with the server's own canonical module. Regenerate
 * after changing the canonical format, so the digests stay correct.
 */
import type { DemoBatchRow, DemoWallets, DemoTimestamps } from "./types.js";

export const WALLETS: DemoWallets = ${JSON.stringify(WALLET, null, 2)};

export const TIMES: DemoTimestamps = ${JSON.stringify(T, null, 2)};

export const BATCHES: DemoBatchRow[] = ${JSON.stringify(
    rows.map((row) => ({
      seed: row.seed,
      dataHash: row.dataHash,
      onChainAddress: row.onChainAddress,
    })),
    null,
    2
  )};

export const SIGNATURE_SEEDS = [
${rows.map((row) => `  "${row.seed.productId}",`).join("\n")}
];
`,
  "utf8"
);

process.stdout.write(
  `wrote ${rows.length} batches to ${target}\n` +
    rows.map((row) => `  ${row.seed.productId}  ${row.dataHash.slice(0, 16)}…\n`).join("")
);
