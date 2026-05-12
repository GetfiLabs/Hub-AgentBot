const {
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} = require("@solana/web3.js");

// Anchor discriminator for `consume_lootbox`
const CONSUME_DISCRIMINATOR = Buffer.from([10, 126, 162, 156, 150, 153, 38, 50]);

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

function deriveAta(owner, mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return pda;
}

function deriveLootboxRequest(programId, player, nonce) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lootbox_request"), player.toBuffer(), nonce], programId,
  );
  return pda;
}

function deriveInventory(programId) {
  // V2 seed — must match INVENTORY_SEED in programs/getfi_lootbox/src/lib.rs.
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("inventory_v2")],
    programId,
  );
  return pda;
}

function derivePlayerState(programId, player) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("player_state"), player.toBuffer()], programId,
  );
  return pda;
}

function buildConsumeInstruction({
  programId,
  backendSigner,
  player,
  config,
  rewardMint,
  nonce,
  randomness,
}) {
  const inventory = deriveInventory(programId);
  const playerState = derivePlayerState(programId, player);
  const lootboxRequest = deriveLootboxRequest(programId, player, nonce);
  const vaultAta = deriveAta(config, rewardMint);
  const playerAta = deriveAta(player, rewardMint);

  const keys = [
    { pubkey: backendSigner, isSigner: true, isWritable: true },
    { pubkey: player, isSigner: false, isWritable: false },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: inventory, isSigner: false, isWritable: true },
    { pubkey: playerState, isSigner: false, isWritable: true },
    { pubkey: lootboxRequest, isSigner: false, isWritable: true },
    { pubkey: rewardMint, isSigner: false, isWritable: false },
    { pubkey: vaultAta, isSigner: false, isWritable: true },
    { pubkey: playerAta, isSigner: false, isWritable: true },
    { pubkey: randomness, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId,
    keys,
    data: CONSUME_DISCRIMINATOR,
  });
}

module.exports = { buildConsumeInstruction };
