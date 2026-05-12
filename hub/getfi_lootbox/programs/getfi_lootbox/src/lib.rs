//! GetFi mystery-box lootbox program — V3.
//!
//! ## Why the on-chain rng is a commit-reveal hash, not a VRF
//!
//! Earlier revisions of this program relied on ORAO VRF for randomness. ORAO
//! v2 charges ~0.0022 SOL of permanently-locked rent per `request_v2`, with
//! no on-chain `close` instruction to recover it (verified against the
//! upstream `orao_vrf` program — its `#[program]` exposes only
//! `init_network`, `update_network`, `request`, `request_v2`, `fulfill`,
//! `fulfill_v2`). At our 0.000298 SOL/box gas-abstracted fee, a full 10-box
//! batch only nets +0.0008 SOL per draw, so single/triple-box opens go net
//! negative for the treasury.
//!
//! V3 replaces ORAO with a commit-reveal scheme. The roll algorithm is
//! deliberately kept simple and fully deterministic so anyone can audit the
//! published rewards by replaying it against the on-chain inputs:
//!
//!   1. Player generates `player_entropy: [u8; 32]` client-side using
//!      `crypto.getRandomValues`.
//!   2. Backend generates `backend_secret: [u8; 32]` and computes
//!      `backend_commitment = sha256(backend_secret)`.
//!   3. `request_lootbox_batch` stores both `player_entropy` and
//!      `backend_commitment` on-chain. The backend's Ed25519 signature over
//!      the request binds them; neither side can swap mid-flight.
//!   4. `consume_lootbox_batch` is called with the revealed `backend_seed`.
//!      The program verifies `sha256(backend_seed) == backend_commitment`,
//!      then derives:
//!         combined = sha256(player_entropy || backend_seed)
//!      and rolls each of the up-to-10 boxes independently:
//!         roll[i] = sha256(combined || "GETFI_LOOTBOX_BATCH_V1" || i)
//!         r[i]    = u32_le(roll[i][0..4]) % 1_000_000
//!         tier[i] = cumulative-weight pick over WEIGHTS_PPM
//!
//! ## Trust model
//!
//! * The commitment is binding under sha256 second-preimage resistance —
//!   once published on-chain, the backend cannot change `backend_secret`.
//! * The player's entropy is locked into the request before the backend
//!   reveals, so the backend cannot grind seeds *with knowledge of* the
//!   player's input at consume-time.
//! * A residual grinding window does exist: between receiving
//!   `player_entropy` and posting the request tx, the backend can compute
//!   many candidate `backend_secret` values and pick one that produces an
//!   unfavourable roll. Closing this window cleanly requires either a real
//!   VRF (e.g. Switchboard On-Demand) or binding the seed to a future slot
//!   that the backend cannot pre-image. We document the residual risk in
//!   the public docs and treat it as acceptable for the current launch
//!   given the loot-table EV; the audit log of (player_entropy,
//!   backend_commitment, backend_seed) on-chain lets any third party
//!   verify the rewards independently after the fact.
//!
//! Daily-cap (50 boxes / UTC day) and G-points escrow remain unchanged.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use anchor_lang::solana_program::{
    ed25519_program,
    hash::hash,
    sysvar::instructions::{
        load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_ID,
    },
};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self as spl_token, Mint, Token, TokenAccount, Transfer as SplTransfer};

declare_id!("Bm6zsJgc87Hj6gGEtpHtyjP89Lwuu7TequM6dgPL8LA7");

// ── Seeds & domain constants ─────────────────────────────────────────────────

const CONFIG_SEED: &[u8] = b"config";
const INVENTORY_SEED: &[u8] = b"inventory_v2";
const PLAYER_STATE_V3_SEED: &[u8] = b"player_state_v3";
const BATCH_REQUEST_SEED: &[u8] = b"lootbox_batch";
const BATCH_MESSAGE_DOMAIN: &[u8] = b"GETFI_LOOTBOX_BATCH_V1";

/// Reward token mint (decimals: 6). Source-of-truth lives in `Config.reward_mint`;
/// this constant is the build-time default for fresh deployments. See
/// `getfi_lootbox/MIGRATION.md` for the rotation playbook on already-deployed instances.
pub const REWARD_TOKEN_MINT: Pubkey = pubkey!("3rTrMpMPQ3Nj7ktRkBYcLmB5diqqhtcw348oq9Poq5Eo");
/// Treasury that receives the gas-abstraction fee (lamports).
pub const TREASURY_PUBKEY: Pubkey = pubkey!("A3TgoR4ArUEsQiuXLM9ikoE2wA8uQPFxEdGxnfGXFqxb");
/// Per-request gas-abstraction fee, in lamports (0.000298 SOL).
pub const LOOTBOX_FEE_LAMPORTS: u64 = 298_000;

/// Tier 1..=6 are scarce major prizes; Tier 7..=10 are the common pool.
/// Tier 7 is the "consolation" guaranteed when major inventory is empty
/// or the player has already won a major prize (anti-whale).
pub const NUM_TIERS: usize = 10;
pub const FALLBACK_TIER: u8 = 7;
pub const MAJOR_TIER_MAX: u8 = 6;
/// Sentinel used by the cascading-fallback walker. Equal to `NUM_TIERS + 1`.
pub const EXHAUSTED_SENTINEL: u8 = (NUM_TIERS as u8) + 1;
/// Maximum boxes a player can buy in a single `request_lootbox_batch` tx.
pub const MAX_BOXES_PER_BATCH: u8 = 10;
/// Hard daily cap per wallet (UTC day), enforced via PlayerStateV3.
pub const DAILY_BOX_LIMIT: u8 = 50;
/// Persisted slot count inside `LootboxBatchRequest.rewards`.
pub const REWARDS_SLOTS: usize = 10;
/// Seconds in a UTC day.
pub const SECONDS_PER_DAY: i64 = 86_400;

/// Reward amounts (raw units; mint has 0 decimals).
const REWARDS: [u64; NUM_TIERS] = [
    2_000_000, // Tier 1
    500_000,   // Tier 2
    100_000,   // Tier 3
    50_000,    // Tier 4
    10_000,    // Tier 5
    2_500,     // Tier 6
    500,       // Tier 7 (fallback)
    100,       // Tier 8
    50,        // Tier 9
    10,        // Tier 10
];

/// Loot table weights out of 1_000_000.
const WEIGHTS_PPM: [u32; NUM_TIERS] = [
    1,        // Tier 1  — 0.0001%
    5,        // Tier 2  — 0.0005%
    50,       // Tier 3  — 0.005%
    200,      // Tier 4  — 0.02%
    2_000,    // Tier 5  — 0.2%
    10_000,   // Tier 6  — 1%
    87_744,   // Tier 7  — ~8.77%
    300_000,  // Tier 8  — 30%
    300_000,  // Tier 9  — 30%
    300_000,  // Tier 10 — 30%
];

