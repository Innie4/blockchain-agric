import { PublicKey } from "@solana/web3.js";

/**
 * Program-derived addresses, re-derived here so the suite can name the accounts
 * it expects without reaching into the API's own code. An independent
 * derivation that agreed with the API by accident would not be worth having.
 *
 * Mirrors `server/src/services/solana/pda.ts`.
 */

export const PRODUCT_SEED = "product";
export const PARTICIPANT_SEED = "participant";

/** `[address, bump]` for a batch's account: `findProgramAddressSync([b"product", productId], programId)`. */
export function deriveProductAddress(
  programId: PublicKey,
  productId: string
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PRODUCT_SEED, "utf8"), Buffer.from(productId, "utf8")],
    programId
  );
}

/** The batch's account address. */
export function productAddress(programId: PublicKey, productId: string): PublicKey {
  return deriveProductAddress(programId, productId)[0];
}

/** `[address, bump]` for a participant's registry entry. */
export function deriveParticipantAddress(
  programId: PublicKey,
  wallet: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PARTICIPANT_SEED, "utf8"), wallet.toBuffer()],
    programId
  );
}

/** A participant's registry entry address. */
export function participantAddress(programId: PublicKey, wallet: PublicKey): PublicKey {
  return deriveParticipantAddress(programId, wallet)[0];
}
