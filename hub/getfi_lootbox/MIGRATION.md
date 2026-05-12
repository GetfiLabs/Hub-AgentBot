# Reward-mint rotation playbook

The current `getfi_lootbox` program (`Bm6zsJgc87Hj6gGEtpHtyjP89Lwuu7TequM6dgPL8LA7`)
binds the reward mint **immutably** at `initialize_config` time. The
deployed `Config` PDA (`[b"config"]`) was initialized against the legacy
V1 mint (`25DdndWWe9VkdZKVbH9j1ucbSGky5LNKdMFo6hvQtkD4`, 0 decimals).
Wallets classify that mint as an NFT collection because of the missing
decimal precision, so we minted a clean **V2 mint** for everything
downstream:

```
$GET v2  3rTrMpMPQ3Nj7ktRkBYcLmB5diqqhtcw348oq9Poq5Eo   (6 decimals, 40 B supply)
```

All client code (Hub frontend, Cloud Functions, RaiderBot) now defaults
to the V2 mint via the `GETFI_REWARD_MINT` / `NEXT_PUBLIC_GETFI_REWARD_MINT`
env vars.

To make the on-chain lootbox payout flow use the V2 mint as well, the
program needs **one new admin instruction** plus an `anchor upgrade`. The
patch is listed below — drop it in, rebuild, upgrade, and run the
post-upgrade script.

---

## 1. Add `update_reward_mint` to the program

`programs/getfi_lootbox/src/lib.rs`, next to `update_backend_signer`:

```rust
pub fn update_reward_mint(ctx: Context<UpdateRewardMint>) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    require_keys_eq!(cfg.owner, ctx.accounts.owner.key(), GetfiError::Unauthorized);
    cfg.reward_mint = ctx.accounts.new_reward_mint.key();
    emit!(RewardMintUpdated {
        config: cfg.key(),
        new_mint: cfg.reward_mint,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateRewardMint<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: Mint account; only its key is stored.
    pub new_reward_mint: Account<'info, Mint>,
    pub owner: Signer<'info>,
}

#[event]
pub struct RewardMintUpdated {
    pub config: Pubkey,
    pub new_mint: Pubkey,
}
```

> **Note**: this only updates the *check* (`config.reward_mint == reward_mint.key()`).
> The vault holding rewards is a separate ATA owned by the Config PDA; we
> create a *new* vault for the new mint in step 3, then fund it.

## 2. Build and upgrade

```bash
cd getfi_lootbox
anchor build
anchor upgrade target/deploy/getfi_lootbox.so \
  --program-id Bm6zsJgc87Hj6gGEtpHtyjP89Lwuu7TequM6dgPL8LA7 \
  --provider.cluster devnet
```

`anchor upgrade` allocates a temporary buffer (~3.9 SOL for our 555 KB
program), writes the new bytecode, then refunds the buffer. Make sure
the deployer wallet has at least 4.5 SOL of headroom on devnet.

If the build complains about `solana-program` / Anchor 0.30.1 vs Agave
3.x toolchain mismatches, pin the workspace toolchain via `rust-toolchain.toml`:

```toml
[toolchain]
channel = "1.78.0"
```

## 3. Point Config at the new mint and fund the new vault

```bash
# 3a. flip the on-chain pointer
anchor run script -- --script update-mint --new-mint 3rTrMpMPQ3Nj7ktRkBYcLmB5diqqhtcw348oq9Poq5Eo

# 3b. derive the new vault ATA (Config PDA owns it)
CONFIG=$(solana address -k <config-pda>)   # or compute from program ID
spl-token create-account 3rTrMpMPQ3Nj7ktRkBYcLmB5diqqhtcw348oq9Poq5Eo --owner $CONFIG

# 3c. seed the vault with the lootbox inventory
spl-token transfer 3rTrMpMPQ3Nj7ktRkBYcLmB5diqqhtcw348oq9Poq5Eo 10000000000 <NEW_VAULT_ADDRESS> --fund-recipient
```

## 4. Sanity check

```bash
solana account <CONFIG_PDA> --output json | jq '.account.data'
spl-token balance --address <NEW_VAULT_ADDRESS>
```

Then run `src/scripts/smoke_open_box.js` from the RaiderBot repo against
devnet — it should produce a successful `consume_lootbox_batch` against
the V2 mint and credit the test wallet's V2 ATA.

---

## Why we did not migrate during the hackathon push

`anchor upgrade` is straightforward in isolation, but combined with the
0.30.1 ↔ Agave 3.x toolchain version surface, a fresh Rust BPF build can
take an hour to debug if the workspace pins drift. We chose to ship the
clean V2 mint plus an explicit migration playbook rather than risk a
broken upgrade window during the hackathon demo. The patch above is the
entire on-chain delta.
