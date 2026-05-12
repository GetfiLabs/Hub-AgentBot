// Phase 3 — Hub-side helpers for the agent delegation + FuelVault flow.
//
// All instructions here are USER-signed (in contrast to the bot's
// agent-signed `open_box_as_agent`). They drop in alongside the existing
// `lib/lootbox.ts` and follow the same conventions: PDA derivers,
// instruction builders, and a couple of tiny pure utilities. No React
// imports — anything that touches the wallet/connection lives in the
// agent pages and the `useAgentAuthority` hook.

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { GETFI_LOOTBOX_PROGRAM_ID } from "./lootbox";

// ── Constants (mirror programs/getfi_lootbox/src/lib.rs) ───────────────────

export const AGENT_SEED = new TextEncoder().encode("agent");
export const FUEL_SEED = new TextEncoder().encode("fuel");

export const AGENT_ACTION_OPEN_BOX = 1 << 0;
export const AGENT_MAX_DURATION_SECONDS = 365 * 86_400;

// ── PDA derivers ───────────────────────────────────────────────────────────

export function deriveAgentAuthorityPda(user: PublicKey, programId = GETFI_LOOTBOX_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([AGENT_SEED, user.toBytes()], programId)[0];
}

export function deriveFuelVaultPda(user: PublicKey, programId = GETFI_LOOTBOX_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([FUEL_SEED, user.toBytes()], programId)[0];
}

// ── Anchor instruction discriminators (sha256("global:<name>")[..8]) ───────
// Hardcoded so we don't drag a hashing dep into the browser bundle. Computed
// once with `crypto.createHash('sha256').update('global:<name>').digest().subarray(0,8)`.

const REGISTER_AGENT_DISC = new Uint8Array([0x87, 0x9d, 0x42, 0xc3, 0x02, 0x71, 0xaf, 0x1e]);
const REVOKE_AGENT_DISC = new Uint8Array([0xe3, 0x3c, 0xd1, 0x7d, 0xf0, 0x75, 0xa3, 0x49]);
const DEPOSIT_FUEL_DISC = new Uint8Array([0xf0, 0xef, 0x07, 0xd6, 0x90, 0x2f, 0x70, 0x77]);
const WITHDRAW_FUEL_DISC = new Uint8Array([0x43, 0x2e, 0x07, 0x95, 0x70, 0xe7, 0x18, 0xda]);

// ── Borsh-ish helpers ──────────────────────────────────────────────────────

function u32LE(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function u64LE(value: bigint | number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}

function i64LE(value: bigint | number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(value), true);
  return out;
}

function concat(...parts: Uint8Array[]): Buffer {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = Buffer.alloc(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ── Instruction builders ───────────────────────────────────────────────────

export function buildRegisterAgentIx({
  user,
  agentPubkey,
  allowedActions,
  expiryTs,
  programId = GETFI_LOOTBOX_PROGRAM_ID,
}: {
  user: PublicKey;
  agentPubkey: PublicKey;
  allowedActions: number;
  expiryTs: number; // unix seconds
  programId?: PublicKey;
}) {
  const data = concat(
    REGISTER_AGENT_DISC,
    agentPubkey.toBytes(),
    u32LE(allowedActions),
    i64LE(expiryTs),
  );
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: deriveAgentAuthorityPda(user, programId), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildRevokeAgentIx({
  authority,
  user,
  programId = GETFI_LOOTBOX_PROGRAM_ID,
}: {
  authority: PublicKey;
  user: PublicKey;
  programId?: PublicKey;
}) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: user, isSigner: false, isWritable: false },
      { pubkey: deriveAgentAuthorityPda(user, programId), isSigner: false, isWritable: true },
    ],
    data: Buffer.from(REVOKE_AGENT_DISC),
  });
}

export function buildDepositFuelIx({
  user,
  lamports,
  programId = GETFI_LOOTBOX_PROGRAM_ID,
}: {
  user: PublicKey;
  lamports: bigint | number;
  programId?: PublicKey;
}) {
  const data = concat(DEPOSIT_FUEL_DISC, u64LE(lamports));
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: deriveAgentAuthorityPda(user, programId), isSigner: false, isWritable: false },
      { pubkey: deriveFuelVaultPda(user, programId), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// `amount = null` → drain to zero (used by /istifa).
export function buildWithdrawFuelIx({
  authority,
  user,
  amount,
  programId = GETFI_LOOTBOX_PROGRAM_ID,
}: {
  authority: PublicKey;
  user: PublicKey;
  amount: bigint | number | null;
  programId?: PublicKey;
}) {
  const amountBytes =
    amount === null ? new Uint8Array([0]) : concat(new Uint8Array([1]), u64LE(amount));
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: user, isSigner: false, isWritable: true },
      { pubkey: deriveAgentAuthorityPda(user, programId), isSigner: false, isWritable: false },
      { pubkey: deriveFuelVaultPda(user, programId), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: concat(WITHDRAW_FUEL_DISC, amountBytes),
  });
}

// ── On-chain account decoder ───────────────────────────────────────────────

export interface AgentAuthority {
  user: PublicKey;
  agentPubkey: PublicKey;
  allowedActions: number;
  expiryTs: number;
  nonceCounter: bigint;
  revoked: boolean;
  bump: number;
}

export const AGENT_AUTHORITY_SIZE = 8 + 32 + 32 + 4 + 8 + 8 + 1 + 1;

export function decodeAgentAuthority(data: Uint8Array): AgentAuthority {
  if (data.length < AGENT_AUTHORITY_SIZE) {
    throw new Error(
      `AgentAuthority: data too small (got ${data.length}, want ${AGENT_AUTHORITY_SIZE})`,
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off = 8; // skip Anchor discriminator
  const user = new PublicKey(data.slice(off, off + 32));
  off += 32;
  const agentPubkey = new PublicKey(data.slice(off, off + 32));
  off += 32;
  const allowedActions = view.getUint32(off, true);
  off += 4;
  const expiryTs = Number(view.getBigInt64(off, true));
  off += 8;
  const nonceCounter = view.getBigUint64(off, true);
  off += 8;
  const revoked = data[off] !== 0;
  off += 1;
  const bump = data[off];
  return { user, agentPubkey, allowedActions, expiryTs, nonceCounter, revoked, bump };
}

// ── UI helpers ─────────────────────────────────────────────────────────────

export function isAgentUsable(auth: AgentAuthority | null, nowSec = Date.now() / 1000): boolean {
  if (!auth) return false;
  if (auth.revoked) return false;
  if (auth.expiryTs <= nowSec) return false;
  if ((auth.allowedActions & AGENT_ACTION_OPEN_BOX) === 0) return false;
  return true;
}
