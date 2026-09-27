import { z } from "zod";
import { AppError, ERROR_CODES } from "../../lib/errors.js";
import { toPublicKey } from "../../lib/crypto.js";
import { childLogger } from "../../lib/logger.js";
import { ROLES, onChainRoleOrdinal, type Role } from "../../lib/roles.js";
import { computeProfileHash } from "../hashing/canonical.js";
import { buildRegisterParticipant } from "../solana/instructions.js";
import { UserModel } from "../../models/index.js";
import { prepareAction, submitAction, type PreparedChainAction } from "../orchestration/chainFlow.js";
import { getChainClient } from "../solana/chainClientRegistry.js";
import { writeAudit } from "../auth/authService.js";

const log = childLogger({ layer: "participants" });

export const participantRegistrationSchema = z.object({
  role: z.enum(ROLES as unknown as [Role, ...Role[]]),
  fullName: z.string().trim().min(2, "Enter your full name.").max(160),
  contactEmail: z
    .string()
    .trim()
    .max(200)
    .refine(
      (value) => value.length === 0 || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
      "Enter a valid email address or leave it blank."
    )
    .default(""),
  contactPhone: z.string().trim().max(40).default(""),
  organisation: z.string().trim().max(200).default(""),
});

export type ParticipantRegistrationInput = z.infer<typeof participantRegistrationSchema>;

export interface PreparedParticipantRegistration {
  prepared: PreparedChainAction;
  profileHash: string;
  participantAddress: string;
  role: Role;
}

export interface ParticipantRegistrationResult {
  walletAddress: string;
  role: Role;
  onChainRegistered: boolean;
  profileHash: string;
  transactionSignature: string;
}

/**
 * Stage one of on-chain participant registration.
 *
 * Registering on-chain is what allows a wallet to receive a product, because
 * the program requires the recipient to already hold a registry entry.
 */
export async function prepareParticipantRegistration(input: {
  walletAddress: string;
  payload: ParticipantRegistrationInput;
  requestId?: string | undefined;
}): Promise<PreparedParticipantRegistration> {
  const chain = getChainClient();
  const role = input.payload.role;
  if (onChainRoleOrdinal(role) === null) {
    throw new AppError(ERROR_CODES.ROLE_NOT_ALLOWED, {
      message: "That role cannot be registered on the blockchain.",
    });
  }

  const user = await UserModel.findOne({ walletAddress: input.walletAddress });
  if (user === null) {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, {
      message: "Sign in with this wallet before registering it as a participant.",
    });
  }
  if (user.role !== role) {
    throw new AppError(ERROR_CODES.ROLE_NOT_ALLOWED, {
      message: `Your account is set up as a ${user.role.toLowerCase()}. Only an administrator can change a participant's role.`,
      details: { accountRole: user.role, requestedRole: role },
    });
  }
  if (user.onChainRegistered) {
    throw new AppError(ERROR_CODES.PARTICIPANT_ALREADY_REGISTERED, {
      message: "This wallet is already registered on the blockchain.",
      details: { transactionSignature: user.onChainRegistrationTx },
    });
  }

  const existing = await chain.fetchParticipant(toPublicKey(input.walletAddress, "walletAddress"));
  if (existing !== null) {
    throw new AppError(ERROR_CODES.PARTICIPANT_ALREADY_REGISTERED, {
      message:
        "This wallet already holds an on-chain participant registration, so the registration cannot be repeated.",
      details: { onChainRole: existing.role, registeredAt: existing.registeredAt },
    });
  }

  const profileHash = computeProfileHash({
    walletAddress: input.walletAddress,
    fullName: input.payload.fullName,
    role,
    contactEmail: input.payload.contactEmail,
    contactPhone: input.payload.contactPhone,
    organisation: input.payload.organisation,
  });

  const instruction = buildRegisterParticipant(
    chain.programId,
    toPublicKey(input.walletAddress, "walletAddress"),
    role,
    Buffer.from(profileHash, "hex")
  );

  const prepared = await prepareAction({
    instructions: [instruction],
    feePayer: input.walletAddress,
    description: `Register as a ${role.toLowerCase()} on Solana`,
    targetAddress: chain
      .participantAddressFor(toPublicKey(input.walletAddress, "walletAddress"))
      .toBase58(),
  });

  await writeAudit({
    action: "participant.register.prepare",
    actorWallet: input.walletAddress,
    actorRole: role,
    outcome: "SUCCESS",
    resourceType: "participant",
    resourceId: input.walletAddress,
    requestId: input.requestId,
  });

  log.info({ walletAddress: input.walletAddress, role }, "prepared participant registration");
  return {
    prepared,
    profileHash,
    participantAddress: prepared.targetAddress,
    role,
  };
}

