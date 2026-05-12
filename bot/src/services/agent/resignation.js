// /istifa flow — bot self-revokes and drains the FuelVault back to the
// user, in a single agent-signed transaction.
//
// Both ixs are user-or-agent-signed at the program level; we use the
// agent's keypair so the user doesn't have to leave Telegram for the
// Hub UI just to fire the bot.

const admin = require('firebase-admin');
const {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {getConnection} = require('../solana/connection');
const {
  buildRevokeAgentIx,
  buildWithdrawFuelIx,
} = require('../solana/agentMutations');
const {fetchAgentAuthority} = require('../solana/agentAuthority');
const {deriveFuelVault} = require('../solana/pdas');
const agentKeys = require('../wallet/agentKeys');
const {ensureAgentFunded} = require('../wallet/operationalWallet');

function programId() {
  return new PublicKey(
    process.env.GETFI_LOOTBOX_PROGRAM_ID
      || 'Bm6zsJgc87Hj6gGEtpHtyjP89Lwuu7TequM6dgPL8LA7',
  );
}

// Returns { txSignature, refundedLamports, walletAddress }.
// Throws if the user has no on-chain agent registered.
async function resignAgent({platform, platformUserId}) {
  const doc = await agentKeys.getDoc(platform, platformUserId);
  if (!doc) {
    throw new Error('no_bot_agent');
  }
  if (!doc.wallet_address) {
    throw new Error('no_wallet_linked');
  }

  const userPubkey = new PublicKey(doc.wallet_address);
  const {keypair: agent} = await agentKeys.getOrCreateAgentKeypair(
    platform, platformUserId, doc.wallet_address,
  );

  const auth = await fetchAgentAuthority(programId(), userPubkey);
  if (!auth) {
    throw new Error('not_registered_onchain');
  }
  if (auth.agentPubkey.toBase58() !== agent.publicKey.toBase58()) {
    throw new Error('agent_pubkey_mismatch');
  }

  // Make sure the agent has enough SOL to pay the tx fee for revoke + withdraw.
  await ensureAgentFunded(agent.publicKey);

  const fuelPda = deriveFuelVault(programId(), userPubkey);
  const connection = getConnection();
  const fuelBefore = await connection.getBalance(fuelPda, 'confirmed');

  const tx = new Transaction().add(
    buildRevokeAgentIx({
      programId: programId(),
      authority: agent.publicKey,
      user: userPubkey,
    }),
    buildWithdrawFuelIx({
      programId: programId(),
      authority: agent.publicKey,
      user: userPubkey,
      amount: null,  // drain everything
    }),
  );
  tx.feePayer = agent.publicKey;
  const txSignature = await sendAndConfirmTransaction(connection, tx, [agent], {
    commitment: 'confirmed',
  });

  await agentKeys.markStatus(platform, platformUserId, 'resigned', {
    resigned_at: admin.firestore.FieldValue.serverTimestamp(),
    last_resignation_tx: txSignature,
  });

  return {
    txSignature,
    refundedLamports: fuelBefore,
    walletAddress: doc.wallet_address,
  };
}

module.exports = {resignAgent};
