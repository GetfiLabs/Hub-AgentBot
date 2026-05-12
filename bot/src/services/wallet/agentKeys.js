// Per-user agent keypair lifecycle backed by Firestore + envelope
// encryption. Each Telegram user that opts into Phase 3 gets a unique
// Solana keypair; the public key is what they delegate to on-chain via
// `register_agent` from the Hub UI. The private key never leaves the
// bot's process unencrypted on disk — it lives in Firestore as a
// versioned envelope blob (see services/wallet/encryption.js).

const admin = require('firebase-admin');
const {Keypair} = require('@solana/web3.js');
const encryption = require('./encryption');

const COLLECTION = 'bot_agents';

function docId(platform, platformUserId) {
  return `${platform}_${platformUserId}`;
}

function db() {
  return admin.firestore();
}

async function getDoc(platform, platformUserId) {
  const id = docId(platform, platformUserId);
  const snap = await db().collection(COLLECTION).doc(id).get();
  if (!snap.exists) return null;
  return {id: snap.id, ...snap.data()};
}

// Returns {keypair, doc, created}. Idempotent — a second call for the
// same user returns the same keypair (decrypted from Firestore).
async function getOrCreateAgentKeypair(platform, platformUserId, walletAddress = null) {
  const id = docId(platform, platformUserId);
  const ref = db().collection(COLLECTION).doc(id);
  const snap = await ref.get();

  if (snap.exists && snap.data().agent_secret_v1) {
    const data = snap.data();
    const secretBytes = encryption.decrypt(data.agent_secret_v1);
    const keypair = Keypair.fromSecretKey(Uint8Array.from(secretBytes));
    return {keypair, doc: {id: snap.id, ...data}, created: false};
  }

  const keypair = Keypair.generate();
  const blob = encryption.encrypt(Buffer.from(keypair.secretKey));
  const payload = {
    platform,
    platform_user_id: String(platformUserId),
    agent_pubkey: keypair.publicKey.toBase58(),
    agent_secret_v1: blob,
    wallet_address: walletAddress || null,
    status: 'pending_onchain',  // user still has to /register on Hub
    created_at: admin.firestore.FieldValue.serverTimestamp(),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
    last_run_at: null,
    next_run_eligible_at: null,
  };
  // `set({merge: true})` so we don't clobber any existing scheduling
  // metadata if the doc was partially populated by another path.
  await ref.set(payload, {merge: true});
  return {keypair, doc: {id, ...payload}, created: true};
}

async function setWalletAddress(platform, platformUserId, walletAddress) {
  const id = docId(platform, platformUserId);
  await db().collection(COLLECTION).doc(id).update({
    wallet_address: walletAddress,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function markStatus(platform, platformUserId, status, extras = {}) {
  const id = docId(platform, platformUserId);
  await db().collection(COLLECTION).doc(id).update({
    status,
    ...extras,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// Returns docs eligible for a farming run, plus a verbose breakdown so
// the scheduler can log *why* docs were filtered out. Includes both
// `active` and `pending_onchain` — the latter is the bootstrap state
// after /connectagent but before the first successful run, and on-chain
// authority status is the real source of truth (verified inside
// farmRunner). Anything else (`resigned`, etc.) stays excluded.
async function listEligibleAgents(thresholdMs) {
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - thresholdMs);
  const snap = await db()
    .collection(COLLECTION)
    .where('status', 'in', ['active', 'pending_onchain'])
    .get();

  const eligible = [];
  const skipped = [];

  for (const doc of snap.docs) {
    const data = doc.data();
    const lastRunAt = data.last_run_at;
    if (!lastRunAt) {
      eligible.push({id: doc.id, ...data, _reason: 'never_run'});
      continue;
    }
    const ageMs = Date.now() - lastRunAt.toMillis();
    if (lastRunAt.toMillis() <= cutoff.toMillis()) {
      eligible.push({id: doc.id, ...data, _reason: `last_run_${Math.round(ageMs / 60000)}m_ago`});
    } else {
      const waitMs = lastRunAt.toMillis() + thresholdMs - Date.now();
      skipped.push({
        id: doc.id,
        platform_user_id: data.platform_user_id,
        status: data.status,
        reason: `cooldown_${Math.round(waitMs / 60000)}m_remaining`,
      });
    }
  }

  return {eligible, skipped, totalScanned: snap.size};
}

module.exports = {
  COLLECTION,
  getOrCreateAgentKeypair,
  getDoc,
  setWalletAddress,
  markStatus,
  listEligibleAgents,
};
