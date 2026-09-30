/**
 * Demo data, generated. Do not edit by hand.
 *
 * Produced by `server/scripts/generate-demo-data.ts`, which computes the
 * registration fingerprints with the server's own canonical module. Regenerate
 * after changing the canonical format, so the digests stay correct.
 */
import type { DemoBatchRow, DemoWallets, DemoTimestamps } from "./types.js";

export const WALLETS: DemoWallets = {
  "farmer": "5wHu1tD9BqKvK9XhW1jF5Hq3pT9nGqQZ3mQ2rY7vKpP",
  "processor": "3nVb8KqL4mRt2YwP9xCd7EfGh1JkMn5QpRs8TvUwX2Za",
  "transporter": "7pQr4StUv9Wx2YzAb5Cd8EfGh1JkMn3QpRs6TyUwX4Ze",
  "retailer": "9mNb3KqL7mRt5YwP2xCd9EfGh4JkMn6QpRs1TvUwX8Zb",
  "regulator": "4tYu6Hj9Kl0MnBvCx2Za7SdFg1QwErTy8UiOp3As5Df"
};

export const TIMES: DemoTimestamps = {
  "cocoaRegistered": "2026-08-14T07:12:04.000Z",
  "soyRegistered": "2026-08-21T06:40:18.000Z",
  "cashewRegistered": "2026-08-28T08:05:51.000Z",
  "plantainRegistered": "2026-09-02T05:58:33.000Z",
  "tomatoRegistered": "2026-09-08T09:22:10.000Z",
  "maizeRegistered": "2026-09-11T06:31:47.000Z",
  "gingerRegistered": "2026-09-15T07:44:29.000Z"
};

