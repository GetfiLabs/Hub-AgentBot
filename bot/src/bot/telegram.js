/**
 * Telegram Bot — Raider / RaiderBot
 *
 * All non-LLM system messages are English. The LLM (gpt-4o-mini) handles
 * multilingual chat by mirroring whatever language the user writes in.
 */

const {Telegraf} = require('telegraf');
const database = require('../services/database');
const gameApi = require('../services/gameApi');
const openai = require('../services/openai');
const teamGroup = require('./team_group');
require('dotenv').config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const TEAM_GROUP_CHAT_ID = process.env.TEAM_GROUP_CHAT_ID;

// ───────────────────────── Short-Term Memory ─────────────────────────
const chatHistoryMemory = new Map();

function getChatHistory(chatId) {
  return chatHistoryMemory.get(chatId) || [];
}
function addToChatHistory(chatId, role, content) {
  if (!chatHistoryMemory.has(chatId)) chatHistoryMemory.set(chatId, []);
  const history = chatHistoryMemory.get(chatId);
  history.push({role, content});
  if (history.length > 20) history.shift();
}
function clearChatHistory(chatId) { chatHistoryMemory.delete(chatId); }

const messageHistoryMap = new Map();
function addToMessageHistory(chatId, role, text) {
  if (!messageHistoryMap.has(chatId)) messageHistoryMap.set(chatId, []);
  const history = messageHistoryMap.get(chatId);
  history.push(`[${role}] ${text}`);
  if (history.length > 3) history.shift();
}
function getMessageHistory(chatId) { return messageHistoryMap.get(chatId) || []; }

// ───────────────────────── Static system strings (English only) ──────
const MSG = {
  start:
    "Connection established. Raider online — I'm your in-game wingman from the Roll Raider tracks. " +
    "Systems are linked. Talk to me anytime — strategy, stuck levels, Hub questions. Let's roll.",
  idRequest:
    "One step before we can start: open Roll Raider, go to Settings on the home screen, " +
    "copy your Player ID, and paste it here as `/playerid YOUR_PLAYER_ID`.",
  systemError: "Something went wrong. Try again in a moment.",
  invalidFormat: "Send your Player ID like this:\n`/playerid YOUR_PLAYER_ID`",
  notFound: "I couldn't find that Player ID in the game system. Double-check it and try again.",
  alreadyLinked: "This Player ID is already linked to another account.",
};

// ───────────────────────── Auth middleware ─────────────────────────
bot.use(async (ctx, next) => {
  const chatId = String(ctx.chat?.id);
  if (chatId === String(TEAM_GROUP_CHAT_ID)) return next();

  if (ctx.updateType === 'my_chat_member') {
    const newStatus = ctx.myChatMember?.new_chat_member?.status;
    if (newStatus === 'kicked' || newStatus === 'left') {
      await database.updateUserStatus('telegram', chatId, 'blocked');
    } else if (newStatus === 'member') {
      await database.updateUserStatus('telegram', chatId, 'active');
    }
    return;
  }

  if (!ctx.from) return next();

  const username = ctx.from.username || ctx.from.first_name || 'Player';
  let user;
  try {
    user = await database.findOrCreateUser('telegram', chatId, username);
    if (user.status === 'blocked' && ctx.message) {
      await database.updateUserStatus('telegram', chatId, 'active');
      user.status = 'active';
    }
  } catch (error) {
    console.error('User check error:', error);
    return next();
  }

  if (user && user.is_verified) {
    ctx.state = ctx.state || {};
    ctx.state.user = user;
    return next();
  }

  const text = ctx.message?.text?.trim() || '';
  if (text.startsWith('/playerid')) return next();
  if (text && /^[A-Za-z0-9_-]{4,}$/.test(text) && !text.startsWith('/')) {
    await handlePlayerIdInput(ctx, chatId, text);
    return;
  }

  if (ctx.message) {
    try {
      await ctx.reply(MSG.idRequest);
    } catch (e) {
      if (e.response && e.response.error_code === 403) {
        await database.updateUserStatus('telegram', chatId, 'blocked');
      } else {
        console.error('Reply error in middleware:', e);
      }
    }
  }
});

