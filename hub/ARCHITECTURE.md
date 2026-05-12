# GetFi Hub — Architecture

This document covers what is not in the README: how the data flows
between Firestore, the Cloud Functions, the Solana program, and the
wallet at every step of a lootbox open; what each PDA is for; and the
security model that keeps a malicious client from minting itself $GET.

---

## 1. System map

```
┌────────────────────┐       ┌────────────────────┐
│  Roll Raider       │       │  RaiderBot         │
│  (mobile game)     │       │  (Telegram AI)     │
│                    │       │                    │
│  writes G + stats  │       │  reads + idempotent│
│  to Firestore      │       │  delta writes via  │
│                    │       │  Players API       │
└────────┬───────────┘       └────────┬───────────┘
         │                            │
         │  Players API (HTTPS, X-API-Key)
         │                            │
         ▼                            ▼
┌────────────────────────────────────────────────┐
│  Roll Raider Cloud Functions (canonical store) │
│  users/{uid}.currency = G points               │
└────────────────────┬───────────────────────────┘
                     │ HTTP GET (read) / POST (delta)
                     │
                     ▼
┌────────────────────────────────────────────────┐
│  GetFi Hub                                     │
│  ┌──────────────┐    ┌─────────────────────┐   │
│  │  Next.js UI  │◀──▶│  Cloud Functions    │   │
│  │  (this repo) │    │  • signLootboxBatch │   │
│  │              │    │  • submitLootboxBatch│  │
│  └──────┬───────┘    │  • crankConsume*    │   │
│         │            │  • signAgentBoxOpen │   │
│         │            │  • linkPlayerId     │   │
│         │            │  • verifyWallet…    │   │
│         │            └──────┬──────────────┘   │
│         │                   │                  │
│         │   Firestore (rules: writes denied)   │
│         │  ┌─────────────────────────────┐     │
│         └─▶│ users/{uid}                 │◀────┘
│            │ game_links/{id}             │
│            │ transactions/{id}           │
│            │ lootbox_requests/{requestId}│
│            │ agent_authorities/{wallet}  │
│            └─────────────────────────────┘
└────────────────────┬───────────────────────────┘
                     │ Anchor (Solana web3.js)
                     ▼
┌────────────────────────────────────────────────┐
│  getfi_lootbox program (Solana devnet)         │
│  PDAs: Config, Inventory, PlayerStateV3,       │
│        AgentAuthority, FuelVault               │
│  Token: $GET SPL mint (6 decimals)             │
└────────────────────────────────────────────────┘
```

---

## 2. Firestore schema

```
users/{uid}
  uid              string
  email            string | null
  displayName      string | null
  primaryWallet    string | null            ← first wallet linked, locks 1↔1
  connectedWallets string[]                 ← all wallets ever linked
  getPoints        number                   ← canonical G balance (also `points`/`totalGetPoints` legacy)
  gamesPlayed      string[]
  lootboxEarnings  number
  role             "user" | "admin"
  activeLootboxRequestId string | null      ← single-flight lock
  createdAt        Timestamp
  lastLogin        Timestamp
  updatedAt        Timestamp

game_links/{autoId}
  uid, gameId, playerId, inGameGetBalance, maxLevel, highScore, createdAt

transactions/{autoId}
  uid, requestId, walletAddress, amount, type
  ("lootbox_spend" | "lootbox_refund" | "lootbox_payout" | …)
  boxTier, status, description, timestamp

lootbox_requests/{requestId}
  uid, walletAddress, requestId, boxes[]    ← up to 10 boxes per batch
  totalCost, playerEntropy (b64), backendCommitment (b64)
  message (b64), signature (b64, Ed25519 over message)
  status: "signed" | "submitted" | "consumed" | "expired"
  txSignature, consumeTxSignature, rewardAmounts[]
  issuedAt, expiresAt, createdAt, updatedAt

agent_authorities/{walletAddress}
  uid, agentPubkey, expiresAt, fuelLamports, revoked
```

---

## 3. The lootbox open in detail

### 3.1 Client builds a request

`/earn` page calls `signLootboxBatch({ boxes: [{ tier: 1 }, { tier: 1 }, …] })`.
Up to 10 boxes per batch (`MAX_BOXES_PER_BATCH`); above-tier boxes
(7+) are limited to 1 per batch by Firestore rules. The client also
generates `playerEntropy` — 32 fresh bytes from `crypto.getRandomValues`,
base64-encoded — and sends it with the request.

### 3.2 Cloud Function `signLootboxBatch`

Server-side, inside a Firestore transaction:

