/**
 * Raider Bot — Main Entry Point
 *
 * Boot order:
 *   1. Firebase Admin (Bot Memory)
 *   2. Firestore runtime config — seeded in background (never blocks)
 *   3. Telegram bot — fire-and-forget launch (Telegraf v4 long-polling
 *      promise only resolves on stop(), so we MUST NOT await it)
 *   4. Command menu publish + scheduler + status reporter
 *
 * Every step logs explicitly. If you see a gap between two step logs,
 * that's the step that hung.
 */

require('dotenv').config();

const database = require('./services/database');
const bot = require('./bot/telegram');
const config = require('./services/config');
const {startScheduler} = require('./services/agent/scheduler');
const statusReporter = require('./services/agent/statusReporter');

function logStep(n, msg) {
  console.log(`[boot ${n}] ${msg}`);
}

// Wrap any promise so a stuck network call surfaces instead of hanging
// main() silently. Resolves to `null` on timeout; the boot continues.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((resolve) =>
      setTimeout(() => {
        console.warn(`⏱️  [boot] "${label}" timed out after ${ms}ms — continuing.`);
        resolve(null);
      }, ms),
    ),
  ]);
}

async function main() {
  console.log('🤖 Raider Bot starting...');
  console.log('──────────────────────────────');

  // ── 1. Firebase ───────────────────────────────────────────────────
  logStep(1, 'initializing Firebase…');
  try {
    await database.initializeDatabase();
    logStep(1, '✅ Firebase ready');
  } catch (error) {
    console.error('❌ [boot 1] Firebase failed:', error.stack || error.message);
    console.error('💡 Check serviceAccountKey.json and FIREBASE_SERVICE_ACCOUNT_PATH.');
    process.exit(1);
  }

  // ── 2. Firestore config seed (non-blocking — runs in background) ──
  logStep(2, 'seeding Firestore runtime config in background…');
  withTimeout(config.ensureSeeded(), 8000, 'config.ensureSeeded')
    .then(() => logStep(2, '✅ config seed call returned'))
    .catch((err) => console.error('⚠️  [boot 2] ensureSeeded threw:', err.stack || err.message));

  // ── 3. Telegram bot ───────────────────────────────────────────────
  // CRITICAL: Telegraf v4's bot.launch() in long-polling mode returns a
  // promise that only resolves when bot.stop() is called. If we `await`
  // it, the rest of main() never runs. So we fire-and-forget here and
  // attach `.catch` for crash visibility.
  logStep(3, 'launching Telegram bot (fire-and-forget)…');
  bot.launch()
    .then(() => logStep(3, 'Telegram bot polling loop ended (this is the stop signal).'))
    .catch((err) => {
      console.error('❌ [boot 3] Telegram bot crashed:', err.stack || err.message);
      console.error('💡 Check TELEGRAM_BOT_TOKEN in .env.');
    });

  // Wait briefly for getUpdates handshake to complete before publishing
  // the command menu (setMyCommands needs an authenticated session).
  await new Promise((r) => setTimeout(r, 1500));
  logStep(3, '✅ Telegram bot launch dispatched');

  // ── 4. Command menu (non-blocking) ────────────────────────────────
  logStep(4, 'publishing Telegram command menu…');
  if (typeof bot.publishCommandMenu === 'function') {
    withTimeout(bot.publishCommandMenu(), 5000, 'publishCommandMenu')
      .then(() => logStep(4, '✅ command menu publish call returned'))
      .catch((err) => console.warn('⚠️  [boot 4] publishCommandMenu threw:', err.message));
  } else {
    console.warn('⚠️  [boot 4] bot.publishCommandMenu is not a function — skipping');
  }

  // ── 5. Agent scheduler ────────────────────────────────────────────
  logStep(5, 'starting agent farming scheduler…');
  try {
    startScheduler();
    logStep(5, '✅ scheduler started');
  } catch (error) {
    console.error('⚠️  [boot 5] scheduler failed:', error.stack || error.message);
    console.error('💡 Check SOLANA_RPC_URL, HUB_SIGN_AGENT_BOX_URL, BOT_AGENT_SHARED_SECRET, BOT_AGENT_MASTER_KEY.');
  }

  // ── 6. Status reporter ────────────────────────────────────────────
  logStep(6, 'starting status reporter…');
  try {
    statusReporter.setBot(bot);
    statusReporter.start();
    logStep(6, '✅ status reporter started');
  } catch (error) {
    console.error('⚠️  [boot 6] status reporter failed:', error.stack || error.message);
  }

  console.log('──────────────────────────────');
  console.log('📋 Commands: /start /playerid /stats /connectagent /agentstatus /report /resign /rule /reset /help');
  console.log('🎉 Boot complete. Bot is running.');
  console.log('──────────────────────────────');

  // ── Graceful shutdown ─────────────────────────────────────────────
  const shutdown = async (signal) => {
    console.log(`\n⏹️  ${signal} received. Shutting down…`);
    try { bot.stop(signal); } catch {}
    try { await database.shutdown(); } catch {}
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

// Surface any unhandled promise so we don't silently miss errors.
process.on('unhandledRejection', (reason) => {
  console.error('🔥 unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('🔥 uncaughtException:', err.stack || err.message);
});

main().catch((err) => {
  console.error('🔥 main() threw:', err.stack || err.message);
  process.exit(1);
});
