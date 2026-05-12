/**
 * OpenAI Service — Raider Bot's intelligence layer (Cost-Optimized: Static System Prompt)
 *
 * Tasks:
 * - Generate smart responses with OpenAI Responses API
 * - Read static instructions from docs/raider_system_prompt.md (instead of file_search)
 * - Manage short-term memory with previous_response_id
 * - Dynamically inject player data into system message
 *
 * NOTE: file_search (Vector Store) disabled for cost optimization.
 *      The entire knowledge base is provided as a string in raider_system_prompt.md.
 */

const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ─── Static System Prompt: Read from docs/raider_system_prompt.md ───
const systemPromptPath = path.join(__dirname, '../../docs/raider_system_prompt.md');
const systemInstructions = fs.readFileSync(systemPromptPath, 'utf-8');

// ───────────────────────── System Prompt ─────────────────────────
/**
 * Generates the system prompt combining Raider Bot's core persona and player data.
 * @param {object|null} gameData - Player statistics
 * @param {string|null} playerId - Player ID
 */
function buildSystemMessage(gameData = null, playerId = null) {
  let prefix = '';

  if (gameData && playerId) {
    prefix = `
[PLAYER DATA]
Player ID: ${playerId}
Level: ${gameData.level}
GET Token: ${gameData.getToken}
Diamonds: ${gameData.diamonds}
High Score: ${gameData.highScore}
---
`;
  }

  // Static system prompt (docs/raider_system_prompt.md) + dynamic player data
  return `${prefix}${systemInstructions}`;
}

// ───────────────────────── Chat with Chat Completions API ─────────────────────────
/**
 * Send message and get response with OpenAI Chat Completions API.
 * Generates response with zero tool cost using static system prompt.
 * Manages short-term memory with messages array.
 *
 * @param {string} userMessage - User's message
 * @param {object|null} gameData - Player data (dynamic injection)
 * @param {string|null} playerId
 * @param {string|null} customInstructions - User specific instructions
 * @param {Array} chatHistory - Previous messages history
 * @returns {Promise<{reply: string, responseId: string, usage: object|null}>}
 */
async function chat(userMessage, gameData = null, playerId = null, customInstructions = null, chatHistory = []) {
  let systemMessage = buildSystemMessage(gameData, playerId);

  if (customInstructions) {
    let instructionsText = customInstructions;
    if (Array.isArray(customInstructions)) {
      instructionsText = customInstructions.map((inst, i) => `${i + 1}. ${inst}`).join('\n');
    }
    systemMessage += `\n\nUSER SPECIFIC INSTRUCTIONS:\n${instructionsText}`;
  }

  const messages = [
    { role: 'system', content: systemMessage },
    ...chatHistory,
    { role: 'user', content: userMessage }
  ];

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: messages,
      max_tokens: 400,
      temperature: 0.85,
      presence_penalty: 0.3,
      frequency_penalty: 0.3,
    });

    const reply = response.choices[0].message.content;

    return {
      reply,
      responseId: response.id, // For compatibility if needed
      usage: response.usage || null,
    };
  } catch (error) {
    console.error('❌ OpenAI Chat API error:', error.message);

    // Log error details
    if (error.status) {
      console.error(`   HTTP Status: ${error.status}`);
    }
    if (error.error) {
      console.error(`   Error body:`, JSON.stringify(error.error));
    }

    return {
      reply: 'I\'m having a technical problem right now, try again in a bit! 🔧',
      responseId: null,
      usage: null,
    };
  }
}


// ───────────────────────── Confidence Analysis (Step 3: Failure Detection) ─────────────────────────
/**
 * Analyzes if the AI response is in "low confidence" or "I don't know" mode.
 * Checks for specific keywords/patterns to use as an escalation trigger.
 *
 * @param {string} reply - Generated AI response text
 * @returns {{isLowConfidence: boolean, reason: string}}
 */
function analyzeConfidence(reply) {
  const lowerReply = reply.toLowerCase();

  // Low confidence patterns
  const uncertaintyPatterns = [
    'i don\'t know',
    'i\'m not sure',
    'i cannot answer',
    'don\'t have information',
    'i cannot provide information',
    'i am unable to help with this',
    'i cannot give a definitive answer',
    'no information found',
    'fabricated', // Due to bot's own rules
  ];

  for (const pattern of uncertaintyPatterns) {
    if (lowerReply.includes(pattern)) {
      return {
        isLowConfidence: true,
        reason: `Detected pattern: "${pattern}"`,
      };
    }
  }

  return {
    isLowConfidence: false,
    reason: null,
  };
}

// ───────────────────────── Exports ─────────────────────────
module.exports = {
  chat,
  buildSystemMessage,
  analyzeConfidence,
};