1. Auth check (must be a signed-in Firebase user).
2. Verify wallet is linked and `primaryWallet` matches.
3. Read `users/{uid}.getPoints`, ensure it covers `totalCost = Σ tierPrice`.
4. Reject if `activeLootboxRequestId` is set and not yet `expired` —
   single-flight lock prevents rapid double-spends.
5. Generate `requestId` (16 random bytes hex).
6. Generate `backendSecret` (32 bytes), compute
   `backendCommitment = sha256(backendSecret)`.
7. Build the canonical message (BATCH_MESSAGE_DOMAIN || requestId || uid ||
   wallet || expiresAt || playerEntropy || backendCommitment ||
   tier_count || tiers[…] || costs[…]).
8. Sign it with the backend Ed25519 hot wallet → `signature`.
9. Atomically:
   - Decrement `users/{uid}.getPoints` by `totalCost`.
   - Set `activeLootboxRequestId = requestId`.
   - Write `lootbox_requests/{requestId}` with `status: "signed"`,
     storing `playerEntropy`, `backendCommitment`, `signature`,
     `message`, `expiresAt = now + 10 min`.
   - Append a `lootbox_spend` row to `transactions`.
10. Return `{ requestId, signature, message, expiresAt }` to the client.

The plaintext `backendSecret` never leaves the server until reveal.

### 3.3 Client submits the on-chain tx

Frontend builds a `request_lootbox_batch` instruction with the Anchor
program, attaches the backend's Ed25519 signature in an `Ed25519Program`
verify ix (so the on-chain program can `Ed25519Program::verify` against
the backend pubkey stored in `Config`). User signs with Phantom and
submits.

The on-chain program:
- Verifies the Ed25519 sigverify ix preceded ours.
- Re-derives `Config`, `Inventory`, `PlayerStateV3` PDAs.
- Decodes the message, asserts `wallet`, `requestId`, `playerEntropy`,
  `backendCommitment`, expiry.
- Locks the box tiers in `PlayerStateV3` and decrements per-tier stock
  in `Inventory`.
- Records `request_status = pending` until `consume_*` reveals.

Frontend then calls `submitLootboxBatch` Cloud Function to update the
Firestore status to `"submitted"` and store `txSignature`.

### 3.4 Crank reveals the secret

`crankConsumeLootboxBatch` is a Firestore-triggered scheduler (devnet:
on every Firestore write to `lootbox_requests` with status `submitted`;
prod: every 30 s) that:

1. Reads the `lootbox_requests` doc.
2. Builds a `consume_lootbox_batch` instruction with the now-revealed
   `backendSecret`.
3. Signs and submits with the same backend hot wallet (paying SOL fee).
4. The on-chain program:
   - Re-computes `sha256(backendSecret) == backendCommitment`.
   - Computes `combined = sha256(playerEntropy || backendSecret)`.
   - For each box `i`: `roll[i] = sha256(combined || DOMAIN || i)`,
     reduces to `[0, 1_000_000)`, picks tier via cumulative-weight table.
   - Transfers the resulting $GET amount from `Config`-owned vault ATA
     to the user's ATA via SPL `Transfer` CPI signed by `Config` PDA.
5. Updates Firestore: `status: "consumed"`, `consumeTxSignature`,
   `rewardAmounts[]`. Realtime snapshot pushes the update to the
   user's UI.

### 3.5 Why the round-trip?

A naive design would let the player call `request` and `consume` in a
single transaction. We split them so:

- The backend's signature pins the batch parameters (cost, tiers,
  entropy) **before** Phantom shows the wallet prompt — the user sees
  exactly what they're paying for.
- The reveal happens in a separate transaction signed by the backend,
  so the user never sees the secret and cannot abort mid-flight.
- The crank can retry with idempotent `consume_lootbox_batch` calls if
  the network drops the tx; the program rejects double-consumes via
  `request_status`.

---

## 4. Security posture

| Threat                                | Mitigation                                          |
| ------------------------------------- | --------------------------------------------------- |
| Client tampering with G balance       | Firestore rules deny writes; only Cloud Functions   |
|                                       | mutate `users.getPoints` inside transactions.       |
| Double-spend by rapid clicks          | `activeLootboxRequestId` single-flight lock + per-  |
|                                       | request id idempotency in `lootbox_requests`.       |
| Forged box request                    | On-chain `Ed25519Program::verify` against backend   |
|                                       | pubkey stored in `Config`.                          |
| Backend manipulating the roll         | Backend commits to `backendSecret` *before* the     |
|                                       | player entropy is bound. SHA-256 second-preimage    |
|                                       | resistance prevents post-hoc swaps.                 |
| Player manipulating the roll          | `playerEntropy` is bound by the backend signature   |
|                                       | as well — neither side controls the roll alone.    |
| Sybil wallet linking                  | `primaryWallet` is one-shot per `users` doc;        |
|                                       | `connectedWallets` is append-only with checks.      |
| Agent bot draining user funds         | `withdraw_fuel` always sends to `agent_authority.   |
|                                       | user`. Agent can self-resign but cannot redirect.   |
| Replay of expired box request         | `expiresAt` baked into the signed message; on-chain |
|                                       | `Clock` check in `request_lootbox_batch`.           |

