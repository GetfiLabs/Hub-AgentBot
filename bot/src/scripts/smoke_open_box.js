// End-to-end smoke test for the Phase 3 agent box-opening flow.
//
//   register_agent  →  deposit_fuel  →  open_box_as_agent  →  withdraw_fuel
//
// Targets devnet against the deployed program. Bypasses the Hub HTTP
// endpoint and signs the backend message locally with the same wallet
// that initialized Config (and is therefore Config.backend_signer).
// Loads ~/.config/solana/id.json — no env-secrets needed beyond a
// SOLANA_RPC_URL override for non-default RPC endpoints.
//
// Usage:
//   BOT_AGENT_MASTER_KEY=$(openssl rand -hex 32) \
//     node src/scripts/smoke_open_box.js [--box-count=1]

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const nacl = require('tweetnacl');
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');

const {
  buildOpenBoxAsAgentTx,
} = require('../services/solana/agentTx');
const {
  deriveAgentAuthority,
  deriveFuelVault,
  deriveConfig,
} = require('../services/solana/pdas');
const {
  fetchAgentAuthority,
} = require('../services/solana/agentAuthority');

const PROGRAM_ID = new PublicKey(
  process.env.GETFI_LOOTBOX_PROGRAM_ID
    || 'Bm6zsJgc87Hj6gGEtpHtyjP89Lwuu7TequM6dgPL8LA7',
);
const REWARD_MINT = new PublicKey(
  process.env.GETFI_REWARD_MINT
    || '3rTrMpMPQ3Nj7ktRkBYcLmB5diqqhtcw348oq9Poq5Eo',
);
const TREASURY = new PublicKey(
  'A3TgoR4ArUEsQiuXLM9ikoE2wA8uQPFxEdGxnfGXFqxb',
);

const AGENT_MESSAGE_DOMAIN = Buffer.from('GETFI_AGENT_BOX_V1');
const AGENT_ACTION_OPEN_BOX = 1;

function loadWallet() {
  const p = path.resolve(os.homedir(), '.config/solana/id.json');
  const bytes = Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf8')));
  return Keypair.fromSecretKey(bytes);
}

function writeI64LE(value) {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(value));
  return out;
}
function writeU64LE(value) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

