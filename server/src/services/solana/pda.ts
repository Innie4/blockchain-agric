import { PublicKey } from "@solana/web3.js";

/**
 * Deterministic program-derived addresses.
 *
 * The backend never stores a program-derived address in the database: both
 * account types are re-derived from their seed on every use, so a stale or
 * tampered address column cannot redirect a lookup.
 */

export const PRODUCT_SEED = "product";
export const PARTICIPANT_SEED = "participant";

/** Mirrors `declare_id!` in the program. Overridden by SOLANA_PROGRAM_ID. */
export const FALLBACK_PROGRAM_ID =
  "CTKBH9KnbTd8zL4sHNpj4CBPPQcHu2uZk613WpA1ZiDm";

export function getProductAddress(
  programId: PublicKey,
  productId: string
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PRODUCT_SEED, "utf8"), Buffer.from(productId, "utf8")],
    programId
  )[0];
}

export function getParticipantAddress(
  programId: PublicKey,
  wallet: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PARTICIPANT_SEED, "utf8"), wallet.toBuffer()],
    programId
  )[0];
}

export function getSystemProgramAddress(programId: PublicKey, productId: string) {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from(PRODUCT_SEED, "utf8"), Buffer.from(productId, "utf8")],
    programId
  );
  return { address, bump };
}
