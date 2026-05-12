// Bot-side instruction builders for the user-or-agent-signed mutations:
//   - revoke_agent
//   - withdraw_fuel(Option<u64>)
//
// Mirrors `programs/getfi_lootbox/src/lib.rs`. Open-box and registration
// builders live elsewhere (agentTx.js / smoke_open_box.js).

const crypto = require('crypto');
const {SystemProgram, TransactionInstruction} = require('@solana/web3.js');
const {deriveAgentAuthority, deriveFuelVault} = require('./pdas');

function disc(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

const REVOKE_AGENT_DISC = disc('revoke_agent');
const WITHDRAW_FUEL_DISC = disc('withdraw_fuel');

function writeU64LE(value) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

function buildRevokeAgentIx({programId, authority, user}) {
  const agentAuthority = deriveAgentAuthority(programId, user);
  return new TransactionInstruction({
    programId,
    keys: [
      {pubkey: authority, isSigner: true, isWritable: false},
      {pubkey: user, isSigner: false, isWritable: false},
      {pubkey: agentAuthority, isSigner: false, isWritable: true},
    ],
    data: Buffer.from(REVOKE_AGENT_DISC),
  });
}

// `amount = null/undefined` → drain to zero (the /istifa case).
// `amount = u64` → partial.
function buildWithdrawFuelIx({programId, authority, user, amount}) {
  const agentAuthority = deriveAgentAuthority(programId, user);
  const fuelVault = deriveFuelVault(programId, user);
  let amountBytes;
  if (amount === null || amount === undefined) {
    amountBytes = Buffer.from([0]);
  } else {
    amountBytes = Buffer.concat([Buffer.from([1]), writeU64LE(amount)]);
  }
  return new TransactionInstruction({
    programId,
    keys: [
      {pubkey: authority, isSigner: true, isWritable: false},
      {pubkey: user, isSigner: false, isWritable: true},
      {pubkey: agentAuthority, isSigner: false, isWritable: false},
      {pubkey: fuelVault, isSigner: false, isWritable: true},
      {pubkey: SystemProgram.programId, isSigner: false, isWritable: false},
    ],
    data: Buffer.concat([WITHDRAW_FUEL_DISC, amountBytes]),
  });
}

module.exports = {
  buildRevokeAgentIx,
  buildWithdrawFuelIx,
  REVOKE_AGENT_DISC,
  WITHDRAW_FUEL_DISC,
};
