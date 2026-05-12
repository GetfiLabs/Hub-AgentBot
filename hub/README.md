# GetFi Hub

**The Web2 ↔ Web3 bridge for the GetFi gaming ecosystem.**

GetFi Hub is a Next.js dApp at `hub.getfi.org` that lets mobile-game players
turn the off-chain points they collect inside GetFi games into the on-chain
**$GET** SPL token on Solana. Players sign in with Firebase, link their
in-game player ID, connect a Phantom/Solflare wallet, and open mystery
lootboxes whose rewards are minted on-chain through a custom Anchor program.

The first integrated game is **Roll Raider**. The companion AI assistant
that talks to players on Telegram lives in the sibling **RaiderBot** repo —
the two systems share the same on-chain program and Hub backend.

---

## Tech stack

| Layer            | Choice                                                |
| ---------------- | ----------------------------------------------------- |
| Framework        | Next.js 16 (App Router, Turbopack), React 19          |
| Styling          | Tailwind CSS v4 + CSS custom properties               |
| Animation        | Framer Motion                                         |
| Auth + DB        | Firebase Auth (Google), Cloud Firestore               |
| Backend          | Firebase Cloud Functions (`onCall` / `onRequest`)     |
| Wallet           | Solana Wallet Adapter (Phantom, Solflare)             |
| On-chain         | Anchor 0.30.1 program (`getfi_lootbox`) on Solana devnet |
| RNG              | Commit-reveal SHA-256 (signed by backend Ed25519)     |
| Forms / state    | React Hook Form + Zod, React Context                  |
| Testing          | Vitest + React Testing Library                        |

---

## Repository layout

```
GetFiHubGemini/
├── src/                  Next.js App Router source
│   ├── app/              Routes: /, /dashboard, /earn, /my-games, /wallet, /profile, /agent
│   ├── components/       Navbar, Footer, AgentSection, FormFields, etc.
│   ├── context/          AppContext — Firebase + wallet + Firestore live state
│   ├── lib/              lootbox.ts (PDAs, mint, message layout), agent.ts, firebase.ts
│   ├── hooks/            useFirebaseAuth, useGetBalance, useAgentAuthority
│   └── services/         Firebase client init
├── functions/            Firebase Cloud Functions (Node.js)
│   ├── index.js          All callables: signLootboxBatch, submitLootboxBatch, …
│   ├── crank/            Devnet auto-consume crank
│   └── lib/rollRaiderApi.js  Roll Raider HTTP client (canonical player store)
├── getfi_lootbox/        Anchor program + scripts + IDL + tests
│   ├── programs/getfi_lootbox/src/lib.rs   Program (V3 commit-reveal RNG)
│   ├── scripts/initialize.ts               One-shot config initializer
│   ├── scripts/init_v2.ts                  Inventory PDA init
│   └── MIGRATION.md                        Reward-mint rotation playbook
├── firestore.rules       Locked-down rules (writes only via Cloud Functions)
├── firebase.json
└── ARCHITECTURE.md       Deep dive: data model, lootbox flow, security
```

---

## On-chain identifiers (devnet)

| Name                | Value                                               |
| ------------------- | --------------------------------------------------- |
| Lootbox program ID  | `Bm6zsJgc87Hj6gGEtpHtyjP89Lwuu7TequM6dgPL8LA7`      |
| $GET token mint     | `3rTrMpMPQ3Nj7ktRkBYcLmB5diqqhtcw348oq9Poq5Eo` (6 decimals, 40 B supply) |
| Treasury (SOL)      | `A3TgoR4ArUEsQiuXLM9ikoE2wA8uQPFxEdGxnfGXFqxb`      |
| Cluster             | `devnet`                                            |

The previous V1 mint (`25Ddnd…tkD4`, 0 decimals) is deprecated — wallets
were classifying it as an NFT because of the missing decimal precision.
The new mint uses 6 decimals (USDC-style), giving us 40 B of human-unit
supply inside Solana's `u64` token-amount field while keeping accounting
human-readable.

---

## Migration Path

The lootbox program (`Bm6zsJ…LA7`) binds `Config.reward_mint` immutably
at `initialize_config` time. To rotate the on-chain reward mint after
launch — for the V1 → V2 mint switch above, or for any future rotation —
follow the playbook in [`getfi_lootbox/MIGRATION.md`](./getfi_lootbox/MIGRATION.md).

It documents:

1. The drop-in `update_reward_mint` Rust instruction to add to
   `programs/getfi_lootbox/src/lib.rs` (with the matching `Accounts`
   struct and event).
2. The `anchor build && anchor upgrade` commands and the SOL buffer
   budget (~3.9 SOL for our 555 KB program).
3. The post-upgrade steps: flip `Config.reward_mint`, derive a new
   vault ATA owned by the Config PDA, fund it with reward inventory.
4. A sanity-check sequence and a smoke-test pointer
   (`RaiderBot Phase2/src/scripts/smoke_open_box.js`) to verify the
   end-to-end flow on devnet.

