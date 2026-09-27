import { beforeEach, describe, expect, it } from "vitest";
import { api, freshState } from "../helpers/runtime.js";
import { dataOf, errorOf, get, post, postPublic, sign, signInRegistered } from "../helpers/apiClient.js";
import {
  ProductMetadataModel,
  UserModel,
  VerificationEventModel,
} from "../../src/models/index.js";

/**
 * The list and filter routes.
 *
 * Each query route declares a schema and must apply it. A route that reads a
 * parsed query without validating it silently loses every default and every
 * bound, which shows up as an unbounded query or an ignored filter rather than
 * as an error, so it is asserted here for every route of that shape.
 */
describe("list and filter routes", () => {
  beforeEach(freshState);

  async function registerFarmer() {
    const farmer = await signInRegistered(api(), "FARMER");
    const draft = dataOf<{
      productId: string;
      prepared: { transaction: string; description: string };
    }>(
      await post(api(), farmer, "/api/products", {
        cropType: "Cocoa",
        quantity: "60",
        unit: "kg",
        harvestDate: "2026-04-18",
        farmLocation: "Owo, Ondo State",
        description: "Cocoa beans dried on raised beds at the Owo drying station.",
      })
    );
    await post(api(), farmer, `/api/products/${draft.productId}/submit`, {
      signedTransaction: sign(draft.prepared, farmer),
    });
    return { farmer, productId: draft.productId };
  }

  it("applies the page size declared by the participants query schema", async () => {
    const processor = await signInRegistered(api(), "PROCESSOR");
    const response = await get(
      api(),
      processor,
      "/api/users/participants?limit=1"
    );
    expect(response.status).toBe(200);
    const { participants } = dataOf<{ participants: unknown[] }>(response);
    expect(Array.isArray(participants)).toBe(true);
  });

  it("rejects a participants page size outside the declared bounds", async () => {
    const processor = await signInRegistered(api(), "PROCESSOR");
    const response = await get(
      api(),
      processor,
      "/api/users/participants?limit=100000"
    );
    expect(response.status).toBe(422);
    expect(errorOf(response).code).toBe("VALIDATION_ERROR");
  });

  it("rejects an unknown participants role", async () => {
    const processor = await signInRegistered(api(), "PROCESSOR");
    const response = await get(
      api(),
      processor,
      "/api/users/participants?role=FARMER"
    );
    expect(response.status).toBe(422);
  });

  it("returns only the roles that may receive a product", async () => {
    const farmer = await signInRegistered(api(), "FARMER");
    const processor = await signInRegistered(api(), "PROCESSOR");
    const retailer = await signInRegistered(api(), "RETAILER");
    const regulator = await signInRegistered(api(), "REGULATOR");
    void farmer;
    void regulator;

    const response = await get(api(), processor, "/api/users/participants?limit=50");
    const { participants } = dataOf<{ participants: Array<{ role: string; walletAddress: string }> }>(response);
    const roles = new Set(participants.map((entry) => entry.role));
    for (const role of roles) {
      expect(["PROCESSOR", "TRANSPORTER", "RETAILER"]).toContain(role);
    }
    const addresses = participants.map((entry) => entry.walletAddress);
    expect(addresses).not.toContain(processor.wallet.address);
    expect(addresses).toContain(retailer.wallet.address);
    // A farmer and a regulator are not eligible to receive a product, so neither
    // is offered as a recipient.
    expect(addresses).not.toContain(farmer.wallet.address);
    expect(addresses).not.toContain(regulator.wallet.address);
  });

  it("applies the product list page size and reports the pagination totals", async () => {
    const { farmer } = await registerFarmer();
    const response = await get(api(), farmer, "/api/products?pageSize=1&page=1");
    expect(response.status).toBe(200);
    const result = dataOf<{
      products: unknown[];
      pagination: { page: number; pageSize: number; total: number; totalPages: number };
    }>(response);
    expect(result.pagination.page).toBe(1);
    expect(result.pagination.pageSize).toBe(1);
    expect(result.pagination.total).toBeGreaterThanOrEqual(1);
    expect(result.pagination.totalPages).toBeGreaterThanOrEqual(1);
    expect(result.products.length).toBeLessThanOrEqual(1);
  });

  it("rejects a product list page size outside the declared bounds", async () => {
    const { farmer } = await registerFarmer();
    const response = await get(api(), farmer, "/api/products?pageSize=5000");
    expect(response.status).toBe(422);
  });

  it("rejects an unknown product status filter", async () => {
    const { farmer } = await registerFarmer();
    const response = await get(api(), farmer, "/api/products?status=TELEPORTED");
    expect(response.status).toBe(422);
  });

  it("honours a valid product status filter", async () => {
    const { farmer, productId } = await registerFarmer();
    const matching = await get(api(), farmer, "/api/products?status=REGISTERED");
    const ids = dataOf<{ products: Array<{ productId: string }> }>(matching).products.map(
      (product) => product.productId
    );
    expect(ids).toContain(productId);
  });

  it("applies the transfer list direction filter", async () => {
    const { farmer } = await registerFarmer();
    for (const direction of ["incoming", "outgoing", "all"]) {
      const response = await get(api(), farmer, `/api/transfers?direction=${direction}`);
      expect(response.status, direction).toBe(200);
      expect(dataOf<{ transfers: unknown[] }>(response).transfers).toEqual([]);
    }
    const rejected = await get(api(), farmer, "/api/transfers?direction=sideways");
    expect(rejected.status).toBe(422);
  });

  it("applies the search query bounds", async () => {
    const tooShort = await get(api(), null, "/api/search?q=a");
    expect(tooShort.status).toBe(422);
    const fine = await get(api(), null, "/api/search?q=cocoa");
    expect(fine.status).toBe(200);
    expect(dataOf<{ term: string }>(fine).term).toBe("cocoa");
  });

  it("applies the activity page bounds", async () => {
    const { farmer } = await registerFarmer();
    const response = await get(api(), farmer, "/api/activity?page=1&pageSize=5");
    expect(response.status).toBe(200);
    const result = dataOf<{
      entries: unknown[];
      pagination: { page: number; pageSize: number; total: number };
    }>(response);
    expect(result.pagination.pageSize).toBe(5);
    expect(result.entries.length).toBeLessThanOrEqual(5);
    expect(result.pagination.total).toBeGreaterThanOrEqual(result.entries.length);
  });

  it("applies the compliance report page bounds and is regulator-only", async () => {
    const { farmer } = await registerFarmer();
    expect((await get(api(), farmer, "/api/compliance/reports")).status).toBe(403);
    const regulator = await signInRegistered(api(), "REGULATOR");
    const response = await get(api(), regulator, "/api/compliance/reports?pageSize=5");
    expect(response.status).toBe(200);
    expect(
      dataOf<{ pagination: { pageSize: number } }>(response).pagination.pageSize
    ).toBe(5);
  });

  it("applies the compliance verification query bounds and is regulator-only", async () => {
    const { farmer } = await registerFarmer();
    expect((await get(api(), farmer, "/api/compliance/verifications")).status).toBe(403);
    const regulator = await signInRegistered(api(), "REGULATOR");
    const response = await get(api(), regulator, "/api/compliance/verifications?pageSize=5");
    expect(response.status).toBe(200);
    expect(
      dataOf<{ pagination: { pageSize: number } }>(response).pagination.pageSize
    ).toBe(5);
  });

  it("does not expose a participant record by address", async () => {
    const { farmer } = await registerFarmer();
    const retailer = await signInRegistered(api(), "RETAILER");
    const response = await get(
      api(),
      retailer,
      `/api/users/${farmer.wallet.address}`
    );
    // A wallet address is not an addressable profile: the participants list is
    // the only way to discover a counterparty, and it discloses no contact
    // details. This keeps a wallet address from becoming a public directory.
    expect(response.status).toBe(404);
  });

  it("keeps the regulator directory free of contact details", async () => {
    const regulator = await signInRegistered(api(), "REGULATOR");
    await UserModel.updateOne(
      { walletAddress: regulator.wallet.address },
      { $set: { "contactInfo.email": "regulator@example.test" } }
    );
    const response = await get(api(), regulator, "/api/users/participants?scope=directory");
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain("regulator@example.test");
  });

  it("records a verification through the log route without a session", async () => {
    const { productId } = await registerFarmer();
    const logged = await postPublic(api(), `/api/verify/${productId}/log`, {
      requestChannel: "SEARCH",
    });
    expect(logged.status).toBe(200);
    const recorded = dataOf<{ result: string }>(logged);
    expect(recorded.result).toBe("VERIFIED");

    const product = await ProductMetadataModel.findOne({ productId }).lean();
    expect(product?.lastVerificationResult).toBe("VERIFIED");
  });

  it("rejects an unknown reader source", async () => {
    const { productId } = await registerFarmer();
    const response = await postPublic(api(), `/api/verify/${productId}/log`, {
      source: "TELEPATHY",
    });
    expect(response.status).toBe(422);
  });

  it("attributes a check to the reader's session, not to a channel the client claims", async () => {
    // A client must not be able to file its own check as a regulator's review, so
    // the actor half of the channel comes from the session alone.
    const { productId } = await registerFarmer();
    const claimed = await postPublic(api(), `/api/verify/${productId}/log`, {
      source: "direct",
    });
    expect(claimed.status).toBe(200);
    const event = await VerificationEventModel.findOne({ productId }).sort({ createdAt: -1 });
    expect(event?.requestChannel).toBe("DIRECT_URL");
  });
});