export const BATCHES: DemoBatchRow[] = [
  {
    "seed": {
      "productId": "AGT-COCOA-2026-A1B2C3",
      "cropType": "cocoa",
      "quantity": 250,
      "unit": "kg",
      "harvestDate": "2026-08-13",
      "farmLocation": "Kumasi, Ashanti Region, Ghana",
      "description": "Washed cocoa beans from the 2026 main harvest, sun dried on raised beds.",
      "additionalNotes": "Moisture content 6.8 percent at packing.",
      "registeredAt": "2026-08-14T07:12:04.000Z",
      "registeredBy": "5wHu1tD9BqKvK9XhW1jF5Hq3pT9nGqQZ3mQ2rY7vKpP",
      "registrantRole": "FARMER",
      "status": "REGISTERED",
      "owner": "5wHu1tD9BqKvK9XhW1jF5Hq3pT9nGqQZ3mQ2rY7vKpP",
      "ownerRole": "FARMER",
      "imageHashes": [],
      "certificateHashes": [],
      "retail": {
        "listed": false,
        "listedAt": null,
        "askingPrice": null,
        "currency": "NGN",
        "soldAt": null,
        "note": ""
      },
      "transferCount": 0
    },
    "dataHash": "3e39c494cd8e5d1cd22c9704ee15a22d50b94daba51c71c5c74fe2762f40dc3c",
    "onChainAddress": "ErvFCPPqyBEvr4FAGgEuYi6YBS2s9ZDmeibKGHk26DwT"
  },
  {
    "seed": {
      "productId": "AGT-SOYBEAN-2026-C4D5E6",
      "cropType": "soybean",
      "quantity": 60,
      "unit": "bags",
      "harvestDate": "2026-08-20",
      "farmLocation": "Ado farm, Ikom LGA, Cross River State",
      "description": "Soybean, cleaned and bagged, no foreign matter over two percent.",
      "additionalNotes": "",
      "registeredAt": "2026-08-21T06:40:18.000Z",
      "registeredBy": "5wHu1tD9BqKvK9XhW1jF5Hq3pT9nGqQZ3mQ2rY7vKpP",
      "registrantRole": "FARMER",
      "status": "IN_PROCESSING",
      "owner": "3nVb8KqL4mRt2YwP9xCd7EfGh1JkMn5QpRs8TvUwX2Za",
      "ownerRole": "PROCESSOR",
      "imageHashes": [],
      "certificateHashes": [],
      "retail": {
        "listed": false,
        "listedAt": null,
        "askingPrice": null,
        "currency": "NGN",
        "soldAt": null,
        "note": ""
      },
      "transferCount": 1
    },
    "dataHash": "42fde3347ada165795bcc4640956b54ea45736d9c53fdb5cc1ae682929bd807a",
    "onChainAddress": "8vg3kzz2dkQqCswJDTZ8Q7HesXpSDcU71xosGzRdboP5"
  },
  {
    "seed": {
      "productId": "AGT-CASHEW-2026-C3D4E5",
      "cropType": "cashew",
      "quantity": 450,
      "unit": "bags",
      "harvestDate": "2026-08-27",
      "farmLocation": "Aiyetoro market, Ilaro, Ogun State",
      "description": "Raw cashew nuts, sun dried and sorted, ready for roasting.",
      "additionalNotes": "Grading confirmed at the depot.",
      "registeredAt": "2026-08-28T08:05:51.000Z",
      "registeredBy": "5wHu1tD9BqKvK9XhW1jF5Hq3pT9nGqQZ3mQ2rY7vKpP",
      "registrantRole": "FARMER",
      "status": "IN_TRANSIT",
      "owner": "7pQr4StUv9Wx2YzAb5Cd8EfGh1JkMn3QpRs6TyUwX4Ze",
      "ownerRole": "TRANSPORTER",
      "imageHashes": [],
      "certificateHashes": [],
      "retail": {
        "listed": false,
        "listedAt": null,
        "askingPrice": null,
        "currency": "NGN",
        "soldAt": null,
        "note": ""
      },
      "transferCount": 2
    },
    "dataHash": "d3054419383f1a730777fad7f74f576fffccbf4aead1cf033efb78efdd62928d",
    "onChainAddress": "5EcrZzH5cfRCt5otZUzY4QLAnuuBtXZeMsMYrmfJ32eK"
  },
  {
    "seed": {
      "productId": "AGT-PLANTAIN-2026-F6G7H8",
      "cropType": "plantain",
      "quantity": 900,
      "unit": "crates",
      "harvestDate": "2026-09-01",
      "farmLocation": "Oja market, Ondo State",
      "description": "Plantain, cut and wrapped in banana leaf, harvested within the week.",
      "additionalNotes": "Ripeness graded A and B, kept separate.",
      "registeredAt": "2026-09-02T05:58:33.000Z",
      "registeredBy": "5wHu1tD9BqKvK9XhW1jF5Hq3pT9nGqQZ3mQ2rY7vKpP",
      "registrantRole": "FARMER",
      "status": "AT_RETAILER",
      "owner": "9mNb3KqL7mRt5YwP2xCd9EfGh4JkMn6QpRs1TvUwX8Zb",
      "ownerRole": "RETAILER",
      "imageHashes": [],
      "certificateHashes": [
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      ],
      "retail": {
        "listed": false,
        "listedAt": null,
        "askingPrice": null,
        "currency": "NGN",
        "soldAt": null,
        "note": ""
      },
      "transferCount": 3
    },
    "dataHash": "ab880466b998e82078a3b5cd21170ab49329c42a3dea4d9250468167027dc451",
    "onChainAddress": "AMrHSnodnt3oAecL5kFeMskkkaGPf4sQK43qW9WLn43n"
  },
  {
    "seed": {
      "productId": "AGT-TOMATO-2026-H9J0K1",
      "cropType": "tomato",
      "quantity": 320,
      "unit": "crates",
      "harvestDate": "2026-09-07",
      "farmLocation": "Ikom LGA, Cross River State",
      "description": "Ripe tomato, two day shade dried, packed in ventilated crates.",
      "additionalNotes": "Best before 21 September 2026.",
      "registeredAt": "2026-09-08T09:22:10.000Z",
      "registeredBy": "5wHu1tD9BqKvK9XhW1jF5Hq3pT9nGqQZ3mQ2rY7vKpP",
      "registrantRole": "FARMER",
      "status": "LISTED",
      "owner": "9mNb3KqL7mRt5YwP2xCd9EfGh4JkMn6QpRs1TvUwX8Zb",
      "ownerRole": "RETAILER",
      "imageHashes": [],
      "certificateHashes": [],
      "retail": {
        "listed": true,
        "listedAt": "2026-09-10T10:05:00.000Z",
        "askingPrice": 485000,
        "currency": "NGN",
        "soldAt": null,
        "note": "Bulk orders of twenty crates or more."
      },
      "transferCount": 3
    },
    "dataHash": "16b5dedd9e19dc5a898095c24f3793b7e6867a660d2cafbaea69f1175ff8f808",
    "onChainAddress": "eXxC8FWxSLSNyp42NcUFbqGhTiYTmrPTFqgU66n83Js"
  },
  {
    "seed": {
      "productId": "AGT-MAIZE-2026-K2L3M4",
      "cropType": "maize",
      "quantity": 1200,
      "unit": "kg",
      "harvestDate": "2026-09-10",
      "farmLocation": "Katsina, Nigeria",
      "description": "Yellow maize, dried to 13 percent moisture, cleaned and sacked.",
      "additionalNotes": "Aflatoxin screening certificate attached.",
      "registeredAt": "2026-09-11T06:31:47.000Z",
      "registeredBy": "5wHu1tD9BqKvK9XhW1jF5Hq3pT9nGqQZ3mQ2rY7vKpP",
      "registrantRole": "FARMER",
      "status": "SOLD",
      "owner": "9mNb3KqL7mRt5YwP2xCd9EfGh4JkMn6QpRs1TvUwX8Zb",
      "ownerRole": "RETAILER",
      "imageHashes": [],
      "certificateHashes": [
        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
      ],
      "retail": {
        "listed": true,
        "listedAt": "2026-09-12T08:20:00.000Z",
        "askingPrice": 720000,
        "currency": "NGN",
        "soldAt": "2026-09-14T15:47:00.000Z",
        "note": "Sold to a miller on forward delivery."
      },
      "transferCount": 3
    },
    "dataHash": "6bb1e425c629a9a8e495e028fc7e1f5b9ec579d40a733d5c990fcf2b0177af49",
    "onChainAddress": "879fTyphyyyiSaQ6yWZWcWrvFqow3W11mvAyWLKoA8ty"
  },
  {
    "seed": {
      "productId": "AGT-GINGER-2026-M5N6P7",
      "cropType": "ginger",
      "quantity": 180,
      "unit": "bags",
      "harvestDate": "2026-09-14",
      "farmLocation": "Okeho, Kwara State",
      "description": "White ginger, washed and sun dried.",
      "additionalNotes": "Held pending a regulator's inspection.",
      "registeredAt": "2026-09-15T07:44:29.000Z",
      "registeredBy": "5wHu1tD9BqKvK9XhW1jF5Hq3pT9nGqQZ3mQ2rY7vKpP",
      "registrantRole": "FARMER",
      "status": "FLAGGED",
      "preFlagStatus": "AT_RETAILER",
      "owner": "9mNb3KqL7mRt5YwP2xCd9EfGh4JkMn6QpRs1TvUwX8Zb",
      "ownerRole": "RETAILER",
      "imageHashes": [],
      "certificateHashes": [],
      "retail": {
        "listed": false,
        "listedAt": null,
        "askingPrice": null,
        "currency": "NGN",
        "soldAt": null,
        "note": ""
      },
      "flagged": true,
      "transferCount": 3
    },
    "dataHash": "8ef723748e6c4f9b965718d3c4ab7ee23a8c682249ca68174376c404a1496582",
    "onChainAddress": "RmuAq6WamoS8RESb4PBYr67iXNGBPbVmcqUdNTYdvTt"
  }
];

export const SIGNATURE_SEEDS = [
  "AGT-COCOA-2026-A1B2C3",
  "AGT-SOYBEAN-2026-C4D5E6",
  "AGT-CASHEW-2026-C3D4E5",
  "AGT-PLANTAIN-2026-F6G7H8",
  "AGT-TOMATO-2026-H9J0K1",
  "AGT-MAIZE-2026-K2L3M4",
  "AGT-GINGER-2026-M5N6P7",
];
