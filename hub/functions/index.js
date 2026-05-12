const {onCall, onRequest, HttpsError} = require("firebase-functions/v2/https");
const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const nacl = require("tweetnacl");
const {Keypair, PublicKey} = require("@solana/web3.js");
const {randomBytes, createHash} = require("crypto");

admin.initializeApp();

const db = admin.firestore();
const {FieldValue, Timestamp} = admin.firestore;

const logger = require("firebase-functions/logger");
const rollRaider = require("./lib/rollRaiderApi");

const onCallOpts = {cors: true};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SINGLE_BOX_COST = 5000;
const MAX_BOXES_PER_BATCH = 10;
const DAILY_BOX_LIMIT = 50;
const REQUEST_TTL_SECONDS = 10 * 60;
const BATCH_MESSAGE_DOMAIN = Buffer.from("GETFI_LOOTBOX_BATCH_V1");

const DEFAULT_PROGRAM_ID = "Bm6zsJgc87Hj6gGEtpHtyjP89Lwuu7TequM6dgPL8LA7";
const DEFAULT_REWARD_MINT = "3rTrMpMPQ3Nj7ktRkBYcLmB5diqqhtcw348oq9Poq5Eo";
const TREASURY = new PublicKey("A3TgoR4ArUEsQiuXLM9ikoE2wA8uQPFxEdGxnfGXFqxb");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getProgramId() {
  return new PublicKey(process.env.GETFI_LOOTBOX_PROGRAM_ID || DEFAULT_PROGRAM_ID);
}

function getRewardMint() {
  return new PublicKey(process.env.GETFI_REWARD_MINT || DEFAULT_REWARD_MINT);
}

function getConfigPda() {
  const configured = process.env.GETFI_CONFIG_PDA;
  if (configured) return new PublicKey(configured);
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    getProgramId(),
  );
  return configPda;
}

function parseSecretKey(value) {
  if (!value) return null;
  const trimmed = value.trim();
  let bytes;
  if (trimmed.startsWith("[")) {
    bytes = Uint8Array.from(JSON.parse(trimmed));
  } else if (trimmed.includes(",")) {
    bytes = Uint8Array.from(trimmed.split(",").map((part) => Number(part.trim())));
  } else {
    bytes = Uint8Array.from(Buffer.from(trimmed, "base64"));
  }
  if (bytes.length === 64) return bytes;
  if (bytes.length === 32) return Keypair.fromSeed(bytes).secretKey;
  throw new HttpsError(
    "failed-precondition",
    "Backend signer secret must be a 32-byte seed or 64-byte secret key.",
  );
}

function getBackendSigner() {
  const secret =
    parseSecretKey(process.env.GETFI_BACKEND_SIGNER_SECRET) ||
    parseSecretKey(process.env.HOT_WALLET_PRIVATE_KEY);
  if (secret) {
    const keypair = Keypair.fromSecretKey(secret);
    return {
      publicKey: keypair.publicKey,
      secretKey: keypair.secretKey,
      isDevelopmentFallback: false,
    };
  }
  if (process.env.GETFI_ALLOW_DEV_SIGNER === "true" || process.env.NODE_ENV === "test") {
    logger.warn("DEV MODE: hardcoded dev signer.");
    const seed = new Uint8Array(32).fill(7);
    const keypair = Keypair.fromSeed(seed);
    return {
      publicKey: keypair.publicKey,
      secretKey: keypair.secretKey,
      isDevelopmentFallback: true,
    };
  }
  throw new HttpsError(
    "failed-precondition",
    "Backend signer not configured. Set HOT_WALLET_PRIVATE_KEY.",
  );
}

function requireAuth(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "User must be logged in.");
  return request.auth.uid;
}

function parseWalletAddress(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpsError("invalid-argument", "walletAddress is required.");
  }
  try {
    return new PublicKey(value);
  } catch (e) {
    throw new HttpsError("invalid-argument", "walletAddress is not a valid Solana address.");
  }
}

function readPointBalance(userData) {
  return Number(userData.getPoints ?? userData.points ?? userData.totalGetPoints ?? 0);
}

function readReservedPoints(userData) {
  return Number(userData.reservedPoints || 0);
}

function writeI64LE(value) {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(value));
  return out;
}

function makeRequestId() {
  return randomBytes(16).toString("hex");
}

