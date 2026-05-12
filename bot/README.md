# RaiderBot

**Telegram-native AI assistant for the Roll Raider mobile game, with an
on-chain "agent" mode that opens GetFi lootboxes on a player's behalf.**

RaiderBot is the Web2 face of GetFi Labs: a Telegraf bot that authenticates
players against Roll Raider's canonical user store, answers gameplay
questions through the OpenAI Responses API with retrieval-augmented
generation (RAG), and — when a player explicitly delegates authority —
runs box-opening transactions against the [`getfi_lootbox`](https://github.com/) Solana
program out of a per-user PDA-owned fuel vault.

The bot speaks Turkish by default (the player base is mostly Turkish-
speaking), but the codebase, configuration, comments, and operational
docs are entirely English.

---

## What the bot does

- **Onboarding** — `/playerid <ID>` binds a Telegram user to a Roll Raider
  player and pulls their canonical stats (level, currency, max score,
  diamonds, sessions) from the Roll Raider Players API on every chat.
- **AI gameplay support** — every player message is routed to the OpenAI
  Responses API with `file_search` against an OpenAI Vector Store loaded
  with the official Roll Raider rule docs. Player stats are injected into
  the system message so the model can answer balance/level questions
  directly.
- **Conversational memory** — `previous_response_id` chains keep short-
  term context per Telegram user; `/reset` clears it.
- **Human-in-the-loop escalation** — if the model's answer is low-confidence
  or contains an explicit "I don't know" signal, the bot:
  1. Tells the player it's "asking the team".
  2. Forwards the question + last messages to a private team Telegram
     group via a second bot.
  3. When the team replies, the bot relays the answer to the player and
     persists the `(question, answer)` pair as a new file in the Vector
     Store, so the next identical question is answered without
     escalation. This is the "permanent learning" loop.
- **On-chain agent mode** — `/connectagent` walks the player through
  authorizing a per-user Solana keypair (the bot's "agent") via the Hub
  webapp. Once authorized, `/agentstatus`, `/report`, and the background
  scheduler can call the Hub's `signAgentBoxOpen` endpoint and submit
  `open_box_as_agent` transactions, paid out of the user-funded
  `FuelVault` PDA. `/resign` revokes the agent and drains the vault back
  to the player. The agent **cannot** redirect SOL or $GET to any other
  destination — that constraint is enforced on-chain.

---

## Tech stack

| Layer            | Choice                                                |
| ---------------- | ----------------------------------------------------- |
| Runtime          | Node.js 18+                                           |
| Bot framework    | Telegraf v4 (long-polling)                            |
| AI               | OpenAI Responses API + Vector Store (RAG)             |
| Bot memory       | Isolated Firebase project (Firestore via firebase-admin) |
| Game data        | Roll Raider Players API (HTTPS, X-API-Key)            |
| On-chain         | `@solana/web3.js`, the Hub's signed message protocol  |
| Crypto           | tweetnacl (Ed25519), AES-GCM via `node:crypto`        |
| Scheduling       | node-cron                                             |

---

## Repository layout

```
RaiderBot Phase2/
├── src/
│   ├── index.js                  Boot orchestrator (Firebase → bot → scheduler → status)
│   ├── bot/
│   │   ├── telegram.js           Player-facing commands (/playerid, /stats, /rule, /reset, …)
│   │   └── team_group.js         Team-group escalation reply handler
│   ├── services/
│   │   ├── database.js           Firestore CRUD (bot_users, bot_qa, bot_qa_learned)
│   │   ├── openai.js             Responses API + RAG + confidence routing
│   │   ├── vectorStore.js        Vector Store maintenance (file upload, list)
│   │   ├── gameApi.js            Roll Raider Players API client
│   │   ├── config.js             Firestore-seeded runtime config
│   │   ├── solana/               Connection, PDAs, IDL, agent transactions
│   │   ├── wallet/               Operational hot wallet + per-user agent keys (AES-GCM at rest)
│   │   └── agent/                Scheduler, farmRunner, hubClient, hubSync, statusReporter
│   └── scripts/
│       ├── setupVectorStore.js   `vs:create | upload | upload-dir | list` CLI
│       └── smoke_open_box.js     End-to-end devnet smoke test
├── docs/
│   └── raider_system_prompt.md   The OpenAI system prompt (persona, tone, rules)
├── .env.example                  Documented env var contract
└── ARCHITECTURE.md               Deep dive: data flow, escalation, agent mode, security
```

---

## Architecture in one diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                          GAME DATA (read)                        │
│                                                                  │
│   Roll Raider Players API  ◀────── HTTP GET (X-API-Key)          │
│   /users/{uid}/stats               /users/{uid}/currencyTransactions
│                                                                  │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│                          RAIDER BOT                              │
│                                                                  │
│   ┌─────────────┐   ┌──────────────┐   ┌──────────────────────┐  │
│   │  Telegraf   │──▶│  OpenAI      │──▶│ Vector Store (RAG)   │  │
│   │  bot        │   │  Responses   │   │  + bot_qa_learned    │  │
│   └──────┬──────┘   │  API         │   └──────────────────────┘  │
│          │          └──────┬───────┘                             │
│          │                 │ low confidence?                     │
│          │                 ▼                                     │
│          │          ┌──────────────┐    Telegram reply          │
│          │          │ team_group   │◀───────────────────────────│
│          │          │ escalation   │    (private team group)    │
│          │          └──────┬───────┘                             │
│          │                 │ on team reply                       │
│          │                 ▼                                     │
│          │          deliver answer to player                     │
│          │          + write QA pair to Vector Store              │
│          │                                                       │
│          ▼                                                       │
│   ┌────────────────────────────────────────────────────────┐    │
│   │  Agent mode (on-chain)                                 │    │
│   │  /connectagent → register_agent (user signs at Hub)    │    │
│   │  /agentstatus  → reads Config + AgentAuthority + ATA   │    │
│   │  scheduler     → POST /signAgentBoxOpen → open_box_as_agent│
│   │  /resign       → revoke_agent + withdraw_fuel          │    │
│   └────────────────────────────────────────────────────────┘    │
│                                                                  │
│   Bot memory (ISOLATED Firebase project — separate from game)   │
│   ├── bot_users/{telegramId}                                    │
│   │   ├── playerId, language, agentPubkey, encrypted secret     │
│   │   └── game_data_cache/                                      │
│   ├── bot_qa/         (escalation queue)                        │
│   └── bot_qa_learned/ (post-escalation QA pairs)                │
└──────────────────────────────────────────────────────────────────┘
```

The bot's Firestore is a **separate project** from the game's database.
The bot never reads or writes game data directly — only via the Players
API. This keeps blast radius contained: a compromised bot service
account cannot mutate live player data.

---

## Bot commands

| Command                | Purpose                                                |
| ---------------------- | ------------------------------------------------------ |
| `/start`               | Welcome message + onboarding hint.                     |
| `/playerid <ID>`       | Bind the chat to a Roll Raider player.                 |
| `/stats`               | Show current player stats (cached + live).             |
| `/rule <topic>`        | Force a doc-grounded answer (RAG only, no escalation). |
| `/reset`               | Clear the current Telegram session's chat memory.      |
| `/connectagent`        | Authorize the bot to open boxes on your behalf.        |
| `/agentstatus`         | Show agent fuel, authority expiry, $GET balance.       |
| `/report`              | Manually trigger a status report DM.                   |
| `/resign`              | Revoke the agent and drain the FuelVault back to you.  |
| `/help`, `/commands`   | List commands.                                         |

Legacy Turkish aliases are accepted (`/agentbaglan`, `/agentdurum`,
`/rapor`, `/istifa`) for users who started before the rename.

---

## Setup

### 1. Prerequisites
- Node.js 18+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- An OpenAI API key with Responses API access
- An **isolated** Firebase project (separate from the game). Create at
  console.firebase.google.com → enable Firestore in Native mode → project
  settings → service accounts → generate a new private key JSON.
- A Roll Raider Players API key (`X-API-Key` header).

### 2. Install
```bash
npm install
```

### 3. Configure
```bash
cp .env.example .env
# Fill in TELEGRAM_BOT_TOKEN, OPENAI_API_KEY, GAME_API_KEY, etc.
# Place the Firebase service account JSON at ./serviceAccountKey.json
# (gitignored — never commit).
```

### 4. Seed the knowledge base
```bash
npm run vs:create                       # creates a Vector Store, prints the ID
# paste the printed ID into OPENAI_VECTOR_STORE_ID in .env
npm run vs:upload-dir -- ./docs         # uploads game-rule docs
npm run vs:list                         # verifies what's indexed
```

### 5. Start the bot
```bash
npm start         # production
npm run dev       # auto-restart on file changes
```

### 6. (Optional) Agent-mode pre-flight
If you want the bot to be able to open boxes for users, you also need:

- A devnet operational wallet (`solana-keygen new -o ./bot-op.json`,
  airdrop ~0.1 SOL — used to seed each user's per-agent keypair with a
  small SOL advance for tx fees, reimbursed on-chain).
- `BOT_AGENT_MASTER_KEY` — 32-byte hex/base64 secret. Used to AES-GCM
  encrypt every per-user agent secret key in Firestore. Generate with
  `openssl rand -hex 32`.
- `BOT_AGENT_SHARED_SECRET` — Bearer token shared with the Hub's
  `signAgentBoxOpen` and `syncAgentRun` endpoints.
- `HUB_SIGN_AGENT_BOX_URL`, `HUB_AGENT_PAGE_URL` — the URLs the Hub
  hands you after deploying its functions.

Once these are set, `startScheduler()` will run `node-cron` every 6 hours
(default) and farm boxes for every authorized user.

---

## Why these design choices?

- **Two isolated Firebase projects.** The bot writes only to its own
  project. The single source of truth for player currency is the Roll
  Raider Players API, not a mirrored copy. This means a compromised bot
  service account can never alter live player balances — it can only
  request idempotent deltas through the API, which the game can
  rate-limit and audit.

- **OpenAI Responses API with `file_search` instead of an in-process
  vector DB.** The Vector Store is hosted by OpenAI and indexed
  automatically when we upload markdown docs. No embedding pipeline to
  maintain, and `previous_response_id` gives us linear conversation
  memory without pickling state ourselves.

- **Escalation as a learning loop, not a fallback.** When the team
  answers an escalated question, the QA pair is appended to the Vector
  Store as a new file. The next identical question is answered by the
  bot directly, so the team workload monotonically decreases over time.

- **Per-user agent keypair, not a single shared bot wallet.** Each
  authorized user gets their own Solana keypair stored AES-GCM-encrypted
  in `bot_users/{telegramId}.agent.encryptedSecret`. The keypair signs
  `open_box_as_agent` and `withdraw_fuel`, both of which the on-chain
  program restricts to sending value back to the registered user only.
  Even a full bot compromise leaks only the per-user agent — it cannot
  drain the user's primary wallet.

- **AES-GCM at rest, not just Firestore rules.** The Firebase project is
  isolated, but defense in depth: even if someone exfiltrates the
  Firestore data, every agent secret key is encrypted with
  `BOT_AGENT_MASTER_KEY` (held only in the bot process env). Without the
  master key, the secrets are useless.

- **Telegraf long-polling fire-and-forget boot.** Telegraf v4's
  `bot.launch()` only resolves on `bot.stop()`. Awaiting it would
  deadlock `main()`. The boot sequence in `src/index.js` documents this
  and dispatches launch with `.then/.catch` so the rest of the boot
  (scheduler, status reporter, command menu publish) can run.

---

## Migration Path

The bot only reads the on-chain $GET mint from the `GETFI_REWARD_MINT`
env var (with a sane devnet default), so any reward-mint rotation is a
one-line `.env` change here plus a process restart.

The on-chain side of that rotation — which has to happen in the
`getfi_lootbox` program, since `Config.reward_mint` is set immutably at
`initialize_config` time — is documented end-to-end in the sibling
repo: [`GetFiHubGemini/getfi_lootbox/MIGRATION.md`](../GetFiHubGemini/getfi_lootbox/MIGRATION.md).

That playbook covers:

- The drop-in `update_reward_mint` Rust instruction patch.
- The `anchor build && anchor upgrade` flow and the SOL buffer budget.
- Funding the new Config-owned vault ATA with reward inventory.
- A smoke-test entrypoint (`src/scripts/smoke_open_box.js`) that
  exercises a full `request → consume` round-trip against the new mint.

Run that script after the on-chain rotation to verify the bot's agent
mode still produces a clean `consume_lootbox_batch` and the user's V2
ATA is credited.

---

## License

MIT — see [LICENSE](./LICENSE).
