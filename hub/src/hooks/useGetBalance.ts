"use client";

import { useEffect, useState, useRef } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { deriveAta, GETFI_REWARD_MINT } from "@/lib/lootbox";

// Live $GET SPL-token balance for the connected wallet's Associated Token
// Account. If the ATA doesn't exist yet the player simply hasn't received any
// GET — we surface that as 0.
//
// Polls every 20 s on top of the initial fetch so reward deliveries from the
// Crank land in the UI without a manual refresh.
export function useGetBalance(walletAddress: string | null | undefined) {
  const { connection } = useConnection();
  const [balance, setBalance] = useState<number | null>(null);
  // Cache the mint decimals so we only fetch it once per session.
  const decimalsRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchDecimals = async (): Promise<number> => {
      if (decimalsRef.current !== null) return decimalsRef.current;
      try {
        const mintInfo = await connection.getAccountInfo(GETFI_REWARD_MINT, "confirmed");
        if (mintInfo) {
          // SPL Mint layout: decimals is a single u8 at byte offset 44.
          const dec = mintInfo.data[44];
          decimalsRef.current = dec;
          return dec;
        }
      } catch (err) {
        console.warn("[GET_BALANCE] mint decimals fetch failed:", err);
      }
      // Fallback: assume 0 decimals (whole-number token) if mint is unreadable.
      return 0;
    };

    const fetchBalance = async () => {
      if (!walletAddress) {
        if (!cancelled) setBalance(0);
        return;
      }
      try {
        const owner = new PublicKey(walletAddress);
        const ata = deriveAta(owner, GETFI_REWARD_MINT);
        const [acc, decimals] = await Promise.all([
          connection.getAccountInfo(ata, "confirmed"),
          fetchDecimals(),
        ]);
        if (cancelled) return;
        if (!acc) {
          setBalance(0);
          return;
        }
        // SPL-token v1: amount is u64 LE at offset 64 (8 bytes).
        const dv = new DataView(acc.data.buffer, acc.data.byteOffset + 64, 8);
        const lo = dv.getUint32(0, true);
        const hi = dv.getUint32(4, true);
        const raw = BigInt(hi) * BigInt(0x100000000) + BigInt(lo);
        // Divide by 10^decimals to get the human-readable amount.
        const divisor = 10 ** decimals;
        const human = Number(raw) / divisor;
        if (!cancelled) setBalance(human);
      } catch (err) {
        console.warn("[GET_BALANCE] fetch failed:", err);
      }
    };

    void fetchBalance();
    const id = setInterval(fetchBalance, 20_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connection, walletAddress]);

  return { balance };
}
