const {PublicKey} = require('@solana/web3.js');

const AGENT_SEED = Buffer.from('agent');
const FUEL_SEED = Buffer.from('fuel');
const CONFIG_SEED = Buffer.from('config');
const INVENTORY_V2_SEED = Buffer.from('inventory_v2');
const PLAYER_STATE_V3_SEED = Buffer.from('player_state_v3');

const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

function deriveAgentAuthority(programId, user) {
  return PublicKey.findProgramAddressSync(
    [AGENT_SEED, user.toBuffer()],
    programId,
  )[0];
}

function deriveFuelVault(programId, user) {
  return PublicKey.findProgramAddressSync(
    [FUEL_SEED, user.toBuffer()],
    programId,
  )[0];
}

function deriveConfig(programId) {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId)[0];
}

function deriveInventoryV2(programId) {
  return PublicKey.findProgramAddressSync([INVENTORY_V2_SEED], programId)[0];
}

function derivePlayerStateV3(programId, user) {
  return PublicKey.findProgramAddressSync(
    [PLAYER_STATE_V3_SEED, user.toBuffer()],
    programId,
  )[0];
}

function deriveAta(owner, mint) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

module.exports = {
  AGENT_SEED,
  FUEL_SEED,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  deriveAgentAuthority,
  deriveFuelVault,
  deriveConfig,
  deriveInventoryV2,
  derivePlayerStateV3,
  deriveAta,
};
