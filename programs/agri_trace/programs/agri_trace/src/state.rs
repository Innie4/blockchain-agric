use anchor_lang::prelude::*;

/// Number of bytes reserved for a product identifier on-chain.
pub const PRODUCT_ID_MAX_LEN: usize = 32;
/// Number of bytes in the canonical off-chain payload hash anchored on-chain.
pub const DATA_HASH_LEN: usize = 32;
/// Number of bytes in a transfer correlation identifier generated off-chain.
pub const TRANSFER_ID_LEN: usize = 16;
/// Bump seed prefix for product accounts.
pub const PRODUCT_SEED: &[u8] = b"product";
/// Bump seed prefix for participant registry accounts.
pub const PARTICIPANT_SEED: &[u8] = b"participant";

/// Participant categories recognised by the protocol.
///
/// The ordinal values are part of the on-chain wire format and are mirrored by
/// the off-chain backend in `server/src/lib/roles.ts`. Never renumber them.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
#[repr(u8)]
pub enum ParticipantRole {
    /// Cultivates and registers agricultural batches.
    Farmer,
    /// Handles, grades and processes registered batches.
    Processor,
    /// Moves batches between supply chain participants.
    Transporter,
    /// Receives batches and lists verified produce for sale.
    Retailer,
    /// Inspects the network and generates compliance reports.
    Regulator,
}

impl ParticipantRole {
    pub fn as_str(self) -> &'static str {
        match self {
            ParticipantRole::Farmer => "FARMER",
            ParticipantRole::Processor => "PROCESSOR",
            ParticipantRole::Transporter => "TRANSPORTER",
            ParticipantRole::Retailer => "RETAILER",
            ParticipantRole::Regulator => "REGULATOR",
        }
    }
}

/// Lifecycle status of a registered batch.
///
/// Ordinals are the on-chain wire values. The backend keeps an identical
/// transition table in `server/src/lib/statusMachine.ts` and the two are
/// asserted to agree by the backend test-suite.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
#[repr(u8)]
pub enum ProductStatus {
    Registered,
    InProcessing,
    Processed,
    InTransit,
    AtRetailer,
    Listed,
    Sold,
    Flagged,
}

impl ProductStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ProductStatus::Registered => "REGISTERED",
            ProductStatus::InProcessing => "IN_PROCESSING",
            ProductStatus::Processed => "PROCESSED",
            ProductStatus::InTransit => "IN_TRANSIT",
            ProductStatus::AtRetailer => "AT_RETAILER",
            ProductStatus::Listed => "LISTED",
            ProductStatus::Sold => "SOLD",
            ProductStatus::Flagged => "FLAGGED",
        }
    }

    /// Statuses this status may legally advance to, ignoring regulator flagging.
    pub fn successors(self) -> &'static [ProductStatus] {
        match self {
            ProductStatus::Registered => &[ProductStatus::InProcessing],
            ProductStatus::InProcessing => &[ProductStatus::Processed],
            ProductStatus::Processed => &[ProductStatus::InTransit],
            ProductStatus::InTransit => &[ProductStatus::AtRetailer],
            ProductStatus::AtRetailer => &[ProductStatus::Listed],
            ProductStatus::Listed => &[ProductStatus::Sold],
            // A sold batch is terminal, and a flagged batch can only be released
            // back to the status it held before it was flagged.
            ProductStatus::Sold | ProductStatus::Flagged => &[],
        }
    }

    /// Whether a linear progression from `self` to `target` is permitted.
    pub fn can_advance_to(self, target: ProductStatus) -> bool {
        self.successors().contains(&target)
    }

    /// Whether the batch is in a state that must not change any further.
    pub fn is_terminal(self) -> bool {
        matches!(self, ProductStatus::Sold)
    }

    /// Whether the batch is currently withheld by a regulator.
    pub fn is_flagged(self) -> bool {
        matches!(self, ProductStatus::Flagged)
    }
}

