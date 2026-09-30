import type { Role } from "../api/types";

/**
 * The shape of the generated demo data.
 *
 * These describe the seed each batch is built from, before it is turned into the
 * provenance chains and records the interface renders. Keeping the seed separate
 * from the built record is what lets the dataset be regenerated from one place.
 */

export interface DemoWallets {
  farmer: string;
  processor: string;
  transporter: string;
  retailer: string;
  regulator: string;
}

export interface DemoTimestamps {
  cocoaRegistered: string;
  soyRegistered: string;
  cashewRegistered: string;
  plantainRegistered: string;
  tomatoRegistered: string;
  maizeRegistered: string;
  gingerRegistered: string;
}

export interface DemoRetail {
  listed: boolean;
  listedAt: string | null;
  askingPrice: number | null;
  currency: string;
  soldAt: string | null;
  note: string;
}

export interface DemoBatchSeed {
  productId: string;
  cropType: string;
  quantity: number;
  unit: string;
  harvestDate: string;
  farmLocation: string;
  description: string;
  additionalNotes: string;
  registeredAt: string;
  registeredBy: string;
  registrantRole: string;
  status: string;
  owner: string;
  ownerRole: string;
  imageHashes: string[];
  certificateHashes: string[];
  retail: DemoRetail;
  transferCount: number;
  flagged?: boolean;
  preFlagStatus?: string;
}

export interface DemoBatchRow {
  seed: DemoBatchSeed;
  /** The registration fingerprint, computed by the server's canonical module. */
  dataHash: string;
  onChainAddress: string;
}

export interface DemoParticipant {
  walletAddress: string;
  fullName: string;
  role: Role;
  organisation: string;
  state: string;
  contactEmail: string;
  contactPhone: string;
}