bot.start(async (ctx) => {
  try {
    await ctx.reply(MSG.start);
  } catch (error) {
    console.error('❌ /start error:', error);
    await ctx.reply(MSG.systemError);
  }
});

// ───────────────────────── /playerid ─────────────────────────
bot.command('playerid', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const args = ctx.message.text.split(' ').slice(1);
  const playerId = args[0];

  if (!playerId) {
    await ctx.reply(MSG.invalidFormat, {parse_mode: 'Markdown'});
    return;
  }
  await handlePlayerIdInput(ctx, chatId, playerId);
});

// ───────────────────────── /stats ─────────────────────────
bot.command('stats', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const user = await database.getPlayerByPlatformId('telegram', chatId);
  if (!user || !user.is_verified) {
    await ctx.reply(MSG.idRequest);
    return;
  }
  try {
    const stats = await gameApi.fetchPlayerStats(user.player_id);
    if (stats) {
      await database.saveGameData(user.player_id, stats);
      await ctx.reply(
        `📊 Your Player Stats\n\n` +
        `🎯 Level: ${stats.level}\n` +
        `🪙 GET Token: ${stats.getToken}\n` +
        `💎 Diamonds: ${stats.diamonds}\n` +
        `🏆 High Score: ${stats.highScore}`,
      );
    } else {
      await ctx.reply(MSG.systemError);
    }
  } catch (error) {
    console.error('❌ /stats error:', error);
    await ctx.reply(MSG.systemError);
  }
});

// ───────────────────────── /push (team broadcast) ─────────────────────────
bot.on('message', async (ctx, next) => {
  const text = ctx.message?.text || ctx.message?.caption || '';
  if (!text.toLowerCase().startsWith('/push')) return next();

  const chatId = String(ctx.chat.id);
  if (chatId !== String(TEAM_GROUP_CHAT_ID)) return;

  const cleanedText = text.replace(/^\/push\s*/i, '');
  try {
    const activeUsers = await database.getAllActiveTelegramUsers();
    if (!activeUsers || activeUsers.length === 0) {
      await ctx.reply('⚠️ No active users found.');
      return;
    }
    await ctx.reply(`⏳ Broadcast started for ${activeUsers.length} users…`);

    let successCount = 0;
    const BATCH_SIZE = 25, DELAY_MS = 1000;
    for (let i = 0; i < activeUsers.length; i += BATCH_SIZE) {
      const batch = activeUsers.slice(i, i + BATCH_SIZE);
      const promises = batch.map(async (user) => {
        try {
          if (!user.platform_user_id) return;
          if (ctx.message.photo) {
            const best = ctx.message.photo[ctx.message.photo.length - 1];
            await ctx.telegram.sendPhoto(user.platform_user_id, best.file_id, {caption: cleanedText});
          } else if (ctx.message.video) {
            await ctx.telegram.sendVideo(user.platform_user_id, ctx.message.video.file_id, {caption: cleanedText});
          } else if (ctx.message.animation) {
            await ctx.telegram.sendAnimation(user.platform_user_id, ctx.message.animation.file_id, {caption: cleanedText});
          } else if (ctx.message.document) {
            await ctx.telegram.sendDocument(user.platform_user_id, ctx.message.document.file_id, {caption: cleanedText});
          } else {
            await ctx.telegram.sendMessage(user.platform_user_id, cleanedText);
          }
          successCount++;
        } catch (err) {
          console.error(`Broadcast failed to ${user.platform_user_id}:`, err.message);
        }
      });
      await Promise.all(promises);
      if (i + BATCH_SIZE < activeUsers.length) {
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }
    }
    await ctx.reply(`🚀 Broadcast delivered to ${successCount} players.`);
  } catch (error) {
    console.error('❌ /push error:', error);
    await ctx.reply('⚠️ Broadcast failed.');
  }
});