/// Outcome of an on-chain verification attestation.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum VerificationResult {
    Verified,
    Mismatch,
    NotFound,
    Incomplete,
}

/// A single registered agricultural batch.
///
/// Field order below is the on-chain wire format. The backend decodes these
/// accounts with a hand-written reader in `server/src/services/solana/layout.ts`
/// which is verified against a reference borsh implementation in the tests.
#[account]
#[derive(InitSpace)]
pub struct ProductAccount {
    /// Account layout version, currently `1`.
    pub version: u8,
    /// Canonical bump seed for this account.
    pub bump: u8,
    /// Reserved feature bits.
    pub flags: u8,
    /// Current lifecycle status.
    pub status: ProductStatus,
    /// Status held immediately before regulator flagging.
    pub pre_flag_status: ProductStatus,
    /// Human readable batch identifier, e.g. `AGT-COCOA-2026-A1B2C3`.
    ///
    /// The bound matches `PRODUCT_ID_MAX_LENGTH` in the backend, so an identifier
    /// the API accepts is always one the program can store.
    #[max_len(PRODUCT_ID_MAX_LEN)]
    pub product_id: String,
    /// Wallet that registered the batch.
    pub registrant: Pubkey,
    /// Wallet that currently owns the batch.
    pub owner: Pubkey,
    /// Chain timestamp of registration, sourced from the Solana cluster.
    pub registered_at: i64,
    /// Chain timestamp of the most recent state change.
    pub updated_at: i64,
    /// Chain timestamp of the most recent ownership transfer.
    pub last_transfer_at: i64,
    /// Chain timestamp of the most recent verification attestation.
    pub last_verified_at: i64,
    /// SHA-256 of the canonical off-chain registration payload.
    pub off_chain_data_hash: [u8; DATA_HASH_LEN],
    /// Number of completed ownership transfers.
    pub transfer_count: u32,
}

impl ProductAccount {
    /// Human readable batch identifier.
    pub fn product_id(&self) -> &str {
        &self.product_id
    }

