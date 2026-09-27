import mongoose, { Schema, model, type InferSchemaType, type Model } from "mongoose";
import {
  PARTICIPANT_ROLE_VALUES,
  type ParticipantRoleValue,
} from "../lib/roles.js";

/**
 * A registered participant. The wallet address is the identity: there is no
 * password, because authentication is a signature over a server-issued
 * challenge.
 */
const contactSchema = new Schema(
  {
    email: { type: String, trim: true, lowercase: true, maxlength: 200, default: "" },
    phone: { type: String, trim: true, maxlength: 40, default: "" },
    address: { type: String, trim: true, maxlength: 400, default: "" },
    state: { type: String, trim: true, maxlength: 120, default: "" },
  },
  { _id: false }
);

const userSchema = new Schema(
  {
    userId: { type: String, required: true, unique: true, immutable: true },
    walletAddress: { type: String, required: true, unique: true, immutable: true },
    fullName: { type: String, trim: true, maxlength: 160, default: "" },
    role: {
      type: String,
      required: true,
      enum: PARTICIPANT_ROLE_VALUES as unknown as string[],
    },
    contactInfo: { type: contactSchema, default: () => ({}) },
    organisation: { type: String, trim: true, maxlength: 200, default: "" },
    registrationDate: { type: Date, required: true, default: () => new Date() },
    status: {
      type: String,
      enum: ["ACTIVE", "SUSPENDED", "WITHDRAWN"],
      required: true,
      default: "ACTIVE",
    },
    /** Whether the wallet holds an on-chain participant registry entry. */
    onChainRegistered: { type: Boolean, required: true, default: false },
    /** On-chain registration transaction, once it has confirmed. */
    onChainRegistrationTx: { type: String, default: null },
    /** SHA-256 of the canonical profile payload anchored on-chain. */
    profileHash: { type: String, default: null },
    lastSeen: { type: Date, required: true, default: () => new Date() },
    /** Count of consecutive failed sign-in attempts, used to throttle abuse. */
    failedAuthAttempts: { type: Number, required: true, default: 0, min: 0 },
    lockedUntil: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: "users" }
);

userSchema.index({ role: 1, status: 1 });
userSchema.index({ registrationDate: -1 });

export type UserDocument = InferSchemaType<typeof userSchema> & { _id: unknown };

export const UserModel: Model<UserDocument> =
  (mongoose.models.User as Model<UserDocument>) ??
  model<UserDocument>("User", userSchema);

export function toParticipantRole(value: string): ParticipantRoleValue {
  if (!(PARTICIPANT_ROLE_VALUES as readonly string[]).includes(value)) {
    throw new Error(`Unknown participant role "${value}" stored on a user record.`);
  }
  return value as ParticipantRoleValue;
}
