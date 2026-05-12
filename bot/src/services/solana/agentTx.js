// Builds the Solana transaction that submits `open_box_as_agent`.
//
// The tx has exactly two instructions, in this order:
//   ix0: Ed25519Program.createInstructionWithPublicKey  (verifies the
//        backend's signature over the agent message)
//   ix1: getfi_lootbox.open_box_as_agent                 (the program ix)
//
// Order matters — the program calls `verify_previous_ed25519_ix(current-1)`,
// which only succeeds if ix0 is the ed25519 verify ix. ComputeBudget
// instructions are intentionally NOT prepended so the relative position
// stays current_index = 1.

const {
  Ed25519Program,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} = require('@solana/web3.js');
const crypto = require('crypto');
const {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  deriveAgentAuthority,
  deriveFuelVault,
  deriveConfig,
  deriveInventoryV2,
  derivePlayerStateV3,
  deriveAta,
} = require('./pdas');

// Anchor instruction discriminator: sha256("global:<name>")[..8].
const OPEN_BOX_AS_AGENT_DISCRIMINATOR = crypto
  .createHash('sha256')
  .update('global:open_box_as_agent')
  .digest()
  .subarray(0, 8);

function writeI64LE(value) {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(value));
  return out;
}

function writeU64LE(value) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

function buildEd25519VerifyInstruction({backendPubkey, message, signature}) {
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: backendPubkey.toBytes(),
    message,
    signature,
  });
}

function buildOpenBoxAsAgentInstruction({
  programId,
  agent,
  user,
  backendSigner,
  configPda,
  rewardMint,
  treasury,
  boxCount,
  nonceCounter,
  playerEntropy,
  backendCommitment,
  backendSeed,
  expiresAt,
  signature,
}) {
  if (playerEntropy.length !== 32) throw new Error('playerEntropy must be 32 bytes');
  if (backendCommitment.length !== 32) throw new Error('backendCommitment must be 32 bytes');
  if (backendSeed.length !== 32) throw new Error('backendSeed must be 32 bytes');
  if (signature.length !== 64) throw new Error('signature must be 64 bytes');

  const data = Buffer.concat([
    OPEN_BOX_AS_AGENT_DISCRIMINATOR,
    Buffer.from([boxCount]),
    writeU64LE(nonceCounter),
    Buffer.from(playerEntropy),
    Buffer.from(backendCommitment),
    Buffer.from(backendSeed),
    writeI64LE(expiresAt),
    Buffer.from(signature),
  ]);

  const agentAuthority = deriveAgentAuthority(programId, user);
  const fuelVault = deriveFuelVault(programId, user);
  const inventory = deriveInventoryV2(programId);
  const playerState = derivePlayerStateV3(programId, user);
  const vaultTokenAccount = deriveAta(configPda, rewardMint);
  const userTokenAccount = deriveAta(user, rewardMint);

  const keys = [
    {pubkey: agent, isSigner: true, isWritable: true},
    {pubkey: user, isSigner: false, isWritable: false},
    {pubkey: backendSigner, isSigner: false, isWritable: false},
    {pubkey: agentAuthority, isSigner: false, isWritable: true},
    {pubkey: fuelVault, isSigner: false, isWritable: true},
    {pubkey: configPda, isSigner: false, isWritable: false},
    {pubkey: inventory, isSigner: false, isWritable: true},
    {pubkey: playerState, isSigner: false, isWritable: true},
    {pubkey: rewardMint, isSigner: false, isWritable: false},
    {pubkey: vaultTokenAccount, isSigner: false, isWritable: true},
    {pubkey: userTokenAccount, isSigner: false, isWritable: true},
    {pubkey: treasury, isSigner: false, isWritable: true},
    {pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false},
    {pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false},
    {pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false},
    {pubkey: SystemProgram.programId, isSigner: false, isWritable: false},
    {pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false},
  ];

  return new TransactionInstruction({programId, keys, data});
}

// Convenience: assemble the two-ix tx ready to be partial-signed by the
// agent (the bot's per-user hot wallet) and sent.
function buildOpenBoxAsAgentTx(params) {
  const ed25519Ix = buildEd25519VerifyInstruction({
    backendPubkey: params.backendSigner,
    message: params.message,
    signature: params.signature,
  });
  const programIx = buildOpenBoxAsAgentInstruction(params);
  const tx = new Transaction().add(ed25519Ix, programIx);
  tx.feePayer = params.agent;
  return tx;
}

module.exports = {
  OPEN_BOX_AS_AGENT_DISCRIMINATOR,
  buildEd25519VerifyInstruction,
  buildOpenBoxAsAgentInstruction,
  buildOpenBoxAsAgentTx,
};
