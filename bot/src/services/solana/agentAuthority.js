// On-chain AgentAuthority reader. Manually deserializes the account so we
// don't have to ship Anchor's full Program client for what is, in the bot's
// hot path, just one account fetch per user per run.
//
// Layout (must match programs/getfi_lootbox/src/lib.rs):
//   8  bytes  account discriminator
//   32 bytes  user (Pubkey)
//   32 bytes  agent_pubkey (Pubkey)
//   4  bytes  allowed_actions (u32 LE)
//   8  bytes  expiry_ts (i64 LE)
//   8  bytes  nonce_counter (u64 LE)
//   1  byte   revoked (bool)
//   1  byte   bump

const {PublicKey} = require('@solana/web3.js');
const {deriveAgentAuthority} = require('./pdas');
const {getConnection} = require('./connection');

const AGENT_AUTHORITY_SIZE = 8 + 32 + 32 + 4 + 8 + 8 + 1 + 1;
const AGENT_ACTION_OPEN_BOX = 1;

function decodeAgentAuthority(data) {
  if (!data || data.length < AGENT_AUTHORITY_SIZE) {
    throw new Error(
      `agent_authority data too small: got ${data ? data.length : 0}, want >= ${AGENT_AUTHORITY_SIZE}`,
    );
  }
  let off = 8; // skip discriminator
  const user = new PublicKey(data.subarray(off, off + 32)); off += 32;
  const agentPubkey = new PublicKey(data.subarray(off, off + 32)); off += 32;
  const allowedActions = data.readUInt32LE(off); off += 4;
  const expiryTs = Number(data.readBigInt64LE(off)); off += 8;
  const nonceCounter = data.readBigUInt64LE(off); off += 8;
  const revoked = data.readUInt8(off) !== 0; off += 1;
  const bump = data.readUInt8(off);
  return {user, agentPubkey, allowedActions, expiryTs, nonceCounter, revoked, bump};
}

async function fetchAgentAuthority(programId, userPubkey) {
  const pda = deriveAgentAuthority(programId, userPubkey);
  const acc = await getConnection().getAccountInfo(pda, 'confirmed');
  if (!acc) return null;
  return {pda, ...decodeAgentAuthority(acc.data)};
}

// Returns null if not registered, or {reason, ...details} if registered but
// not currently usable. Returns the auth payload on success.
async function loadActiveAgentAuthority({programId, userPubkey, expectedAgentPubkey}) {
  const auth = await fetchAgentAuthority(programId, userPubkey);
  if (!auth) return {ok: false, reason: 'not_registered'};
  if (auth.revoked) return {ok: false, reason: 'revoked', auth};
  if (auth.expiryTs <= Math.floor(Date.now() / 1000)) {
    return {ok: false, reason: 'expired', auth};
  }
  if (
    expectedAgentPubkey &&
    auth.agentPubkey.toBase58() !== expectedAgentPubkey.toBase58()
  ) {
    return {ok: false, reason: 'agent_pubkey_mismatch', auth};
  }
  if ((auth.allowedActions & AGENT_ACTION_OPEN_BOX) === 0) {
    return {ok: false, reason: 'open_box_not_allowed', auth};
  }
  return {ok: true, auth};
}

module.exports = {
  AGENT_AUTHORITY_SIZE,
  AGENT_ACTION_OPEN_BOX,
  decodeAgentAuthority,
  fetchAgentAuthority,
  loadActiveAgentAuthority,
};
