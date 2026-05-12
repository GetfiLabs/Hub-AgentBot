// HTTP client for the Hub's agent off-chain sync endpoints.
//
//   GET  /getAgentGBalance — read the user's G balance + reserved + available
//   POST /syncAgentRun     — atomically credit farmed G, debit spent G,
//                            and create the History rows the Hub UI reads
//
// Endpoint URLs come from env. We default the path within the same
// Cloud Functions host as HUB_SIGN_AGENT_BOX_URL so deployments only
// need to set one base if they prefer.

const axios = require('axios');
require('dotenv').config();

function bearer() {
  const secret = process.env.BOT_AGENT_SHARED_SECRET;
  if (!secret) throw new Error('BOT_AGENT_SHARED_SECRET is not set.');
  return secret;
}

function deriveSibling(baseUrl, fnName) {
  // Replace the final path segment with `fnName` so SIBLING functions
  // deployed under the same project resolve automatically.
  return baseUrl.replace(/\/[^/]+$/, `/${fnName}`);
}

function balanceEndpoint() {
  const explicit = process.env.HUB_GET_AGENT_BALANCE_URL;
  if (explicit) return explicit;
  const base = process.env.HUB_SIGN_AGENT_BOX_URL;
  if (!base) throw new Error('Set HUB_GET_AGENT_BALANCE_URL or HUB_SIGN_AGENT_BOX_URL.');
  return deriveSibling(base, 'getAgentGBalance');
}

function syncEndpoint() {
  const explicit = process.env.HUB_SYNC_AGENT_RUN_URL;
  if (explicit) return explicit;
  const base = process.env.HUB_SIGN_AGENT_BOX_URL;
  if (!base) throw new Error('Set HUB_SYNC_AGENT_RUN_URL or HUB_SIGN_AGENT_BOX_URL.');
  return deriveSibling(base, 'syncAgentRun');
}

// Returns { getPoints, reservedPoints, available, exists }. Throws on
// non-200 responses so the caller can decide whether to fall back.
async function getAgentGBalance(walletAddress) {
  const resp = await axios.post(
    balanceEndpoint(),
    {walletAddress},
    {headers: {Authorization: `Bearer ${bearer()}`}, timeout: 15000},
  );
  if (resp.status !== 200) {
    throw new Error(`getAgentGBalance returned ${resp.status}`);
  }
  return resp.data;
}

// Idempotency-light: callers should only invoke this after the on-chain
// tx has confirmed AND they have not already synced for that tx.
async function syncAgentRun({
  walletAddress,
  agentPubkey,
  gFarmed,
  runsCompleted,
  boxCount,
  gSpent,
  getEarned,
  txSignature,
}) {
  const resp = await axios.post(
    syncEndpoint(),
    {
      walletAddress,
      agentPubkey,
      gFarmed,
      runsCompleted,
      boxCount,
      gSpent,
      getEarned,
      txSignature,
    },
    {headers: {Authorization: `Bearer ${bearer()}`}, timeout: 20000},
  );
  if (resp.status !== 200) {
    throw new Error(`syncAgentRun returned ${resp.status}`);
  }
  return resp.data;
}

module.exports = {getAgentGBalance, syncAgentRun};
