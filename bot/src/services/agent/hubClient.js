// Talks to the GetFi Hub Functions `signAgentBoxOpen` HTTP endpoint.
// The bot supplies (walletAddress, agentPubkey, boxCount, nonceCounter,
// playerEntropy); the Hub returns the backend-signed message + the
// commit/seed pair the bot needs to assemble the on-chain tx.

const axios = require('axios');
require('dotenv').config();

function endpoint() {
  const url = process.env.HUB_SIGN_AGENT_BOX_URL;
  if (!url) {
    throw new Error(
      'HUB_SIGN_AGENT_BOX_URL is not set (the deployed signAgentBoxOpen URL).',
    );
  }
  return url;
}

function bearer() {
  const secret = process.env.BOT_AGENT_SHARED_SECRET;
  if (!secret) {
    throw new Error('BOT_AGENT_SHARED_SECRET is not set.');
  }
  return secret;
}

async function signAgentBoxOpen({
  walletAddress,
  agentPubkey,
  boxCount,
  nonceCounter,
  playerEntropy,  // 32 bytes (Buffer or Uint8Array)
}) {
  const body = {
    walletAddress,
    agentPubkey,
    boxCount,
    nonceCounter: String(nonceCounter),
    playerEntropy: Buffer.from(playerEntropy).toString('base64'),
  };
  const resp = await axios.post(endpoint(), body, {
    headers: {Authorization: `Bearer ${bearer()}`},
    timeout: 20000,
  });
  if (resp.status !== 200) {
    throw new Error(`signAgentBoxOpen returned ${resp.status}`);
  }
  return resp.data;
}

module.exports = {signAgentBoxOpen};
