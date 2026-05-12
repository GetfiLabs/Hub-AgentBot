// Live AgentAuthority + FuelVault state for the connected wallet.
// Polls every `pollMs` while the page is open. Returns enough info for
// /agent and /agent/manage to drive their UI without each duplicating
// the fetch logic.

"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  AgentAuthority,
  decodeAgentAuthority,
  deriveAgentAuthorityPda,
  deriveFuelVaultPda,
} from "@/lib/agent";

export interface AgentAuthorityState {
  loading: boolean;
  authority: AgentAuthority | null;
  fuelLamports: number; // 0 if vault never funded
  refresh: () => Promise<void>;
  error: string | null;
}

export function useAgentAuthority(
  walletAddress: string | null,
  pollMs = 8_000,
): AgentAuthorityState {
  const { connection } = useConnection();
  const [authority, setAuthority] = useState<AgentAuthority | null>(null);
  const [fuelLamports, setFuelLamports] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = async () => {
    if (!walletAddress) {
      setAuthority(null);
      setFuelLamports(0);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const user = new PublicKey(walletAddress);
      const authPda = deriveAgentAuthorityPda(user);
      const fuelPda = deriveFuelVaultPda(user);
      const [authAcc, fuelBal] = await Promise.all([
        connection.getAccountInfo(authPda, "confirmed"),
        connection.getBalance(fuelPda, "confirmed"),
      ]);
      setAuthority(authAcc ? decodeAgentAuthority(authAcc.data) : null);
      setFuelLamports(fuelBal);
    } catch (e) {
      setError(e instanceof Error ? e.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      if (cancelled) return;
      await fetchAll();
    };
    void tick();
    if (walletAddress && pollMs > 0) {
      timer = setInterval(tick, pollMs);
    }
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress, pollMs, connection]);

  return { loading, authority, fuelLamports, refresh: fetchAll, error };
}
