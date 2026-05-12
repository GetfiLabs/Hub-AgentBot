/**
 * Game API Service — Roll Raider canonical user store.
 *
 * Roll Raider's HTTP Players API is the single source of truth for
 * `currency` (G) and player stats. The bot only reads from it and writes
 * idempotent deltas; it never mirrors the data locally.
 *
 * Auth: X-API-Key header (NOT Bearer — Cloud Run's frontend rejects
 * Bearer tokens by treating them as Google IAM ID tokens).
 *
 * Field mapping (Roll Raider → bot internals):
 *   currency        → getToken / G balance
 *   premiumCurrency → diamonds
 *   maxScore        → highScore
 *   sessionsPlayed  → totalRuns
 *   level           → level
 *
 * Roll Raider's `users/{uid}` document ID must equal the `player_id`
 * string the bot stores for each Telegram account.
 */

const axios = require('axios');
require('dotenv').config();

const DEFAULT_BASE = 'https://europe-central2-wikzrollraider.cloudfunctions.net/playersApi/v1';
const GAME_API_BASE = process.env.GAME_API_BASE_URL || DEFAULT_BASE;
const GAME_API_KEY = process.env.GAME_API_KEY;

const gameClient = axios.create({
  baseURL: GAME_API_BASE,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    ...(GAME_API_KEY ? {'X-API-Key': GAME_API_KEY} : {}),
  },
});

function assertKey() {
  if (!GAME_API_KEY) {
    throw new Error('GAME_API_KEY env is not set — cannot call Roll Raider API.');
  }
}

// ───────────────────────── Existence check ─────────────────────────
/**
 * GET /users/{uid} — returns true if the player exists, false on 404.
 * Throws for other transport errors so caller can decide.
 */
async function validatePlayerId(playerId) {
  assertKey();
  try {
    const resp = await gameClient.get(`/users/${encodeURIComponent(playerId)}`);
    return resp.status === 200 && resp.data?.exists === true;
  } catch (err) {
    if (err.response && err.response.status === 404) return false;
    console.error(`❌ validatePlayerId(${playerId}) failed:`, err.message);
    throw err;
  }
}

// ───────────────────────── Stats (canonical balance) ─────────────────────────
/**
 * GET /users/{uid}/stats — canonical balances + stats.
 * Returns internal bot shape; raw fields preserved under `_raw` for debug.
 * Returns null on transport failure so callers can fall back to cache.
 */
async function fetchPlayerStats(playerId) {
  assertKey();
  try {
    const resp = await gameClient.get(`/users/${encodeURIComponent(playerId)}/stats`);
    const d = resp.data || {};
    return {
      level: Number(d.level ?? 0),
      getToken: Number(d.currency ?? 0),       // G balance, canonical
      diamonds: Number(d.premiumCurrency ?? 0),
      highScore: Number(d.maxScore ?? 0),
      sessionsPlayed: Number(d.sessionsPlayed ?? 0),
      lastPlayedAt: d.lastPlayedAt ?? null,
      updatedAt: d.updatedAt ?? null,
      _raw: d,
    };
  } catch (err) {
    if (err.response && err.response.status === 404) {
      console.warn(`fetchPlayerStats: player ${playerId} not found in Roll Raider DB`);
      return null;
    }
    console.error(`❌ fetchPlayerStats(${playerId}) failed:`, err.message);
    return null;
  }
}

// ───────────────────────── Currency delta (write) ─────────────────────────
/**
 * POST /users/{uid} — idempotent currency adjustment.
 *
 * @param {Object} params
 * @param {string} params.playerId
 * @param {number} params.delta            non-zero integer; + earn, − spend
 * @param {string} params.reason           short code, e.g. 'raiderbot_offline_farm'
 * @param {string} params.source           'raiderbot' | 'getfihub' | 'roll_raider'
 * @param {string} params.idempotencyKey   `<source>:<scope>:<id>` — deterministic per logical op
 * @param {Object} [params.metadata]       free-form JSON
 * @param {string} [params.occurredAt]     ISO-8601; defaults to now
 *
 * Returns { uid, currency, delta, applied } on success.
 * Throws on 4xx/5xx; caller decides whether to retry / log.
 */
async function adjustCurrency({
  playerId,
  delta,
  reason,
  source,
  idempotencyKey,
  metadata,
  occurredAt,
}) {
  assertKey();
  if (!playerId) throw new Error('adjustCurrency: playerId required');
  if (!Number.isInteger(delta) || delta === 0) {
    throw new Error(`adjustCurrency: delta must be non-zero integer (got ${delta})`);
  }
  if (!reason || !source || !idempotencyKey) {
    throw new Error('adjustCurrency: reason, source, idempotencyKey are required');
  }

  const body = {
    delta,
    reason,
    source,
    idempotencyKey,
    occurredAt: occurredAt || new Date().toISOString(),
    ...(metadata ? {metadata} : {}),
  };

  try {
    const resp = await gameClient.post(`/users/${encodeURIComponent(playerId)}`, body);
    return resp.data; // { uid, currency, delta, applied }
  } catch (err) {
    const code = err.response?.data?.error?.code;
    const msg = err.response?.data?.error?.message || err.message;
    console.error(
      `❌ adjustCurrency(${playerId}, ${delta}, key=${idempotencyKey}) failed [${code || '?'}]: ${msg}`,
    );
    throw err;
  }
}

// ───────────────────────── Currency tx history ─────────────────────────
/**
 * GET /users/{uid}/currencyTransactions — cursor-paginated ledger.
 *
 * @param {string} playerId
 * @param {Object} [opts]
 * @param {number} [opts.limit=50]
 * @param {string} [opts.before]
 * @returns {Promise<{uid, entries: Array, nextCursor: string|null}|null>}
 */
async function fetchCurrencyTransactions(playerId, opts = {}) {
  assertKey();
  const params = {};
  if (opts.limit) params.limit = opts.limit;
  if (opts.before) params.before = opts.before;
  try {
    const resp = await gameClient.get(
      `/users/${encodeURIComponent(playerId)}/currencyTransactions`,
      {params},
    );
    return resp.data;
  } catch (err) {
    if (err.response && err.response.status === 404) return null;
    console.error(`❌ fetchCurrencyTransactions(${playerId}) failed:`, err.message);
    throw err;
  }
}

module.exports = {
  validatePlayerId,
  fetchPlayerStats,
  adjustCurrency,
  fetchCurrencyTransactions,
};
