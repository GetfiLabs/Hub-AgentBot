"use client";

// AgentSection — Authorize + Manage UI, re-skinned to the new GetFi brand
// (paper grain + blue + gold). All on-chain / wallet / context business logic
// from the previous implementation is preserved verbatim; only the visual
// layer was swapped over to the `agent-panel` / `agent-chip` / `agent-row`
// classes that match the rest of the new design language.

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { toast } from "sonner";
import { ExternalLink, Fuel, ShieldCheck } from "lucide-react";
import { useAppContext } from "@/context/AppContext";
import {
  AGENT_ACTION_OPEN_BOX,
  AGENT_MAX_DURATION_SECONDS,
  buildDepositFuelIx,
  buildRegisterAgentIx,
  buildRevokeAgentIx,
  buildWithdrawFuelIx,
} from "@/lib/agent";
import { useAgentAuthority } from "@/hooks/useAgentAuthority";

const EXPIRY_OPTIONS: Array<{ label: string; days: number }> = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "180 days", days: 180 },
  { label: "365 days", days: 365 },
];
const FUEL_OPTIONS = [0.01, 0.05, 0.1, 0.5];
const FUEL_PER_BOX = 308_000; // matches the bot's farmRunner default

type FlowState = "idle" | "wallet" | "submitting" | "done" | "failed";

export default function AgentSection() {
  const params = useSearchParams();
  const { isLoggedIn, walletAddress, login } = useAppContext();
  const { connection } = useConnection();
  const wallet = useWallet();

  const userPubkey = useMemo(() => {
    try {
      return walletAddress ? new PublicKey(walletAddress) : null;
    } catch {
      return null;
    }
  }, [walletAddress]);

  const { authority, fuelLamports, refresh } = useAgentAuthority(walletAddress);

  // eslint-disable-next-line react-hooks/purity
  const nowSec = Math.floor(Date.now() / 1000);
  const isActive = !!authority && !authority.revoked && authority.expiryTs > nowSec;

  if (!walletAddress) {
    return (
      <Shell title="On-chain Agent">
        <p style={{ fontSize: 13, color: "var(--muted)" }}>
          Connect a Solana wallet to manage your agent.
        </p>
        <div style={{ marginTop: 14 }}>
          <WalletMultiButton />
        </div>
      </Shell>
    );
  }
  if (!isLoggedIn) {
    return (
      <Shell title="On-chain Agent">
        <p style={{ fontSize: 13, color: "var(--muted)" }}>Sign in to manage your agent.</p>
        <button
          type="button"
          onClick={() => void login()}
          className="btn btn-rust btn-sm"
          style={{ marginTop: 14 }}
        >
          Sign in with Solana
        </button>
      </Shell>
    );
  }

  if (isActive) {
    return (
      <ManagePanel
        authority={authority!}
        fuelLamports={fuelLamports}
        connection={connection}
        wallet={wallet}
        userPubkey={userPubkey!}
        refresh={refresh}
      />
    );
  }

  return (
    <AuthorizePanel
      preset={params.get("agent") ?? ""}
      authority={authority}
      fuelLamports={fuelLamports}
      connection={connection}
      wallet={wallet}
      userPubkey={userPubkey!}
      refresh={refresh}
    />
  );
}

// ─────────────────────────── Authorize ───────────────────────────

