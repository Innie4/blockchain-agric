use anchor_lang::prelude::*;

pub mod state;

use state::*;

declare_id!("CTKBH9KnbTd8zL4sHNpj4CBPPQcHu2uZk613WpA1ZiDm");

/// Maximum distance a supplied event timestamp may sit ahead of cluster time.
/// Activity is recorded as it happens, so a small forward skew is tolerated
/// while forged future dates are rejected.
pub const MAX_TIMESTAMP_SKEW_SECONDS: i64 = 86_400;

#[program]
pub mod agri_trace {
    use super::*;

    /// Registers a wallet in the on-chain participant registry.
    ///
    /// A transfer recipient must already hold a registry account, so this
    /// instruction is the entry point for every new supply chain participant.
    pub fn register_participant(
        ctx: Context<RegisterParticipant>,
        role: ParticipantRole,
        profile_hash: [u8; DATA_HASH_LEN],
    ) -> Result<()> {
        let now = cluster_time()?;
        let registry = &mut ctx.accounts.participant_registry;
        // A freshly derived PDA holds a zeroed account. Requiring a zeroed
        // participant field turns a repeat call into a business-rule error
        // instead of an opaque constraint failure.
        require!(
            registry.participant == Pubkey::default(),
            AgriTraceError::ParticipantAlreadyRegistered
        );
        registry.version = 1;
        registry.bump = ctx.bumps.participant_registry;
        registry.participant = ctx.accounts.participant.key();
        registry.role = role;
        registry.registered_at = now;
        registry.profile_hash = profile_hash;
        registry.revoked = false;

        emit!(ParticipantRegisteredEvent {
            participant: registry.participant,
            role: registry.role,
            profile_hash: registry.profile_hash,
            registered_at: now,
        });
        Ok(())
    }

    /// Registers a new agricultural batch and creates its on-chain account.
    ///
    /// The account address is derived deterministically from `product_id`, so
    /// the backend never has to store a program-derived address and duplicate
    /// registration fails at the address-derivation step.
    pub fn register_product(
        ctx: Context<RegisterProduct>,
        product_id: String,
        off_chain_data_hash: [u8; DATA_HASH_LEN],
    ) -> Result<()> {
        ProductAccount::validate_product_id(&product_id)?;
        let registrant_role = ctx.accounts.registrant_registry.role;
        require!(
            matches!(
                registrant_role,
                ParticipantRole::Farmer | ParticipantRole::Regulator
            ),
            AgriTraceError::RegistrantRoleNotAllowed
        );

        let now = cluster_time()?;
        let registrant = ctx.accounts.registrant.key();
        let product = &mut ctx.accounts.product;
        product.version = 1;
        product.bump = ctx.bumps.product;
        product.flags = 0;
        product.status = ProductStatus::Registered;
        product.pre_flag_status = ProductStatus::Registered;
        product.product_id = product_id.clone();
        product.registrant = registrant;
        product.owner = registrant;
        product.registered_at = now;
        product.updated_at = now;
        product.last_transfer_at = 0;
        product.last_verified_at = 0;
        product.off_chain_data_hash = off_chain_data_hash;
        product.transfer_count = 0;

        emit!(ProductRegistered {
            product_id,
            product: product.key(),
            registrant,
            owner: registrant,
            status: ProductStatus::Registered,
            registered_at: now,
            off_chain_data_hash,
        });
        Ok(())
    }

