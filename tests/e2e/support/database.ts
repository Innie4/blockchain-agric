import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient, type Collection, type Db } from "mongodb";

import { RUNTIME_ENV_FILE } from "./constants";

/**
 * The test process's own direct connection to the end-to-end database.
 *
 * Two things need it, and neither of them is a reason to add a route to the
 * application:
 *   1. Clearing the collections between tests, so one flow cannot see another's
 *      records.
 *   2. Tampering with a stored batch (FLOW 5), which is the only honest way to
 *      simulate somebody editing a record after registration. An administrator
 *      with direct database access is exactly the threat model the anchored
 *      fingerprint exists for.
 *
 * So there is no reset endpoint in the API at all, in any environment. The
 * connection is opened lazily and reused, and `NODE_ENV` never comes into it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

/**
 * Every collection the API's models declare.
 *
 * The reset drops the whole database, so this list is not used to decide what to
 * empty. It is kept as the record of what the API is expected to write, and the
 * media bucket names are spelled out because GridFS creates them on first upload
 * rather than at startup.
 */
export const E2E_COLLECTIONS: readonly string[] = [
  "users",
  "products",
  "transfers",
  "certificates",
  "processingLogs",
  "transportLogs",
  "verificationEvents",
  "complianceReports",
  "authNonces",
  "sessions",
  "idempotencyKeys",
  "reconciliationTasks",
  "notifications",
  "auditLogs",
  // GridFS writes uploaded files here.
  "agri-trace-media.files",
  "agri-trace-media.chunks",
];

export interface E2eRuntimeEnvironment {
  mongoUri: string;
  mongoDbName: string;
  mockRpcUrl: string;
  programId: string;
  network: string;
}

let cachedEnvironment: E2eRuntimeEnvironment | null = null;

/** Reads what the infrastructure process published, failing with a clear message. */
export function runtimeEnvironment(): E2eRuntimeEnvironment {
  if (cachedEnvironment !== null) return cachedEnvironment;
  const file = resolve(REPO_ROOT, RUNTIME_ENV_FILE);
  try {
    cachedEnvironment = JSON.parse(readFileSync(file, "utf8")) as E2eRuntimeEnvironment;
  } catch (cause) {
    throw new Error(
      `The end-to-end runtime environment at ${RUNTIME_ENV_FILE} could not be read. ` +
        "The infrastructure process must be running; it is the first entry in the `webServer` array. " +
        `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return cachedEnvironment;
}

let client: MongoClient | null = null;
let database: Db | null = null;

async function connect(): Promise<Db> {
  if (database !== null) return database;
  const environment = runtimeEnvironment();
  client = new MongoClient(environment.mongoUri, {
    serverSelectionTimeoutMS: 20_000,
  });
  await client.connect();
  database = client.db(environment.mongoDbName);
  return database;
}

async function collection(name: string): Promise<Collection> {
  return (await connect()).collection(name);
}

/**
 * Empties the test database. Called before each test.
 *
 * The whole database is dropped rather than emptied collection by collection, and
 * the result is then read back and asserted. A partial reset that quietly leaves
 * a document behind does not fail where it happens: it surfaces much later as an
 * unrelated-looking failure, such as a recipient picker offering two identically
 * named participants, and costs far more time to diagnose than it saves.
 */
export async function resetDatabase(): Promise<void> {
  const db = await connect();
  await db.dropDatabase();

  const remaining = await db.listCollections({}, { nameOnly: true }).toArray();
  const names = remaining.map((entry) => entry.name);
  const users = await db.collection("users").countDocuments({});
  if (users !== 0) {
    throw new Error(
      `The test database was not emptied: ${users} participant document(s) survived the reset ` +
        `(collections present: ${names.length === 0 ? "none" : names.join(", ")}). ` +
        "Without a clean database a later test sees another test's participants.",
    );
  }
  process.stdout.write(`RESET-DONE collections=${names.length} users=${users}\n`);
}

export interface StoredProductSnapshot {
  productId: string;
  description: string;
  status: string;
  chainState: string;
  dataHash: string;
  onChainDataHash: string | null;
  ownerWallet: string;
  lastVerificationResult: string;
}

function toSnapshot(document: Record<string, unknown>): StoredProductSnapshot {
  return {
    productId: String(document["productId"] ?? ""),
    description: String(document["description"] ?? ""),
    status: String(document["status"] ?? ""),
    chainState: String(document["chainState"] ?? ""),
    dataHash: String(document["dataHash"] ?? ""),
    onChainDataHash:
      document["onChainDataHash"] === undefined || document["onChainDataHash"] === null
        ? null
        : String(document["onChainDataHash"]),
    ownerWallet: String(document["ownerWallet"] ?? ""),
    lastVerificationResult: String(document["lastVerificationResult"] ?? ""),
  };
}

/** Reads a stored batch, so a test can assert the before-state of a tamper. */
export async function readStoredProduct(productId: string): Promise<StoredProductSnapshot | null> {
  const products = await collection("products");
  const document = await products.findOne({ productId });
  if (document === null) return null;
  return toSnapshot(document as Record<string, unknown>);
}

/**
 * Rewrites a registered batch's description behind the application's back.
 *
 * This is the substitution FLOW 5 is about: the anchored fingerprint covers the
 * description, so changing it must make the next check report a mismatch. The
 * write goes through the database driver rather than the API on purpose, because
 * the API has no route that would let a description be changed after
 * registration — which is the point being tested.
 */
export async function tamperStoredDescription(
  productId: string,
  description: string
): Promise<StoredProductSnapshot> {
  const products = await collection("products");
  const result = await products.updateOne({ productId }, { $set: { description } });
  if (result.matchedCount === 0) {
    throw new Error(`No stored batch named ${productId} was found to tamper with.`);
  }
  const document = await products.findOne({ productId });
  if (document === null) {
    throw new Error(`The stored batch ${productId} disappeared while it was being tampered with.`);
  }
  return toSnapshot(document as Record<string, unknown>);
}

/** Sets a participant's role, for the one step the interface does not offer. */
export async function setParticipantRole(walletAddress: string, role: string): Promise<void> {
  const users = await collection("users");
  const result = await users.updateOne({ walletAddress }, { $set: { role } });
  if (result.matchedCount === 0) {
    throw new Error(`No participant record exists for ${walletAddress}.`);
  }
}

/** The raw stored value of a user field, for assertions about setup. */
export async function readUserField(
  walletAddress: string,
  field: string
): Promise<unknown> {
  const users = await collection("users");
  const document = await users.findOne({ walletAddress }, { projection: { [field]: 1 } });
  if (document === null) return undefined;
  return (document as Record<string, unknown>)[field];
}

/** Closes the test process's database connection. */
export async function closeDatabase(): Promise<void> {
  if (client !== null) {
    await client.close().catch(() => undefined);
  }
  client = null;
  database = null;
}
