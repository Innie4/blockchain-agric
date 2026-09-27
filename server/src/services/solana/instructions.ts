import type { PublicKey} from "@solana/web3.js";
import { SystemProgram, TransactionInstruction } from "@solana/web3.js";
import type { Role } from "../../lib/roles.js";
import type { ProductStatus } from "../../lib/statusMachine.js";
import { toPublicKey } from "../../lib/crypto.js";
import { getParticipantAddress, getProductAddress } from "./pda.js";
import {
  BinaryWriter,
  INSTRUCTION_NAMES,
  ROLE_ORDINALS,
  instructionDiscriminator,
  statusOrdinal,
  verificationResultOrdinal,
  type VerificationResultName,
} from "./layout.js";

/**
 * Builds the transaction instructions the on-chain program expects. The byte
 * layout is documented in `docs/blockchain.md` and asserted against a reference
 * borsh implementation in `tests/unit/solanaLayout.test.ts`.
 */

export function buildRegisterParticipant(
  programId: PublicKey,
  participant: PublicKey,
  role: Role,
  profileHash: Buffer
): TransactionInstruction {
  if (profileHash.length !== 32) {
    throw new Error("profileHash must be 32 bytes.");
  }
  const data = new BinaryWriter()
    .bytes(instructionDiscriminator(INSTRUCTION_NAMES.registerParticipant))
    .u8(ROLE_ORDINALS[role])
    .bytes(profileHash)
    .toBuffer();

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: participant, isSigner: true, isWritable: true },
      {
        pubkey: getParticipantAddress(programId, participant),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: true },
    ],
    data,
  });
}

export function buildRegisterProduct(
  programId: PublicKey,
  registrant: PublicKey,
  productId: string,
  offChainDataHash: Buffer
): TransactionInstruction {
  if (offChainDataHash.length !== 32) {
    throw new Error("offChainDataHash must be 32 bytes.");
  }
  const data = new BinaryWriter()
    .bytes(instructionDiscriminator(INSTRUCTION_NAMES.registerProduct))
    .string(productId)
    .bytes(offChainDataHash)
    .toBuffer();

  const product = getProductAddress(programId, productId);
  const registry = getParticipantAddress(programId, registrant);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: registrant, isSigner: true, isWritable: true },
      { pubkey: registry, isSigner: false, isWritable: false },
      { pubkey: product, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: true },
    ],
    data,
  });
}

export function buildTransferOwnership(
  programId: PublicKey,
  currentOwner: PublicKey,
  productId: string,
  recipient: PublicKey,
  transferId: Buffer
): TransactionInstruction {
  if (transferId.length !== 16) {
    throw new Error("transferId must be 16 bytes.");
  }
  const data = new BinaryWriter()
    .bytes(instructionDiscriminator(INSTRUCTION_NAMES.transferOwnership))
    .bytes(transferId)
    .toBuffer();

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: currentOwner, isSigner: true, isWritable: true },
      { pubkey: getProductAddress(programId, productId), isSigner: false, isWritable: true },
      {
        pubkey: getParticipantAddress(programId, recipient),
        isSigner: false,
        isWritable: false,
      },
    ],
    data,
  });
}

export function buildUpdateStatus(
  programId: PublicKey,
  actor: PublicKey,
  productId: string,
  newStatus: ProductStatus,
  occurredAt: number
): TransactionInstruction {
  const data = new BinaryWriter()
    .bytes(instructionDiscriminator(INSTRUCTION_NAMES.updateStatus))
    .u8(statusOrdinal(newStatus))
    .i64(occurredAt)
    .toBuffer();

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: actor, isSigner: true, isWritable: true },
      {
        pubkey: getParticipantAddress(programId, actor),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: getProductAddress(programId, productId), isSigner: false, isWritable: true },
    ],
    data,
  });
}

export function buildRecordVerification(
  programId: PublicKey,
  verifier: PublicKey,
  productId: string,
  result: VerificationResultName,
  verificationHash: Buffer,
  occurredAt: number
): TransactionInstruction {
  if (verificationHash.length !== 32) {
    throw new Error("verificationHash must be 32 bytes.");
  }
  const data = new BinaryWriter()
    .bytes(instructionDiscriminator(INSTRUCTION_NAMES.recordVerification))
    .u8(verificationResultOrdinal(result))
    .bytes(verificationHash)
    .i64(occurredAt)
    .toBuffer();

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: verifier, isSigner: true, isWritable: true },
      {
        pubkey: getParticipantAddress(programId, verifier),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: getProductAddress(programId, productId), isSigner: false, isWritable: true },
    ],
    data,
  });
}

/** Narrows a user-supplied address to a PublicKey for instruction building. */
export function participantKey(wallet: string): PublicKey {
  return toPublicKey(wallet, "walletAddress");
}