---

## 5. Cloud Functions (callables)

| Function                  | Type      | Purpose                                            |
| ------------------------- | --------- | -------------------------------------------------- |
| `onUserCreated`           | auth hook | Provision `users/{uid}` doc on first sign-in.      |
| `verifyWalletSignature`   | onCall    | Bind a wallet to the Firebase uid (1:1 lock).      |
| `linkPlayerId`            | onCall    | Bind Roll Raider playerId to uid; reject reuse.    |
| `fetchRollRaiderStats`    | onCall    | Proxied read of Players API (level, currency, …). |
| `signLootboxBatch`        | onCall    | See §3.2.                                          |
| `submitLootboxBatch`      | onCall    | Mark request `submitted` after on-chain tx lands.  |
| `cancelLootboxBatch`      | onCall    | Refund a `signed`-but-never-submitted request.     |
| `crankConsumeLootboxBatch`| trigger   | Reveal + consume on-chain.                         |
| `signAgentBoxOpen`        | onRequest | Bot endpoint: signs an agent-mode box-open ix.     |
| `getAgentGBalance`        | onRequest | Bot endpoint: returns canonical G for a user.      |
| `syncAgentRun`            | onRequest | Bot endpoint: idempotent farming-run ledger.       |

The bot endpoints are protected by `Authorization: Bearer
<BOT_AGENT_SHARED_SECRET>` and never accept user JWTs.

---

## 6. The Anchor program (`getfi_lootbox`)

Deployed at `Bm6zsJgc87Hj6gGEtpHtyjP89Lwuu7TequM6dgPL8LA7` on devnet.

**Instructions** (high-level):
- `initialize_config(backend_signer)` — single-shot. Binds the reward
  mint, treasury, and Ed25519 backend pubkey.
- `update_backend_signer` — admin-only key rotation.
- `initialize_inventory_v2`, `restock_tier`, `close_inventory_v2` —
  per-tier supply management.
- `request_lootbox_batch(message, signature)` — the player-signed half of
  the open. Verifies Ed25519 sig, locks tiers, stores commitments.
- `consume_lootbox_batch(backend_secret)` — the backend-signed reveal.
  Verifies commitment, derives rolls, transfers $GET via SPL CPI.
- `cancel_lootbox_batch` — refund path.
- `register_agent`, `revoke_agent`, `deposit_fuel`, `withdraw_fuel` —
  agent-delegation flow used by RaiderBot.
- `open_box_as_agent` — agent-mode box open (signed by bot, paid from
  FuelVault).

**PDAs**:
- `[b"config"]` → `Config { reward_mint, backend_signer, treasury, … }`
- `[b"inventory_v2"]` → `Inventory { tiers: [u32; 9] }`
- `[b"player_state_v3", player.key()]` → request locks
- `[b"agent_authority", user.key()]` → bot delegation
- `[b"fuel_vault", agent_authority.key()]` → bot's SOL escrow

**Why V3 commit-reveal RNG?** Documented at the top of `lib.rs`.
Short version: ORAO VRF locks rent that we cannot recover, which makes
small batches net-negative; SHA-256 commit-reveal under a backend
Ed25519 signature gives us auditable randomness with zero rent burn.

---

## 7. Operations notes

- The crank function holds the only copy of `backendSecret` between
  `signLootboxBatch` and `consume_lootbox_batch`. It is stored in
  Firestore at `lootbox_requests/{requestId}.backendSecret` (private,
  rules-denied to clients), and the field is cleared after consume to
  shrink the rent footprint.
- `expiresAt` is hard-coded to `REQUEST_TTL_SECONDS = 600`. Both the
  Firestore record and the on-chain message include the timestamp, so
  expired requests cannot be replayed even if the program is upgraded.
- `MAX_BOXES_PER_BATCH = 10`, `DAILY_BOX_LIMIT = 50` per user. Both
  enforced server-side.
- Backend hot wallet pays Solana fees during the consume step. Cost is
  ~0.000005 SOL per consume; the gas-abstraction fee bundled into the
  player's `request` transaction (`LOOTBOX_FEE_LAMPORTS = 298_000`)
  reimburses this with margin.
