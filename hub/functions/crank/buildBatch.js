const {
  PublicKey,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} = require("@solana/web3.js");

// Anchor instruction discriminators — sha256("global:<name>")[..8].
const REQUEST_BATCH_DISCRIMINATOR = Buffer.from([
  0x3e, 0x56, 0x9a, 0x09, 0x5f, 0xf9, 0xb6, 0x98,
]); // request_lootbox_batch
const CONSUME_BATCH_DISCRIMINATOR = Buffer.from([
  0x4c, 0x6d, 0x68, 0x64, 0xf9, 0xc6, 0x64, 0x06,
]); // consume_lootbox_batch
const CANCEL_BATCH_DISCRIMINATOR = Buffer.from([
  0x8f, 0x3e, 0x13, 0xf4, 0x1a, 0x20, 0xf1, 0xd6,
]); // cancel_lootbox_batch

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

const BATCH_REQUEST_SEED = Buffer.from("lootbox_batch");
const PLAYER_STATE_V3_SEED = Buffer.from("player_state_v3");
const INVENTORY_SEED = Buffer.from("inventory_v2");

function deriveBatchRequest(programId, player, nonce) {
  const [pda] = PublicKey.findProgramAddressSync(
    [BATCH_REQUEST_SEED, player.toBuffer(), nonce],
    programId,
  );
  return pda;
}

function derivePlayerStateV3(programId, player) {
  const [pda] = PublicKey.findProgramAddressSync(
    [PLAYER_STATE_V3_SEED, player.toBuffer()],
    programId,
  );
  return pda;
}

function deriveInventoryV2(programId) {
  const [pda] = PublicKey.findProgramAddressSync([INVENTORY_SEED], programId);
  return pda;
}

function deriveAta(owner, mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return pda;
}

function writeI64LE(value) {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(value));
  return out;
}

/**
 * Build the request_lootbox_batch instruction.
 *
 * Args layout: discriminator(8) | box_count(1) | nonce(32) |
 *              player_entropy(32) | backend_commitment(32) |
 *              expires_at(i64 LE) | signature(64).
 */
function buildRequestBatchInstruction({
  programId,
  backendSigner,
  player,
  config,
  treasury,
  boxCount,
  nonce,
  playerEntropy,
  backendCommitment,
  expiresAt,
  signature,
}) {
  const lootboxBatch = deriveBatchRequest(programId, player, nonce);
  const playerState = derivePlayerStateV3(programId, player);

  const args = Buffer.concat([
    REQUEST_BATCH_DISCRIMINATOR,
    Buffer.from([boxCount]),
    nonce,
    playerEntropy,
    backendCommitment,
    writeI64LE(expiresAt),
    signature,
  ]);

  const keys = [
    {pubkey: backendSigner, isSigner: true, isWritable: true},
    {pubkey: player, isSigner: true, isWritable: true},
    {pubkey: config, isSigner: false, isWritable: false},
    {pubkey: lootboxBatch, isSigner: false, isWritable: true},
    {pubkey: playerState, isSigner: false, isWritable: true},
    {pubkey: treasury, isSigner: false, isWritable: true},
    {pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false},
    {pubkey: SystemProgram.programId, isSigner: false, isWritable: false},
  ];

  return new TransactionInstruction({
    programId,
    keys,
    data: args,
  });
}

function buildEd25519VerifyInstruction({backendPubkey, message, signature}) {
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: backendPubkey.toBytes(),
    message,
    signature,
  });
}

/**
 * consume_lootbox_batch — backend reveals `backend_seed`, program verifies
 * sha256(backend_seed) == backend_commitment and rolls.
 *
 * Args layout: discriminator(8) | backend_seed(32).
 */
function buildConsumeBatchInstruction({
  programId,
  backendSigner,
  player,
  config,
  rewardMint,
  nonce,
  backendSeed,
}) {
  const inventory = deriveInventoryV2(programId);
  const playerState = derivePlayerStateV3(programId, player);
  const lootboxBatch = deriveBatchRequest(programId, player, nonce);
  const vaultAta = deriveAta(config, rewardMint);
  const playerAta = deriveAta(player, rewardMint);

  const data = Buffer.concat([CONSUME_BATCH_DISCRIMINATOR, backendSeed]);

  const keys = [
    {pubkey: backendSigner, isSigner: true, isWritable: true},
    {pubkey: player, isSigner: false, isWritable: false},
    {pubkey: config, isSigner: false, isWritable: false},
    {pubkey: inventory, isSigner: false, isWritable: true},
    {pubkey: playerState, isSigner: false, isWritable: true},
    {pubkey: lootboxBatch, isSigner: false, isWritable: true},
    {pubkey: rewardMint, isSigner: false, isWritable: false},
    {pubkey: vaultAta, isSigner: false, isWritable: true},
    {pubkey: playerAta, isSigner: false, isWritable: true},
    {pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false},
    {pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false},
    {pubkey: SystemProgram.programId, isSigner: false, isWritable: false},
    {pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false},
  ];

  return new TransactionInstruction({
    programId,
    keys,
    data,
  });
}

/**
 * cancel_lootbox_batch — backend escape hatch; closes the batch PDA and
 * refunds rent. Releases the daily reservation only when the batch was
 * never consumed (consumed batches already promoted theirs).
 */
function buildCancelBatchInstruction({
  programId,
  backendSigner,
  player,
  config,
  nonce,
}) {
  const playerState = derivePlayerStateV3(programId, player);
  const lootboxBatch = deriveBatchRequest(programId, player, nonce);

  const keys = [
    {pubkey: backendSigner, isSigner: true, isWritable: true},
    {pubkey: player, isSigner: false, isWritable: false},
    {pubkey: config, isSigner: false, isWritable: false},
    {pubkey: playerState, isSigner: false, isWritable: true},
    {pubkey: lootboxBatch, isSigner: false, isWritable: true},
  ];

  return new TransactionInstruction({
    programId,
    keys,
    data: CANCEL_BATCH_DISCRIMINATOR,
  });
}

module.exports = {
  buildRequestBatchInstruction,
  buildConsumeBatchInstruction,
  buildCancelBatchInstruction,
  buildEd25519VerifyInstruction,
  deriveBatchRequest,
  derivePlayerStateV3,
  deriveInventoryV2,
};