function buildAgentMessage({
  config, user, agent, rewardMint, boxCount, nonceCounter,
  playerEntropy, backendCommitment, expiresAt,
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

// ── Anchor instruction discriminators ──────────────────────────────────────
function disc(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}
const REGISTER_AGENT_DISC = disc('register_agent');
const DEPOSIT_FUEL_DISC = disc('deposit_fuel');
const WITHDRAW_FUEL_DISC = disc('withdraw_fuel');

function buildRegisterAgentIx({user, agentPubkey, allowedActions, expiryTs}) {
  const agentAuthority = deriveAgentAuthority(PROGRAM_ID, user);
  const data = Buffer.concat([
    REGISTER_AGENT_DISC,
    agentPubkey.toBuffer(),
    Buffer.from(Uint32Array.of(allowedActions).buffer),
    writeI64LE(expiryTs),
  ]);
  const keys = [
    {pubkey: user, isSigner: true, isWritable: true},
    {pubkey: agentAuthority, isSigner: false, isWritable: true},
    {pubkey: SystemProgram.programId, isSigner: false, isWritable: false},
  ];
  return new TransactionInstruction({programId: PROGRAM_ID, keys, data});
}

function buildDepositFuelIx({user, lamports}) {
  const agentAuthority = deriveAgentAuthority(PROGRAM_ID, user);
  const fuelVault = deriveFuelVault(PROGRAM_ID, user);
  const data = Buffer.concat([DEPOSIT_FUEL_DISC, writeU64LE(lamports)]);
  const keys = [
    {pubkey: user, isSigner: true, isWritable: true},
    {pubkey: agentAuthority, isSigner: false, isWritable: false},
    {pubkey: fuelVault, isSigner: false, isWritable: true},
    {pubkey: SystemProgram.programId, isSigner: false, isWritable: false},
  ];
  return new TransactionInstruction({programId: PROGRAM_ID, keys, data});
}

// withdraw_fuel(amount: Option<u64>). Borsh: 0u8 for None, 1u8 + u64 LE for Some.
function buildWithdrawFuelIx({authority, user, amount}) {
  const agentAuthority = deriveAgentAuthority(PROGRAM_ID, user);
  const fuelVault = deriveFuelVault(PROGRAM_ID, user);
  let amountBytes;
  if (amount === null || amount === undefined) {
    amountBytes = Buffer.from([0]);
  } else {
    amountBytes = Buffer.concat([Buffer.from([1]), writeU64LE(amount)]);
  }
  const data = Buffer.concat([WITHDRAW_FUEL_DISC, amountBytes]);
  const keys = [
    {pubkey: authority, isSigner: true, isWritable: false},
    {pubkey: user, isSigner: false, isWritable: true},
    {pubkey: agentAuthority, isSigner: false, isWritable: false},
    {pubkey: fuelVault, isSigner: false, isWritable: true},
    {pubkey: SystemProgram.programId, isSigner: false, isWritable: false},
  ];
  return new TransactionInstruction({programId: PROGRAM_ID, keys, data});
}

// ── Main flow ──────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2).reduce((acc, arg) => {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) acc[m[1]] = m[2];
    return acc;
  }, {});
  const boxCount = Number(args['box-count'] || 1);

  const url = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
  const connection = new Connection(url, 'confirmed');

  // wallet = backend signer (= Config.backend_signer = devnet ~/.config/solana/id.json)
  const backendSigner = loadWallet();
  console.log('🔑 Backend signer / fee payer:', backendSigner.publicKey.toBase58());

  // Test user — fresh keypair. We'll airdrop to it.
  const user = Keypair.generate();
  const agent = Keypair.generate();
  console.log('👤 Test user:', user.publicKey.toBase58());
  console.log('🤖 Test agent:', agent.publicKey.toBase58());

  // Fund user (for register_agent rent + their own register tx fee) and
  // agent (for the open_box tx fee at submit time; will be reimbursed
  // from FuelVault per the program).
  console.log('💸 Funding user + agent from backend signer...');
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: backendSigner.publicKey,
      toPubkey: user.publicKey,
      lamports: 0.1 * LAMPORTS_PER_SOL,
    }),
    SystemProgram.transfer({
      fromPubkey: backendSigner.publicKey,
      toPubkey: agent.publicKey,
      lamports: 0.05 * LAMPORTS_PER_SOL,
    }),
  );
  await sendAndConfirmTransaction(connection, fundTx, [backendSigner], {
    commitment: 'confirmed',
  });

  // 1. register_agent (signed by user) ────────────────────────────────────
  console.log('📝 register_agent…');
  const expiry = Math.floor(Date.now() / 1000) + 30 * 86400;
  const regTx = new Transaction().add(buildRegisterAgentIx({
    user: user.publicKey,
    agentPubkey: agent.publicKey,
    allowedActions: AGENT_ACTION_OPEN_BOX,
    expiryTs: expiry,
  }));
  const regSig = await sendAndConfirmTransaction(connection, regTx, [user], {
    commitment: 'confirmed',
  });
  console.log('   tx:', regSig);

  // 2. deposit_fuel (signed by user) ──────────────────────────────────────
  const fuelLamports = 0.02 * LAMPORTS_PER_SOL;
  console.log(`⛽ deposit_fuel ${fuelLamports} lamports…`);
  const depTx = new Transaction().add(buildDepositFuelIx({
    user: user.publicKey,
    lamports: fuelLamports,
  }));
  const depSig = await sendAndConfirmTransaction(connection, depTx, [user], {
    commitment: 'confirmed',
  });
  console.log('   tx:', depSig);

  // 3. open_box_as_agent ──────────────────────────────────────────────────
  console.log('📦 open_box_as_agent…');
  const auth = await fetchAgentAuthority(PROGRAM_ID, user.publicKey);
  if (!auth) throw new Error('AgentAuthority did not land on chain');
  console.log('   on-chain nonce_counter:', auth.nonceCounter.toString());

  const playerEntropy = crypto.randomBytes(32);
  const backendSeed = crypto.randomBytes(32);
  const backendCommitment = crypto.createHash('sha256').update(backendSeed).digest();
  const expiresAt = Math.floor(Date.now() / 1000) + 5 * 60;
  const configPda = deriveConfig(PROGRAM_ID);
  const message = buildAgentMessage({
    config: configPda,
    user: user.publicKey,
    agent: agent.publicKey,
    rewardMint: REWARD_MINT,
    boxCount,
    nonceCounter: auth.nonceCounter,
    playerEntropy,
    backendCommitment,
    expiresAt,
  });
  const signature = Buffer.from(
    nacl.sign.detached(message, backendSigner.secretKey),
  );

  const openTx = buildOpenBoxAsAgentTx({
    programId: PROGRAM_ID,
    agent: agent.publicKey,
    user: user.publicKey,
    backendSigner: backendSigner.publicKey,
    configPda,
    rewardMint: REWARD_MINT,
    treasury: TREASURY,
    boxCount,
    nonceCounter: auth.nonceCounter,
    playerEntropy,
    backendCommitment,
    backendSeed,
    expiresAt,
    signature,
    message,
  });
  const openSig = await sendAndConfirmTransaction(connection, openTx, [agent], {
    commitment: 'confirmed',
    skipPreflight: false,
  });
  console.log('   tx:', openSig);

  // Pull the parsed tx logs to surface the AgentBoxOpened event.
  const parsed = await connection.getTransaction(openSig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  const logs = parsed?.meta?.logMessages || [];
  const eventLine = logs.find((l) => l.includes('Program data:'));
  console.log('   event logs:', eventLine || '(none)');

  const fuelPda = deriveFuelVault(PROGRAM_ID, user.publicKey);
  const fuelAfter = await connection.getBalance(fuelPda);
  console.log(`   fuel remaining: ${fuelAfter} lamports`);

  // 4. withdraw_fuel — agent drains the vault back to user (the /istifa path).
  console.log('🏁 withdraw_fuel (agent-signed, drain-all)…');
  const wTx = new Transaction().add(buildWithdrawFuelIx({
    authority: agent.publicKey,
    user: user.publicKey,
    amount: null,
  }));
  const wSig = await sendAndConfirmTransaction(connection, wTx, [agent], {
    commitment: 'confirmed',
  });
  console.log('   tx:', wSig);
  const fuelFinal = await connection.getBalance(fuelPda);
  console.log(`   fuel after drain: ${fuelFinal} lamports`);

  console.log('\n✅ smoke test passed end-to-end.');
}

main().catch((e) => {
  console.error('\n❌ smoke test failed:', e);
  if (e.logs) console.error('logs:', e.logs);
  process.exit(1);
});