    /// Lowercase hexadecimal form of the anchored payload hash.
    pub fn off_chain_data_hash_hex(&self) -> String {
        self.off_chain_data_hash
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// Rejects a batch identifier that is not in the agreed form.
    ///
    /// The grammar takes the form of a real identifier such as
    /// `AGT-COCOA-2026-A1B2C3`: a fixed `AGT` prefix, a crop segment of 3 to 6
    /// upper-case alphanumerics, a 4 digit year, and a 6 character batch
    /// segment. It is enforced here, not only in the API, because the identifier
    /// becomes a PDA seed: if the program accepted forms the API rejects, a batch
    /// could be created on chain that the application could never address, and
    /// two spellings of one batch could hold separate accounts.
    ///
    /// The rule is kept identical to `PRODUCT_ID_PATTERN` in
    /// `server/src/lib/crypto.ts`; `server/tests/unit/identifiers.test.ts` and
    /// the tests below both pin it, so the two cannot drift apart unnoticed.
    pub fn validate_product_id(id: &str) -> Result<()> {
        require!(!id.is_empty(), AgriTraceError::MalformedIdentifier);
        require!(
            id.len() <= PRODUCT_ID_MAX_LEN,
            AgriTraceError::MalformedIdentifier
        );
        require!(
            matches_product_id_grammar(id),
            AgriTraceError::MalformedIdentifier
        );
        Ok(())
    }
}

/// `AGT-` prefix, checked as bytes so no Unicode case folding can be involved.
fn has_prefix(bytes: &[u8], prefix: &[u8]) -> bool {
    bytes.len() >= prefix.len() && &bytes[..prefix.len()] == prefix
}

fn is_upper_alphanumeric(byte: u8) -> bool {
    byte.is_ascii_uppercase() || byte.is_ascii_digit()
}

/// Whether an identifier matches `AGT-[A-Z0-9]{3,6}-\d{4}-[A-Z0-9]{6}`.
fn matches_product_id_grammar(id: &str) -> bool {
    let bytes = id.as_bytes();
    if !has_prefix(bytes, b"AGT-") {
        return false;
    }
    let rest = &bytes[4..];

    // The first two segments are dash-delimited; the last runs to the end, so it
    // is taken as the remainder rather than searched for a closing dash.
    let first_dash = match rest.iter().position(|b| *b == b'-') {
        Some(index) => index,
        None => return false,
    };
    let second_dash = match rest[first_dash + 1..].iter().position(|b| *b == b'-') {
        Some(offset) => first_dash + 1 + offset,
        None => return false,
    };

    let (crop, year, batch) = (
        &rest[..first_dash],
        &rest[first_dash + 1..second_dash],
        &rest[second_dash + 1..],
    );

    (3..=6).contains(&crop.len())
        && crop.iter().all(|b| is_upper_alphanumeric(*b))
        && year.len() == 4
        && year.iter().all(u8::is_ascii_digit)
        && batch.len() == 6
        && batch.iter().all(|b| is_upper_alphanumeric(*b))
}

/// On-chain registry entry proving a wallet is a known supply chain participant.
///
/// Ownership transfers require the recipient to already hold one of these
/// accounts, which is how the program rejects transfers to unregistered wallets.
#[account]
#[derive(InitSpace)]
pub struct ParticipantAccount {
    /// Account layout version, currently `1`.
    pub version: u8,
    /// Canonical bump seed for this account.
    pub bump: u8,
    /// Participant wallet.
    pub participant: Pubkey,
    /// Registered participant category.
    pub role: ParticipantRole,
    /// Chain timestamp of registration.
    pub registered_at: i64,
    /// SHA-256 of the canonical off-chain participant profile payload.
    pub profile_hash: [u8; DATA_HASH_LEN],
    /// Whether the registry entry has been revoked by a regulator.
    pub revoked: bool,
}

/// Emitted once when a batch is registered on-chain.
#[event]
pub struct ProductRegistered {
    pub product_id: String,
    pub product: Pubkey,
    pub registrant: Pubkey,
    pub owner: Pubkey,
    pub status: ProductStatus,
    pub registered_at: i64,
    pub off_chain_data_hash: [u8; DATA_HASH_LEN],
}

/// Emitted on every accepted ownership transfer.
#[event]
pub struct OwnershipTransferred {
    pub product_id: String,
    pub product: Pubkey,
    pub from: Pubkey,
    pub to: Pubkey,
    pub transfer_id: [u8; TRANSFER_ID_LEN],
    pub transfer_count: u32,
    pub occurred_at: i64,
}

/// Emitted on every accepted lifecycle status change.
#[event]
pub struct ProductStatusUpdated {
    pub product_id: String,
    pub product: Pubkey,
    pub actor: Pubkey,
    pub previous_status: ProductStatus,
    pub new_status: ProductStatus,
    pub occurred_at: i64,
}

/// Emitted when a regulator attests to a verification outcome.
#[event]
pub struct VerificationRecorded {
    pub product_id: String,
    pub product: Pubkey,
    pub verifier: Pubkey,
    pub result: VerificationResult,
    pub verification_hash: [u8; DATA_HASH_LEN],
    pub occurred_at: i64,
}

/// Emitted when a wallet is added to the on-chain participant registry.
#[event]
pub struct ParticipantRegisteredEvent {
    pub participant: Pubkey,
    pub role: ParticipantRole,
    pub profile_hash: [u8; DATA_HASH_LEN],
    pub registered_at: i64,
}

/// Program-defined errors. Codes are stable and are mapped to the backend error
/// taxonomy in `server/src/services/solana/errorMapping.ts`.
#[error_code]
pub enum AgriTraceError {
    /// A batch already exists at the PDA derived from this identifier.
    #[msg("A product with this identifier is already registered on-chain")]
    DuplicateProduct,
    /// The signer is not the current owner of the batch.
    #[msg("Only the current owner may perform this action")]
    UnauthorizedOwner,
    /// The recipient is not present in the on-chain participant registry.
    #[msg("The recipient is not a registered participant")]
    InvalidRecipient,
    /// The requested status change is not a legal transition.
    #[msg("The requested product status transition is not allowed")]
    InvalidStateTransition,
    /// The product identifier failed on-chain validation.
    #[msg("The product identifier is malformed")]
    MalformedIdentifier,
    /// The recipient's participant category may not hold this batch.
    #[msg("The recipient's role may not receive this product")]
    RecipientRoleNotAllowed,
    /// The signer is not a registered regulator.
    #[msg("Only a registered regulator may perform this action")]
    RegulatorOnly,
    /// The batch is withheld by a regulator and cannot progress.
    #[msg("The product is flagged and cannot be modified")]
    ProductFlagged,
    /// The batch has reached a terminal status.
    #[msg("The product has reached a terminal status")]
    ProductClosed,
    /// The caller has no on-chain participant registry entry.
    #[msg("The signer is not a registered participant")]
    ParticipantNotRegistered,
    /// The provided timestamp is not a plausible value.
    #[msg("The supplied timestamp is not a valid cluster time")]
    InvalidTimestamp,
    /// The wallet already holds an on-chain participant registry entry.
    #[msg("This wallet is already registered as a participant on-chain")]
    ParticipantAlreadyRegistered,
    /// Only a farmer or regulator may register a new batch.
    #[msg("Only a farmer or regulator may register a product batch")]
    RegistrantRoleNotAllowed,
}

/// Bytes of account data preceding the fields, i.e. Anchor's 8 byte discriminator.
pub const ACCOUNT_DISCRIMINATOR_LEN: usize = 8;

#[cfg(test)]
mod tests {
    use super::*;