// ───────────────────────── /rule ─────────────────────────
bot.command('rule', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const text = ctx.message.text.replace(/^\/rule\s*/i, '').trim();

  if (text.toLowerCase() === 'list') {
    try {
      const user = await database.getPlayerByPlatformId('telegram', chatId);
      let rules = user?.custom_instructions || [];
      if (!Array.isArray(rules)) rules = rules ? [rules] : [];
      if (rules.length === 0) {
        await ctx.reply('📋 No saved rules yet. Use /rule <your rule> to add one.');
        return;
      }
      const list = rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
      await ctx.reply(`📋 Your Permanent Rules (${rules.length}):\n\n${list}`);
    } catch (error) {
      console.error('❌ /rule list error:', error);
      await ctx.reply('⚠️ Failed to fetch rules.');
    }
    return;
  }

  if (text.toLowerCase() === 'clear') {
    try {
      await database.clearCustomInstructions('telegram', chatId);
      await ctx.reply('🗑️ All your permanent rules have been cleared.');
    } catch (error) {
      console.error('❌ /rule clear error:', error);
      await ctx.reply('⚠️ Failed to clear rules.');
    }
    return;
  }

  if (!text) {
    await ctx.reply('Add a rule like: /rule Always call me "Captain".\n📋 /rule list — view saved\n🗑️ /rule clear — delete all');
    return;
  }

  try {
    await ctx.sendChatAction('typing');
    await database.saveCustomInstruction('telegram', chatId, text);

    const user = await database.getPlayerByPlatformId('telegram', chatId);
    let gameData = null;
    let playerId = null;
    let customInstructions = user?.custom_instructions || [];
    if (!Array.isArray(customInstructions)) {
      customInstructions = customInstructions ? [customInstructions] : [];
    }
    const totalRuleCount = customInstructions.length;

    if (user && user.is_verified) {
      playerId = user.player_id;
      gameData = await gameApi.fetchPlayerStats(playerId);
      if (!gameData) {
        const cached = await database.getLatestGameData(playerId);
        if (cached) {
          gameData = {
            level: cached.level,
            getToken: parseFloat(cached.get_token),
            diamonds: cached.diamonds,
            highScore: cached.high_score,
          };
        }
      } else {
        await database.saveGameData(playerId, gameData);
      }
    }

    const triggerMessage =
      `SYSTEM OVERRIDE: The user just added a new permanent rule: '${text}'.\n` +
      `Total active rules: ${totalRuleCount}.\n` +
      `STRICT: Reply in the EXACT language of the rule above. Acknowledge briefly, stay in-character as Raider. ` +
      `Confirm the rule is stored. Do NOT ask any trailing question. Keep it short.`;

    const {reply} = await openai.chat(
      triggerMessage, gameData, playerId, customInstructions, []
    );

    addToChatHistory(chatId, 'user', text);
    addToChatHistory(chatId, 'assistant', reply);
    addToMessageHistory(chatId, 'Player', text);
    addToMessageHistory(chatId, 'Bot', reply);

    await ctx.reply(reply);
  } catch (error) {
    console.error('❌ /rule error:', error);
    await ctx.reply('⚠️ Failed to save rule.');
  }
});

// ───────────────────────── /reset ─────────────────────────
bot.command('reset', (ctx) => {
  clearChatHistory(String(ctx.chat.id));
  ctx.reply('🔄 Chat memory cleared.');
});

