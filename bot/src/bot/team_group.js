/**
 * Team Group Bot — Step 3 + 4: Human-AI Transition & Learning Loop
 *
 * Tasks:
 * 1. Forward question to team group when bot is stuck (Player ID, Question, Last 3 Messages)
 * 2. Capture team's Reply and save to database as pending_answer
 * 3. Deliver the pending answer to the player with "Persona Masking"
 * 4. (Step 4) Save QA pairs to database for persistent learning
 *
 * NOTE: Vector Store (file_search) disabled for cost optimization.
 *      QA pairs are only logged to Firebase.
 */

const { Telegraf, Markup } = require('telegraf');
const database = require('../services/database');
require('dotenv').config();

const TEAM_GROUP_CHAT_ID = process.env.TEAM_GROUP_CHAT_ID;

// Team group bot separate Telegraf instance
// NOTE: Using the same bot token. For sending messages to the team group,
// the main bot's access to this group is sufficient.
// If a separate bot token is desired, TEAM_BOT_TOKEN can be added to .env.
let teamBot = null;

/**
 * Set the main bot instance to be able to send messages to the team group.
 * This function is called from index.js.
 * @param {Telegraf} mainBotInstance - Main Telegraf bot instance
 */
function setMainBot(mainBotInstance) {
  teamBot = mainBotInstance;
}

// ───────────────────────── Escalation: Forwarding Question to Team ─────────────────────────
/**
 * Forwards the question the bot couldn't answer to the team group.
 *
 * @param {string} playerId - Player's Player ID
 * @param {string} question - The question asked
 * @param {string[]} messageHistory - Last 3 message history
 * @param {string} telegramChatId - Player's Telegram chat ID
 * @returns {Promise<number|null>} - Message ID in team group (to capture reply)
 */
async function escalateToTeam(playerId, question, messageHistory = [], telegramChatId) {
  if (!TEAM_GROUP_CHAT_ID) {
    console.error('❌ TEAM_GROUP_CHAT_ID not defined! Check .env file.');
    return null;
  }

  if (!teamBot) {
    console.error('❌ Team bot instance not set! setMainBot() must be called.');
    return null;
  }

  try {
    // Prepare message history as formatted text
    const historyText = messageHistory.length > 0
      ? messageHistory.map((msg, i) => `  ${i + 1}. ${msg}`).join('\n')
      : '  (No history)';

    const escalationMessage =
      `🚨 **NEW SUPPORT REQUEST**\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `👤 **Player ID:** \`${playerId}\`\n` +
      `💬 **Question:**\n${question}\n\n` +
      `📜 **Recent Message History:**\n${historyText}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💡 _**Reply** to this message. The answer will be automatically forwarded to the player._\n` +
      `[ChatID: ${telegramChatId}]`;

    // Send message to team group
    const sentMessage = await teamBot.telegram.sendMessage(
      TEAM_GROUP_CHAT_ID,
      escalationMessage,
      { parse_mode: 'Markdown' }
    );

    // Save question to database
    const pendingId = await database.createPendingQuestion(
      playerId,
      question,
      messageHistory,
      sentMessage.message_id,
      telegramChatId
    );

    console.log(`📤 Escalation sent — Pending ID: ${pendingId}, Message ID: ${sentMessage.message_id}`);

    return sentMessage.message_id;
  } catch (error) {
    console.error('❌ Failed to send escalation to team:', error.message);
    return null;
  }
}

// ───────────────────────── Reply Handler: Capture Team Response ─────────────────────────
/**
 * Adds the team group reply handler to the main bot.
 * When a team member Replies to an escalation message,
 * captures the response and saves it to the database.
 *
 * @param {Telegraf} mainBotInstance - Main Telegraf bot instance
 */