/// Initial stock for all 10 tiers. Total emission caps at 400M GET across
/// ~6.6M boxes. When every tier is empty `consume_*` aborts with
/// `InventoryExhausted` rather than minting infinite tokens.
const INITIAL_INVENTORY: [u32; NUM_TIERS] = [
    10,        // 2,000,000 GET each → 20M
    20,        //   500,000 GET each → 10M
    200,       //   100,000 GET each → 20M
    1_000,     //    50,000 GET each → 50M
    5_000,     //    10,000 GET each → 50M
    20_000,    //     2,500 GET each → 50M
    100_000,   //       500 GET each → 50M
    500_000,   //       100 GET each → 50M
    1_000_000, //        50 GET each → 50M
    5_000_000, //        10 GET each → 50M
];

#[program]
pub mod getfi_lootbox {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        backend_signer: Pubkey,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.reward_mint.key(),
            REWARD_TOKEN_MINT,
            GetfiError::InvalidRewardMint
        );
        let config = &mut ctx.accounts.config;
        config.owner = ctx.accounts.owner.key();
        config.backend_signer = backend_signer;
        config.reward_mint = ctx.accounts.reward_mint.key();
        config.treasury = TREASURY_PUBKEY;
        config.bump = ctx.bumps.config;

        let inventory = &mut ctx.accounts.inventory;
        inventory.remaining = INITIAL_INVENTORY;
        inventory.bump = ctx.bumps.inventory;
        Ok(())
    }

    pub fn update_backend_signer(
        ctx: Context<AdminConfig>,
        backend_signer: Pubkey,
    ) -> Result<()> {
        ctx.accounts.config.backend_signer = backend_signer;
        Ok(())
    }

    /// One-shot admin migration helper; init's the v2 inventory PDA when
    /// `Config` is already on-chain.
    pub fn initialize_inventory_v2(ctx: Context<InitializeInventoryV2>) -> Result<()> {
        let inventory = &mut ctx.accounts.inventory;
        inventory.remaining = INITIAL_INVENTORY;
        inventory.bump = ctx.bumps.inventory;
        Ok(())
    }

    /// Admin escape hatch: tear the inventory_v2 PDA down so it can be
    /// re-initialized from scratch. UncheckedAccount on purpose so a stale
    /// layout does not lock us out (see commit-reveal docs above).
    pub fn close_inventory_v2(ctx: Context<CloseInventoryV2>) -> Result<()> {
        let inv = &ctx.accounts.inventory;
        let owner = &ctx.accounts.owner;
        let lamports = inv.lamports();
        **inv.try_borrow_mut_lamports()? = 0;
        **owner.try_borrow_mut_lamports()? = owner
            .lamports()
            .checked_add(lamports)
            .ok_or(error!(GetfiError::InventoryUnderflow))?;
        let mut data = inv.try_borrow_mut_data()?;
        for byte in data.iter_mut() {
            *byte = 0;
        }
        Ok(())
    }

    /// Admin restock for any tier (1..=10).
    pub fn restock_tier(ctx: Context<AdminConfig>, tier: u8, amount: u32) -> Result<()> {
        require!(
            (1..=NUM_TIERS as u8).contains(&tier),
            GetfiError::InvalidBoxTier
        );
        let inv = &mut ctx.accounts.inventory;
        inv.remaining[(tier - 1) as usize] =
            inv.remaining[(tier - 1) as usize].saturating_add(amount);
        Ok(())
    }

    /// Open up to MAX_BOXES_PER_BATCH boxes in a single tx. Player + backend
    /// co-sign; backend is feePayer + rent payer so the player's only
    /// outflow is `box_count * LOOTBOX_FEE_LAMPORTS` to TREASURY.
    ///
    /// Stores both halves of the commit-reveal (`player_entropy` +
    /// `backend_commitment`) in the LootboxBatchRequest PDA. The actual
    /// dice are rolled in `consume_lootbox_batch` after the backend
    /// reveals its secret.
    pub fn request_lootbox_batch(
        ctx: Context<RequestLootboxBatch>,
        box_count: u8,
        nonce: [u8; 32],
        player_entropy: [u8; 32],
        backend_commitment: [u8; 32],
        expires_at: i64,
        signature: [u8; 64],
    ) -> Result<()> {
        require!(
            box_count >= 1 && box_count <= MAX_BOXES_PER_BATCH,
            GetfiError::InvalidBoxCount
        );
        let now = Clock::get()?.unix_timestamp;
        require!(now <= expires_at, GetfiError::SignatureExpired);
        require_keys_eq!(
            ctx.accounts.instructions.key(),
            INSTRUCTIONS_ID,
            GetfiError::InvalidInstructionsSysvar
        );
        require_keys_eq!(
            ctx.accounts.treasury.key(),
            TREASURY_PUBKEY,
            GetfiError::InvalidTreasury
        );
        require_keys_eq!(
            ctx.accounts.backend_signer.key(),
            ctx.accounts.config.backend_signer,
            GetfiError::InvalidBackendSigner
        );

        // Backend Ed25519 authorization binds player_entropy + commitment
        // so neither party can swap them after the request lands.
        let message = build_batch_message(&BatchMessage {
            config: ctx.accounts.config.key(),
            player: ctx.accounts.player.key(),
            reward_mint: ctx.accounts.config.reward_mint,
            box_count,
            nonce,
            player_entropy,
            backend_commitment,
            expires_at,
        });
        verify_previous_ed25519_ix(
            &ctx.accounts.instructions,
            &ctx.accounts.config.backend_signer,
            &message,
            &signature,
        )?;

        // ── Daily-cap reservation (escrow, released by cancel/consume) ──
        let today = (now / SECONDS_PER_DAY) as u32;
        let ps = &mut ctx.accounts.player_state;
        if ps.bump == 0 {
            ps.player = ctx.accounts.player.key();
            ps.has_won_major_prize = false;
            ps.current_day_utc = today;
            ps.boxes_consumed_today = 0;
            ps.boxes_reserved_today = 0;
            ps.bump = ctx.bumps.player_state;
        }
        if ps.current_day_utc != today {
            ps.current_day_utc = today;
            ps.boxes_consumed_today = 0;
            ps.boxes_reserved_today = 0;
        }
        let pending = ps
            .boxes_consumed_today
            .checked_add(ps.boxes_reserved_today)
            .ok_or(error!(GetfiError::DailyLimitExceeded))?;
        let projected = pending
            .checked_add(box_count)
            .ok_or(error!(GetfiError::DailyLimitExceeded))?;
        require!(projected <= DAILY_BOX_LIMIT, GetfiError::DailyLimitExceeded);
        ps.boxes_reserved_today = ps
            .boxes_reserved_today
            .checked_add(box_count)
            .ok_or(error!(GetfiError::DailyLimitExceeded))?;

        // ── Treasury fee CPI: player → treasury ─────────────────────────
        let total_fee = LOOTBOX_FEE_LAMPORTS
            .checked_mul(box_count as u64)
            .ok_or(error!(GetfiError::ArithmeticOverflow))?;
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.player.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            total_fee,
        )?;

        // Persist batch state.
        let batch = &mut ctx.accounts.lootbox_batch;
        batch.player = ctx.accounts.player.key();
        batch.nonce = nonce;
        batch.player_entropy = player_entropy;
        batch.backend_commitment = backend_commitment;
        batch.box_count = box_count;
        batch.consumed = false;
        batch.rewards = [BoxReward::default(); REWARDS_SLOTS];
        batch.total_amount = 0;
        batch.bump = ctx.bumps.lootbox_batch;
        Ok(())
    }

    /// Reveal-and-roll. Backend supplies the preimage of the commitment it
    /// posted in `request_lootbox_batch`; the program verifies the hash,
    /// derives the per-box rolls, transfers rewards, and updates the daily
    /// counter. PDA stays open so the frontend can read the rewards array;
    /// the off-chain crank closes it via `cancel_lootbox_batch` to recover
    /// rent.
    pub fn consume_lootbox_batch(
        ctx: Context<ConsumeLootboxBatch>,
        backend_seed: [u8; 32],
    ) -> Result<()> {
        require!(
            !ctx.accounts.lootbox_batch.consumed,
            GetfiError::AlreadyConsumed
        );
        require_keys_eq!(
            ctx.accounts.lootbox_batch.player,
            ctx.accounts.player.key(),
            GetfiError::InvalidPlayer
        );
        require_keys_eq!(
            ctx.accounts.backend_signer.key(),
            ctx.accounts.config.backend_signer,
            GetfiError::InvalidBackendSigner
        );
        require_keys_eq!(
            ctx.accounts.reward_mint.key(),
            ctx.accounts.config.reward_mint,
            GetfiError::InvalidRewardMint
        );

        // Verify reveal: sha256(backend_seed) must equal the on-chain commitment.
        let computed = hash(&backend_seed).to_bytes();
        require!(
            computed == ctx.accounts.lootbox_batch.backend_commitment,
            GetfiError::InvalidBackendCommitment
        );

        // combined = sha256(player_entropy || backend_seed)
        let mut combined_buf = [0u8; 64];
        combined_buf[..32].copy_from_slice(&ctx.accounts.lootbox_batch.player_entropy);
        combined_buf[32..].copy_from_slice(&backend_seed);
        let combined = hash(&combined_buf).to_bytes();

        let box_count = ctx.accounts.lootbox_batch.box_count;
        require!(
            box_count >= 1 && box_count <= MAX_BOXES_PER_BATCH,
            GetfiError::InvalidBoxCount
        );

        let mut total_amount: u64 = 0;
        let mut won_major_in_batch = false;
        let starting_has_won = ctx.accounts.player_state.has_won_major_prize;
        for i in 0..box_count {
            // roll[i] = sha256(combined || domain || i)
            let mut buf = [0u8; 32 + BATCH_MESSAGE_DOMAIN.len() + 1];
            buf[..32].copy_from_slice(&combined);
            buf[32..32 + BATCH_MESSAGE_DOMAIN.len()].copy_from_slice(BATCH_MESSAGE_DOMAIN);
            buf[32 + BATCH_MESSAGE_DOMAIN.len()] = i;
            let h = hash(&buf).to_bytes();
            let r = u32::from_le_bytes([h[0], h[1], h[2], h[3]]) % 1_000_000;
            let rolled = roll_tier_from_u32(r);
            let already_major = starting_has_won || won_major_in_batch;
            let tier = resolve_tier_with_inventory(
                rolled,
                &mut ctx.accounts.inventory.remaining,
                already_major,
            )?;
            if tier <= MAJOR_TIER_MAX {
                won_major_in_batch = true;
            }
            let amount = REWARDS[(tier - 1) as usize];
            total_amount = total_amount
                .checked_add(amount)
                .ok_or(error!(GetfiError::ArithmeticOverflow))?;
            ctx.accounts.lootbox_batch.rewards[i as usize] = BoxReward { tier, amount };
        }

        if won_major_in_batch {
            ctx.accounts.player_state.has_won_major_prize = true;
        }

        // Promote daily reservation → consumed (only on success).
        let now = Clock::get()?.unix_timestamp;
        let today = (now / SECONDS_PER_DAY) as u32;
        let ps = &mut ctx.accounts.player_state;
        if ps.current_day_utc != today {
            ps.current_day_utc = today;
            ps.boxes_consumed_today = 0;
            ps.boxes_reserved_today = 0;
        }
        ps.boxes_reserved_today = ps.boxes_reserved_today.saturating_sub(box_count);
        ps.boxes_consumed_today = ps
            .boxes_consumed_today
            .checked_add(box_count)
            .ok_or(error!(GetfiError::ArithmeticOverflow))?;

        // Single SPL transfer for the whole batch.
        let bump = ctx.accounts.config.bump;
        let signer_seeds: &[&[u8]] = &[CONFIG_SEED, &[bump]];
        let binding = [signer_seeds];
        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SplTransfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.player_token_account.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            &binding,
        );
        spl_token::transfer(cpi, total_amount)?;

        let batch = &mut ctx.accounts.lootbox_batch;
        batch.consumed = true;
        batch.total_amount = total_amount;

        emit!(LootboxBatchRevealed {
            player: ctx.accounts.player.key(),
            box_count,
            total_amount,
        });
        Ok(())
    }

    /// Close a LootboxBatchRequest and refund its rent to backend_signer.
    /// Two callers (off-chain crank): post-consume cleanup, and abandoned-
    /// batch cleanup. Only releases the daily-cap reservation when the
    /// batch was *not* consumed (consumed batches already promoted their
    /// reservation in `consume_lootbox_batch`).
    pub fn cancel_lootbox_batch(ctx: Context<CancelLootboxBatch>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.backend_signer.key(),
            ctx.accounts.config.backend_signer,
            GetfiError::InvalidBackendSigner
        );
        if !ctx.accounts.lootbox_batch.consumed {
            let ps = &mut ctx.accounts.player_state;
            let cancelled = ctx.accounts.lootbox_batch.box_count;
            let now = Clock::get()?.unix_timestamp;
            let today = (now / SECONDS_PER_DAY) as u32;
            if ps.current_day_utc == today {
                ps.boxes_reserved_today =
                    ps.boxes_reserved_today.saturating_sub(cancelled);
            }
        }
        Ok(())
    }

    // ── Phase 3 — Agent delegation + FuelVault ──────────────────────────────

    /// User authorizes a specific agent (e.g. RaiderBot's per-user hot
    /// wallet) to call `open_box_as_agent` on their behalf for a bounded
    /// time window. The agent never gains custody of GET or SOL beyond
    /// the FuelVault outflows defined by this program.
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        agent_pubkey: Pubkey,
        allowed_actions: u32,
        expiry_ts: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(expiry_ts > now, GetfiError::AgentInvalidExpiry);
        require!(
            expiry_ts.saturating_sub(now) <= AGENT_MAX_DURATION_SECONDS,
            GetfiError::AgentInvalidExpiry,
        );
        let known_mask = AGENT_ACTION_OPEN_BOX;
        require!(
            allowed_actions != 0 && (allowed_actions & !known_mask) == 0,
            GetfiError::AgentInvalidActions,
        );

        let auth = &mut ctx.accounts.agent_authority;
        auth.user = ctx.accounts.user.key();
        auth.agent_pubkey = agent_pubkey;
        auth.allowed_actions = allowed_actions;
        auth.expiry_ts = expiry_ts;
        auth.nonce_counter = 0;
        auth.revoked = false;
        auth.bump = ctx.bumps.agent_authority;

        emit!(AgentRegistered {
            user: auth.user,
            agent: agent_pubkey,
            allowed_actions,
            expiry_ts,
        });
        Ok(())
    }

    /// Revoke an agent. Either party may sign:
    ///   - the user (kicking the bot out — the normal "Revoke agent" flow)
    ///   - the agent itself (bot self-resigning, e.g. on /resign)
    /// Sets `revoked = true`. The FuelVault drain is a separate
    /// `withdraw_fuel` ix; clients should bundle both into one tx so
    /// /istifa is atomic from the user's perspective.
    pub fn revoke_agent(ctx: Context<RevokeAgent>) -> Result<()> {
        let auth = &mut ctx.accounts.agent_authority;
        let signer = ctx.accounts.authority.key();
        require!(
            signer == auth.user || signer == auth.agent_pubkey,
            GetfiError::AgentAuthorityMismatch,
        );
        auth.revoked = true;

        emit!(AgentRevocation {
            user: auth.user,
            agent: auth.agent_pubkey,
            revoked_by: signer,
        });
        Ok(())
    }

    /// Top up the user's FuelVault with SOL. From this point on the SOL
    /// physically lives in the FuelVault PDA (a SystemAccount, no data,
    /// no rent lock) — the agent cannot touch it; only this program can,
    /// and only via the two narrow paths in `open_box_as_agent` and
    /// `withdraw_fuel`.
    pub fn deposit_fuel(ctx: Context<DepositFuel>, lamports: u64) -> Result<()> {
        require!(lamports > 0, GetfiError::FuelInsufficient);
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.fuel_vault.to_account_info(),
                },
            ),
            lamports,
        )?;
        Ok(())
    }

    /// Withdraw SOL from the FuelVault back to the user.
    /// `amount = None` drains the vault to zero — used by /resign.
    /// Either the user or the registered agent may sign, but the
    /// destination is *always* `agent_authority.user`. This is the
    /// on-chain enforcement of "the agent cannot touch your money" —
    /// the agent can only ever push fuel back to its delegator, never
    /// to itself or any third party.
    pub fn withdraw_fuel(ctx: Context<WithdrawFuel>, amount: Option<u64>) -> Result<()> {
        let auth = &ctx.accounts.agent_authority;
        let signer = ctx.accounts.authority.key();
        require!(
            signer == auth.user || signer == auth.agent_pubkey,
            GetfiError::AgentAuthorityMismatch,
        );
        require_keys_eq!(
            ctx.accounts.user.key(),
            auth.user,
            GetfiError::AgentAuthorityMismatch,
        );

        let vault_balance = ctx.accounts.fuel_vault.lamports();
        let to_send = match amount {
            None => vault_balance,
            Some(x) => {
                require!(x <= vault_balance, GetfiError::FuelWithdrawTooLarge);
                x
            }
        };
        require!(to_send > 0, GetfiError::FuelInsufficient);

        let user_key = auth.user;
        let bump = ctx.bumps.fuel_vault;
        let signer_seeds: &[&[u8]] = &[FUEL_SEED, user_key.as_ref(), &[bump]];
        let binding = [signer_seeds];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.fuel_vault.to_account_info(),
                    to: ctx.accounts.user.to_account_info(),
                },
                &binding,
            ),
            to_send,
        )?;
        Ok(())
    }

    /// Single-tx merge of `request_lootbox_batch + consume_lootbox_batch`
    /// for the autonomous-agent flow. The agent signs the on-chain tx;
    /// the backend signs the ed25519 message that binds
    /// (player_entropy, backend_commitment, nonce_counter); the program
    /// verifies the reveal in the same tx (no separate consume needed).
    ///
    /// Cost flow — all paid out of the FuelVault, the user pays nothing
    /// in this tx:
    ///   - `LOOTBOX_FEE_LAMPORTS * box_count`  → TREASURY
    ///   - `AGENT_TX_FEE_REIMBURSEMENT`        → agent (covers tx fee)
    ///
    /// GET rewards always go straight to the user's ATA, never to the
    /// agent. The PlayerStateV3 daily-cap counter is intentionally NOT
    /// touched here — agent box opens are rate-limited off-chain by
    /// the bot's 3-day cadence. We do read/update `has_won_major_prize`
    /// so anti-whale logic stays consistent with the user-facing flow.
    pub fn open_box_as_agent(
        ctx: Context<OpenBoxAsAgent>,
        box_count: u8,
        nonce_counter: u64,
        player_entropy: [u8; 32],
        backend_commitment: [u8; 32],
        backend_seed: [u8; 32],
        expires_at: i64,
        signature: [u8; 64],
    ) -> Result<()> {
        require!(
            box_count >= 1 && box_count <= MAX_BOXES_PER_BATCH,
            GetfiError::InvalidBoxCount,
        );
        let now = Clock::get()?.unix_timestamp;
        require!(now <= expires_at, GetfiError::SignatureExpired);

        require_keys_eq!(
            ctx.accounts.instructions.key(),
            INSTRUCTIONS_ID,
            GetfiError::InvalidInstructionsSysvar,
        );
        require_keys_eq!(
            ctx.accounts.treasury.key(),
            TREASURY_PUBKEY,
            GetfiError::InvalidTreasury,
        );
        require_keys_eq!(
            ctx.accounts.backend_signer.key(),
            ctx.accounts.config.backend_signer,
            GetfiError::InvalidBackendSigner,
        );

        // ── Agent delegation checks ─────────────────────────────────────
        {
            let auth = &ctx.accounts.agent_authority;
            require!(!auth.revoked, GetfiError::AgentIsRevoked);
            require!(now < auth.expiry_ts, GetfiError::AgentExpired);
            require_keys_eq!(
                auth.user,
                ctx.accounts.user.key(),
                GetfiError::AgentAuthorityMismatch,
            );
            require_keys_eq!(
                auth.agent_pubkey,
                ctx.accounts.agent.key(),
                GetfiError::AgentPubkeyMismatch,
            );
            require!(
                auth.allowed_actions & AGENT_ACTION_OPEN_BOX != 0,
                GetfiError::AgentActionNotAllowed,
            );
            require!(
                nonce_counter == auth.nonce_counter,
                GetfiError::AgentNonceMismatch,
            );
        }

        // ── Verify backend ed25519 over the bound message ───────────────
        let message = build_agent_message(&AgentBoxMessage {
            config: ctx.accounts.config.key(),
            user: ctx.accounts.user.key(),
            agent: ctx.accounts.agent.key(),
            reward_mint: ctx.accounts.config.reward_mint,
            box_count,
            nonce_counter,
            player_entropy,
            backend_commitment,
            expires_at,
        });
        verify_previous_ed25519_ix(
            &ctx.accounts.instructions,
            &ctx.accounts.config.backend_signer,
            &message,
            &signature,
        )?;

        // ── Reveal: sha256(backend_seed) must match the commitment ──────
        let computed = hash(&backend_seed).to_bytes();
        require!(
            computed == backend_commitment,
            GetfiError::InvalidBackendCommitment,
        );

        // ── Pre-flight FuelVault sufficiency ────────────────────────────
        let treasury_fee = LOOTBOX_FEE_LAMPORTS
            .checked_mul(box_count as u64)
            .ok_or(error!(GetfiError::ArithmeticOverflow))?;
        let total_outflow = treasury_fee
            .checked_add(AGENT_TX_FEE_REIMBURSEMENT)
            .ok_or(error!(GetfiError::ArithmeticOverflow))?;
        require!(
            ctx.accounts.fuel_vault.lamports() >= total_outflow,
            GetfiError::FuelInsufficient,
        );

        // ── Roll: combined = sha256(player_entropy || backend_seed) ─────
        let mut combined_buf = [0u8; 64];
        combined_buf[..32].copy_from_slice(&player_entropy);
        combined_buf[32..].copy_from_slice(&backend_seed);
        let combined = hash(&combined_buf).to_bytes();

        // PlayerStateV3 is read for `has_won_major_prize` only (anti-whale).
        // Init if first-ever interaction; do NOT touch the daily counters
        // — agent flow is exempt by design (cap enforced off-chain).
        let ps = &mut ctx.accounts.player_state;
        if ps.bump == 0 {
            ps.player = ctx.accounts.user.key();
            ps.has_won_major_prize = false;
            ps.current_day_utc = (now / SECONDS_PER_DAY) as u32;
            ps.boxes_consumed_today = 0;
            ps.boxes_reserved_today = 0;
            ps.bump = ctx.bumps.player_state;
        }

        let mut total_amount: u64 = 0;
        let mut won_major_in_batch = false;
        let starting_has_won = ps.has_won_major_prize;
        // Per-roll hash uses the original BATCH_MESSAGE_DOMAIN so the
        // dice-rolling math stays bit-identical to the user-facing flow.
        for i in 0..box_count {
            let mut buf = [0u8; 32 + BATCH_MESSAGE_DOMAIN.len() + 1];
            buf[..32].copy_from_slice(&combined);
            buf[32..32 + BATCH_MESSAGE_DOMAIN.len()].copy_from_slice(BATCH_MESSAGE_DOMAIN);
            buf[32 + BATCH_MESSAGE_DOMAIN.len()] = i;
            let h = hash(&buf).to_bytes();
            let r = u32::from_le_bytes([h[0], h[1], h[2], h[3]]) % 1_000_000;
            let rolled = roll_tier_from_u32(r);
            let already_major = starting_has_won || won_major_in_batch;
            let tier = resolve_tier_with_inventory(
                rolled,
                &mut ctx.accounts.inventory.remaining,
                already_major,
            )?;
            if tier <= MAJOR_TIER_MAX {
                won_major_in_batch = true;
            }
            let amount = REWARDS[(tier - 1) as usize];
            total_amount = total_amount
                .checked_add(amount)
                .ok_or(error!(GetfiError::ArithmeticOverflow))?;
        }
        if won_major_in_batch {
            ps.has_won_major_prize = true;
        }

        // ── FuelVault → TREASURY (gas-abstraction fee) ──────────────────
        let user_key = ctx.accounts.user.key();
        let fuel_bump = ctx.bumps.fuel_vault;
        let fuel_seeds: &[&[u8]] = &[FUEL_SEED, user_key.as_ref(), &[fuel_bump]];
        let fuel_binding = [fuel_seeds];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.fuel_vault.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
                &fuel_binding,
            ),
            treasury_fee,
        )?;

        // ── FuelVault → agent (tx-fee reimbursement) ────────────────────
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.fuel_vault.to_account_info(),
                    to: ctx.accounts.agent.to_account_info(),
                },
                &fuel_binding,
            ),
            AGENT_TX_FEE_REIMBURSEMENT,
        )?;

        // ── GET vault → user ATA (single SPL transfer) ──────────────────
        let cfg_bump = ctx.accounts.config.bump;
        let cfg_seeds: &[&[u8]] = &[CONFIG_SEED, &[cfg_bump]];
        let cfg_binding = [cfg_seeds];
        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SplTransfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            &cfg_binding,
        );
        spl_token::transfer(cpi, total_amount)?;

        // ── Bump replay counter so this exact (nonce, signature) pair
        //     can never re-enter the program ───────────────────────────
        let auth = &mut ctx.accounts.agent_authority;
        auth.nonce_counter = auth
            .nonce_counter
            .checked_add(1)
            .ok_or(error!(GetfiError::ArithmeticOverflow))?;

        emit!(AgentBoxOpened {
            user: user_key,
            agent: ctx.accounts.agent.key(),
            box_count,
            total_amount,
            fuel_remaining: ctx.accounts.fuel_vault.lamports(),
        });
        Ok(())
    }
}

