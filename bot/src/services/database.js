/**
 * Database Service — Isolated Firebase (Bot Memory)
 * 
 * Tasks:
 * - Telegram/WhatsApp User ID → Player ID mapping (bot_users collection)
 * - Q&A history and escalation management (bot_qa collection)
 * - Learning log tracking
 * 
 * NOTE: This Firebase project is completely isolated from the main game database.
 * Game data is only read via HTTP through GAME_API_BASE_URL.
 */

const admin = require('firebase-admin');
const path = require('path');
require('dotenv').config();

// ───────────────────────── Firebase Initialization ─────────────────────────
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json';
const resolvedPath = path.resolve(serviceAccountPath);

let db;

function getFirestore() {
  if (!db) {
    throw new Error('Firebase not initialized! initializeDatabase() must be called.');
  }
  return db;
}

// ───────────────────────── Initialization ─────────────────────────
/**
 * Initializes Firebase Admin SDK and establishes Firestore connection.
 */
async function initializeDatabase() {
  try {
    const serviceAccount = require(resolvedPath);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    db = admin.firestore();

    // Test Firestore connection
    await db.collection('_health').doc('check').set({
      lastCheck: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log('✅ Isolated Firebase connection established (Bot Memory).');
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') {
      console.error(`❌ Firebase service account file not found: ${resolvedPath}`);
      console.error('💡 Download the serviceAccountKey.json from the isolated Firebase project and place it in the project root.');
    } else {
      console.error('❌ Firebase initialization error:', error.message);
    }
    throw error;
  }
}

// ───────────────────────── Player CRUD (bot_users collection) ─────────────────────────

/**
 * Register Telegram/WhatsApp user to Firebase or fetch existing record.
 * Document ID format: `{platform}_{platformUserId}`.
 */
async function findOrCreateUser(platform, platformUserId, username = null) {
  const docId = `${platform}_${platformUserId}`;
  const docRef = getFirestore().collection('bot_users').doc(docId);
  const doc = await docRef.get();

  if (doc.exists) {
    return { id: doc.id, ...doc.data() };
  }

  // Create new user
  const newUser = {
    platform,
    platform_user_id: platformUserId,
    username: username || null,
    player_id: null,
    is_verified: false,
    status: 'active',
    created_at: admin.firestore.FieldValue.serverTimestamp(),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  };

  await docRef.set(newUser);
  console.log(`👤 New user record created: ${docId}`);

  return { id: docId, ...newUser };
}

/**
 * Verify and link Player ID to the user.
 */
async function linkPlayerId(platform, platformUserId, playerId) {
  const docId = `${platform}_${platformUserId}`;
  const docRef = getFirestore().collection('bot_users').doc(docId);
  const doc = await docRef.get();

  if (!doc.exists) {
    throw new Error('User not found.');
  }

  // Check if the same player_id is linked to another user
  const existingPlayer = await getFirestore()
    .collection('bot_users')
    .where('player_id', '==', playerId)
    .limit(1)
    .get();

  if (!existingPlayer.empty) {
    const existingDoc = existingPlayer.docs[0];
    if (existingDoc.id !== docId) {
      const error = new Error('This Player ID is already linked to another account!');
      error.code = 'DUPLICATE_PLAYER_ID';
      throw error;
    }
  }

  await docRef.update({
    player_id: playerId,
    is_verified: true,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  });

  const updated = await docRef.get();
  return { id: updated.id, ...updated.data() };
}

/**
 * Get linked Player ID by platform user ID.
 */
async function getPlayerByPlatformId(platform, platformUserId) {
  const docId = `${platform}_${platformUserId}`;
  const docRef = getFirestore().collection('bot_users').doc(docId);
  const doc = await docRef.get();

  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

/**
 * Update the status of a user (e.g. active, blocked)
 */
async function updateUserStatus(platform, platformUserId, status) {
  const docId = `${platform}_${platformUserId}`;
  const docRef = getFirestore().collection('bot_users').doc(docId);
  const doc = await docRef.get();

  if (doc.exists) {
    await docRef.update({
      status: status,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

/**
 * Save player game data to Firebase (cache).
 * Subcollection: bot_users/{docId}/game_data_cache
 */
async function saveGameData(playerId, gameData) {
  const { level, getToken, diamonds, highScore } = gameData;

  // Find document by playerId
  const snapshot = await getFirestore()
    .collection('bot_users')
    .where('player_id', '==', playerId)
    .limit(1)
    .get();

  if (snapshot.empty) return;

  const userDocId = snapshot.docs[0].id;

  await getFirestore()
    .collection('bot_users')
    .doc(userDocId)
    .collection('game_data_cache')
    .add({
      player_id: playerId,
      level: level || 0,
      get_token: getToken || 0,
      diamonds: diamonds || 0,
      high_score: highScore || 0,
      fetched_at: admin.firestore.FieldValue.serverTimestamp(),
    });
}

/**
 * Get latest saved game data.
 */
async function getLatestGameData(playerId) {
  const snapshot = await getFirestore()
    .collection('bot_users')
    .where('player_id', '==', playerId)
    .limit(1)
    .get();

  if (snapshot.empty) return null;

  const userDocId = snapshot.docs[0].id;

  const cacheSnapshot = await getFirestore()
    .collection('bot_users')
    .doc(userDocId)
    .collection('game_data_cache')
    .orderBy('fetched_at', 'desc')
    .limit(1)
    .get();

  if (cacheSnapshot.empty) return null;
  return cacheSnapshot.docs[0].data();
}

/**
 * Get all active (verified) Telegram users.
 */
async function getAllActiveTelegramUsers() {
  const snapshot = await getFirestore()
    .collection('bot_users')
    .where('platform', '==', 'telegram')
    .where('is_verified', '==', true)
    .get();

  return snapshot.docs.map((doc) => doc.data());
}

// ───────────────────────── Pending Questions — bot_qa collection (Step 3: Escalation) ─────────────────────────

/**
 * Save unanswered question to Firebase.
 * @param {string} playerId - Player ID
 * @param {string} question - Question asked
 * @param {string[]} messageHistory - Last 3 message history
 * @param {number} telegramMessageId - Message ID in team group
 * @param {string} telegramChatId - Player's Telegram chat ID (for reply delivery)
 * @returns {Promise<string>} - ID of the created record
 */
async function createPendingQuestion(playerId, question, messageHistory, telegramMessageId, telegramChatId) {
  const docRef = await getFirestore().collection('bot_qa').add({
    player_id: playerId,
    question,
    message_history: messageHistory || [],
    telegram_message_id: telegramMessageId,
    telegram_chat_id: telegramChatId,
    answer: null,
    status: 'pending',
    created_at: admin.firestore.FieldValue.serverTimestamp(),
    answered_at: null,
  });

  return docRef.id;
}

/**
 * Find pending question by message ID in team group.
 * @param {number} telegramMessageId - Message ID in team group
 * @returns {Promise<object|null>}
 */
async function getPendingQuestionByMessageId(telegramMessageId) {
  const snapshot = await getFirestore()
    .collection('bot_qa')
    .where('telegram_message_id', '==', telegramMessageId)
    .limit(1)
    .get();

  if (snapshot.empty) return null;

  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
}

/**
 * Mark pending question as answered.
 * @param {string} questionId - ID of the question record
 * @param {string} answer - Team answer
 */
async function answerPendingQuestion(questionId, answer) {
  await getFirestore().collection('bot_qa').doc(questionId).update({
    answer,
    status: 'answered',
    answered_at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Get answered but not yet delivered pending questions for player.
 * @param {string} playerId
 * @returns {Promise<object[]>}
 */
async function getPendingAnswersForPlayer(playerId) {
  const snapshot = await getFirestore()
    .collection('bot_qa')
    .where('player_id', '==', playerId)
    .where('status', '==', 'answered')
    .orderBy('answered_at', 'asc')
    .get();

  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

// ───────────────────────── Step 4: Learning Loop ─────────────────────────

/**
 * Mark question status as 'delivered' (forwarded to player).
 * @param {string} questionId - ID of the question record
 */
async function markQuestionDelivered(questionId) {
  await getFirestore().collection('bot_qa').doc(questionId).update({
    status: 'delivered',
  });
}

/**
 * Save custom instructions for the user (Long Term Memory)
 */
async function saveCustomInstruction(platform, platformUserId, instructions) {
  const docId = `${platform}_${platformUserId}`;
  const docRef = getFirestore().collection('bot_users').doc(docId);
  const doc = await docRef.get();

  if (!doc.exists) {
    throw new Error('User not found.');
  }

  await docRef.update({
    custom_instructions: admin.firestore.FieldValue.arrayUnion(instructions),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Clear all custom instructions for the user (Long Term Memory Reset)
 */
async function clearCustomInstructions(platform, platformUserId) {
  const docId = `${platform}_${platformUserId}`;
  const docRef = getFirestore().collection('bot_users').doc(docId);
  const doc = await docRef.get();

  if (!doc.exists) {
    throw new Error('User not found.');
  }

  await docRef.update({
    custom_instructions: admin.firestore.FieldValue.delete(),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Log QA pair learning history to Firebase.
 * @param {string} question - Original question
 * @param {string} answer - Team answer
 * @param {string} vectorStoreFileId - ID of the file uploaded to Vector Store (optional)
 */
async function logLearnedQA(question, answer, vectorStoreFileId = null) {
  await getFirestore().collection('bot_qa_learned').add({
    question,
    answer,
    vector_store_file_id: vectorStoreFileId,
    created_at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ───────────────────────── Shutdown ─────────────────────────
/**
 * Cleanly closes Firebase connection.
 */
async function shutdown() {
  try {
    if (admin.apps.length > 0) {
      await admin.app().delete();
      console.log('🔌 Firebase connection closed.');
    }
  } catch (error) {
    console.error('⚠️ Firebase shutdown error:', error.message);
  }
}

// ───────────────────────── Exports ─────────────────────────
module.exports = {
  initializeDatabase,
  findOrCreateUser,
  linkPlayerId,
  getPlayerByPlatformId,
  saveGameData,
  getLatestGameData,
  getAllActiveTelegramUsers,
  createPendingQuestion,
  getPendingQuestionByMessageId,
  answerPendingQuestion,
  getPendingAnswersForPlayer,
  markQuestionDelivered,
  saveCustomInstruction,
  clearCustomInstructions,
  logLearnedQA,
  updateUserStatus,
  shutdown,
};
