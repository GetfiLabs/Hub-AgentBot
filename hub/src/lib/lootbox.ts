import { PublicKey } from "@solana/web3.js";

// ── PDA seeds (must match programs/getfi_lootbox/src/lib.rs) ────────────────

const INVENTORY_SEED = new TextEncoder().encode("inventory_v2");
const PLAYER_STATE_V3_SEED = new TextEncoder().encode("player_state_v3");

/// On-chain GetFi lootbox program (Anchor) deployed on devnet.
export const GETFI_LOOTBOX_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_GETFI_LOOTBOX_PROGRAM_ID ??
    "Bm6zsJgc87Hj6gGEtpHtyjP89Lwuu7TequM6dgPL8LA7",
);

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

/// On-chain treasury that receives the gas-abstraction fee. Must match the
/// `TREASURY_PUBKEY` constant baked into the Anchor program.
export const TREASURY_PUBKEY = new PublicKey(
  process.env.NEXT_PUBLIC_GETFI_TREASURY ?? "A3TgoR4ArUEsQiuXLM9ikoE2wA8uQPFxEdGxnfGXFqxb",
);

/// $GET SPL token mint (must match the Cloud Function `DEFAULT_REWARD_MINT`).
export const GETFI_REWARD_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_GETFI_REWARD_MINT ?? "3rTrMpMPQ3Nj7ktRkBYcLmB5diqqhtcw348oq9Poq5Eo",
);

/// Fixed price for one mystery box (G points).
export const SINGLE_BOX_COST = 5000;
/// Per-request gas-abstraction fee (lamports / 1e9 SOL).
export const LOOTBOX_FEE_LAMPORTS = 298_000;

export function deriveInventoryPda(programId: PublicKey) {
  return PublicKey.findProgramAddressSync([INVENTORY_SEED], programId)[0];
}

export function derivePlayerStateV3Pda(programId: PublicKey, player: PublicKey) {
  return PublicKey.findProgramAddressSync([PLAYER_STATE_V3_SEED, player.toBytes()], programId)[0];
}

export function deriveAta(owner: PublicKey, mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/// Generate the player-side entropy for the V3 commit-reveal RNG. Returns
/// 32 fresh bytes from the browser CSPRNG, encoded base64 so it can be
/// passed straight to the `signLootboxBatch` callable.
export function generatePlayerEntropy(): {
  bytes: Uint8Array;
  base64: string;
} {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return { bytes, base64: btoa(binary) };
}
