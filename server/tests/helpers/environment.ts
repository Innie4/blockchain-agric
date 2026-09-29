import { MongoMemoryServer } from "mongodb-memory-server";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import type { Application } from "express";
import { createApp } from "../../src/app.js";
import { connectDatabase, disconnectDatabase } from "../../src/config/database.js";
import { resetMediaBucket } from "../../src/services/files/mediaStore.js";
import { setChainClient } from "../../src/services/solana/chainClientRegistry.js";
import { InMemoryChainClient } from "./inMemoryChain.js";
import { CLUSTER_TIME } from "./testEnv.js";

/**
 * Shared test environment: a real MongoDB instance, the real Express app, and an
 * in-process chain that speaks the same interface as the production client.
 *
 * Everything below the HTTP boundary is the production code path. The only
 * substitution is the Solana transport, and the harness installs it explicitly
 * so no production module can quietly acquire it.
 */

export const TEST_PROGRAM_ID = new PublicKey("CTKBH9KnbTd8zL4sHNpj4CBPPQcHu2uZk613WpA1ZiDm");

let mongoServer: MongoMemoryServer | null = null;

export interface TestEnvironment {
  app: Application;
  chain: InMemoryChainClient;
  uri: string;
}

let environment: TestEnvironment | null = null;

/** Boots the shared environment once for the whole run. */
export async function startEnvironment(port: number): Promise<TestEnvironment> {
  if (environment !== null) return environment;

  mongoServer = await MongoMemoryServer.create({
    instance: { port, dbName: "agri_trace_test" },
  });
  const uri = mongoServer.getUri("agri_trace_test");

  const chain = new InMemoryChainClient(TEST_PROGRAM_ID, CLUSTER_TIME);
  setChainClient(chain);

  await connectDatabase();
  resetMediaBucket();

  const app = createApp();
  environment = { app, chain, uri };
  return environment;
}

export async function stopEnvironment(): Promise<void> {
  setChainClient(null);
  resetMediaBucket();
  await disconnectDatabase();
  if (mongoServer !== null) {
    await mongoServer.stop();
    mongoServer = null;
  }
  environment = null;
}

export function getEnvironment(): TestEnvironment {
  if (environment === null) {
    throw new Error("The test environment has not been started.");
  }
  return environment;
}

/** Removes every document between tests without dropping the indexes. */
export async function resetDatabase(): Promise<void> {
  const { default: mongoose } = await import("mongoose");
  const collections = await mongoose.connection.db?.collections();
  if (collections === undefined) return;
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
}

/** A participant identified by a real keypair, so signatures really verify. */
export interface TestWallet {
  keypair: Keypair;
  address: string;
  /** Signs an arbitrary UTF-8 message the way a browser wallet would. */
  signMessage(message: string): string;
  /** Signs a prepared transaction the way a browser wallet would. */
  signTransaction(base64: string): string;
}

export function createWallet(): TestWallet {
  const keypair = Keypair.generate();
  return {
    keypair,
    address: keypair.publicKey.toBase58(),
    signMessage(message: string): string {
      const signature = nacl.sign.detached(
        new Uint8Array(Buffer.from(message, "utf8")),
        keypair.secretKey
      );
      return Buffer.from(signature).toString("base64");
    },
    signTransaction(base64: string): string {
      const transaction = Transaction.from(Buffer.from(base64, "base64"));
      // A wallet fills in the fee payer's signature; every other signer is
      // rejected earlier, so a single signature is correct here.
      transaction.partialSign(keypair);
      return transaction.serialize().toString("base64");
    },
  };
}

export interface SignedInSession {
  wallet: TestWallet;
  cookies: string[];
  csrfToken: string;
  userId: string;
}

/** A tiny cookie jar, so each identity keeps its own session. */
export class CookieJar {
  private readonly jar = new Map<string, string>();

  capture(response: { headers: Record<string, unknown> }): void {
    const raw = response.headers["set-cookie"];
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
    for (const entry of list) {
      const [pair] = entry.split(";");
      if (pair === undefined) continue;
      const separator = pair.indexOf("=");
      if (separator === -1) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (value.length === 0) {
        this.jar.delete(name);
      } else {
        this.jar.set(name, value);
      }
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  get(name: string): string | undefined {
    return this.jar.get(name);
  }

  set(name: string, value: string): void {
    this.jar.set(name, value);
  }

  clear(): void {
    this.jar.clear();
  }
}
