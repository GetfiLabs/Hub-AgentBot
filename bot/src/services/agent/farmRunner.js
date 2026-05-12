// Runs ONE farming cycle for a single user:
//
//   1. Simulated farming   — pick {runs, gPerRun} from config, sum to gFarmed.
//   2. Read Hub G balance  — current available off-chain G.
//   3. Decide boxCount     — min(target, fuelAffordable, gAffordable(projected)).
//   4. On-chain (if >0)    — open_box_as_agent, sign + send + confirm.
//   5. Hub sync            — atomic credit gFarmed + debit gSpent + log txns.
//
// Verbose logging at every step so silent failures stop being silent.

const crypto = require('crypto');
const admin = require('firebase-admin');
const {PublicKey, sendAndConfirmTransaction} = require('@solana/web3.js');
const {getConnection} = require('../solana/connection');
const {loadActiveAgentAuthority} = require('../solana/agentAuthority');
const {buildOpenBoxAsAgentTx} = require('../solana/agentTx');
const {decodeEventsFromLogs} = require('../solana/eventCoder');
const {deriveFuelVault} = require('../solana/pdas');
const {signAgentBoxOpen} = require('./hubClient');
const {getAgentGBalance, syncAgentRun} = require('./hubSync');
const agentKeys = require('../wallet/agentKeys');
const {ensureAgentFunded} = require('../wallet/operationalWallet');
const database = require('../database');
const gameApi = require('../gameApi');

const DEFAULT_TARGET_BOX_COUNT = 10;
const DEFAULT_FUEL_PER_BOX = 308_000;
const G_COST_PER_BOX = 5_000;

function programId() {
  const id = process.env.GETFI_LOOTBOX_PROGRAM_ID
    || 'Bm6zsJgc87Hj6gGEtpHtyjP89Lwuu7TequM6dgPL8LA7';
  return new PublicKey(id);
}

function randInt(lo, hi) {
  const a = Math.min(lo, hi), b = Math.max(lo, hi);
  return Math.floor(a + Math.random() * (b - a + 1));
}

// Simulate offline runs and the G they collected.
function simulateFarming(cfg) {
  const runsMin = cfg.farming_runs_min || 3;
  const runsMax = cfg.farming_runs_max || 7;
  const gMin = cfg.farming_g_per_run_min || 1500;
  const gMax = cfg.farming_g_per_run_max || 4000;
  const runs = randInt(runsMin, runsMax);
  let gFarmed = 0;
  for (let i = 0; i < runs; i++) gFarmed += randInt(gMin, gMax);
  return {runs, gFarmed};
}

