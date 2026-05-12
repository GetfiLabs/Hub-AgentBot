"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AlertTriangle, Bot, Lock } from "lucide-react";
import { Transaction } from "@solana/web3.js";
import {
  deriveInventoryPda,
  derivePlayerStateV3Pda,
  generatePlayerEntropy,
  GETFI_LOOTBOX_PROGRAM_ID,
  SINGLE_BOX_COST,
} from "@/lib/lootbox";
import { useAppContext } from "@/context/AppContext";
import { toast } from "sonner";
import {
  cancelLootboxBatch,
  signLootboxBatch,
  submitLootboxBatch,
  SignLootboxBatchResponse,
} from "@/services/firebase";
import { useGetBalance } from "@/hooks/useGetBalance";

// V2 on-chain GlobalInventory: 8-byte disc + 10 × u32 LE + 1-byte bump = 49 B.
const NUM_TIERS = 10;
const INVENTORY_DATA_LEN = NUM_TIERS * 4;
const INVENTORY_MIN_LEN = 8 + INVENTORY_DATA_LEN + 1;
type Inventory = { remaining: number[]; loadedAt: number };

const FEE_PER_BOX_SOL = 0.000_298;
const DAILY_BOX_LIMIT = 50;
const MAX_BATCH_SIZE = 10;

// PlayerStateV3 layout (after 8-byte Anchor disc)
const PLAYER_STATE_V3_LEN = 8 + 32 + 1 + 4 + 1 + 1 + 1;
type DailyState = { consumed: number; reserved: number; remaining: number };

// Initial stock per tier (must match the on-chain Anchor program's seed
// inventory). Used to compute true depletion ratios for the prize-ledger
// progress bars — `remaining / initial`.
const PRIZE_TIERS: Array<{
  tier: number;
  amount: number;
  initial: number;
  bucket: "legendary" | "epic" | "rare" | "common";
}> = [
  { tier: 1, amount: 2_000_000, initial: 10, bucket: "legendary" },
  { tier: 2, amount: 500_000, initial: 20, bucket: "legendary" },
  { tier: 3, amount: 100_000, initial: 200, bucket: "epic" },
  { tier: 4, amount: 50_000, initial: 1_000, bucket: "epic" },
  { tier: 5, amount: 10_000, initial: 5_000, bucket: "rare" },
  { tier: 6, amount: 2_500, initial: 20_000, bucket: "rare" },
  { tier: 7, amount: 500, initial: 100_000, bucket: "common" },
  { tier: 8, amount: 100, initial: 500_000, bucket: "common" },
  { tier: 9, amount: 50, initial: 1_000_000, bucket: "common" },
  { tier: 10, amount: 10, initial: 5_000_000, bucket: "common" },
];

type FlowState = "idle" | "signing" | "wallet" | "submitting" | "cranking" | "revealed" | "failed";

const STEP_LABELS: Record<Exclude<FlowState, "idle" | "failed">, string> = {
  signing: "Reserving G & preparing tx",
  wallet: "Awaiting wallet signature",
  submitting: "Broadcasting on-chain",
  cranking: "Backend Crank rolling boxes",
  revealed: "Rewards delivered",
};

type Reward = { tier: number; amount: number };

