// Decodes Anchor `emit!` events out of Solana transaction logs.
//
// Anchor logs each event as a `Program data: <base64>` line where the
// base64 payload is `[8-byte event discriminator, ...borsh fields]`.
// Discriminator = sha256("event:<EventName>")[..8].
//
// We hand-roll the decoder for the three Phase 3 events instead of
// shipping the full Anchor coder — saves a dep and keeps the bot lean.

const crypto = require('crypto');
const {PublicKey} = require('@solana/web3.js');

const PROGRAM_DATA_PREFIX = 'Program data: ';

function eventDisc(name) {
  return crypto.createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
}

function readPubkey(buf, off) {
  return {value: new PublicKey(buf.subarray(off, off + 32)), next: off + 32};
}

const EVENTS = {
  AgentBoxOpened: {
    disc: eventDisc('AgentBoxOpened'),
    decode(buf) {
      let off = 0;
      const u = readPubkey(buf, off); off = u.next;
      const a = readPubkey(buf, off); off = a.next;
      const boxCount = buf.readUInt8(off); off += 1;
      const totalAmount = buf.readBigUInt64LE(off); off += 8;
      const fuelRemaining = buf.readBigUInt64LE(off); off += 8;
      return {
        user: u.value,
        agent: a.value,
        boxCount,
        totalAmount,    // BigInt — raw GET units (decimals=0 on devnet mint)
        fuelRemaining,  // BigInt — lamports
      };
    },
  },
  AgentRegistered: {
    disc: eventDisc('AgentRegistered'),
    decode(buf) {
      let off = 0;
      const u = readPubkey(buf, off); off = u.next;
      const a = readPubkey(buf, off); off = a.next;
      const allowedActions = buf.readUInt32LE(off); off += 4;
      const expiryTs = Number(buf.readBigInt64LE(off));
      return {user: u.value, agent: a.value, allowedActions, expiryTs};
    },
  },
  AgentRevocation: {
    disc: eventDisc('AgentRevocation'),
    decode(buf) {
      let off = 0;
      const u = readPubkey(buf, off); off = u.next;
      const a = readPubkey(buf, off); off = a.next;
      const r = readPubkey(buf, off);
      return {user: u.value, agent: a.value, revokedBy: r.value};
    },
  },
};

function decodeEventsFromLogs(logs) {
  if (!Array.isArray(logs)) return [];
  const out = [];
  for (const line of logs) {
    if (typeof line !== 'string' || !line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const b64 = line.slice(PROGRAM_DATA_PREFIX.length).trim();
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch (_) { continue; }
    if (buf.length < 8) continue;
    const disc = buf.subarray(0, 8);
    for (const [name, def] of Object.entries(EVENTS)) {
      if (disc.equals(def.disc)) {
        try {
          out.push({name, ...def.decode(buf.subarray(8))});
        } catch (_) {
          // Ignore malformed events — we'd rather silently skip than
          // crash the runner over a single corrupt log line.
        }
        break;
      }
    }
  }
  return out;
}

module.exports = {decodeEventsFromLogs, EVENTS};