// Returns one of:
//   {status: 'opened',  txSignature, boxCount, gSpent, gFarmed, runs, getEarned}
//   {status: 'farmed_only', gFarmed, runs}                    (no boxes; G credited)
//   {status: 'skipped', reason}
//   {status: 'failed',  reason, error}
async function runFarmingSessionForAgentDoc(doc, opts = {}) {
  const cfg = opts.cfg || {};
  const targetBoxCount = opts.targetBoxCount || cfg.box_count_per_run || DEFAULT_TARGET_BOX_COUNT;
  const fuelPerBox = opts.fuelPerBoxLamports || cfg.fuel_lamports_per_box || DEFAULT_FUEL_PER_BOX;
  const userId = doc.platform_user_id;
  const tag = `[farmRunner ${userId}]`;

  try {
    if (!doc.wallet_address) {
      console.warn(`${tag} skipped — no wallet_address linked`);
      return {status: 'skipped', reason: 'no_wallet_linked'};
    }
    let walletPubkey;
    try {
      walletPubkey = new PublicKey(doc.wallet_address);
    } catch (e) {
      console.error(`${tag} invalid wallet_address "${doc.wallet_address}":`, e.message);
      return {status: 'skipped', reason: 'invalid_wallet_address'};
    }

    // Lookup Roll Raider playerId for this bot user (canonical sync target).
    // Missing player_id is non-fatal — bot still farms; we just skip the
    // Roll Raider write and log it.
    const botUser = await database.getPlayerByPlatformId(doc.platform, doc.platform_user_id).catch(() => null);
    const playerId = botUser?.player_id || null;
    if (!playerId) {
      console.warn(`${tag} no player_id linked — Roll Raider sync will be skipped this cycle`);
    }

    // ── Step 1: simulate farming ────────────────────────────────────
    const {runs, gFarmed} = simulateFarming(cfg);
    console.log(`${tag} farming → ${runs} runs, ${gFarmed} G`);

    // ── Step 2: load agent keypair + verify on-chain authority ──────
    const {keypair: agentKp} = await agentKeys.getOrCreateAgentKeypair(
      doc.platform,
      doc.platform_user_id,
      doc.wallet_address,
    );

    const auth = await loadActiveAgentAuthority({
      programId: programId(),
      userPubkey: walletPubkey,
      expectedAgentPubkey: agentKp.publicKey,
    });
    if (!auth.ok) {
      console.warn(`${tag} skipped — auth check failed: ${auth.reason}`);
      return {status: 'skipped', reason: `agent_auth_${auth.reason}`};
    }
    const onchainNonceCounter = auth.auth.nonceCounter;

    // ── Step 3: poll Hub for current G balance ──────────────────────
    let availableG = 0;
    try {
      const bal = await getAgentGBalance(doc.wallet_address);
      availableG = Number(bal.available || 0);
      console.log(
        `${tag} Hub balance: getPoints=${bal.getPoints} reserved=${bal.reservedPoints} ` +
        `available=${availableG} (projected with farm: ${availableG + gFarmed})`,
      );
    } catch (err) {
      console.warn(`${tag} Hub balance lookup failed: ${err.message}; assuming 0 baseline`);
    }
    const projectedG = availableG + gFarmed;

    // ── Step 4: compute boxCount = min(target, fuelAfford, gAfford) ──
    const connection = getConnection();
    const fuelPda = deriveFuelVault(programId(), walletPubkey);
    const fuelLamports = await connection.getBalance(fuelPda, 'confirmed');
    const fuelAffordable = Math.floor(fuelLamports / fuelPerBox);
    const gAffordable = Math.floor(projectedG / G_COST_PER_BOX);
    const boxCount = Math.max(0, Math.min(targetBoxCount, fuelAffordable, gAffordable));
    console.log(
      `${tag} affordability: target=${targetBoxCount}, fuelAfford=${fuelAffordable}, ` +
      `gAfford=${gAffordable} → opening ${boxCount}`,
    );

    // Pre-allocate the bot_agent_runs doc ref so its ID can be used as
    // a deterministic idempotency key for the Roll Raider farm credit.
    const runRef = admin.firestore().collection('bot_agent_runs').doc();
    const runId = runRef.id;
    const farmIdemKey = `raiderbot:run:${runId}`;

    // Pre-compute the eventual write record so the farmed-only branch
    // and the opened branch share the same Firestore field shape.
    const runFsBase = {
      platform: doc.platform,
      platform_user_id: doc.platform_user_id,
      wallet_address: doc.wallet_address,
      agent_pubkey: agentKp.publicKey.toBase58(),
      runs_completed: runs,
      g_farmed: gFarmed,
      player_id: playerId,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (boxCount <= 0) {
      // Still credit farming to Hub — the user is farming whether or
      // not the box flow is fundable this cycle.
      console.log(`${tag} no boxes this cycle — syncing farming-only`);
      try {
        await syncAgentRun({
          walletAddress: doc.wallet_address,
          agentPubkey: agentKp.publicKey.toBase58(),
          gFarmed,
          runsCompleted: runs,
          boxCount: 0,
          gSpent: 0,
          getEarned: '0',
          txSignature: null,
        });
      } catch (err) {
        console.error(`${tag} Hub sync (farm-only) failed: ${err.message}`);
      }

      await runRef.set({
        ...runFsBase,
        box_count: 0,
        g_spent: 0,
        nonce_counter: onchainNonceCounter.toString(),
        tx_signature: null,
        total_amount: null,
        fuel_remaining: fuelLamports.toString(),
        status: fuelAffordable <= 0 ? 'insufficient_fuel' : 'insufficient_g',
      });

      // Mirror farmed G to Roll Raider (canonical authority). Failure is
      // non-fatal — Hub ledger already has the credit.
      if (playerId && gFarmed > 0) {
        try {
          const resp = await gameApi.adjustCurrency({
            playerId,
            delta: gFarmed,
            reason: 'raiderbot_offline_farm',
            source: 'raiderbot',
            idempotencyKey: farmIdemKey,
            metadata: {runs, boxesOpened: 0, runDocId: runId},
          });
          console.log(`${tag} Roll Raider farm credit: applied=${resp.applied} newCurrency=${resp.currency}`);
        } catch (err) {
          console.error(`${tag} ⚠️  Roll Raider farm credit failed (Hub still consistent):`, err.message);
        }
      }

      // Promote pending → active so future ticks treat this user as
      // wired-up regardless of fund/fuel state.
      if (doc.status !== 'active') {
        await agentKeys.markStatus(doc.platform, doc.platform_user_id, 'active', {
          last_run_at: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        await agentKeys.markStatus(doc.platform, doc.platform_user_id, 'active', {
          last_run_at: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      return {status: 'farmed_only', gFarmed, runs};
    }

    // ── Step 5: request Hub backend signature for on-chain tx ────────
    const playerEntropy = crypto.randomBytes(32);
    const signed = await signAgentBoxOpen({
      walletAddress: walletPubkey.toBase58(),
      agentPubkey: agentKp.publicKey.toBase58(),
      boxCount,
      nonceCounter: onchainNonceCounter,
      playerEntropy,
    });
    console.log(`${tag} Hub signed (expiresAt=${signed.expiresAt}, rewardMint=${signed.rewardMint})`);

    // Cache the reward mint so the status reporter can read it without
    // requiring an extra env var.
    try {
      await admin.firestore()
        .collection('system_config')
        .doc('raider_bot')
        .set({reward_mint: signed.rewardMint}, {merge: true});
    } catch (e) {
      // non-fatal — env fallback covers this
    }

    const tx = buildOpenBoxAsAgentTx({
      programId: programId(),
      agent: agentKp.publicKey,
      user: walletPubkey,
      backendSigner: new PublicKey(signed.backendSigner),
      configPda: new PublicKey(signed.configPda),
      rewardMint: new PublicKey(signed.rewardMint),
      treasury: new PublicKey(signed.treasury),
      boxCount,
      nonceCounter: onchainNonceCounter,
      playerEntropy,
      backendCommitment: Buffer.from(signed.backendCommitment, 'base64'),
      backendSeed: Buffer.from(signed.backendSeed, 'base64'),
      expiresAt: signed.expiresAt,
      signature: Buffer.from(signed.signature, 'base64'),
      message: Buffer.from(signed.message, 'base64'),
    });

    await ensureAgentFunded(agentKp.publicKey);

    console.log(`${tag} broadcasting open_box_as_agent tx…`);
    const txSignature = await sendAndConfirmTransaction(connection, tx, [agentKp], {
      commitment: 'confirmed',
      skipPreflight: false,
    });
    console.log(`${tag} tx confirmed: ${txSignature}`);

    const parsed = await connection.getTransaction(txSignature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    const events = decodeEventsFromLogs(parsed?.meta?.logMessages || []);
    const opened = events.find((e) => e.name === 'AgentBoxOpened');
    if (!opened) {
      console.warn(`${tag} tx landed but no AgentBoxOpened event decoded`);
    }

    const gSpent = boxCount * G_COST_PER_BOX;
    const getEarnedStr = opened ? opened.totalAmount.toString() : '0';

    // ── Step 6: persist run record (bot's isolated Firestore) ────────
    await runRef.set({
      ...runFsBase,
      box_count: boxCount,
      g_spent: gSpent,
      nonce_counter: onchainNonceCounter.toString(),
      tx_signature: txSignature,
      total_amount: getEarnedStr,
      fuel_remaining: opened ? opened.fuelRemaining.toString() : null,
      status: 'confirmed',
    });

    await agentKeys.markStatus(doc.platform, doc.platform_user_id, 'active', {
      last_run_at: admin.firestore.FieldValue.serverTimestamp(),
      last_run_tx: txSignature,
    });

    // ── Step 7: Hub sync (off-chain G ledger + Hub history) ──────────
    try {
      const syncResp = await syncAgentRun({
        walletAddress: doc.wallet_address,
        agentPubkey: agentKp.publicKey.toBase58(),
        gFarmed,
        runsCompleted: runs,
        boxCount,
        gSpent,
        getEarned: getEarnedStr,
        txSignature,
      });
      console.log(
        `${tag} Hub synced: newGetPoints=${syncResp.newGetPoints} ` +
        `(credited=${syncResp.credited}, debited=${syncResp.debited})`,
      );
    } catch (err) {
      console.error(
        `${tag} ❌ Hub sync failed AFTER on-chain success — manual reconciliation needed:`,
        err.message,
      );
    }

    // ── Step 8: Roll Raider canonical sync (farm credit + box spend) ──
    // Idempotent: replay-safe via deterministic keys. Failure isolated
    // per call so a 5xx on one delta doesn't void the other.
    if (playerId) {
      if (gFarmed > 0) {
        try {
          const resp = await gameApi.adjustCurrency({
            playerId,
            delta: gFarmed,
            reason: 'raiderbot_offline_farm',
            source: 'raiderbot',
            idempotencyKey: farmIdemKey,
            metadata: {runs, boxesOpened: boxCount, runDocId: runId},
          });
          console.log(`${tag} Roll Raider farm credit: applied=${resp.applied} newCurrency=${resp.currency}`);
        } catch (err) {
          console.error(`${tag} ⚠️  Roll Raider farm credit failed:`, err.message);
        }
      }
      if (gSpent > 0) {
        try {
          const resp = await gameApi.adjustCurrency({
            playerId,
            delta: -gSpent,
            reason: 'raiderbot_lootbox_spend',
            source: 'raiderbot',
            idempotencyKey: `raiderbot:lootbox:${txSignature}`,
            metadata: {boxCount, txSignature, getEarned: getEarnedStr},
          });
          console.log(`${tag} Roll Raider box spend: applied=${resp.applied} newCurrency=${resp.currency}`);
        } catch (err) {
          console.error(`${tag} ⚠️  Roll Raider box spend failed:`, err.message);
        }
      }
    }

    return {
      status: 'opened',
      txSignature,
      boxCount,
      gSpent,
      gFarmed,
      runs,
      totalAmount: getEarnedStr,
      fuelRemaining: opened ? opened.fuelRemaining.toString() : null,
    };
  } catch (err) {
    console.error(`${tag} ❌ THREW:`, err.stack || err.message || err);
    if (err.logs) console.error(`${tag} program logs:`, err.logs);
    return {status: 'failed', reason: err.message || String(err), error: err};
  }
}

module.exports = {runFarmingSessionForAgentDoc, G_COST_PER_BOX, simulateFarming};
