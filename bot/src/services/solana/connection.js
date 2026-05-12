const {Connection} = require('@solana/web3.js');
require('dotenv').config();

let cached = null;

function getConnection() {
  if (cached) return cached;
  const url = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
  cached = new Connection(url, 'confirmed');
  return cached;
}

module.exports = {getConnection};