// ── Account contexts ─────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + Config::SIZE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = owner,
        space = 8 + GlobalInventory::SIZE,
        seeds = [INVENTORY_SEED],
        bump
    )]
    pub inventory: Account<'info, GlobalInventory>,
    pub reward_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeInventoryV2<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = owner)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = owner,
        space = 8 + GlobalInventory::SIZE,
        seeds = [INVENTORY_SEED],
        bump
    )]
    pub inventory: Account<'info, GlobalInventory>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseInventoryV2<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = owner)]
    pub config: Account<'info, Config>,
    /// CHECK: drained + zeroed by hand inside the instruction body.
    #[account(mut, seeds = [INVENTORY_SEED], bump)]
    pub inventory: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = owner)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [INVENTORY_SEED], bump = inventory.bump)]
    pub inventory: Account<'info, GlobalInventory>,
}

#[derive(Accounts)]
#[instruction(box_count: u8, nonce: [u8; 32])]
pub struct RequestLootboxBatch<'info> {
    /// Backend hot wallet — pays network fees + rent + co-signs the tx.
    #[account(mut)]
    pub backend_signer: Signer<'info>,
    /// Player — signs to authorize the SystemProgram.transfer to TREASURY.
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init,
        payer = backend_signer,
        space = 8 + LootboxBatchRequest::SIZE,
        seeds = [BATCH_REQUEST_SEED, player.key().as_ref(), &nonce],
        bump,
    )]
    pub lootbox_batch: Box<Account<'info, LootboxBatchRequest>>,
    #[account(
        init_if_needed,
        payer = backend_signer,
        space = 8 + PlayerStateV3::SIZE,
        seeds = [PLAYER_STATE_V3_SEED, player.key().as_ref()],
        bump,
    )]
    pub player_state: Box<Account<'info, PlayerStateV3>>,
    /// CHECK: enforced equal to TREASURY_PUBKEY.
    #[account(mut)]
    pub treasury: AccountInfo<'info>,
    /// CHECK: must be the instructions sysvar (used for ed25519 verify).
    pub instructions: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ConsumeLootboxBatch<'info> {
    #[account(mut)]
    pub backend_signer: Signer<'info>,
    /// CHECK: enforced equal to lootbox_batch.player.
    pub player: AccountInfo<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.reward_mint == reward_mint.key() @ GetfiError::InvalidRewardMint,
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [INVENTORY_SEED], bump = inventory.bump)]
    pub inventory: Box<Account<'info, GlobalInventory>>,
    #[account(
        mut,
        seeds = [PLAYER_STATE_V3_SEED, player.key().as_ref()],
        bump = player_state.bump,
    )]
    pub player_state: Box<Account<'info, PlayerStateV3>>,
    #[account(
        mut,
        seeds = [BATCH_REQUEST_SEED, player.key().as_ref(), &lootbox_batch.nonce],
        bump = lootbox_batch.bump,
    )]
    pub lootbox_batch: Box<Account<'info, LootboxBatchRequest>>,
    #[account(address = config.reward_mint)]
    pub reward_mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = reward_mint,
        associated_token::authority = config,
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = backend_signer,
        associated_token::mint = reward_mint,
        associated_token::authority = player,
    )]
    pub player_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CancelLootboxBatch<'info> {
    #[account(mut)]
    pub backend_signer: Signer<'info>,
    /// CHECK: enforced equal to lootbox_batch.player.
    pub player: AccountInfo<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [PLAYER_STATE_V3_SEED, player.key().as_ref()],
        bump = player_state.bump,
    )]
    pub player_state: Box<Account<'info, PlayerStateV3>>,
    #[account(
        mut,
        seeds = [BATCH_REQUEST_SEED, player.key().as_ref(), &lootbox_batch.nonce],
        bump = lootbox_batch.bump,
        close = backend_signer,
        constraint = lootbox_batch.player == player.key() @ GetfiError::InvalidPlayer,
    )]
    pub lootbox_batch: Box<Account<'info, LootboxBatchRequest>>,
}