    /// Transfers ownership of a batch to another registered participant.
    ///
    /// Ownership is enforced on-chain: the signer must be the current owner and
    /// the recipient must already exist in the participant registry. The
    /// recipient's category is read from that registry entry rather than taken
    /// from the caller, so the caller cannot misdeclare it.
    pub fn transfer_ownership(
        ctx: Context<TransferOwnership>,
        transfer_id: [u8; TRANSFER_ID_LEN],
    ) -> Result<()> {
        let owner_key = ctx.accounts.current_owner.key();
        let recipient_registry = &ctx.accounts.recipient_registry;
        let recipient = recipient_registry.participant;
        let recipient_role = recipient_registry.role;

        require!(!recipient_registry.revoked, AgriTraceError::InvalidRecipient);
        require!(
            matches!(
                recipient_role,
                ParticipantRole::Processor
                    | ParticipantRole::Transporter
                    | ParticipantRole::Retailer
            ),
            AgriTraceError::RecipientRoleNotAllowed
        );
        require!(recipient != owner_key, AgriTraceError::InvalidRecipient);

        let product = &mut ctx.accounts.product;
        require!(
            product.owner == owner_key,
            AgriTraceError::UnauthorizedOwner
        );
        require!(!product.status.is_flagged(), AgriTraceError::ProductFlagged);
        require!(!product.status.is_terminal(), AgriTraceError::ProductClosed);

        let previous_owner = product.owner;
        let now = cluster_time()?;
        product.owner = recipient;
        product.transfer_count = product.transfer_count.saturating_add(1);
        product.last_transfer_at = now;
        product.updated_at = now;
        // Handing a batch to a processor, transporter or retailer advances the
        // lifecycle so the on-chain status reflects where the batch now sits.
        product.status = match recipient_role {
            ParticipantRole::Processor => ProductStatus::InProcessing,
            ParticipantRole::Transporter => ProductStatus::InTransit,
            ParticipantRole::Retailer => ProductStatus::AtRetailer,
            _ => product.status,
        };

        emit!(OwnershipTransferred {
            product_id: product.product_id.clone(),
            product: product.key(),
            from: previous_owner,
            to: recipient,
            transfer_id,
            transfer_count: product.transfer_count,
            occurred_at: now,
        });
        Ok(())
    }

    /// Advances a batch through its lifecycle.
    ///
    /// Only the current owner may advance a batch. A regulator holding a
    /// registry entry may additionally withhold or release a batch.
    pub fn update_status(
        ctx: Context<UpdateProductStatus>,
        new_status: ProductStatus,
        occurred_at: i64,
    ) -> Result<()> {
        let now = cluster_time()?;
        let actor = ctx.accounts.actor.key();
        let is_regulator = ctx.accounts.actor_registry.role == ParticipantRole::Regulator
            && !ctx.accounts.actor_registry.revoked;

        let product = &mut ctx.accounts.product;
        let is_owner = product.owner == actor;
        require!(is_owner || is_regulator, AgriTraceError::UnauthorizedOwner);
        validate_event_time(product.registered_at, occurred_at, now)?;

        let previous_status = product.status;
        match (previous_status, new_status) {
            (ProductStatus::Flagged, ProductStatus::Flagged) => {
                return err!(AgriTraceError::InvalidStateTransition)
            }
            (ProductStatus::Flagged, _) => {
                require!(is_regulator, AgriTraceError::RegulatorOnly);
                let restored = product.pre_flag_status;
                require!(
                    restored == new_status || restored.can_advance_to(new_status),
                    AgriTraceError::InvalidStateTransition
                );
                product.status = new_status;
                product.pre_flag_status = new_status;
            }
            (_, ProductStatus::Flagged) => {
                require!(is_regulator, AgriTraceError::RegulatorOnly);
                require!(
                    !previous_status.is_terminal(),
                    AgriTraceError::ProductClosed
                );
                product.pre_flag_status = previous_status;
                product.status = ProductStatus::Flagged;
            }
            _ => {
                require!(is_owner, AgriTraceError::UnauthorizedOwner);
                require!(
                    !previous_status.is_flagged(),
                    AgriTraceError::ProductFlagged
                );
                require!(
                    !previous_status.is_terminal(),
                    AgriTraceError::ProductClosed
                );
                require!(
                    previous_status.can_advance_to(new_status),
                    AgriTraceError::InvalidStateTransition
                );
                product.status = new_status;
            }
        }

        product.updated_at = now;
        emit!(ProductStatusUpdated {
            product_id: product.product_id.clone(),
            product: product.key(),
            actor,
            previous_status,
            new_status: product.status,
            occurred_at: now,
        });
        Ok(())
    }

