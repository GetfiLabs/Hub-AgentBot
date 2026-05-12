/**
 * Roll Raider Players API client (Hub side).
 *
 * Contract: PLAYERS_API.md at project root.
 * Roll Raider is the canonical source of truth for `currency` (G).
 * Hub sends deltas (idempotent) and reads `currency` from /stats responses.
 *
 * Auth: `X-API-Key` header (NOT Bearer).
 */

const DEFAULT_BASE =
  "https://europe-central2-wikzrollraider.cloudfunctions.net/playersApi/v1";

function baseUrl() {
  return process.env.ROLL_RAIDER_API_BASE || DEFAULT_BASE;
}

function apiKey() {
  const key = process.env.ROLL_RAIDER_API_KEY;
  if (!key) {
    throw new Error("ROLL_RAIDER_API_KEY env not set");
  }
  return key;
}

async function request(path, {method = "GET", body} = {}) {
  const url = `${baseUrl()}${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      "X-API-Key": apiKey(),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!resp.ok) {
    const err = new Error(
      `Roll Raider API ${method} ${path} → ${resp.status} ${
        json?.error?.message || text || ""
      }`,
    );
    err.status = resp.status;
    err.code = json?.error?.code;
    err.body = json;
    throw err;
  }
  return json;
}

async function getPlayer(playerId) {
  return request(`/users/${encodeURIComponent(playerId)}`);
}

async function getPlayerStats(playerId) {
  return request(`/users/${encodeURIComponent(playerId)}/stats`);
}

/**
 * POST /users/{uid} — idempotent currency delta.
 * @returns {Promise<{uid, currency, delta, applied}>}
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
  if (!playerId) throw new Error("adjustCurrency: playerId required");
  if (!Number.isInteger(delta) || delta === 0) {
    throw new Error(`adjustCurrency: delta must be non-zero integer`);
  }
  if (!reason || !source || !idempotencyKey) {
    throw new Error("adjustCurrency: reason, source, idempotencyKey required");
  }
  return request(`/users/${encodeURIComponent(playerId)}`, {
    method: "POST",
    body: {
      delta,
      reason,
      source,
      idempotencyKey,
      occurredAt: occurredAt || new Date().toISOString(),
      ...(metadata ? {metadata} : {}),
    },
  });
}

async function getCurrencyTransactions(playerId, {limit, before} = {}) {
  const qs = new URLSearchParams();
  if (limit) qs.set("limit", String(limit));
  if (before) qs.set("before", before);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request(
    `/users/${encodeURIComponent(playerId)}/currencyTransactions${suffix}`,
  );
}

module.exports = {
  getPlayer,
  getPlayerStats,
  adjustCurrency,
  getCurrencyTransactions,
};