// ── State accounts ───────────────────────────────────────────────────────────

#[account]
pub struct Config {
    pub owner: Pubkey,
    pub backend_signer: Pubkey,
    pub reward_mint: Pubkey,
    pub treasury: Pubkey,
    pub bump: u8,
}
impl Config {
    pub const SIZE: usize = 32 + 32 + 32 + 32 + 1;
}

#[account]
pub struct GlobalInventory {
    pub remaining: [u32; NUM_TIERS],
    pub bump: u8,
}
impl GlobalInventory {
    pub const SIZE: usize = 4 * NUM_TIERS + 1;
}

#[account]
#[derive(Default)]
pub struct PlayerStateV3 {
    pub player: Pubkey,
    pub has_won_major_prize: bool,
    pub current_day_utc: u32,
    pub boxes_consumed_today: u8,
    pub boxes_reserved_today: u8,
    pub bump: u8,
}
impl PlayerStateV3 {
    pub const SIZE: usize = 32 + 1 + 4 + 1 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct BoxReward {
    pub tier: u8,
    pub amount: u64,
}
impl BoxReward {
    pub const SIZE: usize = 1 + 8;
}

#[account]
pub struct LootboxBatchRequest {
    pub player: Pubkey,
    pub nonce: [u8; 32],
    /// Player-supplied entropy (32 bytes from `crypto.getRandomValues`).
    pub player_entropy: [u8; 32],
    /// `sha256(backend_secret)` — backend cannot change `backend_secret`
    /// after the request lands.
    pub backend_commitment: [u8; 32],
    pub box_count: u8,
    pub consumed: bool,
    pub total_amount: u64,
    pub rewards: [BoxReward; REWARDS_SLOTS],
    pub bump: u8,
}
impl LootboxBatchRequest {
    pub const SIZE: usize = 32  // player
        + 32                    // nonce
        + 32                    // player_entropy
        + 32                    // backend_commitment
        + 1                     // box_count
        + 1                     // consumed
        + 8                     // total_amount
        + REWARDS_SLOTS * BoxReward::SIZE
        + 1; // bump
}

#[event]
pub struct LootboxBatchRevealed {
    pub player: Pubkey,
    pub box_count: u8,
    pub total_amount: u64,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

struct BatchMessage {
    config: Pubkey,
    player: Pubkey,
    reward_mint: Pubkey,
    box_count: u8,
    nonce: [u8; 32],
    player_entropy: [u8; 32],
    backend_commitment: [u8; 32],
    expires_at: i64,
}

fn build_batch_message(message: &BatchMessage) -> Vec<u8> {
    let mut out = Vec::with_capacity(
        BATCH_MESSAGE_DOMAIN.len() + 32 * 3 + 1 + 32 * 3 + 8,
    );
    out.extend_from_slice(BATCH_MESSAGE_DOMAIN);
    out.extend_from_slice(message.config.as_ref());
    out.extend_from_slice(message.player.as_ref());
    out.extend_from_slice(message.reward_mint.as_ref());
    out.push(message.box_count);
    out.extend_from_slice(&message.nonce);
    out.extend_from_slice(&message.player_entropy);
    out.extend_from_slice(&message.backend_commitment);
    out.extend_from_slice(&message.expires_at.to_le_bytes());
    out
}

fn roll_tier_from_u32(r_mod_1m: u32) -> u8 {
    let mut acc: u32 = 0;
    for (i, w) in WEIGHTS_PPM.iter().enumerate() {
        acc = acc.saturating_add(*w);
        if r_mod_1m < acc {
            return (i as u8) + 1;
        }
    }
    NUM_TIERS as u8
}

/// Anti-whale + cascading-fallback walker. Returns the resolved tier
/// (1..=10) and decrements its inventory slot. Aborts with
/// `InventoryExhausted` if every slot is empty.
fn resolve_tier_with_inventory(
    rolled: u8,
    inventory: &mut [u32; NUM_TIERS],
    has_won_major: bool,
) -> Result<u8> {
    let mut tier = if rolled <= MAJOR_TIER_MAX && has_won_major {
        FALLBACK_TIER
    } else {
        rolled
    };
    while tier <= NUM_TIERS as u8 && inventory[(tier - 1) as usize] == 0 {
        tier += 1;
    }
    require!(tier < EXHAUSTED_SENTINEL, GetfiError::InventoryExhausted);
    let idx = (tier - 1) as usize;
    inventory[idx] = inventory[idx]
        .checked_sub(1)
        .ok_or(error!(GetfiError::InventoryUnderflow))?;
    Ok(tier)
}

fn verify_previous_ed25519_ix(
    instructions: &AccountInfo,
    signer: &Pubkey,
    message: &[u8],
    signature: &[u8; 64],
) -> Result<()> {
    let current_index = load_current_index_checked(instructions)? as usize;
    require!(current_index > 0, GetfiError::MissingSignatureInstruction);
    let ix = load_instruction_at_checked(current_index - 1, instructions)?;
    require_keys_eq!(
        ix.program_id,
        ed25519_program::ID,
        GetfiError::InvalidSignatureInstruction
    );
    require!(ix.data.len() >= 16, GetfiError::InvalidSignatureInstruction);
    require!(ix.data[0] == 1, GetfiError::InvalidSignatureInstruction);

    let signature_offset = read_u16(&ix.data, 2)? as usize;
    let signature_instruction_index = read_u16(&ix.data, 4)?;
    let public_key_offset = read_u16(&ix.data, 6)? as usize;
    let public_key_instruction_index = read_u16(&ix.data, 8)?;
    let message_offset = read_u16(&ix.data, 10)? as usize;
    let message_size = read_u16(&ix.data, 12)? as usize;
    let message_instruction_index = read_u16(&ix.data, 14)?;

    require!(
        signature_instruction_index == u16::MAX
            && public_key_instruction_index == u16::MAX
            && message_instruction_index == u16::MAX,
        GetfiError::InvalidSignatureInstruction
    );

    let signature_end = signature_offset
        .checked_add(64)
        .ok_or(error!(GetfiError::InvalidSignatureInstruction))?;
    let public_key_end = public_key_offset
        .checked_add(32)
        .ok_or(error!(GetfiError::InvalidSignatureInstruction))?;
    let message_end = message_offset
        .checked_add(message_size)
        .ok_or(error!(GetfiError::InvalidSignatureInstruction))?;
    require!(
        signature_end <= ix.data.len()
            && public_key_end <= ix.data.len()
            && message_end <= ix.data.len(),
        GetfiError::InvalidSignatureInstruction
    );
    require!(
        &ix.data[signature_offset..signature_end] == signature,
        GetfiError::InvalidSignature
    );
    require!(
        &ix.data[public_key_offset..public_key_end] == signer.as_ref(),
        GetfiError::InvalidSignatureSigner
    );
    require!(
        &ix.data[message_offset..message_end] == message,
        GetfiError::InvalidSignatureMessage
    );
    Ok(())
}

fn read_u16(data: &[u8], offset: usize) -> Result<u16> {
    let end = offset
        .checked_add(2)
        .ok_or(error!(GetfiError::InvalidSignatureInstruction))?;
    require!(end <= data.len(), GetfiError::InvalidSignatureInstruction);
    Ok(u16::from_le_bytes([data[offset], data[offset + 1]]))
}

#[error_code]
pub enum GetfiError {
    #[msg("Invalid lootbox tier.")] InvalidBoxTier,
    #[msg("Backend signature has expired.")] SignatureExpired,
    #[msg("Missing Ed25519 signature instruction.")] MissingSignatureInstruction,
    #[msg("Invalid Ed25519 signature instruction.")] InvalidSignatureInstruction,
    #[msg("Invalid backend signature.")] InvalidSignature,
    #[msg("Invalid backend signature signer.")] InvalidSignatureSigner,
    #[msg("Invalid backend signature message.")] InvalidSignatureMessage,
    #[msg("Invalid sysvar instructions account.")] InvalidInstructionsSysvar,
    #[msg("Invalid player for this request.")] InvalidPlayer,
    #[msg("Invalid backend signer.")] InvalidBackendSigner,
    #[msg("Invalid treasury account.")] InvalidTreasury,
    #[msg("Invalid reward mint.")] InvalidRewardMint,
    #[msg("Lootbox request has already been consumed.")] AlreadyConsumed,
    #[msg("Backend seed does not match the on-chain commitment.")]
    InvalidBackendCommitment,
    #[msg("Inventory underflow.")] InventoryUnderflow,
    #[msg("All inventory tiers are exhausted.")] InventoryExhausted,
    #[msg("Box count must be between 1 and 10.")] InvalidBoxCount,
    #[msg("Daily box limit (50 per UTC day) exceeded.")] DailyLimitExceeded,
    #[msg("Arithmetic overflow.")] ArithmeticOverflow,
    // ── Phase 3 (agent + fuel) ───────────────────────────────────────────────
    #[msg("Agent has been revoked.")] AgentIsRevoked,
    #[msg("Agent delegation has expired.")] AgentExpired,
    #[msg("This action is not in the agent's allowed_actions bitmask.")]
    AgentActionNotAllowed,
    #[msg("Authority must be either the delegating user or the registered agent.")]
    AgentAuthorityMismatch,
    #[msg("Agent pubkey does not match the on-chain registration.")] AgentPubkeyMismatch,
    #[msg("Agent expiry must be in the future and within the maximum delegation window.")]
    AgentInvalidExpiry,
    #[msg("Agent allowed_actions bitmask is empty or contains unknown bits.")]
    AgentInvalidActions,
    #[msg("Agent nonce counter mismatch — possible replay.")] AgentNonceMismatch,
    #[msg("Fuel vault balance is insufficient for this operation.")] FuelInsufficient,
    #[msg("Withdraw amount exceeds fuel vault balance.")] FuelWithdrawTooLarge,
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — Agent delegation + FuelVault
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_SEED: &[u8] = b"agent";
const FUEL_SEED: &[u8] = b"fuel";
/// Domain tag for the agent ed25519 message. Distinct from the user-facing
/// `BATCH_MESSAGE_DOMAIN` so signatures cannot be replayed cross-flow.
const AGENT_MESSAGE_DOMAIN: &[u8] = b"GETFI_AGENT_BOX_V1";

/// Bitmask of actions a delegated agent is allowed to perform on behalf of
/// the user. Single-bit today; reserved for future granular permissions
/// (e.g. claim_rewards, transfer_get) without an account-layout migration.
pub const AGENT_ACTION_OPEN_BOX: u32 = 1 << 0;

/// Lamports the agent gets reimbursed from the FuelVault per
/// `open_box_as_agent` to cover the on-chain tx fee. Two ed25519 sigs
/// + program ix ≈ 5_000–10_000 lamports today; rounded up.
pub const AGENT_TX_FEE_REIMBURSEMENT: u64 = 10_000;

/// Maximum delegation lifetime: 365 days. `expiry_ts` must be in the
/// future and within this window — forces users to renew yearly so a
/// stolen agent key can't be exploited indefinitely.
pub const AGENT_MAX_DURATION_SECONDS: i64 = 365 * 86_400;

#[account]
pub struct AgentAuthority {
    pub user: Pubkey,
    pub agent_pubkey: Pubkey,
    pub allowed_actions: u32,
    pub expiry_ts: i64,
    /// Strictly-increasing replay guard; the backend signs over the
    /// expected value and the program enforces equality + bumps.
    pub nonce_counter: u64,
    pub revoked: bool,
    pub bump: u8,
}
impl AgentAuthority {
    pub const SIZE: usize = 32 + 32 + 4 + 8 + 8 + 1 + 1;
}

#[event]
pub struct AgentRegistered {
    pub user: Pubkey,
    pub agent: Pubkey,
    pub allowed_actions: u32,
    pub expiry_ts: i64,
}

#[event]
pub struct AgentRevocation {
    pub user: Pubkey,
    pub agent: Pubkey,
    pub revoked_by: Pubkey,
}

#[event]
pub struct AgentBoxOpened {
    pub user: Pubkey,
    pub agent: Pubkey,
    pub box_count: u8,
    pub total_amount: u64,
    pub fuel_remaining: u64,
}

struct AgentBoxMessage {
    config: Pubkey,
    user: Pubkey,
    agent: Pubkey,
    reward_mint: Pubkey,
    box_count: u8,
    nonce_counter: u64,
    player_entropy: [u8; 32],
    backend_commitment: [u8; 32],
    expires_at: i64,
}

fn build_agent_message(m: &AgentBoxMessage) -> Vec<u8> {
    let mut out =
        Vec::with_capacity(AGENT_MESSAGE_DOMAIN.len() + 32 * 4 + 1 + 8 + 32 + 32 + 8);
    out.extend_from_slice(AGENT_MESSAGE_DOMAIN);
    out.extend_from_slice(m.config.as_ref());
    out.extend_from_slice(m.user.as_ref());
    out.extend_from_slice(m.agent.as_ref());
    out.extend_from_slice(m.reward_mint.as_ref());
    out.push(m.box_count);
    out.extend_from_slice(&m.nonce_counter.to_le_bytes());
    out.extend_from_slice(&m.player_entropy);
    out.extend_from_slice(&m.backend_commitment);
    out.extend_from_slice(&m.expires_at.to_le_bytes());
    out
}

#[derive(Accounts)]
pub struct RegisterAgent<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init,
        payer = user,
        space = 8 + AgentAuthority::SIZE,
        seeds = [AGENT_SEED, user.key().as_ref()],
        bump,
    )]
    pub agent_authority: Account<'info, AgentAuthority>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeAgent<'info> {
    /// Either the user or the registered agent — verified in the handler
    /// against `agent_authority.user` / `.agent_pubkey`.
    pub authority: Signer<'info>,
    /// CHECK: derivation reference for the AgentAuthority PDA. Anchor's
    /// seed-match enforces equality with `agent_authority.user`.
    pub user: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [AGENT_SEED, user.key().as_ref()],
        bump = agent_authority.bump,
    )]
    pub agent_authority: Account<'info, AgentAuthority>,
}

