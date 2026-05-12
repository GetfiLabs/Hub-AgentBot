// Bot's operational hot wallet — funds individual per-user agent
// keypairs with a small amount of SOL so they can pay tx fees on the
// hot path. The agent earns its keep back via the
// `AGENT_TX_FEE_REIMBURSEMENT` paid by the FuelVault inside
// `open_box_as_agent`, so this is essentially seed funding plus a
// safety buffer.
//
// Distinct from BACKEND_SIGNER (which is a Hub-side concept). This
// wallet should be a fresh, low-balance keypair the bot operator owns.
// Loaded from `BOT_OPERATIONAL_WALLET_SECRET` env: either a base58
// string, a base64 string, or a JSON-array of bytes (matching the
// solana-keygen file format).

const {
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {getConnection} = require('../solana/connection');
require('dotenv').config();

const DEFAULT_TOPUP_TARGET_LAMPORTS = 5_000_000; // 0.005 SOL
const DEFAULT_TOPUP_TRIGGER_LAMPORTS = 2_000_000; // top up if below 0.002 SOL

let cached = null;

function parseSecret(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    return Uint8Array.from(JSON.parse(trimmed));
  }
  if (trimmed.includes(',')) {
    return Uint8Array.from(trimmed.split(',').map((p) => Number(p.trim())));
  }
  // base58 secret keys are 88 chars; base64 are 88 too. Try base64 first.
  try {
    const buf = Buffer.from(trimmed, 'base64');
    if (buf.length === 64 || buf.length === 32) return Uint8Array.from(buf);
  } catch (_) {}
  // Fall back to bs58 if available.
  try {
    const bs58 = require('bs58');
    return Uint8Array.from(bs58.decode(trimmed));
  } catch (_) {
    throw new Error(
      'BOT_OPERATIONAL_WALLET_SECRET could not be parsed as JSON-array, base64, or base58.',
    );
  }
}

function getOperationalWallet() {
  if (cached) return cached;
  const raw = process.env.BOT_OPERATIONAL_WALLET_SECRET;
  if (!raw) {
    throw new Error(
      'BOT_OPERATIONAL_WALLET_SECRET is not set. Generate one with `solana-keygen new -o ./bot-op.json` and paste the JSON-array contents into .env.',
    );
  }


  const bytes = parseSecret(raw);
  const secretKey =
    bytes.length === 32 ? Keypair.fromSeed(bytes).secretKey : bytes;
  cached = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  return cached;
}

// Tops up `agentPubkey` to `target` lamports if its current balance is
// below `trigger`. No-op when already topped up.
async function ensureAgentFunded(agentPubkey, opts = {}) {
  const target = opts.targetLamports || DEFAULT_TOPUP_TARGET_LAMPORTS;
  const trigger = opts.triggerLamports || DEFAULT_TOPUP_TRIGGER_LAMPORTS;

  const connection = getConnection();
  const balance = await connection.getBalance(agentPubkey, 'confirmed');
  if (balance >= trigger) {
    return {topped: false, balance};
  }
  const wallet = getOperationalWallet();
  const delta = target - balance;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: agentPubkey,
      lamports: delta,
    }),
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [wallet], {
    commitment: 'confirmed',
  });
  return {topped: true, balance: target, txSignature: sig, addedLamports: delta};
}

module.exports = {
  getOperationalWallet,
  ensureAgentFunded,
  DEFAULT_TOPUP_TARGET_LAMPORTS,
  DEFAULT_TOPUP_TRIGGER_LAMPORTS,
};
