"use client";

import Image from "next/image";
import { Suspense } from "react";
import { Copy, Lock, LogOut, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useAppContext } from "@/context/AppContext";
import AgentSection from "@/components/AgentSection";
import { useGetBalance } from "@/hooks/useGetBalance";

export default function ProfilePage() {
  const { isLoggedIn, userProfile, logout, walletAddress, totalGetPoints, gameLinks } =
    useAppContext();
  const { balance: getBalance } = useGetBalance(walletAddress);

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
            Connect your wallet to view your profile.
          </p>
        </div>
      </div>
    );
  }

  const avatarSeed = walletAddress ? walletAddress.slice(0, 2).toUpperCase() : "GF";

  const copyAddress = () => {
    if (!walletAddress) return;
    navigator.clipboard.writeText(walletAddress);
    toast.success("Address copied!");
  };

  const role = userProfile?.role || "user";
  const roleLabel = role === "admin" ? "Admin" : "Raider";

  // Compact number formatter — 142,830 → "142.8k", 1_240_000 → "1.24M".
  const compact = (n: number) =>
    n >= 1_000_000
      ? (n / 1_000_000).toFixed(2).replace(/\.?0+$/, "") + "M"
      : n >= 1_000
        ? (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k"
        : String(n);

  return (
    <div className="app-shell page-anim">
      <header className="profile-head">
        <div className="avatar" aria-hidden="true">
          <span className="avatar-mono">{avatarSeed}</span>
        </div>
        <div className="profile-id">
          <span className="eyebrow">— player</span>
          <h2 className="page-title">
            {roleLabel}{" "}
            <span className="mono rust">#{(userProfile?.uid || "00000").slice(-5)}</span>
          </h2>
          <span className="profile-since">
            Joined GetFi · {role === "admin" ? "Studio admin" : "Active player"}
          </span>
        </div>
        <div className="profile-stats">
          <div>
            <span className="ps-num mono">{gameLinks.length}</span>
            <span className="ps-lbl">games</span>
          </div>
          <div>
            <span
              className="ps-num mono"
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <Image
                src="/G.png"
                alt=""
                width={22}
                height={22}
                style={{
                  filter: "drop-shadow(0 1px 3px rgba(0,0,0,.35))",
                  marginTop: -2,
                }}
              />
              {compact(totalGetPoints)}
            </span>
            <span className="ps-lbl">G</span>
          </div>
          <div>
            <span className="ps-num mono">{getBalance === null ? "—" : compact(getBalance)}</span>
            <span className="ps-lbl">$GET</span>
          </div>
        </div>
      </header>

      <section className="profile-body">
        <div>
          <section className="wallets-panel">
            <header className="wp-head">
              <div>
                <span className="eyebrow">— linked wallets</span>
                <h3>Wallets</h3>
              </div>
              <span
                style={{
                  fontFamily: "var(--font-jetbrains)",
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: ".12em",
                  textTransform: "uppercase",
                  color: "var(--muted)",
                }}
              >
                {walletAddress ? "1 connected" : "none"}
              </span>
            </header>

            <ul className="wallet-list">
              <li className="wallet-row wallet-row--primary">
                <span className="wr-tag">Primary</span>
                <span className="wr-icon" aria-hidden="true">
                  <Wallet size={20} />
                </span>
                <span className="wr-meta">
                  <span className="wr-net">Solana · Devnet</span>
                  <span className="wr-addr mono">{walletAddress || "Not connected"}</span>
                </span>
                <span className="wr-balance">
                  <span className="mono">
                    {getBalance === null ? "—" : getBalance.toLocaleString()}
                  </span>
                  <span className="wr-bal-unit">$GET</span>
                </span>
                <button
                  type="button"
                  className="copy-btn"
                  aria-label="Copy address"
                  onClick={copyAddress}
                >
                  <Copy size={12} />
                </button>
              </li>
            </ul>
            <p className="wallets-foot">
              One account, multiple wallets. $GET payouts go to whichever wallet you mark as
              primary.
            </p>

            <button
              type="button"
              onClick={logout}
              className="btn btn-danger btn-block"
              style={{ marginTop: 16 }}
            >
              <LogOut size={14} />
              Disconnect &amp; Logout
            </button>
          </section>
        </div>

        {/* ─── On-chain Agent panel (new design language) ────────── */}
        <Suspense
          fallback={
            <section className="agent-panel" style={{ marginTop: 0 }}>
              <span className="eyebrow">— on-chain agent</span>
              <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 8 }}>
                Loading agent state…
              </p>
            </section>
          }
        >
          <AgentSection />
        </Suspense>
      </section>
    </div>
  );
}