// ───────────────────────── General text catcher ─────────────────────────
bot.on('text', async (ctx, next) => {
  const chatId = String(ctx.chat.id);
  const text = ctx.message.text.trim();

  if (chatId === String(TEAM_GROUP_CHAT_ID)) return next();
  if (text.startsWith('/')) return next();

  try {
    const user = ctx.state?.user || await database.getPlayerByPlatformId('telegram', chatId);
    if (!user || !user.is_verified) return;

    await ctx.sendChatAction('typing');
    addToMessageHistory(chatId, 'Player', text);

    let gameData = await gameApi.fetchPlayerStats(user.player_id);
    if (!gameData) {
      const cached = await database.getLatestGameData(user.player_id);
      if (cached) {
        gameData = {
          level: cached.level,
          getToken: parseFloat(cached.get_token),
          diamonds: cached.diamonds,
          highScore: cached.high_score,
        };
      }
    } else {
      await database.saveGameData(user.player_id, gameData);
    }

    const customInstructions = user.custom_instructions || null;
    const chatHistory = getChatHistory(chatId);

    const {reply} = await openai.chat(text, gameData, user.player_id, customInstructions, chatHistory);

    addToChatHistory(chatId, 'user', text);
    addToChatHistory(chatId, 'assistant', reply);
    addToMessageHistory(chatId, 'Bot', reply);

    const {isLowConfidence, reason} = openai.analyzeConfidence(reply);
    if (isLowConfidence) {
      console.log(`⚠️ Low confidence (${reason}) — escalating.`);
      await ctx.reply("I'm pinging the team on this — sit tight.");
      const messageHistory = getMessageHistory(chatId);
      await teamGroup.escalateToTeam(user.player_id, text, messageHistory, chatId);
    } else {
      await ctx.reply(reply);
    }
  } catch (error) {
    console.error('❌ Message processing error:', error);
    await ctx.reply(MSG.systemError);
  }
});

// ───────────────────────── Media escalation ─────────────────────────
async function handleMediaEscalation(ctx, mediaType) {
  const chatId = String(ctx.chat.id);
  if (chatId === String(TEAM_GROUP_CHAT_ID)) return;
  try {
    const user = await database.getPlayerByPlatformId('telegram', chatId);
    const playerId = (user && user.player_id) ? user.player_id : 'Unknown';
    const username = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'Unknown');
    const caption = ctx.message.caption || '';

    const teamCaption =
      `🚨 New Report!\n` +
      `👤 PlayerID: ${playerId}\n` +
      `📱 Telegram: ${username}\n` +
      (caption ? `💬 Description: ${caption}\n` : '') +
      `\n[ChatID: ${chatId}]`;

    if (!TEAM_GROUP_CHAT_ID) {
      console.error('❌ TEAM_GROUP_CHAT_ID not defined.');
      await ctx.reply(MSG.systemError);
      return;
    }

    if (mediaType === 'photo') {
      const photo = ctx.message.photo;
      const best = photo[photo.length - 1];
      await bot.telegram.sendPhoto(TEAM_GROUP_CHAT_ID, best.file_id, {caption: teamCaption});
    } else if (mediaType === 'document') {
      await bot.telegram.sendDocument(TEAM_GROUP_CHAT_ID, ctx.message.document.file_id, {caption: teamCaption});
    }

    await ctx.reply(
      "Got your report Cap. Forwarded to the engineers at Base Command. " +
      "Keep your rhythm on the track in the meantime."
    );
  } catch (error) {
    console.error(`❌ Media (${mediaType}) error:`, error);
    await ctx.reply(MSG.systemError);
  }
}
bot.on('photo', (ctx) => handleMediaEscalation(ctx, 'photo'));
bot.on('document', (ctx) => handleMediaEscalation(ctx, 'document'));

// ───────────────────────── Player ID linker ─────────────────────────
async function handlePlayerIdInput(ctx, chatId, playerId) {
  try {
    await ctx.sendChatAction('typing');
    const isValid = await gameApi.validatePlayerId(playerId);
    if (!isValid) {
      await ctx.reply(MSG.notFound);
      return;
    }

    const username = ctx.from.username || ctx.from.first_name || 'Player';
    await database.findOrCreateUser('telegram', chatId, username);
    await database.linkPlayerId('telegram', chatId, playerId);

    let gameData = await gameApi.fetchPlayerStats(playerId);
    if (gameData) await database.saveGameData(playerId, gameData);
    else gameData = {};

    const user = await database.getPlayerByPlatformId('telegram', chatId);
    const customInstructions = user ? user.custom_instructions : null;
    const chatHistory = getChatHistory(chatId);

    const triggerMessage = 'System matched, please welcome the player with the initial connection message';
    addToMessageHistory(chatId, 'System', triggerMessage);

    const {reply} = await openai.chat(triggerMessage, gameData, playerId, customInstructions, chatHistory);

    addToChatHistory(chatId, 'user', triggerMessage);
    addToChatHistory(chatId, 'assistant', reply);
    addToMessageHistory(chatId, 'Bot', reply);

    await ctx.reply(reply);
  } catch (error) {
    if (error.code === 'DUPLICATE_PLAYER_ID') {
      await ctx.reply(MSG.alreadyLinked);
      return;
    }
    console.error('❌ Player ID linking error:', error);
    await ctx.reply(MSG.systemError);
  }
}