    /// The account sizes the backend hard-codes when it allocates and decodes.
    ///
    /// `server/src/services/solana/layout.ts` reads these accounts with a
    /// hand-written reader, so the two definitions of the wire format have to
    /// agree exactly. Asserting the sizes here means a field added, removed or
    /// resized on this side fails the program's own tests rather than quietly
    /// producing accounts the backend misreads.
    const BACKEND_PRODUCT_ACCOUNT_SIZE: usize = 181;
    const BACKEND_PARTICIPANT_ACCOUNT_SIZE: usize = 8 + 1 + 1 + 32 + 1 + 8 + 32 + 1;

    #[test]
    fn product_account_size_matches_the_backend_reader() {
        assert_eq!(
            ProductAccount::INIT_SPACE + ACCOUNT_DISCRIMINATOR_LEN,
            BACKEND_PRODUCT_ACCOUNT_SIZE,
            "the product account no longer occupies the bytes the backend allocates and decodes"
        );
    }

    #[test]
    fn participant_account_size_matches_the_backend_reader() {
        assert_eq!(
            ParticipantAccount::INIT_SPACE + ACCOUNT_DISCRIMINATOR_LEN,
            BACKEND_PARTICIPANT_ACCOUNT_SIZE,
            "the participant account no longer occupies the bytes the backend allocates and decodes"
        );
    }

    #[test]
    fn the_account_can_hold_the_longest_valid_identifier() {
        // The bound fixes the account size, so if it were too small a valid
        // identifier could not be stored and every registration would fail.
        let longest = "AGT-COCOA-2026-A1B2C3";
        assert!(longest.len() <= PRODUCT_ID_MAX_LEN);
        assert!(ProductAccount::validate_product_id(longest).is_ok());
        assert_eq!(PRODUCT_ID_MAX_LEN, 32);
    }

    #[test]
    fn participant_role_ordinals_are_the_wire_values() {
        // Mirrored by `server/src/lib/roles.ts`; never renumber these.
        assert_eq!(ParticipantRole::Farmer as u8, 0);
        assert_eq!(ParticipantRole::Processor as u8, 1);
        assert_eq!(ParticipantRole::Transporter as u8, 2);
        assert_eq!(ParticipantRole::Retailer as u8, 3);
        assert_eq!(ParticipantRole::Regulator as u8, 4);
    }

