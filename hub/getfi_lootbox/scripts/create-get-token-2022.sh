#!/usr/bin/env bash
set -euo pipefail

export PATH="/Users/cihan/.solana-custom/bin:${PATH}"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PROGRAM_ID="${PROGRAM_ID:-Adk7dnM6okakjN9YrRsSo1VvcBi5BBwGNwk9UyZjomQy}"
CLUSTER="${CLUSTER:-devnet}"
DECIMALS="${DECIMALS:-6}"
TOKEN_2022_PROGRAM="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

CONFIG_PDA="$(node - <<'NODE'
const { PublicKey } = require('@solana/web3.js');
const programId = new PublicKey(process.env.PROGRAM_ID || 'Adk7dnM6okakjN9YrRsSo1VvcBi5BBwGNwk9UyZjomQy');
const [pda] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId);
console.log(pda.toBase58());
NODE
)"

mkdir -p keys
MINT_KEYPAIR="${MINT_KEYPAIR:-keys/get-token-mint.json}"

if [ ! -f "$MINT_KEYPAIR" ]; then
  solana-keygen new --no-bip39-passphrase --silent --outfile "$MINT_KEYPAIR"
fi

MINT_ADDRESS="$(solana-keygen pubkey "$MINT_KEYPAIR")"

echo "Program ID: $PROGRAM_ID"
echo "Config PDA / mint+freeze authority: $CONFIG_PDA"
echo "GET mint keypair: $MINT_KEYPAIR"
echo "GET mint address: $MINT_ADDRESS"

if spl-token --url "$CLUSTER" --program-id "$TOKEN_2022_PROGRAM" display "$MINT_ADDRESS" >/dev/null 2>&1; then
  echo "Token already exists on $CLUSTER: $MINT_ADDRESS"
else
  spl-token --url "$CLUSTER" \
    --program-id "$TOKEN_2022_PROGRAM" \
    create-token "$MINT_KEYPAIR" \
    --decimals "$DECIMALS" \
    --enable-freeze
fi

spl-token --url "$CLUSTER" \
  --program-id "$TOKEN_2022_PROGRAM" \
  authorize "$MINT_ADDRESS" mint "$CONFIG_PDA"

spl-token --url "$CLUSTER" \
  --program-id "$TOKEN_2022_PROGRAM" \
  authorize "$MINT_ADDRESS" freeze "$CONFIG_PDA"

echo "GET Token-2022 mint is ready."
echo "Mint: $MINT_ADDRESS"
echo "Authority PDA: $CONFIG_PDA"