// ───────────────────────── Agent commands (Phase 3) ─────────────────────────

const {PublicKey, LAMPORTS_PER_SOL} = require('@solana/web3.js');
const admin = require('firebase-admin');
const agentKeys = require('../services/wallet/agentKeys');
const {fetchAgentAuthority} = require('../services/solana/agentAuthority');
const {deriveFuelVault} = require('../services/solana/pdas');
const {getConnection} = require('../services/solana/connection');
const {resignAgent} = require('../services/agent/resignation');
const {getGetTokenBalance} = require('../services/solana/tokenBalance');

const PHASE3_PROGRAM_ID = new PublicKey(
  process.env.GETFI_LOOTBOX_PROGRAM_ID || 'Bm6zsJgc87Hj6gGEtpHtyjP89Lwuu7TequM6dgPL8LA7',
);
const HUB_AGENT_PAGE_URL = process.env.HUB_AGENT_PAGE_URL || null;

function fmtSol(lamports) {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(4);
}

// /connectagent <wallet> — generate agent keypair + show Hub link
async function cmdConnectAgent(ctx) {
  const chatId = String(ctx.chat.id);
  const match = ctx.message.text.match(/^\/\w+(?:@\w+)?(?:\s+(\S+))?/i);
  const walletAddressRaw = match && match[1] ? match[1] : null;

  try {
    if (!walletAddressRaw) {
      await ctx.reply(
        '🔗 Connect your wallet:\n`/connectagent <SolanaWalletAddress>`\n\n' +
        'Copy your Solana wallet address from Phantom and paste it after the command.',
        {parse_mode: 'Markdown'},
      );
      return;
    }
    let walletPubkey;
    try {
      walletPubkey = new PublicKey(walletAddressRaw);
    } catch {
      await ctx.reply('⚠️ Not a valid Solana wallet address. Try again.');
      return;
    }

    const {keypair, created} = await agentKeys.getOrCreateAgentKeypair(
      'telegram', chatId, walletPubkey.toBase58(),
    );
    if (!created) {
      await agentKeys.setWalletAddress('telegram', chatId, walletPubkey.toBase58());
    }
    const agentPub = keypair.publicKey.toBase58();
    const hubLink = HUB_AGENT_PAGE_URL
      ? `\n\n🌐 Hub: ${HUB_AGENT_PAGE_URL}?agent=${agentPub}`
      : '';
    await ctx.reply(
      '✅ Agent keypair ready.\n\n' +
      `🤖 *Agent Pubkey:*\n\`${agentPub}\`\n\n` +
      `👤 *Your Wallet:*\n\`${walletPubkey.toBase58()}\`\n\n` +
      "🔐 Now open GetFi Hub and go to your *Profile* (or the *Earn* page). " +
      "Find the *Authorize Agent* section, paste this Agent Pubkey, deposit fuel " +
      "(recommended: *0.05 SOL*), and confirm." +
      hubLink +
      '\n\nOnce confirmed, run `/agentstatus` to check the state.',
      {parse_mode: 'Markdown'},
    );
  } catch (err) {
    console.error(`❌ /connectagent error (chat=${chatId}):`, err);
    try {
      await ctx.reply(
        `⚠️ Failed to create agent:\n\`${err && err.message ? err.message : String(err)}\``,
        {parse_mode: 'Markdown'},
      );
    } catch {}
  }
}