function registerTeamReplyHandler(mainBotInstance) {
  mainBotInstance.on('text', async (ctx, next) => {
    // Only process messages from team group
    const chatId = String(ctx.chat.id);
    if (chatId !== String(TEAM_GROUP_CHAT_ID)) {
      return next();
    }

    // Skip messages that are not replies
    if (!ctx.message.reply_to_message) {
      return;
    }

    const repliedMessageId = ctx.message.reply_to_message.message_id;
    const teamAnswer = ctx.message.text.trim();

    try {
      // Check if this reply belongs to an escalation message
      const pendingQuestion = await database.getPendingQuestionByMessageId(repliedMessageId);

      if (!pendingQuestion) {
        // ─── Fallback: Media escalation or message tagged with ChatID ───
        // If no record in Firebase bot_qa, extract [ChatID: xxx] from original message
        const originalText = ctx.message.reply_to_message.text
          || ctx.message.reply_to_message.caption
          || '';
        const chatIdMatch = originalText.match(/\[ChatID:\s*(\d+)\]/);

        if (!chatIdMatch) {
          // Neither bot_qa record nor ChatID tag found — this reply is not for us
          return;
        }

        // ChatID found — forward team answer directly to user
        const targetChatId = chatIdMatch[1];
        try {
          const playerMessage =
            `🛠 *Message from Base Command, Captain!*\n\n` +
            `${teamAnswer}\n\n` +
            `_If your issue is resolved, time to get back to the track!_ 🎮`;

          await mainBotInstance.telegram.sendMessage(targetChatId, playerMessage, {
            parse_mode: 'Markdown',
          });

          console.log(`✅ Media report response forwarded to player — ChatID: ${targetChatId}`);

          // Confirmation to team group
          await ctx.reply('✅ Response successfully forwarded to player.', {
            reply_to_message_id: ctx.message.message_id,
          });
        } catch (sendError) {
          console.error('❌ Failed to forward media report response:', sendError.message);
          await ctx.reply('❌ Response could not be forwarded. The user might have blocked the bot.', {
            reply_to_message_id: ctx.message.message_id,
          });
        }
        return;
      }

      if (pendingQuestion.status === 'answered' || pendingQuestion.status === 'delivered') {
        await ctx.reply('⚠️ This question has already been answered!', {
          reply_to_message_id: ctx.message.message_id,
        });
        return;
      }

      // Save answer to database
      await database.answerPendingQuestion(pendingQuestion.id, teamAnswer);

      // ─── Step 4.1: Deliver response to player with Persona Masking ───
      const playerChatId = pendingQuestion.telegram_chat_id;
      if (playerChatId) {
        const playerMessage =
          `🤖 I just called the developer team directly and got the scoop for you! ` +
          `Here is the deal:\n\n` +
          `${teamAnswer}`;

        await mainBotInstance.telegram.sendMessage(playerChatId, playerMessage);
        console.log(`✅ Team response forwarded to player — Player: ${pendingQuestion.player_id}, Chat: ${playerChatId}`);

        // Update status to 'delivered'
        await database.markQuestionDelivered(pendingQuestion.id);
      }

      // ─── Step 4.3: Persistent Learning — Log QA pair to Firebase ───
      // NOTE: Vector Store disabled (cost optimization).
      //      QA pairs only saved to Firebase database.
      try {
        await database.logLearnedQA(
          pendingQuestion.question,
          teamAnswer,
          null // no vectorStoreFileId (file_search disabled)
        );
        console.log(`📚 QA pair saved to Firebase — Question: "${pendingQuestion.question.substring(0, 50)}..."`);
      } catch (qaError) {
        console.error('⚠️ Failed to save QA pair to Firebase (flow continues):', qaError.message);
      }

      // Confirmation message to team group
      await ctx.reply('✅ Response forwarded to player and saved to database! 📚', {
        reply_to_message_id: ctx.message.message_id,
      });
    } catch (error) {
      console.error('❌ Error processing team response:', error);
      await ctx.reply('❌ An error occurred while processing the response.', {
        reply_to_message_id: ctx.message.message_id,
      });
    }
  });
}

// ───────────────────────── Exports ─────────────────────────
module.exports = {
  setMainBot,
  escalateToTeam,
  registerTeamReplyHandler,
};