#[derive(Accounts)]
pub struct DepositFuel<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    /// Tying deposits to a registered agent keeps the mental model
    /// "fuel exists for an agent" — preventing orphan vaults.
    #[account(
        seeds = [AGENT_SEED, user.key().as_ref()],
        bump = agent_authority.bump,
        constraint = agent_authority.user == user.key() @ GetfiError::AgentAuthorityMismatch,
    )]
    pub agent_authority: Account<'info, AgentAuthority>,
    #[account(
        mut,
        seeds = [FUEL_SEED, user.key().as_ref()],
        bump,
    )]
    pub fuel_vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawFuel<'info> {
    /// Either the user or the registered agent. Destination is locked
    /// to `user` (which is constrained to `agent_authority.user`), so the
    /// agent can only ever push fuel back to its delegator.
    pub authority: Signer<'info>,
    #[account(mut)]
    pub user: SystemAccount<'info>,
    #[account(
        seeds = [AGENT_SEED, user.key().as_ref()],
        bump = agent_authority.bump,
    )]
    pub agent_authority: Account<'info, AgentAuthority>,
    #[account(
        mut,
        seeds = [FUEL_SEED, user.key().as_ref()],
        bump,
    )]
    pub fuel_vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenBoxAsAgent<'info> {
    /// Agent (bot hot wallet) — feePayer + signer of the on-chain tx.
    /// Reimbursed exactly `AGENT_TX_FEE_REIMBURSEMENT` from the FuelVault
    /// before the ix returns.
    #[account(mut)]
    pub agent: Signer<'info>,
    /// User the agent is acting for. Not a signer — that's the whole
    /// point of the delegation. PDA derivation + the explicit
    /// require_keys_eq in the handler enforce identity.
    /// CHECK: not a signer; semantics enforced via PDA seeds + handler.
    pub user: AccountInfo<'info>,
    /// CHECK: must equal `config.backend_signer`. Not a tx-level signer;
    /// authorization is proven by the preceding ed25519 verify ix.
    pub backend_signer: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [AGENT_SEED, user.key().as_ref()],
        bump = agent_authority.bump,
    )]
    pub agent_authority: Box<Account<'info, AgentAuthority>>,
    #[account(
        mut,
        seeds = [FUEL_SEED, user.key().as_ref()],
        bump,
    )]
    pub fuel_vault: SystemAccount<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.reward_mint == reward_mint.key() @ GetfiError::InvalidRewardMint,
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [INVENTORY_SEED], bump = inventory.bump)]
    pub inventory: Box<Account<'info, GlobalInventory>>,
    /// Read-only for `has_won_major_prize`; daily counters intentionally
    /// untouched in the agent flow.
    #[account(
        init_if_needed,
        payer = agent,
        space = 8 + PlayerStateV3::SIZE,
        seeds = [PLAYER_STATE_V3_SEED, user.key().as_ref()],
        bump,
    )]
    pub player_state: Box<Account<'info, PlayerStateV3>>,
    #[account(address = config.reward_mint)]
    pub reward_mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = reward_mint,
        associated_token::authority = config,
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = agent,
        associated_token::mint = reward_mint,
        associated_token::authority = user,
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: enforced equal to TREASURY_PUBKEY in the handler.
    #[account(mut)]
    pub treasury: AccountInfo<'info>,
    /// CHECK: must be the instructions sysvar (used for ed25519 verify).
    pub instructions: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
