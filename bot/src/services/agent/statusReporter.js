// Periodic agent activity report.
//
// Sends ONE cohesive Raider-voice message per user per interval that
// summarizes:
//   • Farming since last report (runs + G collected)
//   • On-chain box opening since last report (boxes, G spent, $GET earned)
//   • Current on-chain $GET wallet balance
//
// Skips users with zero activity. Interval is Firestore-driven
// (status_report_interval_minutes). Per-user gating uses
// bot_users.last_status_report_at.

const cron = require('node-cron');
const admin = require('firebase-admin');
const {PublicKey} = require('@solana/web3.js');
const config = require('../config');
const database = require('../database');
const agentKeys = require('../wallet/agentKeys');
const {getGetTokenBalance} = require('../solana/tokenBalance');

let botRef = null;
function setBot(b) { botRef = b; }

const TICK_SCHEDULE = '* * * * *';

async function tick() {
  if (!botRef) return;

  let cfg;
  try {
    cfg = await config.getConfig();
  } catch (err) {
    console.error('❌ [StatusReporter] config read failed:', err.message);
    return;
  }
  const intervalMs = cfg.status_report_interval_minutes * 60 * 1000;
  const cutoffMs = Date.now() - intervalMs;

  let users;
  try {
    users = await database.getAllActiveTelegramUsers();
  } catch (err) {
    console.error('❌ [StatusReporter] user list failed:', err.message);
    return;
  }

  for (const user of users) {
    try {
      const last = user.last_status_report_at
        ? user.last_status_report_at.toMillis?.() ?? 0
        : 0;
      if (last > cutoffMs) continue;
      await sendOne(user, last);
    } catch (err) {
      console.error(`❌ [StatusReporter] ${user.platform_user_id} failed:`, err.stack || err.message);
    }
  }
}

async function sendOne(user, lastReportAtMs) {
  const chatId = user.platform_user_id;

  // ── Aggregate agent runs since last report ──────────────────────────
  const agentDoc = await agentKeys.getDoc('telegram', chatId).catch(() => null);
  if (!agentDoc) {
    // User hasn't connected an agent — skip silently.
    await touchReportTimestamp(chatId);
    return;
  }

  const sinceTs = lastReportAtMs > 0
    ? admin.firestore.Timestamp.fromMillis(lastReportAtMs)
    : null;

  let q = admin.firestore()
    .collection('bot_agent_runs')
    .where('platform', '==', 'telegram')
    .where('platform_user_id', '==', chatId);
  if (sinceTs) q = q.where('created_at', '>', sinceTs);
  const snap = await q.get();

  let runs = 0;
  let gFarmed = 0;
  let boxes = 0;
  let gSpent = 0;
  let getEarned = 0n;
  for (const d of snap.docs) {
    const data = d.data();
    runs += Number(data.runs_completed || 0);
    gFarmed += Number(data.g_farmed || 0);
    boxes += Number(data.box_count || 0);
    gSpent += Number(data.g_spent || (Number(data.box_count || 0) * 5000));
    if (data.total_amount) {
      try { getEarned += BigInt(data.total_amount); } catch {}
    }
  }

  if (runs === 0 && boxes === 0 && gFarmed === 0) {
    // Nothing happened — don't spam.
    await touchReportTimestamp(chatId);
    return;
  }

  // ── On-chain $GET balance ───────────────────────────────────────────
  let getBalanceLine = '';
  if (agentDoc.wallet_address) {
    try {
      const bal = await getGetTokenBalance(new PublicKey(agentDoc.wallet_address));
      getBalanceLine = `\n\n💰 Your wallet now holds ${bal.ui} $GET.`;
    } catch (err) {
      console.warn(`   [StatusReporter] on-chain $GET lookup failed for ${chatId}: ${err.message}`);
    }
  }

  // ── Build the Raider-voice message ───────────────────────────────────
  const lines = [];
  lines.push('📡 Raider Status Report');
  lines.push('');

  if (boxes > 0) {
    lines.push(
      `While you were away I knocked out ${runs} ${runs === 1 ? 'run' : 'runs'} ` +
      `and pulled in ${gFarmed.toLocaleString()} G. ` +
      `Hit the Hub afterwards — popped ${boxes} ${boxes === 1 ? 'box' : 'boxes'}, ` +
      `spent ${gSpent.toLocaleString()} G, and sent ${getEarned.toString()} $GET to your wallet.`,
    );
  } else if (gFarmed > 0) {
    lines.push(
      `Got ${runs} ${runs === 1 ? 'run' : 'runs'} done while you were out — ` +
      `${gFarmed.toLocaleString()} G in the bank. ` +
      `Didn't crack any boxes this round (saving fuel or stacking G).`,
    );
  } else {
    // runs but no farming and no boxes — shouldn't happen but handle gracefully
    lines.push(`Quiet shift. Nothing to report yet.`);
  }

  const msg = lines.join('\n') + getBalanceLine;

  try {
    await botRef.telegram.sendMessage(chatId, msg);
    await touchReportTimestamp(chatId);
  } catch (err) {
    if (err.response && err.response.error_code === 403) {
      await database.updateUserStatus('telegram', String(chatId), 'blocked').catch(() => {});
    } else {
      console.error(`   send failed for ${chatId}:`, err.message);
    }
  }
}

async function touchReportTimestamp(chatId) {
  try {
    await admin.firestore()
      .collection('bot_users')
      .doc(`telegram_${chatId}`)
      .update({
        last_status_report_at: admin.firestore.FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn(`   [StatusReporter] touch ts failed for ${chatId}: ${err.message}`);
  }
}

function start() {
  console.log('🔔 [StatusReporter] starting — interval from Firestore (status_report_interval_minutes)');
  cron.schedule(TICK_SCHEDULE, () => {
    tick().catch((err) => console.error('❌ [StatusReporter] uncaught:', err));
  });
}

module.exports = {start, setBot, tick};
