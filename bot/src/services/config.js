// Firestore-backed runtime config for RaiderBot.
//
// Doc path: system_config/raider_bot
// Fields (all optional — sane defaults applied):
//   run_interval_minutes              (default 10)   — agent farming cadence
//   box_count_per_run                 (default 10)   — desired boxes per cycle
//   fuel_lamports_per_box             (default 308000) — fuel consumed per box (estimate)
//   status_report_interval_minutes    (default 5)    — periodic check-in to users
//
// Values are cached for CACHE_TTL_MS so a busy scheduler doesn't hit
// Firestore on every tick.

const admin = require('firebase-admin');

const DOC_PATH = ['system_config', 'raider_bot'];
const CACHE_TTL_MS = 15 * 1000; // 15s — admin edits propagate in <1 minute

const DEFAULTS = Object.freeze({
  run_interval_minutes: 10,
  box_count_per_run: 10,
  fuel_lamports_per_box: 308_000,
  status_report_interval_minutes: 5,
  // Simulated offline farming — Raider "does runs" between cycles.
  // Per cycle: pick runs ∈ [min, max], g_per_run ∈ [min, max] uniformly.
  // Defaults aim for ~9–28k G per 10-minute cycle.
  farming_runs_min: 3,
  farming_runs_max: 7,
  farming_g_per_run_min: 1500,
  farming_g_per_run_max: 4000,
});

let cache = null;
let cacheAt = 0;

async function fetchRaw() {
  try {
    const snap = await admin.firestore()
      .collection(DOC_PATH[0])
      .doc(DOC_PATH[1])
      .get();
    if (!snap.exists) return {};
    return snap.data() || {};
  } catch (err) {
    console.warn(`⚠️  [Config] Firestore read failed (${err.message}); using cached/defaults.`);
    return null; // signal: keep last cache
  }
}

function applyDefaults(raw) {
  const out = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const fromDoc = raw && raw[k];
    out[k] = typeof fromDoc === 'number' && Number.isFinite(fromDoc) && fromDoc > 0
      ? fromDoc
      : v;
  }
  return out;
}

async function getConfig() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL_MS) return cache;

  const raw = await fetchRaw();
  if (raw === null && cache) return cache;

  const merged = applyDefaults(raw || {});
  cache = merged;
  cacheAt = now;
  return merged;
}

// Force-refresh cache; useful for tests + admin "apply now" flows.
async function refresh() {
  cacheAt = 0;
  return getConfig();
}

// Ensure the doc exists with default values so an admin sees the schema
// in Firestore console. Idempotent and safe to call on every startup.
async function ensureSeeded() {
  try {
    const ref = admin.firestore()
      .collection(DOC_PATH[0])
      .doc(DOC_PATH[1]);
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set({
        ...DEFAULTS,
        _description: 'RaiderBot runtime config. Edit values in Firestore — bot picks up changes within ~15s.',
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`📝 [Config] Seeded ${DOC_PATH.join('/')} with defaults.`);
    }
  } catch (err) {
    console.warn(`⚠️  [Config] ensureSeeded failed (${err.message}); continuing with defaults.`);
  }
}

module.exports = {DEFAULTS, getConfig, refresh, ensureSeeded};