export default function EarnPage() {
  const { isLoggedIn, walletAddress, totalGetPoints, userProfile } = useAppContext();
  const { connection } = useConnection();
  const wallet = useWallet();
  const { balance: getBalance } = useGetBalance(walletAddress);

  const [boxCount, setBoxCount] = useState<number>(1);
  const [flowState, setFlowState] = useState<FlowState>("idle");
  const [error, setError] = useState("");
  const [requestId, setRequestId] = useState("");
  const [rewards, setRewards] = useState<Reward[] | null>(null);
  const [totalReward, setTotalReward] = useState<number>(0);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [daily, setDaily] = useState<DailyState | null>(null);

  // ── Inventory polling ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const fetchInventory = async () => {
      try {
        const pda = deriveInventoryPda(GETFI_LOOTBOX_PROGRAM_ID);
        const acc = await connection.getAccountInfo(pda, "confirmed");
        if (cancelled || !acc) return;
        const data = acc.data;
        if (data.length < INVENTORY_MIN_LEN) return;
        const view = new DataView(data.buffer, data.byteOffset + 8, INVENTORY_DATA_LEN);
        const remaining = Array.from({ length: NUM_TIERS }, (_, i) => view.getUint32(i * 4, true));
        if (!cancelled) setInventory({ remaining, loadedAt: Date.now() });
      } catch (err) {
        console.warn("[INVENTORY] fetch failed:", err);
      }
    };
    void fetchInventory();
    const id = setInterval(fetchInventory, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connection]);

  const refreshInventory = useCallback(async () => {
    try {
      const pda = deriveInventoryPda(GETFI_LOOTBOX_PROGRAM_ID);
      const acc = await connection.getAccountInfo(pda, "confirmed");
      if (!acc) return;
      const data = acc.data;
      if (data.length < INVENTORY_MIN_LEN) return;
      const view = new DataView(data.buffer, data.byteOffset + 8, INVENTORY_DATA_LEN);
      const remaining = Array.from({ length: NUM_TIERS }, (_, i) => view.getUint32(i * 4, true));
      setInventory({ remaining, loadedAt: Date.now() });
    } catch (err) {
      console.warn("[INVENTORY] refresh failed:", err);
    }
  }, [connection]);

  // ── PlayerStateV3 daily-cap polling ───────────────────────────────────────
  const refreshDaily = useCallback(async () => {
    if (!walletAddress) {
      setDaily({ consumed: 0, reserved: 0, remaining: DAILY_BOX_LIMIT });
      return;
    }
    try {
      const { PublicKey } = await import("@solana/web3.js");
      const player = new PublicKey(walletAddress);
      const pda = derivePlayerStateV3Pda(GETFI_LOOTBOX_PROGRAM_ID, player);
      const acc = await connection.getAccountInfo(pda, "confirmed");
      if (!acc) {
        setDaily({ consumed: 0, reserved: 0, remaining: DAILY_BOX_LIMIT });
        return;
      }
      if (acc.data.length < PLAYER_STATE_V3_LEN) return;
      const d = acc.data;
      const onChainDay = d.readUInt32LE(8 + 32 + 1);
      const consumed = d.readUInt8(8 + 32 + 1 + 4);
      const reserved = d.readUInt8(8 + 32 + 1 + 4 + 1);
      const today = Math.floor(Date.now() / 1000 / 86_400);
      if (onChainDay !== today) {
        setDaily({ consumed: 0, reserved: 0, remaining: DAILY_BOX_LIMIT });
        return;
      }
      const used = consumed + reserved;
      const remaining = Math.max(0, DAILY_BOX_LIMIT - used);
      setDaily({ consumed, reserved, remaining });
    } catch (err) {
      console.warn("[PLAYER_STATE] fetch failed:", err);
    }
  }, [connection, walletAddress]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await refreshDaily();
    };
    void tick();
    const id = setInterval(tick, 12_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refreshDaily]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const reservedPoints = (userProfile as { reservedPoints?: number } | null)?.reservedPoints ?? 0;
  const availableG = Math.max(0, totalGetPoints - reservedPoints);
  const gCost = SINGLE_BOX_COST * boxCount;
  const solCost = FEE_PER_BOX_SOL * boxCount;
  const canAfford = availableG >= gCost;
  const dailyRemaining = daily?.remaining ?? DAILY_BOX_LIMIT;
  const dailyHeadroom = dailyRemaining;
  const withinDailyCap = boxCount <= dailyHeadroom;
  const busy = flowState !== "idle" && flowState !== "revealed" && flowState !== "failed";
  const poolRemaining = inventory
    ? inventory.remaining.reduce((sum, r, i) => sum + r * PRIZE_TIERS[i].amount, 0)
    : 0;

  // ── Chest stage class (drives CSS animations) ─────────────────────────────
  const stageClass = (() => {
    if (flowState === "wallet" || flowState === "submitting" || flowState === "cranking")
      return "chest-stage is-opening";
    if (flowState === "revealed") return "chest-stage is-opened is-revealed";
    return "chest-stage";
  })();

  // ── Open flow (unchanged logic) ───────────────────────────────────────────
  const requestPollingRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    return () => {
      if (requestPollingRef.current) clearInterval(requestPollingRef.current);
    };
  }, []);

  const handleOpen = async () => {
    if (!wallet.publicKey || !wallet.signTransaction) {
      setError("Connect a Solana wallet first.");
      return;
    }
    if (userProfile?.primaryWallet && wallet.publicKey.toBase58() !== userProfile.primaryWallet) {
      const short =
        userProfile.primaryWallet.slice(0, 4) + "…" + userProfile.primaryWallet.slice(-4);
      setError(`Wrong wallet — connect your primary wallet (${short}).`);
      return;
    }
    if (!canAfford) {
      setError(`Insufficient G — need ${gCost.toLocaleString()}.`);
      return;
    }
    if (!withinDailyCap) {
      setError(
        `Daily limit — only ${dailyHeadroom} ${
          dailyHeadroom === 1 ? "box" : "boxes"
        } left today (cap ${DAILY_BOX_LIMIT}/UTC day).`,
      );
      return;
    }

    setError("");
    setRewards(null);
    setTotalReward(0);
    setRequestId("");

    try {
      setFlowState("signing");
      const playerEntropy = generatePlayerEntropy();
      const response = await signLootboxBatch(walletAddress!, boxCount, playerEntropy.base64);
      const payload = response.data as SignLootboxBatchResponse;
      if (payload.playerEntropy !== playerEntropy.base64) {
        throw new Error(
          "Backend echoed a different playerEntropy than we sent — refusing to sign.",
        );
      }
      setRequestId(payload.requestId);

      setFlowState("wallet");
      const txBytes = Buffer.from(payload.partiallySignedTx, "base64");
      const tx = Transaction.from(txBytes);
      const signed = await wallet.signTransaction(tx);
      const signature = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: true,
      });

      setFlowState("submitting");
      await submitLootboxBatch(payload.requestId, signature);

      try {
        await connection.confirmTransaction(
          {
            signature,
            blockhash: payload.blockhash,
            lastValidBlockHeight: payload.lastValidBlockHeight,
          },
          "confirmed",
        );
      } catch {
        // Crank picks it up via Firestore.
      }

      setFlowState("cranking");
      const start = Date.now();
      const poll = async () => {
        const { getFirestore, doc, getDoc } = await import("firebase/firestore");
        const db = getFirestore();
        const snap = await getDoc(doc(db, "lootbox_batches", payload.requestId));
        const data = snap.data() as
          | { status?: string; rewards?: Reward[]; totalReward?: number; crankError?: string }
          | undefined;
        if (data?.status === "consumed") {
          setRewards(data.rewards ?? []);
          setTotalReward(Number(data.totalReward ?? 0));
          setFlowState("revealed");
          toast.success(
            `Won ${Number(data.totalReward ?? 0).toLocaleString()} GET across ${boxCount} ${boxCount === 1 ? "box" : "boxes"}`,
          );
          void refreshInventory();
          void refreshDaily();
          return true;
        }
        if (data?.status === "consume_failed") {
          setError(
            "Crank failed: " + (data.crankError ?? "unknown") + " — your G has been refunded.",
          );
          setFlowState("failed");
          return true;
        }
        if (Date.now() - start > 120_000) {
          setError("Crank is taking longer than expected — check back in a minute.");
          setFlowState("failed");
          return true;
        }
        return false;
      };

      requestPollingRef.current = setInterval(async () => {
        const done = await poll();
        if (done && requestPollingRef.current) {
          clearInterval(requestPollingRef.current);
          requestPollingRef.current = null;
        }
      }, 1500);
    } catch (caught: unknown) {
      console.error("[OPEN_BATCH] failed:", caught);
      setFlowState("failed");
      const msg = caught instanceof Error ? caught.message : "Mystery batch tx failed.";
      setError(msg);
      toast.error(msg, { duration: 8000 });
    }
  };

  const handleResetStuckRequest = async () => {
    try {
      await cancelLootboxBatch();
      setError("");
      setFlowState("idle");
      setRequestId("");
      setRewards(null);
      setTotalReward(0);
      toast.success("Stuck request cleared. Your G escrow has been released.");
      void refreshDaily();
    } catch (err) {
      toast.error("Reset failed: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  if (!isLoggedIn) {
    return (
      <div className="app-shell page-anim">
        <div
          className="panel"
          style={{ maxWidth: 480, margin: "12vh auto", padding: 32, textAlign: "center" }}
        >
          <Lock size={36} color="var(--gold)" style={{ margin: "0 auto" }} />
          <h1 className="page-title" style={{ fontSize: 28, marginTop: 16 }}>
            Login required
          </h1>
          <p style={{ color: "var(--muted)", marginTop: 8 }}>
            Login to spend G and crack open the on-chain mystery boxes.
          </p>
        </div>
      </div>
    );
  }

  const topReward = rewards
    ? rewards.reduce((m, r) => (r.amount > m.amount ? r : m), rewards[0])
    : null;

  return (
    <div className="app-shell page-anim">
      <header className="earn-head">
        <div className="earn-head-text">
          <span className="eyebrow">— the vault</span>
          <h2 className="page-title">
            Convert G into <span className="rust">$GET</span>.
          </h2>
          <p className="earn-blurb">
            Each opening costs <span className="mono">{SINGLE_BOX_COST.toLocaleString()} G</span>{" "}
            and a tiny network fee. Prize odds are public and decrement live as the global pool
            drains — what&apos;s left is what&apos;s left.
          </p>
        </div>
      </header>

      {/* ─── Agent CTA strip ─────────────────────────────────────────────── */}
      <Link href="/profile" className="agent-cta">
        <span className="agent-cta-mark" aria-hidden="true">
          <Bot size={18} />
        </span>
        <span className="agent-cta-body">
          <span className="agent-cta-title">Let your Agent open boxes for you</span>
          <span className="agent-cta-sub">
            Hand the job over — set it up in Profile and the bot opens boxes on a schedule.
          </span>
        </span>
        <span className="agent-cta-go">
          Configure
          <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
            <path
              d="M3 8h10M9 4l4 4-4 4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </Link>

      <div className="earn-balances">
        <div className="eb-card">
          <span className="eb-eyebrow">Your G balance</span>
          <span className="eb-value">
            <Image src="/G.png" alt="" width={22} height={22} className="eb-gicon" />
            {availableG.toLocaleString()}
          </span>
          {reservedPoints > 0 && (
            <span style={{ fontSize: 11, color: "var(--muted)" }}>
              ({reservedPoints.toLocaleString()} G reserved in active batch)
            </span>
          )}
        </div>
        <div className="eb-divider" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path
              d="M5 12h14M13 6l6 6-6 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div className="eb-card eb-card--get">
          <span className="eb-eyebrow">$GET earned</span>
          <span className="eb-value">
            {getBalance === null ? "—" : getBalance.toLocaleString()}{" "}
            <span className="eb-unit">$GET</span>
          </span>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>
            On-chain wallet balance · launch-locked
          </span>
        </div>
      </div>

      {!walletAddress && (
        <div style={{ marginTop: 12 }}>
          <WalletMultiButton />
        </div>
      )}

      {error && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
          <div className="agent-callout agent-callout--err" style={{ display: "flex", gap: 10 }}>
            <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <span style={{ fontWeight: 700 }}>{error}</span>
          </div>
          {(error.includes("pending") ||
            error.includes("already") ||
            error.includes("stuck") ||
            flowState === "failed") && (
            <button
              type="button"
              onClick={handleResetStuckRequest}
              className="btn btn-danger"
              style={{ alignSelf: "flex-start" }}
            >
              <AlertTriangle size={14} />
              Cancel stuck request
            </button>
          )}
        </div>
      )}

      <div className="earn-grid">
        {/* ─── Vault stage ────────────────────────────────────────────── */}
        <section className="vault-stage">
          <div className={stageClass}>
            <div className="chest-light" aria-hidden="true" />
            <div className="chest-rays" aria-hidden="true" />
            <div className="chest">
              <div className="chest-shadow" aria-hidden="true" />
              <div className="chest-body">
                <div className="chest-band chest-band-top" />
                <div className="chest-band chest-band-bottom" />
                <div className="chest-rivet rivet-1" />
                <div className="chest-rivet rivet-2" />
                <div className="chest-rivet rivet-3" />
                <div className="chest-rivet rivet-4" />
                <div className="chest-grain" />
                <div className="chest-keyhole">
                  <div className="kh-circle" />
                  <div className="kh-slot" />
                </div>
              </div>
              <div className="chest-lid">
                <div className="chest-lid-front">
                  <div className="chest-band chest-band-top" />
                  <div className="chest-rivet rivet-l1" />
                  <div className="chest-rivet rivet-l2" />
                  <div className="chest-rivet rivet-l3" />
                  <div className="chest-grain" />
                  <div className="chest-clasp">
                    <div className="clasp-pin" />
                  </div>
                </div>
              </div>
              <div className="chest-glow" aria-hidden="true" />
            </div>
            <div className="reveal-card" aria-live="polite">
              <span className="rc-eyebrow">You drew</span>
              <span className="rc-amount mono">+{totalReward.toLocaleString()}</span>
              <span className="rc-unit">$GET</span>
              {topReward && (
                <span className="rc-tier">
                  Top tier {topReward.tier} · {boxCount} {boxCount === 1 ? "box" : "boxes"}
                </span>
              )}
            </div>
          </div>

          <div className="vault-controls">
            <div className="sl-row">
              <span className="sl-label">1</span>
              <input
                className="open-slider"
                type="range"
                min={1}
                max={MAX_BATCH_SIZE}
                step={1}
                value={boxCount}
                onChange={(e) => setBoxCount(Number(e.target.value))}
                disabled={busy}
                aria-label="Boxes per draw"
              />
              <span className="sl-max">{MAX_BATCH_SIZE}</span>
            </div>

            {flowState === "revealed" ? (
              <button
                type="button"
                className="open-btn"
                onClick={() => {
                  setFlowState("idle");
                  setRewards(null);
                  setTotalReward(0);
                  setRequestId("");
                }}
              >
                <span className="ob-line ob-cost">Open another batch</span>
                <span className="ob-line ob-action">Reset vault</span>
              </button>
            ) : (
              <button
                type="button"
                className="open-btn"
                onClick={handleOpen}
                disabled={busy || !canAfford || !withinDailyCap}
              >
                <span className="ob-line ob-cost">
                  <Image src="/G.png" alt="" width={18} height={18} />
                  <span className="mono">{gCost.toLocaleString()}</span>
                </span>
                <span className="ob-line ob-action">
                  {busy
                    ? (STEP_LABELS[flowState as keyof typeof STEP_LABELS] ?? "Working")
                    : !canAfford
                      ? "Insufficient G"
                      : !withinDailyCap
                        ? `Daily limit — ${dailyHeadroom} left`
                        : `Open vault · ${boxCount} ${boxCount === 1 ? "box" : "boxes"}`}
                </span>
              </button>
            )}
            <span className="ob-fee">
              Network fee · <span className="mono">{solCost.toFixed(6)}</span> SOL · daily{" "}
              {dailyRemaining}/{DAILY_BOX_LIMIT}
            </span>
            {requestId && (
              <div
                style={{
                  marginTop: 6,
                  padding: 6,
                  background: "rgba(8,33,89,0.5)",
                  borderRadius: 8,
                  fontFamily: "var(--font-jetbrains)",
                  fontSize: 10,
                  color: "var(--muted)",
                  wordBreak: "break-all",
                  textAlign: "center",
                }}
              >
                req: {requestId}
              </div>
            )}
          </div>
        </section>

        {/* ─── Prize ledger ──────────────────────────────────────────── */}
        <aside className="prize-ledger">
          <header className="pl-head">
            <span className="pl-eyebrow">Prize ledger</span>
            <h3>What&apos;s left in the pool</h3>
            <p>Updated live · finite supply.</p>
          </header>
          <ol className="pl-list">
            {PRIZE_TIERS.map((p, i) => {
              const remaining = inventory?.remaining[i] ?? null;
              // True depletion ratio: how much of the original stock is still
              // unclaimed. While the on-chain account is still loading we
              // optimistically render full bars rather than empty ones.
              const ratio =
                remaining === null
                  ? 100
                  : Math.max(0, Math.min(100, (remaining / p.initial) * 100));
              return (
                <li key={p.tier} className="pl-row" data-tier={p.bucket}>
                  <span className="pl-rank">{String(p.tier).padStart(2, "0")}</span>
                  <span className="pl-amount">
                    {p.amount.toLocaleString()} <em>$GET</em>
                  </span>
                  <span className="pl-bar" aria-hidden="true">
                    <i style={{ width: `${ratio}%` }} />
                  </span>
                  <span className="pl-left">
                    {remaining !== null ? remaining.toLocaleString() : "—"}
                  </span>
                </li>
              );
            })}
          </ol>
          <footer className="pl-foot">
            <span className="mono">{poolRemaining.toLocaleString()}</span>
            <span className="pl-foot-lbl">$GET remaining</span>
          </footer>
        </aside>
      </div>
    </div>
  );
}
