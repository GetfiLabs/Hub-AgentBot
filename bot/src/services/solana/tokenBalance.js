// On-chain SPL token balance lookup for the GetFi $GET reward mint.
//
// Used by the status reporter and /agentstatus to display the user's
// actual on-chain $GET balance (separate from the off-chain G points
// the Hub tracks in Firestore).
//
// Reads the mint from env (GETFI_REWARD_MINT) with a hardcoded fallback
// that matches the Hub functions default.

const {PublicKey} = require('@solana/web3.js');
const {getConnection} = require('./connection');

const DEFAULT_REWARD_MINT = '3rTrMpMPQ3Nj7ktRkBYcLmB5diqqhtcw348oq9Poq5Eo';
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

function getRewardMint() {
  return new PublicKey(process.env.GETFI_REWARD_MINT || DEFAULT_REWARD_MINT);
}

function deriveAta(owner, mint) {
  return PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

// Returns { raw: bigint, ui: string, decimals: number } or
// { raw: 0n, ui: '0', decimals: null } when the ATA doesn't exist yet.
async function getGetTokenBalance(userPubkey) {
  const owner = userPubkey instanceof PublicKey ? userPubkey : new PublicKey(userPubkey);
  const mint = getRewardMint();
  const ata = deriveAta(owner, mint);
  const connection = getConnection();
  try {
    const resp = await connection.getTokenAccountBalance(ata, 'confirmed');
    const v = resp.value;
    return {
      raw: BigInt(v.amount),
      ui: v.uiAmountString || String(v.uiAmount || 0),
      decimals: v.decimals,
    };
  } catch (err) {
    const msg = (err && err.message) || '';
    // Account doesn't exist yet (user has never received $GET) — surface as zero.
    if (/could not find account|Invalid param|AccountNotFound|Account not found/i.test(msg)) {
      return {raw: 0n, ui: '0', decimals: null};
    }
    throw err;
  }
}

module.exports = {getGetTokenBalance, getRewardMint, deriveAta};
