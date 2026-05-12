// Agent farming scheduler.
//
// Reads run_interval_minutes from Firestore (system_config/raider_bot)
// on every tick so the cadence can be tuned live. node-cron fires every
// minute; verbose logging on every tick so operators can diagnose stalls
// without attaching a debugger.

const cron = require('node-cron');
const {listEligibleAgents} = require('../wallet/agentKeys');
const {runFarmingSessionForAgentDoc} = require('./farmRunner');
const config = require('../config');

const TICK_SCHEDULE = '* * * * *'; // every minute

let tickCounter = 0;
let tickInFlight = false;

async function runOneTick() {
  if (tickInFlight) {
    console.log('⏭️  [Scheduler] Previous tick still running — skipping this minute.');
    return;
  }
  tickInFlight = true;
  const tickId = ++tickCounter;
  const startedAt = Date.now();

  try {
    console.log(`\n🌀 [Scheduler #${tickId}] tick at ${new Date().toISOString()}`);

    let cfg;
    try {
      cfg = await config.getConfig();
    } catch (err) {
      console.error(`❌ [Scheduler #${tickId}] config read failed:`, err.stack || err.message);
      return;
    }
    const intervalMs = cfg.run_interval_minutes * 60 * 1000;
    console.log(
      `   config: run_interval=${cfg.run_interval_minutes}m, ` +
      `box_count=${cfg.box_count_per_run}, ` +
      `fuel_per_box=${cfg.fuel_lamports_per_box} lamports`,
    );

    let scan;
    try {
      scan = await listEligibleAgents(intervalMs);
    } catch (err) {
      console.error(`❌ [Scheduler #${tickId}] listEligibleAgents failed:`, err.stack || err.message);
      return;
    }
    console.log(
      `   scanned ${scan.totalScanned} agent doc(s) — ` +
      `${scan.eligible.length} eligible, ${scan.skipped.length} on cooldown`,
    );

    if (scan.skipped.length > 0) {
      for (const s of scan.skipped) {
        console.log(`   ⏳ ${s.platform_user_id} (${s.status}) — ${s.reason}`);
      }
    }

    if (scan.eligible.length === 0) {
      console.log(`💤 [Scheduler #${tickId}] nothing to do.`);
      return;
    }

    for (const doc of scan.eligible) {
      console.log(`   ▶️  running ${doc.platform_user_id} (${doc._reason}, status=${doc.status})`);
      try {
        const result = await runFarmingSessionForAgentDoc(doc, {
          cfg,
          targetBoxCount: cfg.box_count_per_run,
          fuelPerBoxLamports: cfg.fuel_lamports_per_box,
        });
        console.log(
          `   ← ${doc.platform_user_id}: ${result.status}` +
          (result.reason ? ` (${result.reason})` : '') +
          (result.runs ? ` runs=${result.runs}` : '') +
          (result.gFarmed ? ` gFarmed=${result.gFarmed}` : '') +
          (result.boxCount ? ` boxes=${result.boxCount}` : '') +
          (result.gSpent ? ` gSpent=${result.gSpent}` : '') +
          (result.totalAmount ? ` getEarned=${result.totalAmount}` : '') +
          (result.txSignature ? ` tx=${result.txSignature.slice(0, 16)}…` : ''),
        );
      } catch (err) {
        console.error(
          `❌ [Scheduler #${tickId}] ${doc.platform_user_id} threw:`,
          err.stack || err.message,
        );
      }
    }

    const elapsed = Date.now() - startedAt;
    console.log(`✅ [Scheduler #${tickId}] complete in ${elapsed}ms.`);
  } finally {
    tickInFlight = false;
  }
}

function startScheduler() {
  console.log(`🔄 [Scheduler] node-cron schedule: "${TICK_SCHEDULE}" — every minute, config from Firestore.`);
  cron.schedule(TICK_SCHEDULE, () => {
    runOneTick().catch((err) => {
      console.error('❌ [Scheduler] uncaught tick error:', err.stack || err.message);
    });
  });

  // Kick a tick immediately so the bot doesn't wait up to 60s after boot
  // before the operator sees any output. Useful for "I just deployed —
  // is the scheduler alive?" sanity checks.
  setTimeout(() => {
    console.log('🚀 [Scheduler] firing initial tick (boot warm-up)…');
    runOneTick().catch((err) => {
      console.error('❌ [Scheduler] boot tick error:', err.stack || err.message);
    });
  }, 3000);
}

module.exports = {startScheduler, runOneTick};
