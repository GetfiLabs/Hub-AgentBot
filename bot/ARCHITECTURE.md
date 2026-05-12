# RaiderBot — Architecture

This document covers the parts of the bot that are not obvious from the
README: the bot's place in the GetFi data plane, the AI escalation
state machine, the on-chain agent flow, and the security boundaries
that keep the bot from being a privileged attacker against either the
game or the player.

---

## 1. The bot's place in the data plane

```
┌──────────────────┐    canonical writes    ┌─────────────────────────┐
│  Roll Raider     │───────────────────────▶│  Roll Raider Firestore  │
│  (mobile game)   │                        │  users/{uid}            │
└──────────────────┘                        └────────────┬────────────┘
                                                         │
                                                         │ HTTP only
                                                         │ (X-API-Key)
                                                         ▼
                                            ┌─────────────────────────┐
                                            │  Players API (Cloud Run)│
                                            │  /v1/users/{uid}        │
                                            │  /v1/users/{uid}/stats  │
                                            │  /v1/users/{uid}/       │
                                            │     currencyTransactions│
                                            └────┬─────────────┬──────┘
                                                 │ GET         │ GET
                                                 │             │
┌──────────────────┐    Bearer (BOT_AGENT_       │             │
│  GetFi Hub       │     SHARED_SECRET)          │             │
│  Cloud Functions │◀────────────────────────────┘             │
│  • signAgentBox  │                                           │
│  • syncAgentRun  │                                           │
│  • getAgentG…    │                                           │
└────────▲─────────┘                                           │
         │ HTTP + Bearer                                       │
         │                                                     │
┌────────┴─────────────────────────────────────────────────────┴──────┐
│                          RAIDER BOT                                 │
│                                                                     │
│  Telegram ───▶ Telegraf ───▶ OpenAI Responses ───▶ Vector Store     │
│                                  │                                  │
│                                  ▼                                  │
│                          confidence routing                         │
│                          ├── high → reply                           │
│                          └── low  → team_group escalation           │
│                                                                     │
│  Scheduler ─▶ Hub /signAgentBoxOpen ─▶ open_box_as_agent (Solana)   │
│                                                                     │
│  Bot Firestore (ISOLATED project)                                   │
│  bot_users / bot_qa / bot_qa_learned                                │
└─────────────────────────────────────────────────────────────────────┘
```

**No direct DB connection** to the game's Firestore. The only mutations
the bot can perform on game state are idempotent deltas through the
Players API, which the game itself controls and audits.

---

## 2. Bot Firestore schema

```
bot_users/{telegramId}
  telegramId         number
  username           string?
  language           "tr" | "en"
  playerId           string?              ← Roll Raider users.uid
  agent              {                    ← present after /connectagent
    pubkey: string,
    encryptedSecret: string (b64 AES-GCM ciphertext),
    nonce: string (b64 12-byte AES-GCM nonce),
    authoritySigner: string,
    expiresAt: number,
    revokedAt: number?,
  }
  lastChatAt         Timestamp
  previousResponseId string?              ← OpenAI conversation chain head
  game_data_cache/   subcollection — last seen Players API stats

bot_qa/{questionId}                       ← escalation queue
  telegramId, playerId, question, history[], status:
    "pending" | "answered" | "delivered" | "rejected"
  teamReply, teamUserId, answeredAt

bot_qa_learned/{pairId}                   ← post-escalation knowledge
  question, answer, vectorStoreFileId, addedAt

config/runtime                            ← seeded by services/config.js
  systemPrompt, escalationThreshold, …
```

All collections live in a Firebase project **separate** from Roll
Raider's. Service-account compromise stays inside this blast radius.

---

## 3. The AI conversation lifecycle

```
Telegram user sends "How do I unlock the Crystal Vault?"
          │
          ▼
bot/telegram.js resolves the user → bot_users/{telegramId}
          │
          ▼
services/openai.js builds the request:
   system message = persona + injected stats (level, currency, level cap, …)
   input         = the user's message
   tools         = [{ type: "file_search", vector_store_ids: [VS_ID] }]
   previous_response_id = bot_users.previousResponseId  (if any)
          │
          ▼
OpenAI Responses API replies. We extract:
   • answer text
   • file_search citations (used for confidence + audit log)
   • a confidence heuristic from the model's own self-report + content
          │
   ┌──────┴──────┐
   ▼             ▼
high conf    low conf or "I don't know" pattern
   │             │
   │             ▼
   │       1. reply to user: "I'm asking the team — back in a sec."
   │       2. write bot_qa/{id} { status: "pending", history: lastN }
   │       3. team_group.js posts to TEAM_GROUP_CHAT_ID with reply markup
   │       4. team replies with /reply or quoted message
   │       5. bot persists status: "answered", teamReply
   │       6. relays answer to player ("Asked the devs directly — here's the deal: …")
   │       7. uploads (question, answer) to Vector Store as a new file →
   │          bot_qa_learned/{pairId} (next identical Q is answered locally)
   │
   ▼
reply to user, persist previousResponseId for next message
```

`previous_response_id` is the OpenAI-managed conversation pointer; we
never reconstruct chat history ourselves. `/reset` simply clears the
field on `bot_users/{telegramId}`.

