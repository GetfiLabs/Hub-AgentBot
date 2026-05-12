"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Loader2, Wallet } from "lucide-react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useAppContext } from "@/context/AppContext";

export default function LoginPage() {
  const { isLoggedIn, login } = useAppContext();
  const router = useRouter();
  const { wallets, select, connect, connected, wallet: selectedWallet, connecting } = useWallet();
  const [connectingName, setConnectingName] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const signingRef = useRef(false);

  // Redirect if already logged in
  useEffect(() => {
    if (isLoggedIn) router.replace("/");
  }, [isLoggedIn, router]);

  // Step 2: after select() updates selectedWallet, call connect()
  useEffect(() => {
    if (!connectingName) return;
    if (connected) return;
    if (connecting) return;
    if (selectedWallet?.adapter.name !== connectingName) return;

    connect().catch((err) => {
      console.error("[LOGIN] connect() failed:", err);
      setConnectingName(null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWallet?.adapter.name, connectingName, connected, connecting]);

  // Step 3: wallet connected → auto-trigger SIWS sign
  useEffect(() => {
    if (connected && !isLoggedIn && !signingRef.current) {
      signingRef.current = true;
      setSigning(true);
      login().finally(() => {
        setSigning(false);
        signingRef.current = false;
        setConnectingName(null);
      });
    }
    if (!connected) {
      signingRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, isLoggedIn]);

  if (isLoggedIn) return null;

  const handleWalletClick = (walletName: string) => {
    if (connecting || signing) return;
    setConnectingName(walletName);
    select(walletName as Parameters<typeof select>[0]);
  };

  const detected = wallets.filter(
    (w) => w.readyState === "Installed" || w.readyState === "Loadable",
  );
  const others = wallets.filter((w) => w.readyState !== "Installed" && w.readyState !== "Loadable");
  const orderedWallets = [...detected, ...others];

  const isBusy = connecting || signing;

  return (
    <div
      className="app-shell page-anim"
      style={{ display: "grid", placeItems: "center", minHeight: "70vh" }}
    >
      <div className="modal" style={{ animation: "none" }}>
        <header style={{ textAlign: "center", marginBottom: 20 }}>
          <div
            className="avatar"
            aria-hidden="true"
            style={{ width: 70, height: 70, margin: "0 auto 16px", borderRadius: 18 }}
          >
            <Image
              src="/G.png"
              alt=""
              width={36}
              height={36}
              style={{ filter: "drop-shadow(0 2px 4px rgba(0,0,0,.3))" }}
            />
          </div>
          <span className="eyebrow" style={{ justifyContent: "center" }}>
            — GetFi Hub
          </span>
          <h3 style={{ marginTop: 6 }}>
            <span className="rust">Connect</span> Wallet
          </h3>
          <p className="modal-sub">Choose a wallet to sign in to your account.</p>
        </header>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {orderedWallets.map((w) => {
            const isDetected = w.readyState === "Installed" || w.readyState === "Loadable";
            const isActive = connectingName === w.adapter.name && (connecting || signing);

            return (
              <button
                key={w.adapter.name}
                type="button"
                onClick={() => handleWalletClick(w.adapter.name)}
                disabled={isBusy}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  width: "100%",
                  minHeight: 56,
                  padding: "10px 14px",
                  borderRadius: 12,
                  border: isDetected ? "1px solid var(--line)" : "1px solid var(--line-soft)",
                  background: isDetected ? "rgba(8,33,89,.45)" : "transparent",
                  opacity: isDetected ? 1 : 0.55,
                  textAlign: "left",
                  cursor: isBusy ? "not-allowed" : "pointer",
                  transition: "all .15s var(--ease)",
                }}
              >
                {w.adapter.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={w.adapter.icon}
                    alt={w.adapter.name}
                    style={{ width: 32, height: 32, borderRadius: 8, flexShrink: 0 }}
                  />
                ) : (
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 8,
                      background: "rgba(255,255,255,.1)",
                      display: "grid",
                      placeItems: "center",
                      flexShrink: 0,
                    }}
                  >
                    <Wallet size={14} />
                  </div>
                )}

                <span style={{ flex: 1, fontWeight: 700, color: "var(--ink)", fontSize: 14 }}>
                  {w.adapter.name}
                </span>

                {isActive ? (
                  <Loader2 size={16} className="animate-spin" style={{ color: "var(--gold)" }} />
                ) : isDetected ? (
                  <span
                    style={{
                      padding: "3px 8px",
                      borderRadius: 6,
                      background: "rgba(91,201,71,.15)",
                      color: "var(--green)",
                      fontSize: 10,
                      fontWeight: 800,
                      letterSpacing: ".08em",
                      textTransform: "uppercase",
                    }}
                  >
                    Detected
                  </span>
                ) : (
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>Not installed</span>
                )}
              </button>
            );
          })}
        </div>

        {signing && (
          <div
            className="agent-callout agent-callout--warn"
            style={{
              marginTop: 16,
              display: "flex",
              gap: 8,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Loader2 size={14} className="animate-spin" />
            Waiting for wallet signature…
          </div>
        )}

        <p
          style={{
            marginTop: 18,
            textAlign: "center",
            fontSize: 11,
            color: "var(--muted)",
          }}
        >
          Signing is free and does not send a transaction.
        </p>
      </div>
    </div>
  );
}