Client code (Hub frontend, Cloud Functions, RaiderBot) only reads the
mint from `GETFI_REWARD_MINT` / `NEXT_PUBLIC_GETFI_REWARD_MINT` env
vars, so once the on-chain rotation lands the only client-side change
is a single env-var bump and a redeploy.

---

## Getting started

### 1. Prerequisites
- Node.js 20+
- Firebase CLI (for emulators / deploy)
- A Solana wallet (Phantom or Solflare) on **devnet**
- Devnet SOL — request from `https://faucet.solana.com`

### 2. Install
```bash
npm install
(cd functions && npm install)
```

### 3. Environment
Copy `.env.example` to `.env.local` and fill in your Firebase web config
(create a Firebase project at console.firebase.google.com, enable Google
sign-in, and create a Firestore database in Native mode):

```
NEXT_PUBLIC_FIREBASE_API_KEY=…
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=…
NEXT_PUBLIC_FIREBASE_PROJECT_ID=…
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=…
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=…
NEXT_PUBLIC_FIREBASE_APP_ID=…
```

The program ID and $GET mint above are baked in as defaults; override
only if you redeploy:

```
NEXT_PUBLIC_GETFI_LOOTBOX_PROGRAM_ID=…
NEXT_PUBLIC_GETFI_REWARD_MINT=…
```

### 4. Run locally
```bash
npm run dev          # Next.js dev server on :3000
firebase emulators:start --only functions,firestore   # local backend
```

### 5. Deploy
```bash
npm run build
vercel deploy        # frontend
firebase deploy --only functions,firestore:rules
```

---

## Lootbox flow at a glance

```
 Player                Hub frontend              Cloud Functions             getfi_lootbox program
   │  click "Open box"     │                            │                              │
   │──────────────────────▶│  signLootboxBatch(boxes)   │                              │
   │                       │───────────────────────────▶│ build msg, Ed25519-sign,     │
   │                       │                            │ create lootbox_requests doc  │
   │                       │   { signature, request }   │                              │
   │                       │◀───────────────────────────│                              │
   │  Phantom signs tx     │                            │                              │
   │◀──────────────────────│ buildRequestLootboxBatchTx │                              │
   │                       │                            │                              │
   │  send tx to Solana    │                            │                              │
   │──────────────────────────────────────────────────────────────────────────────────▶│ request_lootbox_batch
   │                       │                            │                              │   stores commitments
   │                       │  submitLootboxBatch        │                              │
   │                       │───────────────────────────▶│ mark "submitted"             │
   │                       │                            │                              │
   │                       │                            │  crankConsumeLootboxBatch    │
   │                       │                            │ (scheduled / on-demand)      │
   │                       │                            │─────────────────────────────▶│ consume_lootbox_batch
   │                       │                            │                              │   sha256 reveal,
   │                       │                            │                              │   transfer rewards
   │  $GET lands in ATA    │ realtime Firestore update  │                              │
   │◀──────────────────────│◀───────────────────────────│                              │
```

Full sequence + threat model in [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Why these design choices?

- **Firestore as the off-chain ledger.** Mobile games already write player
  scores there; Hub reads the canonical balance from the Roll Raider
  Players API instead of mirroring it. The only writes the Hub does are
  atomic Cloud-Function transactions (lootbox cost deduction + lootbox
  request creation), so client tampering is impossible — every G mutation
  lives inside a signed Firestore transaction with a request-ID lock
  against double-spend.

- **Commit-reveal RNG instead of ORAO VRF.** Earlier program revisions used
  ORAO VRF, which permanently locks ~0.0022 SOL of rent per `request_v2`
  with no on-chain `close` instruction. At our gas-abstracted box pricing
  the rent burn made single/triple-box opens net-negative for the treasury.
  V3 replaces it with a SHA-256 commit-reveal scheme: the player generates
  32 bytes of CSPRNG entropy client-side, the backend commits to a hidden
  seed, both are bound together by the backend's Ed25519 signature, and
  `consume_lootbox_batch` reveals the seed. Anyone can re-derive the
  resulting tier roll by replaying the on-chain inputs.

- **Single Ed25519 signature gates every box request.** The backend hot
  wallet is the only entity that can issue valid `request_lootbox_batch`
  transactions, which prevents a malicious frontend from forging requests
  without backend approval, while still letting the user hold custody of
  their wallet and pay their own SOL fee.

- **PDAs for everything.** Config, inventory, per-player request state,
  per-agent authority, and per-agent FuelVaults are all PDAs derived
  deterministically from seeds. No off-chain state has to be threaded
  through transactions.

- **Locked-down Firestore rules.** Direct client writes are denied across
  the board. Every mutation goes through a Cloud Function so we can
  validate, lock, and audit it. See `firestore.rules`.

---

## License

MIT — see [LICENSE](./LICENSE).