---

## 4. On-chain agent mode

This is the bot's privileged path: opening lootboxes on a player's
behalf. The on-chain side is enforced by the `getfi_lootbox` Anchor
program (sibling repo); the bot just manages the keys and timing.

### 4.1 Authorization (`/connectagent`)

```
1. Bot:  generates a fresh Solana keypair (the per-user agent).
2. Bot:  encrypts secret with AES-GCM using BOT_AGENT_MASTER_KEY.
         Stores ciphertext + nonce in bot_users/{telegramId}.agent.
3. Bot:  replies with a deep link to HUB_AGENT_PAGE_URL?agent=<pubkey>
4. User: opens the Hub page, signs `register_agent` with their Phantom.
         The on-chain AgentAuthority PDA records:
            user = phantom pubkey
            agent = bot-generated pubkey
            expires_at = now + duration
            fuel_lamports = funded amount (paid by user)
5. Hub:  POSTs back to the bot once register_agent confirms.
6. Bot:  marks agent as active in Firestore.
```

The user pays both the SOL fuel and the registration tx. The bot only
holds the private key for the agent keypair — it is never the user.

### 4.2 Box opening (scheduler or `/report`)

```
node-cron tick (default: every 6 h)
   │
   ▼
agent/scheduler.js loads all active agents from bot_users
   │
   ▼ for each user:
agent/farmRunner.js:
   1. Compute next box tier based on last run + user pref.
   2. POST Hub /signAgentBoxOpen
        Authorization: Bearer BOT_AGENT_SHARED_SECRET
        body: { user, agent, requestId, tier, … }
      → returns { signature, message } (Ed25519 by Hub backend signer)
   3. Build `open_box_as_agent` ix on Solana:
        - signs with agent keypair (decrypted from Firestore using master key)
        - includes Hub's Ed25519 verify ix
        - debits FuelVault PDA for SOL fee
   4. Submit + confirm.
   5. POST Hub /syncAgentRun with the result for ledger reconciliation.
   6. statusReporter DMs the user a summary.
```

### 4.3 Resignation (`/resign`)

```
1. Bot signs revoke_agent (legal: agent self-resigning)
   AND withdraw_fuel(amount = None) (drain to user)
   in a single transaction.
2. On-chain program enforces destination = agent_authority.user.
   The agent CANNOT redirect to itself or any third party.
3. bot_users/{telegramId}.agent.revokedAt = now.
```

---

## 5. Security boundaries

| Threat                                    | Mitigation                                                  |
| ----------------------------------------- | ----------------------------------------------------------- |
| Compromised bot service account           | Bot Firestore is isolated. No write path to the game's DB.  |
| Compromised bot host                      | Per-user agent secrets are AES-GCM encrypted with           |
|                                           | `BOT_AGENT_MASTER_KEY`, which lives only in the bot's       |
|                                           | process env. Firestore alone is not enough to forge txs.    |
| Compromised agent keypair                 | On-chain `withdraw_fuel` and `open_box_as_agent` payouts    |
|                                           | are constrained to `agent_authority.user` — the agent       |
|                                           | cannot self-pay or redirect.                                |
| Forged Players API call                   | `X-API-Key` header verified server-side; key lives in       |
|                                           | Firebase Secret Manager; rotation documented.               |
| Forged Hub call from bot                  | `BOT_AGENT_SHARED_SECRET` Bearer required. No user JWT      |
|                                           | accepted on bot endpoints.                                  |
| Prompt injection in player message        | System prompt isolates persona; tool calls limited to       |
|                                           | `file_search`. Bot never echoes private data and never      |
|                                           | issues tool calls beyond Vector Store reads.                |
| Prompt injection in escalation response   | Team replies are persona-masked but never executed —        |
|                                           | they're text relayed to the player and indexed in           |
|                                           | the Vector Store.                                           |
| Replay of a signed agent box request      | `requestId` plus `expiresAt` in the signed message; the     |
|                                           | on-chain program rejects expired or duplicate requests.     |
| Mass agent abuse (Sybil)                  | Each Telegram ID gets one agent. Hub `register_agent`       |
|                                           | constraints + bot Firestore unique key cap fan-out.         |

---

## 6. Operations

- **Boot logs are step-numbered** (`[boot 1] …`) so production logs
  pinpoint exactly which initialization step hung. See `src/index.js`.
- **Telegraf `bot.launch()` is fire-and-forget.** Awaiting it deadlocks
  the boot. Crashes surface via the `.catch` attached at boot, plus
  `unhandledRejection` and `uncaughtException` traps.
- **Vector Store maintenance** is purely CLI-driven via
  `npm run vs:upload-dir -- ./docs`. No background sync — when the
  rules change, re-upload and the next chat picks them up.
- **Escalation backlog** — long-pending `bot_qa` entries are visible in
  Firestore. There is no auto-expiry; a stuck escalation indicates the
  team group lost the bot or `TEAM_GROUP_CHAT_ID` drifted.
- **Devnet smoke test** — `node src/scripts/smoke_open_box.js` runs the
  full agent box-open flow end-to-end and is the canonical way to
  verify a fresh deployment.
