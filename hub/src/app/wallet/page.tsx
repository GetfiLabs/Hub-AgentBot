"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import {
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  Coins,
  Copy,
  Gift,
  Lock,
  PackageOpen,
  RotateCcw,
  TrendingUp,
} from "lucide-react";
import { db } from "@/lib/firebase";
import { useAppContext } from "@/context/AppContext";
import { useGetBalance } from "@/hooks/useGetBalance";

type TransactionRecord = {
  id: string;
  type?: string;
  amount?: number;
  description?: string;
  requestId?: string;
};

// Direction & icon mapping. "in" = wallet receives G (green, up-right arrow),
// "out" = wallet spends G (red, down-right arrow). The icon picks a more
// specific glyph when we recognize the transaction type.
type Direction = "in" | "out";

function classifyTx(tx: TransactionRecord): {
  direction: Direction;
  icon: typeof ArrowUpRight;
  bucket: "earn" | "spend";
} {
  const type = String(tx.type || "").toLowerCase();
  const desc = String(tx.description || "").toLowerCase();
  const isRefund = type.includes("refund") || desc.includes("refund");
  const isWin = type.includes("win") || type.includes("reward") || desc.includes("won");
  const isCollect = type.includes("collect") || desc.includes("collect");
  const isOpen = type.includes("open") || desc.includes("open");
  const isAgent = type.includes("agent") || desc.includes("agent");
  const isSpend = type.includes("spend") || isOpen;

  if (isSpend && !isRefund) {
    return { direction: "out", icon: isOpen ? PackageOpen : ArrowDownRight, bucket: "spend" };
  }
  if (isRefund) {
    return { direction: "in", icon: RotateCcw, bucket: "earn" };
  }
  if (isWin) {
    return { direction: "in", icon: Gift, bucket: "earn" };
  }
  if (isAgent) {
    return { direction: "in", icon: Bot, bucket: "earn" };
  }
  if (isCollect) {
    return { direction: "in", icon: TrendingUp, bucket: "earn" };
  }
  return { direction: "in", icon: ArrowUpRight, bucket: "earn" };
}

export default function WalletPage() {
  const { isLoggedIn, walletAddress, totalGetPoints, user } = useAppContext();
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<"all" | "earn" | "spend">("all");
  const { balance: getBalance } = useGetBalance(walletAddress);

  useEffect(() => {
    if (!user) return;
    const txQuery = query(
      collection(db, "transactions"),
      where("uid", "==", user.uid),
      orderBy("timestamp", "desc"),
    );
    return onSnapshot(txQuery, (snapshot) => {
      setTransactions(
        snapshot.docs.map((doc) => ({
          id: doc.id,
          ...(doc.data() as Omit<TransactionRecord, "id">),
        })),
      );
    });
  }, [user]);

  const totals = useMemo(() => {
    return transactions.reduce(
      (acc, tx) => {
        const c = classifyTx(tx);
        const amt = Number(tx.amount || 0);
        if (c.bucket === "spend") acc.spent += amt;
        if (c.bucket === "earn" && String(tx.type).includes("refund")) acc.refunded += amt;
        if (c.bucket === "earn" && !String(tx.type).includes("refund")) acc.earned += amt;
        return acc;
      },
      { spent: 0, refunded: 0, earned: 0 },
    );
  }, [transactions]);

  const filtered = useMemo(() => {
    if (tab === "all") return transactions;
    return transactions.filter((t) => classifyTx(t).bucket === tab);
  }, [transactions, tab]);

  const copy = async () => {
    if (!walletAddress) return;
    await navigator.clipboard.writeText(walletAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
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
            Wallet history is private to your account.
          </p>
        </div>
      </div>
    );
  }

  const short = walletAddress
    ? walletAddress.slice(0, 5) + "…" + walletAddress.slice(-6)
    : "Not connected";

  return (
    <div className="app-shell page-anim">
      <header className="page-head">
        <div>
          <span className="eyebrow">— ledger</span>
          <h2 className="page-title">Wallet</h2>
        </div>
        <span className="addr-pill">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          <span className="mono">{short}</span>
          <button type="button" className="copy-btn" aria-label="Copy address" onClick={copy}>
            {copied ? <CheckCircle2 size={12} /> : <Copy size={12} />}
          </button>
        </span>
      </header>

      <section className="wallet-balances">
        <article className="wb-card wb-g">
          <span className="wb-eyebrow">G points · available</span>
          <span className="wb-value">
            <Image src="/G.png" alt="" width={30} height={30} className="wb-glyph" />
            {totalGetPoints.toLocaleString()}
          </span>
          <span className="wb-foot">across {transactions.length} ledger records</span>
        </article>

        <article className="wb-card wb-spent">
          <span className="wb-eyebrow">G spent · all time</span>
          <span className="wb-value">{totals.spent.toLocaleString()}</span>
          <span className="wb-foot">
            {totals.refunded > 0 ? `${totals.refunded.toLocaleString()} refunded` : "All settled"}
          </span>
        </article>

        <article className="wb-card wb-get">
          <span className="wb-eyebrow">$GET earned · launch-locked</span>
          <span className="wb-value">
            <Coins size={26} color="var(--gold)" style={{ flexShrink: 0 }} />
            {getBalance === null ? "—" : getBalance.toLocaleString()}
          </span>
          <span className="wb-foot">
            Frozen until owner launch approval · then thaw &amp; transfer
          </span>
        </article>
      </section>

      <section className="activity">
        <header className="activity-head">
          <h3>Activity</h3>
          <div
            style={{
              display: "inline-flex",
              gap: 3,
              padding: 4,
              background: "rgba(8,33,89,.7)",
              border: "1px solid var(--navy-outline)",
              borderRadius: 999,
            }}
          >
            {(["all", "earn", "spend"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                style={{
                  padding: "6px 14px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 700,
                  color: tab === t ? "#162447" : "var(--muted)",
                  background:
                    tab === t
                      ? "linear-gradient(180deg, #FFE680, var(--gold) 45%, var(--gold-2))"
                      : "transparent",
                  textShadow: tab === t ? "0 1px 0 rgba(255,255,255,.35)" : "none",
                }}
              >
                {t === "all" ? "All" : t === "earn" ? "Earnings" : "Vault"}
              </button>
            ))}
          </div>
        </header>

        {filtered.length === 0 ? (
          <div
            style={{
              padding: 32,
              textAlign: "center",
              color: "var(--muted)",
              fontSize: 13,
            }}
          >
            No transactions yet.
          </div>
        ) : (
          <ol className="activity-list">
            {filtered.slice(0, 20).map((tx) => {
              const c = classifyTx(tx);
              const Icon = c.icon;
              return (
                <li key={tx.id} className="act-row" data-kind={c.bucket}>
                  <span className="act-icon" aria-hidden="true">
                    <Icon size={16} />
                  </span>
                  <span className="act-meta">
                    <span className="act-title">{tx.description || tx.type || "Transaction"}</span>
                    <span className="act-sub">{tx.requestId || tx.id}</span>
                  </span>
                  <span className="act-amt">
                    {c.direction === "out" ? "−" : "+"}
                    {Number(tx.amount || 0).toLocaleString()} G
                  </span>
                  <span className="act-time">—</span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
