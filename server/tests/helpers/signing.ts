import type { Keypair} from "@solana/web3.js";
import { Transaction } from "@solana/web3.js";
import type { TestWallet } from "./environment.js";

/** Signs a prepared transaction the way a browser wallet would. */
export function signTransactionFrom(base64: string, wallet: TestWallet): string {
  const transaction = Transaction.from(Buffer.from(base64, "base64"));
  transaction.partialSign(wallet.keypair);
  return transaction.serialize().toString("base64");
}

/** Signs with a keypair that is not the one the transaction expects. */
export function signTransactionWithForeignKey(
  base64: string,
  foreign: Keypair
): string {
  const transaction = Transaction.from(Buffer.from(base64, "base64"));
  transaction.addSignature(foreign.publicKey, Buffer.alloc(64));
  return transaction.serialize().toString("base64");
}

/** Re-serialises a prepared transaction with no signature at all. */
export function stripSignature(base64: string): string {
  const transaction = Transaction.from(Buffer.from(base64, "base64"));
  transaction.signatures = transaction.signatures.map((pair) => ({
    publicKey: pair.publicKey,
    signature: null,
  }));
  return transaction.serialize({ requireAllSignatures: false }).toString("base64");
}

/** A syntactically valid but meaningless base64 blob. */
export function garbageTransaction(): string {
  return Buffer.from("not-a-transaction-at-all", "utf8").toString("base64");
}