export async function submitParticipantRegistration(input: {
  walletAddress: string;
  signedTransaction: string;
  requestId?: string | undefined;
}): Promise<ParticipantRegistrationResult> {
  const chain = getChainClient();
  const user = await UserModel.findOne({ walletAddress: input.walletAddress });
  if (user === null) {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, {
      message: "Sign in with this wallet before submitting its registration.",
    });
  }
  if (user.onChainRegistered) {
    return {
      walletAddress: user.walletAddress,
      role: user.role as Role,
      onChainRegistered: true,
      profileHash: user.profileHash ?? "",
      transactionSignature: user.onChainRegistrationTx ?? "",
    };
  }

  const wallet = toPublicKey(input.walletAddress, "walletAddress");
  const confirmed = await submitAction({
    signedTransaction: input.signedTransaction,
    expectedSigner: input.walletAddress,
    description: "Register participant on-chain",
    targetAddress: chain.participantAddressFor(wallet).toBase58(),
  });

  // Confirm the chain really recorded this wallet before claiming it did.
  const onChain = await chain.fetchParticipant(wallet);
  if (onChain === null) {
    throw new AppError(ERROR_CODES.BLOCKCHAIN_ACCOUNT_NOT_FOUND, {
      message:
        "The transaction confirmed but the on-chain participant record cannot be read. An administrator has been notified.",
      details: { signature: confirmed.signature },
    });
  }
  if (onChain.role !== user.role) {
    throw new AppError(ERROR_CODES.HASH_MISMATCH, {
      message:
        "The transaction confirmed but the role stored on-chain does not match your account. An administrator has been notified.",
      details: {
        onChainRole: onChain.role,
        accountRole: user.role,
        signature: confirmed.signature,
      },
    });
  }

  user.onChainRegistered = true;
  user.onChainRegistrationTx = confirmed.signature;
  user.profileHash = onChain.profileHash;
  await user.save();

  await writeAudit({
    action: "participant.register.submit",
    actorWallet: input.walletAddress,
    actorRole: user.role,
    outcome: "SUCCESS",
    resourceType: "participant",
    resourceId: input.walletAddress,
    requestId: input.requestId,
    detail: { signature: confirmed.signature, role: onChain.role },
  });

  log.info(
    { walletAddress: input.walletAddress, role: onChain.role, signature: confirmed.signature },
    "participant registration confirmed"
  );
  return {
    walletAddress: user.walletAddress,
    role: onChain.role,
    onChainRegistered: true,
    profileHash: onChain.profileHash,
    transactionSignature: confirmed.signature,
  };
}

/**
 * Confirms whether a wallet holds an on-chain registry entry. Called when a
 * participant returns to the application, so a missing registration is noticed
 * before an operation fails on-chain.
 */
export async function refreshRegistrationState(walletAddress: string): Promise<boolean> {
  const chain = getChainClient();
  const user = await UserModel.findOne({ walletAddress });
  if (user === null) return false;
  if (user.role === "CONSUMER") return false;
  try {
    const onChain = await chain.fetchParticipant(toPublicKey(walletAddress, "walletAddress"));
    if (onChain === null) {
      if (user.onChainRegistered) {
        user.onChainRegistered = false;
        user.onChainRegistrationTx = null;
        await user.save();
      }
      return false;
    }
    if (!user.onChainRegistered || user.profileHash !== onChain.profileHash) {
      user.onChainRegistered = true;
      user.profileHash = onChain.profileHash;
      await user.save();
    }
    return true;
  } catch (error) {
    log.warn({ walletAddress, problem: String(error) }, "could not read participant registration");
    return user.onChainRegistered;
  }
}