// /agentstatus — on-chain state + lifetime + since-last-check totals
async function cmdAgentStatus(ctx) {
  const chatId = String(ctx.chat.id);
  try {
    const doc = await agentKeys.getDoc('telegram', chatId);
    if (!doc) {
      await ctx.reply(
        "🔌 You don't have an agent yet.\n\nStart with: `/connectagent <SolanaWalletAddress>`",
        {parse_mode: 'Markdown'},
      );
      return;
    }
    if (!doc.wallet_address) {
      await ctx.reply(
        '⚠️ No wallet address linked.\nReconnect with `/connectagent <SolanaWalletAddress>`.',
        {parse_mode: 'Markdown'},
      );
      return;
    }

    const userPubkey = new PublicKey(doc.wallet_address);
    const auth = await fetchAgentAuthority(PHASE3_PROGRAM_ID, userPubkey);
    const fuelPda = deriveFuelVault(PHASE3_PROGRAM_ID, userPubkey);
    const fuelLamports = await getConnection().getBalance(fuelPda, 'confirmed');

    // On-chain $GET balance — separate from the off-chain G the Hub
    // tracks in Firestore; this is the SPL token in the wallet itself.
    let onchainGetLine = '';
    try {
      const bal = await getGetTokenBalance(userPubkey);
      onchainGetLine = `💎 On-chain $GET: *${bal.ui}*\n`;
    } catch (err) {
      console.warn(`   [/agentstatus] $GET balance lookup failed: ${err.message}`);
      onchainGetLine = '💎 On-chain $GET: (lookup failed)\n';
    }

    let onchain;
    if (!auth) {
      onchain = "❌ Not registered on-chain — pending authorization on the Hub.";
    } else if (auth.revoked) {
      onchain = '🚫 On-chain status: REVOKED.';
    } else if (auth.expiryTs <= Math.floor(Date.now() / 1000)) {
      onchain = `⏳ Expired (${new Date(auth.expiryTs * 1000).toISOString()}).`;
    } else if (auth.agentPubkey.toBase58() !== doc.agent_pubkey) {
      onchain = "⚠️ A different agent is registered on the Hub — doesn't match this bot.";
    } else {
      onchain = `✅ Active — until: ${new Date(auth.expiryTs * 1000).toUTCString()}`;
    }

    const lastViewedTs = doc.last_status_viewed_at
      ? doc.last_status_viewed_at.toMillis?.()
      : null;

    // Aggregate runs since last /agentstatus view (or all-time if first view).
    const sinceFilter = lastViewedTs
      ? admin.firestore.Timestamp.fromMillis(lastViewedTs)
      : null;

    const baseQuery = admin.firestore()
      .collection('bot_agent_runs')
      .where('platform', '==', 'telegram')
      .where('platform_user_id', '==', chatId);

    let sinceQuery = baseQuery;
    if (sinceFilter) sinceQuery = sinceQuery.where('created_at', '>', sinceFilter);

    const [sinceSnap, allSnap] = await Promise.all([
      sinceQuery.get(),
      baseQuery.get(),
    ]);

    const agg = (snap) => {
      let boxes = 0, gSpent = 0, getEarned = 0n;
      for (const d of snap.docs) {
        const data = d.data();
        boxes += Number(data.box_count || 0);
        gSpent += Number(data.g_spent || (Number(data.box_count || 0) * 5000));
        if (data.total_amount) {
          try { getEarned += BigInt(data.total_amount); } catch {}
        }
      }
      return {boxes, gSpent, getEarned};
    };
    const since = agg(sinceSnap);
    const lifetime = agg(allSnap);

    const lastRun = doc.last_run_at
      ? new Date(doc.last_run_at.toMillis()).toUTCString()
      : 'no runs yet';
    const nonce = auth ? auth.nonceCounter.toString() : '—';

    const sinceLabel = lastViewedTs
      ? `since last check (${new Date(lastViewedTs).toUTCString()})`
      : 'since the beginning';

    await ctx.reply(
      '📡 *Agent Status*\n\n' +
      `🤖 Agent: \`${doc.agent_pubkey}\`\n` +
      `👤 Wallet: \`${doc.wallet_address}\`\n` +
      onchainGetLine +
      '\n' +
      `🔗 ${onchain}\n` +
      `⛽ Fuel (FuelVault): *${fmtSol(fuelLamports)} SOL*\n` +
      `🔢 Nonce: ${nonce}\n` +
      `⏱ Last run: ${lastRun}\n\n` +
      `📊 *Activity ${sinceLabel}*\n` +
      `📦 Boxes opened: ${since.boxes}\n` +
      `💰 G spent: ${since.gSpent.toLocaleString()}\n` +
      `🪙 GET earned: ${since.getEarned.toString()}\n\n` +
      `♾️ *Lifetime totals*\n` +
      `📦 Boxes opened: ${lifetime.boxes}\n` +
      `💰 G spent: ${lifetime.gSpent.toLocaleString()}\n` +
      `🪙 GET earned: ${lifetime.getEarned.toString()}`,
      {parse_mode: 'Markdown'},
    );

    // Update last_status_viewed_at AFTER computing the diff.
    await admin.firestore()
      .collection('bot_agents')
      .doc(`telegram_${chatId}`)
      .update({
        last_status_viewed_at: admin.firestore.FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.error(`❌ /agentstatus error (chat=${chatId}):`, err);
    try {
      await ctx.reply(
        `⚠️ Failed to read status:\n\`${err && err.message ? err.message : String(err)}\``,
        {parse_mode: 'Markdown'},
      );
    } catch {}
  }
}

// /report — last 5 runs
async function cmdReport(ctx) {
  const chatId = String(ctx.chat.id);
  try {
    const snap = await admin
      .firestore()
      .collection('bot_agent_runs')
      .where('platform', '==', 'telegram')
      .where('platform_user_id', '==', chatId)
      .orderBy('created_at', 'desc')
      .limit(5)
      .get();

    if (snap.empty) {
      await ctx.reply(
        "📭 No agent runs yet. Authorize an agent on the Hub and deposit fuel — " +
        "the first run will fire on the next scheduler tick.",
      );
      return;
    }

    let totalGet = 0n;
    const lines = snap.docs.map((d) => {
      const data = d.data();
      const t = data.created_at ? new Date(data.created_at.toMillis()).toISOString().slice(0, 16).replace('T', ' ') : '?';
      const get = data.total_amount ? BigInt(data.total_amount) : 0n;
      totalGet += get;
      const tx = (data.tx_signature || '').slice(0, 8);
      return `• ${t} — *${get}* GET (${data.box_count}× box) — \`${tx}…\``;
    });

    await ctx.reply(
      '📊 *Last 5 Agent Runs*\n\n' +
      lines.join('\n') +
      `\n\n🪙 *Total (last 5):* ${totalGet.toString()} GET`,
      {parse_mode: 'Markdown'},
    );
  } catch (err) {
    console.error(`❌ /report error (chat=${chatId}):`, err);
    try {
      await ctx.reply(
        `⚠️ Failed to read report:\n\`${err && err.message ? err.message : String(err)}\``,
        {parse_mode: 'Markdown'},
      );
    } catch {}
  }
}

// /resign — revoke + drain fuel back to user
async function cmdResign(ctx) {
  const chatId = String(ctx.chat.id);
  try {
    const result = await resignAgent({platform: 'telegram', platformUserId: chatId});
    await ctx.reply(
      '👋 Resignation accepted.\n\n' +
      `💰 *${fmtSol(result.refundedLamports)} SOL* refunded to your main wallet.\n` +
      `🤖 Agent has been *revoked* on-chain — it can no longer act on your behalf.\n\n` +
      `🔗 Tx: \`${result.txSignature}\``,
      {parse_mode: 'Markdown'},
    );
  } catch (err) {
    if (err.message === 'no_bot_agent' || err.message === 'no_wallet_linked') {
      await ctx.reply("🤷 You don't have a connected agent.");
      return;
    }
    if (err.message === 'not_registered_onchain') {
      await ctx.reply("⚠️ No on-chain record. If you never authorized on the Hub, there's nothing to resign.");
      return;
    }
    if (err.message === 'agent_pubkey_mismatch') {
      await ctx.reply("⚠️ The Hub has a different agent registered. Resign via the Hub instead.");
      return;
    }
    console.error(`❌ /resign error (chat=${chatId}):`, err);
    try {
      await ctx.reply(
        `⚠️ Resignation failed:\n\`${err && err.message ? err.message : String(err)}\``,
        {parse_mode: 'Markdown'},
      );
    } catch {}
  }
}

// /help — list all commands
async function cmdHelp(ctx) {
  await ctx.reply(
    '🤖 *Raider — Available Commands*\n\n' +
    '*General*\n' +
    '`/start` — welcome + link Player ID\n' +
    '`/playerid <ID>` — link your Roll Raider Player ID\n' +
    '`/stats` — show your in-game stats\n' +
    '`/rule <text>` — save a permanent personal rule\n' +
    '`/rule list` — list saved rules\n' +
    '`/rule clear` — delete all rules\n' +
    '`/reset` — clear chat memory\n' +
    '`/help` or `/commands` — show this list\n\n' +
    '*Agent (on-chain box opening)*\n' +
    '`/connectagent <wallet>` — create your agent keypair\n' +
    '`/agentstatus` — current agent state + activity\n' +
    '`/report` — last 5 agent runs\n' +
    '`/resign` — revoke agent + return fuel',
    {parse_mode: 'Markdown'},
  );
}

// ── Wire up English commands + Turkish legacy aliases ────────────────
bot.command('connectagent', cmdConnectAgent);
bot.command('agentbaglan', cmdConnectAgent); // legacy alias

bot.command('agentstatus', cmdAgentStatus);
bot.command('agentdurum', cmdAgentStatus); // legacy alias

bot.command('report', cmdReport);
bot.command('rapor', cmdReport); // legacy alias

bot.command('resign', cmdResign);
bot.command('istifa', cmdResign); // legacy alias

bot.command('help', cmdHelp);
bot.command('commands', cmdHelp);

// ── Telegram BotFather command menu ─────────────────────────────────
async function publishCommandMenu() {
  try {
    await bot.telegram.setMyCommands([
      {command: 'start', description: 'Welcome + link Player ID'},
      {command: 'playerid', description: 'Link your Roll Raider Player ID'},
      {command: 'stats', description: 'Show your in-game stats'},
      {command: 'connectagent', description: 'Create your on-chain agent keypair'},
      {command: 'agentstatus', description: 'Current agent state + activity'},
      {command: 'report', description: 'Last 5 agent runs'},
      {command: 'resign', description: 'Revoke agent + return fuel'},
      {command: 'rule', description: 'Save / list / clear permanent rules'},
      {command: 'reset', description: 'Clear chat memory'},
      {command: 'help', description: 'Show all available commands'},
    ]);
    console.log('✅ Telegram command menu published.');
  } catch (err) {
    console.warn('⚠️ setMyCommands failed:', err.message);
  }
}

// ───────────────────────── Team group + error handler ───────────────
teamGroup.setMainBot(bot);
teamGroup.registerTeamReplyHandler(bot);

bot.catch((err, ctx) => {
  const isForbidden = err.response && err.response.error_code === 403;
  if (isForbidden) {
    const chatId = ctx.chat?.id || 'unknown';
    console.log(`⚠️ 403 Forbidden: blocked by user ${chatId}.`);
    if (ctx.chat?.id) {
      database.updateUserStatus('telegram', String(ctx.chat.id), 'blocked').catch(() => {});
    }
  } else {
    console.error(`❌ Global Telegraf Error for ${ctx.updateType}:`, err);
  }
});

module.exports = bot;
module.exports.publishCommandMenu = publishCommandMenu;