    /// Records a regulator's verification attestation for a batch.
    pub fn record_verification(
        ctx: Context<RecordVerification>,
        result: VerificationResult,
        verification_hash: [u8; DATA_HASH_LEN],
        occurred_at: i64,
    ) -> Result<()> {
        require!(
            ctx.accounts.verifier_registry.role == ParticipantRole::Regulator
                && !ctx.accounts.verifier_registry.revoked,
            AgriTraceError::RegulatorOnly
        );
        let now = cluster_time()?;
        let product = &mut ctx.accounts.product;
        validate_event_time(product.registered_at, occurred_at, now)?;
        product.last_verified_at = now;

        emit!(VerificationRecorded {
            product_id: product.product_id.clone(),
            product: product.key(),
            verifier: ctx.accounts.verifier.key(),
            result,
            verification_hash,
            occurred_at: now,
        });
        Ok(())
    }
}

/// Cluster time, used for every timestamp the protocol records itself.
fn cluster_time() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

/// Rejects event timestamps that are implausible relative to cluster time so a
/// participant cannot backdate or post-date a processing or transport event.
fn validate_event_time(registered_at: i64, occurred_at: i64, now: i64) -> Result<i64> {
    require!(now > 0, AgriTraceError::InvalidTimestamp);
    require!(
        occurred_at >= registered_at,
        AgriTraceError::InvalidTimestamp
    );
    require!(
        occurred_at <= now.saturating_add(MAX_TIMESTAMP_SKEW_SECONDS),
        AgriTraceError::InvalidTimestamp
    );
    Ok(now)
}

#[derive(Accounts)]
pub struct RegisterParticipant<'info> {
    #[account(mut)]
    pub participant: Signer<'info>,

    #[account(
        init_if_needed,
        payer = participant,
        space = ParticipantAccount::INIT_SPACE,
        seeds = [PARTICIPANT_SEED, participant.key().as_ref()],
        bump,
    )]
    pub participant_registry: Account<'info, ParticipantAccount>,

    /// The system program, which creates the account above.
    ///
    /// Declared as an address-checked `AccountInfo` rather than
    /// `Program<'info, System>`: in anchor-lang 0.30.1 the `Program` wrapper
    /// requires its type to implement `AccountDeserialize`, which `System` does
    /// not, so that spelling does not compile. Pinning the address is also the
    /// stronger check, because it is exactly the address that must be supplied.
    #[account(address = ::anchor_lang::system_program::ID)]
    pub system_program: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(product_id: String)]
pub struct RegisterProduct<'info> {
    #[account(mut)]
    pub registrant: Signer<'info>,

    /// The registering wallet's registry entry, so the program enforces
    /// registration without trusting any off-chain role claim.
    #[account(
        seeds = [PARTICIPANT_SEED, registrant.key().as_ref()],
        bump,
    )]
    pub registrant_registry: Account<'info, ParticipantAccount>,

    #[account(
        init,
        payer = registrant,
        space = ProductAccount::INIT_SPACE,
        seeds = [PRODUCT_SEED, product_id.as_bytes()],
        bump,
    )]
    pub product: Account<'info, ProductAccount>,

    /// The system program, which creates the account above. Address-checked;
    /// see the note on `RegisterParticipant::system_program`.
    #[account(address = ::anchor_lang::system_program::ID)]
    pub system_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct TransferOwnership<'info> {
    #[account(mut)]
    pub current_owner: Signer<'info>,

    #[account(
        mut,
        seeds = [PRODUCT_SEED, product.product_id.as_bytes()],
        bump = product.bump,
    )]
    pub product: Account<'info, ProductAccount>,

    /// Registry entry of the receiving participant. Its absence is how an
    /// unregistered recipient is rejected.
    pub recipient_registry: Account<'info, ParticipantAccount>,
}

#[derive(Accounts)]
pub struct UpdateProductStatus<'info> {
    #[account(mut)]
    pub actor: Signer<'info>,

    /// Registry entry of the acting wallet. Only consulted for regulator powers.
    pub actor_registry: Account<'info, ParticipantAccount>,

    #[account(
        mut,
        seeds = [PRODUCT_SEED, product.product_id.as_bytes()],
        bump = product.bump,
    )]
    pub product: Account<'info, ProductAccount>,
}

#[derive(Accounts)]
pub struct RecordVerification<'info> {
    #[account(mut)]
    pub verifier: Signer<'info>,

    pub verifier_registry: Account<'info, ParticipantAccount>,

    #[account(
        mut,
        seeds = [PRODUCT_SEED, product.product_id.as_bytes()],
        bump = product.bump,
    )]
    pub product: Account<'info, ProductAccount>,
}