function sha256(...parts) {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

/**
 * Builds the batch message that backend signs Ed25519 over and that the
 * on-chain `request_lootbox_batch` re-derives + verifies. Layout matches
 * `build_batch_message` in lib.rs:
 *   domain || config || player || reward_mint || box_count || nonce ||
 *   player_entropy || backend_commitment || expires_at(i64 LE)
 */
function buildBatchMessage({
  config,
  player,
  rewardMint,
  boxCount,
  nonce,
  playerEntropy,
  backendCommitment,
  expiresAt,
}) {
  return Buffer.concat([
    BATCH_MESSAGE_DOMAIN,
    config.toBuffer(),
    player.toBuffer(),
    rewardMint.toBuffer(),
    Buffer.from([boxCount]),
    Buffer.from(nonce),
    Buffer.from(playerEntropy),
    Buffer.from(backendCommitment),
    writeI64LE(expiresAt),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth + onboarding
// ─────────────────────────────────────────────────────────────────────────────

exports.onUserCreated = functions.auth.user().onCreate(async (user) => {
  const userRef = db.collection("users").doc(user.uid);
  const snap = await userRef.get();
  if (snap.exists) {
    await userRef.set({lastLogin: FieldValue.serverTimestamp()}, {merge: true});
    return;
  }
  await userRef.set({
    uid: user.uid,
    primaryWallet: user.uid,
    connectedWallets: [user.uid],
    getPoints: 0,
    lootboxEarnings: 0,
    createdAt: FieldValue.serverTimestamp(),
    lastLogin: FieldValue.serverTimestamp(),
  });
});

exports.verifyWalletSignature = onCall(onCallOpts, async (request) => {
  try {
    const {walletAddress, signature, message} = request.data || {};
    if (!walletAddress || !signature || !message) {
      throw new HttpsError(
        "invalid-argument",
        "walletAddress, signature, and message are required.",
      );
    }
    const walletPubkey = parseWalletAddress(walletAddress);
    const walletAddr = walletPubkey.toBase58();
    const messageBytes = new Uint8Array(Buffer.from(message, "utf8"));
    const sigBytes = new Uint8Array(Buffer.from(signature, "base64"));
    const valid = nacl.sign.detached.verify(messageBytes, sigBytes, walletPubkey.toBytes());
    if (!valid) throw new HttpsError("unauthenticated", "Invalid wallet signature.");

    const userRef = db.collection("users").doc(walletAddr);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      await userRef.set({
        uid: walletAddr,
        primaryWallet: walletAddr,
        connectedWallets: [walletAddr],
        getPoints: 0,
        lootboxEarnings: 0,
        createdAt: FieldValue.serverTimestamp(),
        lastLogin: FieldValue.serverTimestamp(),
      });
    } else {
      await userRef.set(
        {
          connectedWallets: FieldValue.arrayUnion(walletAddr),
          lastLogin: FieldValue.serverTimestamp(),
        },
        {merge: true},
      );
    }

    const token = await admin.auth().createCustomToken(walletAddr);
    return {token};
  } catch (error) {
    logger.error(
      "verifyWalletSignature FAILED:",
      error instanceof Error ? error.message : error,
    );
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Failed to verify wallet signature.");
  }
});

exports.linkPlayerId = onCall(onCallOpts, async (request) => {
  try {
    const uid = requireAuth(request);
    const {gameId, playerId} = request.data || {};
    if (!gameId || !playerId) {
      throw new HttpsError("invalid-argument", "Missing gameId or playerId.");
    }
    const existing = await db
      .collection("game_links")
      .where("gameId", "==", gameId)
      .where("playerId", "==", playerId)
      .get();
    if (!existing.empty) {
      throw new HttpsError("already-exists", "This player ID is already linked.");
    }
    await db.collection("game_links").add({
      uid,
      gameId,
      playerId,
      inGameGetBalance: 0,
      maxLevel: 1,
      highScore: 0,
      createdAt: FieldValue.serverTimestamp(),
    });
    return {success: true};
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Failed to link player ID.");
  }
});

// Roll Raider canonical stats proxy — Hub UI reads live values here so
// the game/Bot/Hub all show the same numbers. Caller must be authed and
// own the playerId (via game_links).
exports.fetchRollRaiderStats = onCall(onCallOpts, async (request) => {
  const uid = requireAuth(request);
  const {playerId} = request.data || {};
  if (!playerId || typeof playerId !== "string") {
    throw new HttpsError("invalid-argument", "playerId is required.");
  }
  const linkSnap = await db
    .collection("game_links")
    .where("uid", "==", uid)
    .where("gameId", "==", "roll_raider")
    .where("playerId", "==", playerId)
    .limit(1)
    .get();
  if (linkSnap.empty) {
    throw new HttpsError("permission-denied", "Player ID not linked to your account.");
  }
  try {
    const stats = await rollRaider.getPlayerStats(playerId);
    return {
      playerId,
      level: Number(stats.level ?? 0),
      currency: Number(stats.currency ?? 0),
      premiumCurrency: Number(stats.premiumCurrency ?? 0),
      maxScore: Number(stats.maxScore ?? 0),
      sessionsPlayed: Number(stats.sessionsPlayed ?? 0),
      lastPlayedAt: stats.lastPlayedAt ?? null,
      updatedAt: stats.updatedAt ?? null,
    };
  } catch (err) {
    if (err.status === 404) {
      throw new HttpsError("not-found", "Player not found in Roll Raider DB.");
    }
    logger.error("fetchRollRaiderStats failed", err.message);
    throw new HttpsError("internal", "Failed to fetch Roll Raider stats.");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// V3 batch flow (commit-reveal, no ORAO)
//
// 1. signLootboxBatch:
//    - Frontend supplies `playerEntropy` (32 random bytes from
//      `crypto.getRandomValues`).
//    - Backend generates `backendSecret` (32 random bytes), keeps it in
//      Firestore, and posts `backendCommitment = sha256(backendSecret)` in
//      the on-chain request. The Ed25519-signed batch message binds both
//      values so neither party can swap them.
// 2. submitLootboxBatch: frontend reports the signed-tx signature.
// 3. crankConsumeLootboxBatch: reads `backendSecret` back out of Firestore,
//    feeds it as the `backend_seed` parameter to `consume_lootbox_batch`.
//    The on-chain program verifies sha256(backend_seed) == commitment,
//    derives randomness, ships rewards, and we close the batch PDA in a
//    follow-up tx to recover its rent.
// ─────────────────────────────────────────────────────────────────────────────

exports.signLootboxBatch = onCall(onCallOpts, async (request) => {
  try {
    const uid = requireAuth(request);
    const data = request.data || {};
    const walletAddress = parseWalletAddress(data.walletAddress);
    const boxCount = Number(data.boxCount);
    if (!Number.isInteger(boxCount) || boxCount < 1 || boxCount > MAX_BOXES_PER_BATCH) {
      throw new HttpsError(
        "invalid-argument",
        `boxCount must be an integer 1..${MAX_BOXES_PER_BATCH}.`,
      );
    }
    if (walletAddress.toBase58() !== uid) {
      throw new HttpsError("permission-denied", "Wallet does not match authenticated user.");
    }

    // playerEntropy: 32 bytes base64 from frontend's crypto.getRandomValues.
    if (typeof data.playerEntropy !== "string" || !data.playerEntropy) {
      throw new HttpsError("invalid-argument", "playerEntropy is required.");
    }
    const playerEntropy = Buffer.from(data.playerEntropy, "base64");
    if (playerEntropy.length !== 32) {
      throw new HttpsError("invalid-argument", "playerEntropy must be 32 bytes.");
    }

    const cost = SINGLE_BOX_COST * boxCount;
    const requestId = makeRequestId();
    const nonce = randomBytes(32);
    const backendSecret = randomBytes(32); // revealed at consume time.
    const backendCommitment = sha256(backendSecret);
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + REQUEST_TTL_SECONDS;
    const expiresAtTimestamp = Timestamp.fromMillis(expiresAt * 1000);
    const config = getConfigPda();
    const rewardMint = getRewardMint();
    const programId = getProgramId();
    const signer = getBackendSigner();
    const hotWallet = Keypair.fromSecretKey(signer.secretKey);

    const message = buildBatchMessage({
      config,
      player: walletAddress,
      rewardMint,
      boxCount,
      nonce,
      playerEntropy,
      backendCommitment,
      expiresAt,
    });
    const signature = Buffer.from(nacl.sign.detached(message, signer.secretKey));

    // Escrow the G in `reservedPoints` (NOT decremented from getPoints).
    await db.runTransaction(async (tx) => {
      const userRef = db.collection("users").doc(uid);
      const requestRef = db.collection("lootbox_batches").doc(requestId);
      const transactionRef = db.collection("transactions").doc();

      const userDoc = await tx.get(userRef);
      if (!userDoc.exists) throw new HttpsError("not-found", "User not found.");
      const userData = userDoc.data() || {};
      if (userData.activeLootboxBatchId) {
        throw new HttpsError(
          "failed-precondition",
          "You already have a pending batch request.",
        );
      }
      const balance = readPointBalance(userData);
      const reserved = readReservedPoints(userData);
      const available = balance - reserved;
      if (available < cost) {
        throw new HttpsError(
          "failed-precondition",
          `Insufficient G — need ${cost.toLocaleString()},` +
            ` available ${available.toLocaleString()}.`,
        );
      }

      tx.update(userRef, {
        reservedPoints: FieldValue.increment(cost),
        activeLootboxBatchId: requestId,
        updatedAt: FieldValue.serverTimestamp(),
      });

      tx.create(requestRef, {
        uid,
        walletAddress: walletAddress.toBase58(),
        requestId,
        cost,
        boxCount,
        nonce: nonce.toString("base64"),
        playerEntropy: playerEntropy.toString("base64"),
        backendCommitment: backendCommitment.toString("base64"),
        // backendSecret stays server-side until the crank reveals it on-chain.
        // We persist it here so the crank can recover it from any function
        // instance / cold-start; rotating it would re-roll the commitment,
        // which is locked on-chain.
        backendSecret: backendSecret.toString("base64"),
        config: config.toBase58(),
        rewardMint: rewardMint.toBase58(),
        treasury: TREASURY.toBase58(),
        programId: programId.toBase58(),
        backendSigner: signer.publicKey.toBase58(),
        message: message.toString("base64"),
        signature: signature.toString("base64"),
        status: "signed",
        issuedAt,
        expiresAt,
        expiresAtTimestamp,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      tx.create(transactionRef, {
        uid,
        requestId,
        walletAddress: walletAddress.toBase58(),
        amount: cost,
        type: "lootbox_batch_reserve",
        status: "signed",
        boxCount,
        description: `Reserved ${cost.toLocaleString()} G for ${boxCount}-box batch`,
        timestamp: FieldValue.serverTimestamp(),
      });
    });

    // Build + partial-sign the on-chain tx so Phantom only needs to add the
    // player's signature. Backend = feePayer + rent payer.
    const {Connection, Transaction, ComputeBudgetProgram} = require("@solana/web3.js");
    const {
      buildRequestBatchInstruction,
      buildEd25519VerifyInstruction,
    } = require("./crank/buildBatch");

    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");

    const ed25519Ix = buildEd25519VerifyInstruction({
      backendPubkey: signer.publicKey,
      message,
      signature,
    });
    const requestIx = buildRequestBatchInstruction({
      programId,
      backendSigner: hotWallet.publicKey,
      player: walletAddress,
      config,
      treasury: TREASURY,
      boxCount,
      nonce,
      playerEntropy,
      backendCommitment,
      expiresAt,
      signature,
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({units: 400_000}),
      ed25519Ix,
      requestIx,
    );
    tx.feePayer = hotWallet.publicKey;
    const {blockhash, lastValidBlockHeight} =
      await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.partialSign(hotWallet);

    const serialized = tx.serialize({requireAllSignatures: false});

    return {
      success: true,
      requestId,
      cost,
      boxCount,
      programId: programId.toBase58(),
      backendSigner: signer.publicKey.toBase58(),
      treasury: TREASURY.toBase58(),
      partiallySignedTx: serialized.toString("base64"),
      blockhash,
      lastValidBlockHeight,
      expiresAt,
      // Echo so the frontend can sanity-check it wasn't substituted.
      playerEntropy: playerEntropy.toString("base64"),
      backendCommitment: backendCommitment.toString("base64"),
      developmentSigner: signer.isDevelopmentFallback,
    };
  } catch (error) {
    logger.error(
      "signLootboxBatch FAILED:",
      error instanceof Error ? error.message : error,
    );
    if (error instanceof HttpsError) throw error;
    throw new HttpsError(
      "internal",
      "signLootboxBatch failed: " +
        (error instanceof Error ? error.message : "unknown"),
    );
  }
});

exports.submitLootboxBatch = onCall(onCallOpts, async (request) => {
  try {
    const uid = requireAuth(request);
    const {requestId, txSignature} = request.data || {};
    if (!requestId || !txSignature) {
      throw new HttpsError(
        "invalid-argument",
        "requestId and txSignature are required.",
      );
    }
    await db.runTransaction(async (tx) => {
      const userRef = db.collection("users").doc(uid);
      const requestRef = db.collection("lootbox_batches").doc(requestId);
      const requestDoc = await tx.get(requestRef);
      if (!requestDoc.exists || requestDoc.data().uid !== uid) {
        throw new HttpsError("not-found", "Lootbox batch not found.");
      }
      tx.update(requestRef, {
        status: "submitted",
        txSignature,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(userRef, {
        activeLootboxBatchId: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    return {success: true};
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Failed to mark batch as submitted.");
  }
});

exports.cancelLootboxBatch = onCall(onCallOpts, async (request) => {
  try {
    const uid = requireAuth(request);
    await db.runTransaction(async (tx) => {
      const userRef = db.collection("users").doc(uid);
      const userDoc = await tx.get(userRef);
      if (!userDoc.exists) throw new HttpsError("not-found", "User not found.");
      const userData = userDoc.data() || {};
      const activeId = userData.activeLootboxBatchId;
      if (!activeId) {
        throw new HttpsError("not-found", "No pending batch to cancel.");
      }
      const requestRef = db.collection("lootbox_batches").doc(activeId);
      const requestDoc = await tx.get(requestRef);
      if (!requestDoc.exists || requestDoc.data().uid !== uid) {
        tx.update(userRef, {
          activeLootboxBatchId: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return;
      }
      const requestData = requestDoc.data();
      if (requestData.status === "signed" || requestData.status === "submitted") {
        const cost = Number(requestData.cost) || 0;
        tx.update(userRef, {
          reservedPoints: FieldValue.increment(-cost),
          activeLootboxBatchId: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.update(requestRef, {
          status: "cancelled",
          updatedAt: FieldValue.serverTimestamp(),
        });
        const refundRef = db.collection("transactions").doc();
        tx.create(refundRef, {
          uid,
          requestId: activeId,
          walletAddress: requestData.walletAddress,
          amount: cost,
          type: "lootbox_batch_release",
          status: "cancelled",
          boxCount: requestData.boxCount,
          description: `Released ${cost.toLocaleString()} G escrow (batch cancelled — no G spent)`,
          timestamp: FieldValue.serverTimestamp(),
        });
      } else {
        tx.update(userRef, {
          activeLootboxBatchId: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    });
    return {success: true};
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Failed to cancel batch.");
  }
});

/**
 * Crank — fires when a `lootbox_batches/{requestId}` doc transitions to
 * `submitted`. Reveals the backend secret on-chain, settles the G escrow,
 * mirrors per-box rewards into Firestore, and closes the batch PDA to
 * recover its rent.
 */
exports.crankConsumeLootboxBatch = functions
  .runWith({timeoutSeconds: 300, memory: "512MB"})
  .firestore.document("lootbox_batches/{requestId}")
  .onUpdate(async (change, ctx) => {
    const before = change.before.data();
    const after = change.after.data();
    if (before.status === after.status) return null;
    if (after.status !== "submitted") return null;

    const requestId = ctx.params.requestId;
    const uid = after.uid;
    const cost = Number(after.cost) || 0;
    const boxCount = Number(after.boxCount) || 0;
    logger.info("crankConsumeLootboxBatch: starting", {requestId, boxCount});

    try {
      const {Connection, Transaction, ComputeBudgetProgram} = require("@solana/web3.js");
      const {
        buildConsumeBatchInstruction,
        buildCancelBatchInstruction,
        deriveBatchRequest,
      } = require("./crank/buildBatch");

      const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
      const connection = new Connection(rpcUrl, "confirmed");
      const signer = getBackendSigner();
      const hotWallet = Keypair.fromSecretKey(signer.secretKey);

      // Reveal the secret that was committed at request time.
      if (typeof after.backendSecret !== "string" || !after.backendSecret) {
        throw new Error(
          "backendSecret missing from Firestore doc — cannot reveal commitment.",
        );
      }
      const backendSeed = Buffer.from(after.backendSecret, "base64");
      if (backendSeed.length !== 32) {
        throw new Error(
          `backendSecret invalid length ${backendSeed.length} (want 32 bytes).`,
        );
      }

      const ix = buildConsumeBatchInstruction({
        programId: new PublicKey(after.programId),
        backendSigner: hotWallet.publicKey,
        player: new PublicKey(after.walletAddress),
        config: new PublicKey(after.config),
        rewardMint: new PublicKey(after.rewardMint),
        nonce: Buffer.from(after.nonce, "base64"),
        backendSeed,
      });

      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({units: 400_000}),
        ix,
      );
      tx.feePayer = hotWallet.publicKey;
      const {blockhash, lastValidBlockHeight} =
        await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.sign(hotWallet);

      const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
      });
      await connection.confirmTransaction(
        {signature: sig, blockhash, lastValidBlockHeight},
        "confirmed",
      );
      logger.info("crank: batch consume confirmed", {requestId, sig});

      // Pull the per-box rewards back out of the persisted PDA so the
      // frontend can render them straight from Firestore.
      const batchPda = deriveBatchRequest(
        new PublicKey(after.programId),
        new PublicKey(after.walletAddress),
        Buffer.from(after.nonce, "base64"),
      );
      const batchAcc = await connection.getAccountInfo(batchPda, "confirmed");
      const rewardsArr = [];
      let totalAmount = 0;
      if (batchAcc && batchAcc.data) {
        // Layout (after 8-byte disc):
        //   player(32) + nonce(32) + player_entropy(32) + backend_commitment(32)
        //   + box_count(1) + consumed(1) + total_amount(u64 LE)
        //   + 10 × { tier(u8) + amount(u64 LE) }
        //   + bump(1)
        const d = batchAcc.data.subarray(8);
        let off = 32 + 32 + 32 + 32;
        const onChainBoxCount = d[off];
        off += 1;
        off += 1; // consumed
        totalAmount = Number(d.readBigUInt64LE(off));
        off += 8;
        for (let i = 0; i < onChainBoxCount; i += 1) {
          const tier = d[off];
          off += 1;
          const amount = Number(d.readBigUInt64LE(off));
          off += 8;
          rewardsArr.push({tier, amount});
        }
      }

      // Settle the G escrow now that the on-chain consume confirmed.
      await db.runTransaction(async (txn) => {
        const userRef = db.collection("users").doc(uid);
        const requestRef = change.after.ref;
        const debitRef = db.collection("transactions").doc();
        // NOTE: getPoints/reservedPoints are local Hub mirror — Roll Raider
        // is canonical (see mirror call below). Local ledger stays for
        // pre-check + escrow during sign/submit; full removal is a follow-up
        // refactor (game API has no reserve/commit primitive).
        txn.update(userRef, {
          getPoints: FieldValue.increment(-cost),
          reservedPoints: FieldValue.increment(-cost),
          updatedAt: FieldValue.serverTimestamp(),
        });
        txn.update(requestRef, {
          status: "consumed",
          consumeTxSignature: sig,
          rewards: rewardsArr,
          totalReward: totalAmount,
          // Drop the secret from Firestore once it's revealed on-chain — it
          // has done its job and there's no reason to keep it around.
          backendSecret: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        txn.create(debitRef, {
          uid,
          requestId,
          walletAddress: after.walletAddress,
          amount: cost,
          type: "lootbox_batch_spend",
          status: "consumed",
          boxCount,
          totalReward: totalAmount,
          description:
            `Spent ${cost.toLocaleString()} G — ${boxCount}-box batch ` +
            `(won ${totalAmount.toLocaleString()} GET)`,
          timestamp: FieldValue.serverTimestamp(),
        });
      });

      // Mirror the spend to Roll Raider (canonical). Idempotent via
      // requestId-derived key. Failure is logged but non-fatal — local
      // ledger already debited; a reconciliation job can replay later.
      try {
        const linkSnap = await db
          .collection("game_links")
          .where("uid", "==", uid)
          .where("gameId", "==", "roll_raider")
          .limit(1)
          .get();
        if (!linkSnap.empty) {
          const playerId = linkSnap.docs[0].data().playerId;
          const resp = await rollRaider.adjustCurrency({
            playerId,
            delta: -cost,
            reason: "getfihub_lootbox_spend",
            source: "getfihub",
            idempotencyKey: `getfihub:lootbox:${requestId}`,
            metadata: {boxCount, totalReward: totalAmount, consumeTxSignature: sig},
          });
          logger.info("crank: Roll Raider mirror", {
            requestId,
            playerId,
            applied: resp.applied,
            currency: resp.currency,
          });
        } else {
          logger.warn("crank: no Roll Raider playerId linked — mirror skipped", {uid});
        }
      } catch (err) {
        logger.error("crank: Roll Raider mirror FAILED (manual reconcile)", {
          requestId,
          uid,
          error: err.message,
          code: err.code,
        });
      }

      // Recover the LootboxBatchRequest rent (~0.00226 SOL) back to the
      // treasury. Best-effort: a failed close logs a warning and the PDA
      // can be reaped later.
      try {
        const closeIx = buildCancelBatchInstruction({
          programId: new PublicKey(after.programId),
          backendSigner: hotWallet.publicKey,
          player: new PublicKey(after.walletAddress),
          config: new PublicKey(after.config),
          nonce: Buffer.from(after.nonce, "base64"),
        });
        const closeTx = new Transaction().add(closeIx);
        closeTx.feePayer = hotWallet.publicKey;
        const recent = await connection.getLatestBlockhash("confirmed");
        closeTx.recentBlockhash = recent.blockhash;
        closeTx.sign(hotWallet);
        const closeSig = await connection.sendRawTransaction(closeTx.serialize(), {
          skipPreflight: false,
        });
        await connection.confirmTransaction(
          {signature: closeSig, ...recent},
          "confirmed",
        );
        logger.info("crank: batch PDA closed, rent refunded", {
          requestId,
          closeSig,
        });
      } catch (closeErr) {
        logger.warn(
          "crank: post-consume close failed (rent stays locked, retry later):",
          closeErr instanceof Error ? closeErr.message : closeErr,
        );
      }
      return null;
    } catch (err) {
      logger.error(
        "crankConsumeLootboxBatch failed:",
        err instanceof Error ? err.message : err,
      );

      // Release the G escrow so the user keeps their balance.
      try {
        await db.runTransaction(async (txn) => {
          const userRef = db.collection("users").doc(uid);
          const releaseRef = db.collection("transactions").doc();
          txn.update(userRef, {
            reservedPoints: FieldValue.increment(-cost),
            updatedAt: FieldValue.serverTimestamp(),
          });
          txn.update(change.after.ref, {
            status: "consume_failed",
            crankError: err instanceof Error ? err.message : String(err),
            updatedAt: FieldValue.serverTimestamp(),
          });
          txn.create(releaseRef, {
            uid,
            requestId,
            walletAddress: after.walletAddress,
            amount: cost,
            type: "lootbox_batch_release",
            status: "consume_failed",
            boxCount,
            description: `Released ${cost.toLocaleString()} G escrow — crank failed, no G spent`,
            timestamp: FieldValue.serverTimestamp(),
          });
        });
      } catch (settleErr) {
        logger.error(
          "crank: escrow release also failed:",
          settleErr instanceof Error ? settleErr.message : settleErr,
        );
      }

      // Recover the batch PDA rent + release the on-chain reservation.
      try {
        const {Connection, Transaction: Tx} = require("@solana/web3.js");
        const {buildCancelBatchInstruction} = require("./crank/buildBatch");
        const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
        const cleanupConn = new Connection(rpcUrl, "confirmed");
        const cleanupSigner = getBackendSigner();
        const cleanupHot = Keypair.fromSecretKey(cleanupSigner.secretKey);
        const closeIx = buildCancelBatchInstruction({
          programId: new PublicKey(after.programId),
          backendSigner: cleanupHot.publicKey,
          player: new PublicKey(after.walletAddress),
          config: new PublicKey(after.config),
          nonce: Buffer.from(after.nonce, "base64"),
        });
        const closeTx = new Tx().add(closeIx);
        closeTx.feePayer = cleanupHot.publicKey;
        const recent = await cleanupConn.getLatestBlockhash("confirmed");
        closeTx.recentBlockhash = recent.blockhash;
        closeTx.sign(cleanupHot);
        const closeSig = await cleanupConn.sendRawTransaction(
          closeTx.serialize(),
          {skipPreflight: false},
        );
        await cleanupConn.confirmTransaction(
          {signature: closeSig, ...recent},
          "confirmed",
        );
        logger.info("crank: failed-batch PDA closed, rent refunded", {
          requestId,
          closeSig,
        });
      } catch (closeErr) {
        logger.warn(
          "crank: failed-batch close also failed (rent stays locked):",
          closeErr instanceof Error ? closeErr.message : closeErr,
        );
      }
      return null;
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — Agent box-opening
//
// Bot calls this HTTP endpoint (Bearer-authenticated with a shared secret)
// to obtain a backend Ed25519 signature over the on-chain message that
// `open_box_as_agent` verifies. The bot then assembles the tx itself
// (ed25519 verify ix + open_box_as_agent ix) and submits it.
//
// Single-tx commit-reveal: we return both `backendCommitment` and
// `backendSeed`. There is no "commit-then-reveal-later" gap to abuse —
// they're consumed atomically inside the same Solana tx the bot lands.
//
// Authn: Bearer <BOT_AGENT_SHARED_SECRET>. This is Phase 3.0 dev-mode
// auth; the long-term plan is per-agent ed25519 challenges.
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_TX_TTL_SECONDS = 5 * 60;

exports.signAgentBoxOpen = onRequest({cors: true}, async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(405).json({error: "method-not-allowed"});
      return;
    }
    const expected = process.env.BOT_AGENT_SHARED_SECRET;
    if (!expected) {
      logger.error("signAgentBoxOpen: BOT_AGENT_SHARED_SECRET not configured");
      res.status(503).json({error: "bot-auth-not-configured"});
      return;
    }
    const authHeader = req.get("authorization") || "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match || match[1] !== expected) {
      res.status(401).json({error: "unauthorized"});
      return;
    }

    const body = req.body || {};
    const walletAddress = body.walletAddress;
    const agentPubkeyStr = body.agentPubkey;
    const boxCount = Number(body.boxCount);
    const nonceCounter = body.nonceCounter;
    const playerEntropyB64 = body.playerEntropy;

    if (typeof walletAddress !== "string" || typeof agentPubkeyStr !== "string") {
      res.status(400).json({error: "walletAddress and agentPubkey are required"});
      return;
    }
    if (!Number.isInteger(boxCount) || boxCount < 1 || boxCount > MAX_BOXES_PER_BATCH) {
      res.status(400).json({error: `boxCount must be 1..${MAX_BOXES_PER_BATCH}`});
      return;
    }
    if (typeof nonceCounter !== "string" && typeof nonceCounter !== "number") {
      res.status(400).json({error: "nonceCounter is required (string or number)"});
      return;
    }
    if (typeof playerEntropyB64 !== "string" || !playerEntropyB64) {
      res.status(400).json({error: "playerEntropy (base64) is required"});
      return;
    }

    const user = parseWalletAddress(walletAddress);
    let agent;
    try {
      agent = new PublicKey(agentPubkeyStr);
    } catch (e) {
      res.status(400).json({error: "agentPubkey is not a valid Solana address"});
      return;
    }
    const playerEntropy = Buffer.from(playerEntropyB64, "base64");
    if (playerEntropy.length !== 32) {
      res.status(400).json({error: "playerEntropy must decode to 32 bytes"});
      return;
    }

    const config = getConfigPda();
    const rewardMint = getRewardMint();
    const programId = getProgramId();
    const signer = getBackendSigner();

    const backendSecret = randomBytes(32);
    const backendCommitment = sha256(backendSecret);
    const expiresAt = Math.floor(Date.now() / 1000) + AGENT_TX_TTL_SECONDS;

    const {buildAgentMessage} = require("./crank/buildAgentMessage");
    const message = buildAgentMessage({
      config,
      user,
      agent,
      rewardMint,
      boxCount,
      nonceCounter: BigInt(nonceCounter),
      playerEntropy,
      backendCommitment,
      expiresAt,
    });
    const signature = Buffer.from(nacl.sign.detached(message, signer.secretKey));

    res.status(200).json({
      walletAddress: user.toBase58(),
      agentPubkey: agent.toBase58(),
      boxCount,
      nonceCounter: String(nonceCounter),
      playerEntropy: playerEntropy.toString("base64"),
      backendCommitment: backendCommitment.toString("base64"),
      backendSeed: backendSecret.toString("base64"),
      signature: signature.toString("base64"),
      message: message.toString("base64"),
      expiresAt,
      programId: programId.toBase58(),
      configPda: config.toBase58(),
      rewardMint: rewardMint.toBase58(),
      treasury: TREASURY.toBase58(),
      backendSigner: signer.publicKey.toBase58(),
      developmentSigner: signer.isDevelopmentFallback,
    });
  } catch (error) {
    logger.error(
      "signAgentBoxOpen FAILED:",
      error instanceof Error ? error.message : error,
    );
    res.status(500).json({error: "internal"});
  }
});

exports.openLootBox = onCall(onCallOpts, () => {
  throw new HttpsError(
    "failed-precondition",
    "openLootBox is deprecated. Use signLootboxBatch.",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Agent <→> Hub off-chain sync
//
// The bot's RaiderBot agent opens boxes on-chain. The on-chain `open_box_
// as_agent` instruction does NOT touch the off-chain G ledger (which lives
// in Firestore), so the bot must call these endpoints to keep the user's
// Hub balance in sync and produce the History rows the Hub UI reads.
//
// Same Bearer-secret auth as signAgentBoxOpen.
// ─────────────────────────────────────────────────────────────────────────────

function checkBotAuth(req, res) {
  const expected = process.env.BOT_AGENT_SHARED_SECRET;
  if (!expected) {
    logger.error("agent endpoint: BOT_AGENT_SHARED_SECRET not configured");
    res.status(503).json({error: "bot-auth-not-configured"});
    return false;
  }
  const authHeader = req.get("authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== expected) {
    res.status(401).json({error: "unauthorized"});
    return false;
  }
  return true;
}

// GET available G balance for the user's wallet. The bot calls this
// before a farming cycle to know how many boxes are affordable off-chain.
// uid === walletAddress in SIWS architecture.
exports.getAgentGBalance = onRequest({cors: true}, async (req, res) => {
  try {
    if (req.method !== "POST" && req.method !== "GET") {
      res.status(405).json({error: "method-not-allowed"});
      return;
    }
    if (!checkBotAuth(req, res)) return;

    const wallet = (req.body && req.body.walletAddress) || req.query.walletAddress;
    if (typeof wallet !== "string" || !wallet.trim()) {
      res.status(400).json({error: "walletAddress required"});
      return;
    }
    // Validate it's a real Solana pubkey.
    try { new PublicKey(wallet); } catch { res.status(400).json({error: "invalid walletAddress"}); return; }

    const userDoc = await db.collection("users").doc(wallet).get();
    if (!userDoc.exists) {
      res.status(200).json({walletAddress: wallet, getPoints: 0, reservedPoints: 0, available: 0, exists: false});
      return;
    }
    const userData = userDoc.data() || {};
    const balance = readPointBalance(userData);
    const reserved = readReservedPoints(userData);
    res.status(200).json({
      walletAddress: wallet,
      getPoints: balance,
      reservedPoints: reserved,
      available: Math.max(0, balance - reserved),
      exists: true,
    });
  } catch (error) {
    logger.error("getAgentGBalance FAILED:", error instanceof Error ? error.message : error);
    res.status(500).json({error: "internal"});
  }
});

// Atomic post-run sync. Credits farmed G, debits spent G, and creates
// transaction rows the Hub History page can render.
//
// Body:
//   walletAddress: string (uid)
//   agentPubkey: string
//   gFarmed: number   ≥ 0  — G credited to the user from offline runs
//   runsCompleted: number ≥ 0 — number of simulated runs (display only)
//   boxCount: number  ≥ 0  — boxes opened on-chain this cycle
//   gSpent: number    ≥ 0  — G to debit (boxCount × 5000)
//   getEarned: string      — on-chain $GET token amount (string for bigints)
//   txSignature: string?   — on-chain tx signature
//
// Returns:
//   { newGetPoints, debited, credited, gFarmTxnId, gSpendTxnId }
exports.syncAgentRun = onRequest({cors: true}, async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(405).json({error: "method-not-allowed"});
      return;
    }
    if (!checkBotAuth(req, res)) return;

    const b = req.body || {};
    const wallet = String(b.walletAddress || "").trim();
    const agentPubkey = String(b.agentPubkey || "").trim();
    const gFarmed = Math.max(0, Math.floor(Number(b.gFarmed) || 0));
    const runsCompleted = Math.max(0, Math.floor(Number(b.runsCompleted) || 0));
    const boxCount = Math.max(0, Math.floor(Number(b.boxCount) || 0));
    const gSpent = Math.max(0, Math.floor(Number(b.gSpent) || 0));
    const getEarned = String(b.getEarned || "0");
    const txSignature = b.txSignature ? String(b.txSignature) : null;

    if (!wallet) { res.status(400).json({error: "walletAddress required"}); return; }
    try { new PublicKey(wallet); } catch { res.status(400).json({error: "invalid walletAddress"}); return; }
    if (gFarmed === 0 && boxCount === 0) {
      res.status(400).json({error: "nothing to sync (both gFarmed and boxCount are 0)"});
      return;
    }
    if (boxCount > 0 && gSpent !== boxCount * SINGLE_BOX_COST) {
      res.status(400).json({error: `gSpent must equal boxCount × ${SINGLE_BOX_COST}`});
      return;
    }

    let outcome;
    await db.runTransaction(async (tx) => {
      const userRef = db.collection("users").doc(wallet);
      const userDoc = await tx.get(userRef);

      let userExisted = userDoc.exists;
      let currentBalance = 0;
      if (userExisted) currentBalance = readPointBalance(userDoc.data() || {});

      const netDelta = gFarmed - gSpent;
      const newBalance = currentBalance + netDelta;

      const userUpdate = {
        getPoints: FieldValue.increment(netDelta),
        lastAgentRunAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (!userExisted) {
        // Create a minimal user doc so the agent can credit a wallet that
        // hasn't logged into the Hub yet. The Hub login flow will fill in
        // the rest of the profile.
        userUpdate.primaryWallet = wallet;
        userUpdate.connectedWallets = [wallet];
        userUpdate.getPoints = netDelta; // overwrite increment to absolute
        userUpdate.role = "user";
        userUpdate.createdAt = FieldValue.serverTimestamp();
        tx.set(userRef, userUpdate, {merge: true});
      } else {
        tx.update(userRef, userUpdate);
      }

      let gFarmTxnId = null;
      let gSpendTxnId = null;

      if (gFarmed > 0) {
        const ref = db.collection("transactions").doc();
        gFarmTxnId = ref.id;
        tx.create(ref, {
          uid: wallet,
          walletAddress: wallet,
          agentPubkey: agentPubkey || null,
          amount: gFarmed,
          type: "agent_farm",
          status: "credited",
          runsCompleted,
          description: `Agent collected ${gFarmed.toLocaleString()} G from ${runsCompleted} offline run${runsCompleted === 1 ? "" : "s"}`,
          timestamp: FieldValue.serverTimestamp(),
        });
      }

      if (boxCount > 0) {
        const ref = db.collection("transactions").doc();
        gSpendTxnId = ref.id;
        tx.create(ref, {
          uid: wallet,
          walletAddress: wallet,
          agentPubkey: agentPubkey || null,
          amount: gSpent,
          type: "agent_box_open",
          status: "consumed",
          boxCount,
          totalReward: getEarned,
          txSignature: txSignature || null,
          description: `Agent opened ${boxCount} box${boxCount === 1 ? "" : "es"} on-chain — spent ${gSpent.toLocaleString()} G, won ${getEarned} GET`,
          timestamp: FieldValue.serverTimestamp(),
        });
      }

      outcome = {
        newGetPoints: newBalance,
        debited: gSpent,
        credited: gFarmed,
        gFarmTxnId,
        gSpendTxnId,
        userExisted,
      };
    });

    res.status(200).json(outcome);
  } catch (error) {
    logger.error("syncAgentRun FAILED:", error instanceof Error ? error.message : error);
    res.status(500).json({error: "internal", message: error instanceof Error ? error.message : String(error)});
  }
});

// Test helpers (not deployed; consumed by the unit-test harness).
exports._test = {
  SINGLE_BOX_COST,
  MAX_BOXES_PER_BATCH,
  DAILY_BOX_LIMIT,
  buildBatchMessage,
  getConfigPda,
  getProgramId,
  getRewardMint,
  getBackendSigner,
};