function AuthorizePanel({
  preset,
  authority,
  fuelLamports,
  connection,
  wallet,
  userPubkey,
  refresh,
}: {
  preset: string;
  authority: ReturnType<typeof useAgentAuthority>["authority"];
  fuelLamports: number;
  connection: ReturnType<typeof useConnection>["connection"];
  wallet: ReturnType<typeof useWallet>;
  userPubkey: PublicKey;
  refresh: () => Promise<void>;
}) {
  const [agentInput, setAgentInput] = useState(preset);
  const [days, setDays] = useState<number>(30);
  const [fuelSol, setFuelSol] = useState<number>(0.05);
  const [flow, setFlow] = useState<FlowState>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [txSignature, setTxSignature] = useState<string>("");

  const agentPubkey = useMemo(() => {
    try {
      return agentInput.trim() ? new PublicKey(agentInput.trim()) : null;
    } catch {
      return null;
    }
  }, [agentInput]);

  const canSubmit =
    flow === "idle" &&
    !!agentPubkey &&
    days >= 1 &&
    days <= 365 &&
    fuelSol > 0 &&
    !!wallet.signTransaction;

  async function handleSubmit() {
    if (!agentPubkey || !wallet.signTransaction) return;
    setErrorMsg("");
    setTxSignature("");
    try {
      const expiryTs = Math.floor(Date.now() / 1000) + days * 86_400;
      if (expiryTs - Math.floor(Date.now() / 1000) > AGENT_MAX_DURATION_SECONDS) {
        throw new Error("Duration cannot exceed 365 days.");
      }
      const lamports = Math.round(fuelSol * LAMPORTS_PER_SOL);

      const tx = new Transaction()
        .add(
          buildRegisterAgentIx({
            user: userPubkey,
            agentPubkey,
            allowedActions: AGENT_ACTION_OPEN_BOX,
            expiryTs,
          }),
        )
        .add(
          buildDepositFuelIx({
            user: userPubkey,
            lamports: BigInt(lamports),
          }),
        );
      tx.feePayer = userPubkey;
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;

      setFlow("wallet");
      const signed = await wallet.signTransaction(tx);

      setFlow("submitting");
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
      });
      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed",
      );

      setTxSignature(sig);
      setFlow("done");
      toast.success("Agent authorized.");
      void refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
      setFlow("failed");
      toast.error("Authorization failed: " + msg);
    }
  }

  // eslint-disable-next-line react-hooks/purity
  const expired = !!authority && authority.expiryTs <= Math.floor(Date.now() / 1000);
  const revoked = !!authority && authority.revoked;

  return (
    <Shell title="Authorize Agent">
      <p style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.6 }}>
        Let RaiderBot open mystery boxes on your behalf. The agent can only touch your FuelVault
        through this program — neither you nor the bot can access it directly. You can resign and
        drain the fuel back at any time.
      </p>

      {(revoked || expired) && (
        <div className="agent-callout agent-callout--warn" style={{ marginTop: 12 }}>
          {revoked ? "A previous agent was revoked." : "A previous agent has expired."} You can
          authorize a new one below.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 18, marginTop: 20 }}>
        <label>
          <span className="agent-field-label">Agent Pubkey</span>
          <input
            type="text"
            value={agentInput}
            onChange={(e) => setAgentInput(e.target.value)}
            placeholder="Pubkey provided by the bot"
            className="agent-input"
          />
          {agentInput && !agentPubkey && (
            <p style={{ marginTop: 6, fontSize: 11, color: "#ff8a8a" }}>
              Not a valid Solana address.
            </p>
          )}
        </label>

        <div>
          <span className="agent-field-label">Authorization duration</span>
          <div className="agent-chip-group">
            {EXPIRY_OPTIONS.map((o) => (
              <button
                key={o.days}
                type="button"
                onClick={() => setDays(o.days)}
                className={`agent-chip ${days === o.days ? "is-on" : ""}`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className="agent-field-label">Fuel (SOL — ~0.0003 SOL per box)</span>
          <div className="agent-chip-group">
            {FUEL_OPTIONS.map((sol) => (
              <button
                key={sol}
                type="button"
                onClick={() => setFuelSol(sol)}
                className={`agent-chip ${fuelSol === sol ? "is-on-mint" : ""}`}
              >
                {sol} SOL
              </button>
            ))}
          </div>
          <p style={{ marginTop: 8, fontSize: 11, color: "var(--muted)" }}>
            Funds roughly {Math.floor((fuelSol * LAMPORTS_PER_SOL) / FUEL_PER_BOX)} box openings.
          </p>
        </div>

        {fuelLamports > 0 && (
          <p className="agent-callout agent-callout--warn">
            FuelVault already has {(fuelLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL — this deposit
            will add on top.
          </p>
        )}

        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void handleSubmit()}
          className="btn btn-rust btn-block"
        >
          {flow === "wallet"
            ? "Waiting for wallet signature…"
            : flow === "submitting"
              ? "Broadcasting on-chain…"
              : "Authorize + Deposit Fuel"}
        </button>

        {flow === "done" && txSignature && (
          <div className="agent-callout agent-callout--ok">
            Agent authorized.{" "}
            <a
              href={`https://explorer.solana.com/tx/${txSignature}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: "underline" }}
            >
              View tx <ExternalLink size={11} style={{ display: "inline" }} />
            </a>
          </div>
        )}
        {flow === "failed" && errorMsg && (
          <div className="agent-callout agent-callout--err">{errorMsg}</div>
        )}
      </div>
    </Shell>
  );
}

// ─────────────────────────── Manage ───────────────────────────

function ManagePanel({
  authority,
  fuelLamports,
  connection,
  wallet,
  userPubkey,
  refresh,
}: {
  authority: NonNullable<ReturnType<typeof useAgentAuthority>["authority"]>;
  fuelLamports: number;
  connection: ReturnType<typeof useConnection>["connection"];
  wallet: ReturnType<typeof useWallet>;
  userPubkey: PublicKey;
  refresh: () => Promise<void>;
}) {
  const [partialSol, setPartialSol] = useState<string>("0.01");
  const [flow, setFlow] = useState<FlowState>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [txSignature, setTxSignature] = useState<string>("");

  async function sendTx(tx: Transaction): Promise<string> {
    if (!wallet.signTransaction) throw new Error("Wallet not connected.");
    tx.feePayer = userPubkey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    setFlow("wallet");
    const signed = await wallet.signTransaction(tx);
    setFlow("submitting");
    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    return sig;
  }

  async function handlePartialWithdraw() {
    setErrorMsg("");
    setTxSignature("");
    try {
      const lamports = Math.round(Number(partialSol) * LAMPORTS_PER_SOL);
      if (!Number.isFinite(lamports) || lamports <= 0) throw new Error("Enter a valid SOL amount.");
      if (lamports > fuelLamports) throw new Error("Not enough SOL in the vault.");
      const tx = new Transaction().add(
        buildWithdrawFuelIx({
          authority: userPubkey,
          user: userPubkey,
          amount: BigInt(lamports),
        }),
      );
      const sig = await sendTx(tx);
      setTxSignature(sig);
      setFlow("done");
      toast.success(`${partialSol} SOL returned to your main wallet.`);
      void refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
      setFlow("failed");
      toast.error("Withdraw failed: " + msg);
    }
  }

  async function handleResign() {
    setErrorMsg("");
    setTxSignature("");
    try {
      const tx = new Transaction()
        .add(buildRevokeAgentIx({ authority: userPubkey, user: userPubkey }))
        .add(
          buildWithdrawFuelIx({
            authority: userPubkey,
            user: userPubkey,
            amount: null,
          }),
        );
      const sig = await sendTx(tx);
      setTxSignature(sig);
      setFlow("done");
      toast.success("Agent revoked, fuel returned.");
      void refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
      setFlow("failed");
      toast.error("Operation failed: " + msg);
    }
  }

  // eslint-disable-next-line react-hooks/purity
  const nowSec = Math.floor(Date.now() / 1000);
  const remaining = Math.max(0, authority.expiryTs - nowSec);
  const remainingDays = Math.floor(remaining / 86_400);
  const remainingHours = Math.floor((remaining % 86_400) / 3_600);
  const canOpenBox = (authority.allowedActions & AGENT_ACTION_OPEN_BOX) !== 0;

  return (
    <Shell
      title="Agent Manager"
      headerRight={
        <span
          style={{
            padding: "4px 10px",
            borderRadius: 6,
            background: "linear-gradient(180deg, #78E85E, var(--green) 50%, var(--green-2))",
            color: "#062414",
            border: "1px solid var(--green-3)",
            fontFamily: "var(--font-jetbrains)",
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: ".12em",
            textTransform: "uppercase",
          }}
        >
          Active
        </span>
      }
    >
      <dl style={{ margin: 0 }}>
        <div className="agent-row mono">
          <dt>Agent Pubkey</dt>
          <dd>{authority.agentPubkey.toBase58()}</dd>
        </div>
        <div className="agent-row mono">
          <dt>Wallet</dt>
          <dd>{authority.user.toBase58()}</dd>
        </div>
        <div className="agent-row">
          <dt>Permissions</dt>
          <dd>
            {canOpenBox ? "open_box ✓" : `bitmask 0x${authority.allowedActions.toString(16)}`}
          </dd>
        </div>
        <div className="agent-row">
          <dt>Expires</dt>
          <dd>
            {remainingDays}d {remainingHours}h
            <span style={{ color: "var(--muted)", fontWeight: 500, marginLeft: 6 }}>
              ({new Date(authority.expiryTs * 1000).toUTCString()})
            </span>
          </dd>
        </div>
        <div className="agent-row">
          <dt>Nonce</dt>
          <dd className="mono">{authority.nonceCounter.toString()}</dd>
        </div>
        <div className="agent-row">
          <dt>
            <Fuel size={11} style={{ display: "inline", marginRight: 4, color: "var(--gold)" }} />
            FuelVault
          </dt>
          <dd className="mono" style={{ color: "var(--gold)" }}>
            {(fuelLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL
          </dd>
        </div>
      </dl>

      <section style={{ marginTop: 20 }}>
        <span className="agent-field-label">Partial Fuel Withdrawal</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="number"
            step="0.001"
            min="0"
            max={(fuelLamports / LAMPORTS_PER_SOL).toString()}
            value={partialSol}
            onChange={(e) => setPartialSol(e.target.value)}
            className="agent-input"
            style={{ width: 140 }}
          />
          <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 600 }}>SOL</span>
          <button
            type="button"
            className="btn btn-ink btn-sm"
            disabled={flow === "wallet" || flow === "submitting" || fuelLamports === 0}
            onClick={() => void handlePartialWithdraw()}
            style={{ marginLeft: "auto" }}
          >
            Withdraw
          </button>
        </div>
        <p style={{ marginTop: 8, fontSize: 11, color: "var(--muted)" }}>
          Keeps the agent running — just pulls some SOL back out.
        </p>
      </section>

      <section
        style={{
          marginTop: 20,
          padding: 14,
          borderRadius: 12,
          border: "1px solid rgba(230, 57, 70, 0.3)",
          background: "rgba(230, 57, 70, 0.06)",
        }}
      >
        <span className="agent-field-label" style={{ color: "#ff8a8a" }}>
          Resign Agent + Withdraw All Fuel
        </span>
        <p style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10 }}>
          One tx revokes the agent and drains the FuelVault back to your main wallet. Cannot be
          undone.
        </p>
        <button
          type="button"
          disabled={flow === "wallet" || flow === "submitting"}
          onClick={() => void handleResign()}
          className="btn btn-danger btn-block"
        >
          {flow === "wallet"
            ? "Waiting for wallet signature…"
            : flow === "submitting"
              ? "Broadcasting on-chain…"
              : "Resign + Withdraw All Fuel"}
        </button>
      </section>

      {flow === "done" && txSignature && (
        <div className="agent-callout agent-callout--ok" style={{ marginTop: 16 }}>
          Transaction confirmed.{" "}
          <a
            href={`https://explorer.solana.com/tx/${txSignature}?cluster=devnet`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ textDecoration: "underline" }}
          >
            View tx <ExternalLink size={11} style={{ display: "inline" }} />
          </a>
        </div>
      )}
      {flow === "failed" && errorMsg && (
        <div className="agent-callout agent-callout--err" style={{ marginTop: 16 }}>
          {errorMsg}
        </div>
      )}
    </Shell>
  );
}

// ─────────────────────────── shared bits ───────────────────────────

function Shell({
  title,
  headerRight,
  children,
}: {
  title: string;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="agent-panel">
      <header className="wp-head" style={{ alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <span className="eyebrow">— on-chain agent</span>
          <h3>{title}</h3>
        </div>
        {headerRight ?? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontFamily: "var(--font-jetbrains)",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: ".12em",
              textTransform: "uppercase",
              color: "var(--muted)",
            }}
          >
            <ShieldCheck size={12} />
            on-chain
          </span>
        )}
      </header>
      <div style={{ marginTop: 8 }}>{children}</div>
    </section>
  );
}