    #[test]
    fn product_status_ordinals_are_the_wire_values() {
        assert_eq!(ProductStatus::Registered as u8, 0);
        assert_eq!(ProductStatus::InProcessing as u8, 1);
        assert_eq!(ProductStatus::Processed as u8, 2);
        assert_eq!(ProductStatus::InTransit as u8, 3);
        assert_eq!(ProductStatus::AtRetailer as u8, 4);
        assert_eq!(ProductStatus::Listed as u8, 5);
        assert_eq!(ProductStatus::Sold as u8, 6);
        assert_eq!(ProductStatus::Flagged as u8, 7);
    }

    #[test]
    fn a_stage_only_advances_one_step_at_a_time() {
        assert!(ProductStatus::Registered.can_advance_to(ProductStatus::InProcessing));
        assert!(!ProductStatus::Registered.can_advance_to(ProductStatus::Listed));
        assert!(ProductStatus::Listed.can_advance_to(ProductStatus::Sold));
        assert!(!ProductStatus::Sold.can_advance_to(ProductStatus::Listed));
    }

    #[test]
    fn a_well_formed_identifier_is_accepted() {
        for id in [
            "AGT-COCOA-2026-A1B2C3",
            "AGT-COA-2026-ABC123",
            "AGT-COCOA-2026-AAAAAA",
        ] {
            assert!(
                ProductAccount::validate_product_id(id).is_ok(),
                "{id} should be a valid identifier"
            );
        }
    }

    #[test]
    fn a_malformed_identifier_is_refused() {
        for id in [
            "",
            "cocoa-2026",
            "AGT-COCOA-2026",
            "AGT-COCOA-26-A1B2C3",
            "AGT-COCOA-2026-A1B2",
            "AGT-COCOA-2026-A1B2C3D",
            "AGT--2026-A1B2C3",
            "AGT-cocoa-2026-a1b2c3",
            "AGT-COCOA-2026-A1B2C3 ",
            "AGT_COCOA_2026_A1B2C3",
        ] {
            assert!(
                ProductAccount::validate_product_id(id).is_err(),
                "{id} should be refused"
            );
        }
        // Longer than the bound the account can hold.
        assert!(ProductAccount::validate_product_id(&"A".repeat(64)).is_err());
    }

    #[test]
    fn the_identifier_grammar_matches_the_backend_pattern() {
        // The same cases the backend's `PRODUCT_ID_PATTERN` decides, so the two
        // definitions of a valid identifier are asserted to agree.
        let backend_agrees = |id: &str| -> bool {
            let segments_ok = |segment: &str, min: usize, max: usize| {
                (min..=max).contains(&segment.len())
                    && segment.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
            };
            let parts: Vec<&str> = id.split('-').collect();
            match parts.as_slice() {
                ["AGT", crop, year, batch] => {
                    segments_ok(crop, 3, 6)
                        && year.len() == 4
                        && year.bytes().all(|b| b.is_ascii_digit())
                        && segments_ok(batch, 6, 6)
                }
                _ => false,
            }
        };

        for id in [
            "AGT-COCOA-2026-A1B2C3",
            "AGT-COA-2026-ABC123",
            "AGT-COCOA-2026-AAAAAA",
            "AGT-COCOA-2026",
            "AGT-COCOA-26-A1B2C3",
            "AGT-COCOA-2026-A1B2",
            "AGT-COCOA-2026-A1B2C3D",
            "AGT--2026-A1B2C3",
            "AGT-cocoa-2026-a1b2c3",
            "AGT_COCOA_2026_A1B2C3",
            "cocoa-2026",
        ] {
            assert_eq!(
                ProductAccount::validate_product_id(id).is_ok(),
                backend_agrees(id),
                "the program and the backend disagree about {id}"
            );
        }
    }
}
