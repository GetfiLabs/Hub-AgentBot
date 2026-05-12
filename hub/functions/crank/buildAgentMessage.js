// Mirrors `build_agent_message` in
// programs/getfi_lootbox/src/lib.rs (Phase 3). Layout:
//   domain || config || user || agent || reward_mint || box_count(u8) ||
//   nonce_counter(u64 LE) || player_entropy(32) || backend_commitment(32) ||
//   expires_at(i64 LE)
// Domain is distinct from the user-facing batch flow so signatures can
// never be replayed cross-flow.

const AGENT_MESSAGE_DOMAIN = Buffer.from("GETFI_AGENT_BOX_V1");

function writeU64LE(value) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

function writeI64LE(value) {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(value));
  return out;
}

function buildAgentMessage({
  config,
  user,
  agent,
  rewardMint,
  boxCount,
  nonceCounter,
  playerEntropy,
  backendCommitment,
  expiresAt,
}) {
  return Buffer.concat([
    AGENT_MESSAGE_DOMAIN,
    config.toBuffer(),
    user.toBuffer(),
    agent.toBuffer(),
    rewardMint.toBuffer(),
    Buffer.from([boxCount]),
    writeU64LE(nonceCounter),
    Buffer.from(playerEntropy),
    Buffer.from(backendCommitment),
    writeI64LE(expiresAt),
  ]);
}

module.exports = {AGENT_MESSAGE_DOMAIN, buildAgentMessage};
