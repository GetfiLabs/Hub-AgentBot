import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase";

export const verifyWalletSignature = (walletAddress: string, signature: string, message: string) =>
  httpsCallable(
    functions,
    "verifyWalletSignature",
  )({
    walletAddress,
    signature,
    message,
  });

export const linkPlayerId = (gameId: string, playerId: string) =>
  httpsCallable(functions, "linkPlayerId")({ gameId, playerId });

export type RollRaiderStats = {
  playerId: string;
  level: number;
  currency: number;          // canonical G balance (game-side authoritative)
  premiumCurrency: number;   // diamonds
  maxScore: number;
  sessionsPlayed: number;
  lastPlayedAt: string | null;
  updatedAt: string | null;
};

export const fetchRollRaiderStats = (playerId: string) =>
  httpsCallable<{ playerId: string }, RollRaiderStats>(
    functions,
    "fetchRollRaiderStats",
  )({ playerId });

// ── V3 batch flow (commit-reveal, no ORAO) ──────────────────────────────────

export type SignLootboxBatchResponse = {
  success: boolean;
  requestId: string;
  cost: number;
  boxCount: number;
  programId: string;
  backendSigner: string;
  treasury: string;
  partiallySignedTx: string; // base64
  blockhash: string;
  lastValidBlockHeight: number;
  expiresAt: number;
  /** Echo of the player_entropy we sent (sanity check for substitution). */
  playerEntropy: string; // base64
  /** sha256(backend_secret) the backend committed on-chain. */
  backendCommitment: string; // base64
  developmentSigner?: boolean;
};

/**
 * Generate a fresh 32-byte player entropy and exchange it with the backend
 * for a partially-signed batch tx.
 *
 * `playerEntropy` is the player's contribution to the commit-reveal RNG —
 * it is mixed into the on-chain randomness so the backend cannot pick the
 * roll outcome unilaterally. Generated browser-side via
 * `crypto.getRandomValues`.
 */
export const signLootboxBatch = (
  walletAddress: string,
  boxCount: number,
  playerEntropyB64: string,
) =>
  httpsCallable<
    { walletAddress: string; boxCount: number; playerEntropy: string },
    SignLootboxBatchResponse
  >(
    functions,
    "signLootboxBatch",
  )({ walletAddress, boxCount, playerEntropy: playerEntropyB64 });

export const submitLootboxBatch = (requestId: string, txSignature: string) =>
  httpsCallable(functions, "submitLootboxBatch")({ requestId, txSignature });

export const cancelLootboxBatch = () => httpsCallable(functions, "cancelLootboxBatch")();
