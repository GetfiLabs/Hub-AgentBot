"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { toast } from "sonner";
import { auth, db, functions } from "../lib/firebase";
import { onAuthStateChanged, signInWithCustomToken, signOut, User } from "firebase/auth";
import {
  doc,
  onSnapshot,
  collection,
  query,
  where,
  updateDoc,
  serverTimestamp,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";

type FirestoreTimestampLike = unknown;

export interface UserProfile {
  uid: string;
  primaryWallet: string | null;
  connectedWallets: string[];
  getPoints: number;
  gamesPlayed?: string[];
  lootboxEarnings: number;
  role?: "user" | "admin";
  createdAt: FirestoreTimestampLike;
  lastLogin: FirestoreTimestampLike;
}

export interface GameLink {
  gameId: string;
  playerId: string;
  inGameGetBalance: number;
  maxLevel: number;
  highScore: number;
}

interface AppContextType {
  isLoggedIn: boolean;
  user: User | null;
  userProfile: UserProfile | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  walletAddress: string | null;
  connectWallet: () => Promise<void>;
  totalGetPoints: number;
  gameLinks: GameLink[];
  addGameLink: (gameId: string, playerId: string) => Promise<void>;
  openLootBox: (boxTier: number) => Promise<boolean>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [totalGetPoints, setTotalGetPoints] = useState(0);
  const [gameLinks, setGameLinks] = useState<GameLink[]>([]);
  const wallet = useWallet();
  const walletAddress = wallet.connected && wallet.publicKey ? wallet.publicKey.toBase58() : null;

  useEffect(() => {
    let unsubscribeUser: (() => void) | undefined;
    let unsubscribeGL: (() => void) | undefined;

    const unsubscribeAuth = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setIsLoggedIn(!!currentUser);

      if (unsubscribeUser) unsubscribeUser();
      if (unsubscribeGL) unsubscribeGL();

      if (currentUser && currentUser.uid) {
        const userDocRef = doc(db, "users", currentUser.uid);

        try {
          await updateDoc(userDocRef, { lastLogin: serverTimestamp() });
        } catch {
          // Doc may not exist yet on very first sign-in; verifyWalletSignature creates it
        }

        unsubscribeUser = onSnapshot(
          userDocRef,
          (docSnap) => {
            if (docSnap.exists()) {
              const data = docSnap.data();
              setUserProfile(data as UserProfile);
              setTotalGetPoints(data.getPoints ?? data.points ?? data.totalGetPoints ?? 0);
            }
          },
          (error) => {
            console.error("[FIRESTORE] User profile listener error:", error);
          },
        );

        const glQuery = query(collection(db, "game_links"), where("uid", "==", currentUser.uid));
        unsubscribeGL = onSnapshot(
          glQuery,
          (querySnapshot) => {
            const links: GameLink[] = [];
            querySnapshot.forEach((d) => {
              const data = d.data();
              links.push({
                gameId: data.gameId,
                playerId: data.playerId,
                inGameGetBalance: data.inGameGetBalance || 0,
                maxLevel: data.maxLevel || 1,
                highScore: data.highScore || 0,
              });
            });
            setGameLinks(links);
          },
          (error) => {
            console.error("[FIRESTORE] Game links listener error:", error);
          },
        );
      } else {
        setTotalGetPoints(0);
        setGameLinks([]);
        setUserProfile(null);
      }
    });

    return () => {
      unsubscribeAuth();
      if (unsubscribeUser) unsubscribeUser();
      if (unsubscribeGL) unsubscribeGL();
    };
  }, []);

  // SIWS: wallet must already be connected before calling login().
  // connect() is intentionally NOT called here — the login page handles wallet selection via useWalletModal.
  const login = async () => {
    const pubkey = wallet.publicKey;
    const signMessage = wallet.signMessage;

    if (!pubkey || !signMessage) {
      toast.error("Please connect your wallet first.");
      return;
    }

    try {
      const walletAddr = pubkey.toBase58();
      const nonce = Date.now().toString();
      const message = `Sign in to GetFi Hub\n\nWallet: ${walletAddr}\nNonce: ${nonce}`;
      const messageBytes = new TextEncoder().encode(message);

      const signatureBytes = await signMessage(messageBytes);
      const signatureB64 = Buffer.from(signatureBytes).toString("base64");

      const verifyFn = httpsCallable(functions, "verifyWalletSignature");
      const result = await verifyFn({
        walletAddress: walletAddr,
        signature: signatureB64,
        message,
      });

      const { token } = result.data as { token: string };
      await signInWithCustomToken(auth, token);
    } catch (error) {
      console.error("[LOGIN] SIWS failed:", error);
      const msg = error instanceof Error ? error.message : "Sign-in failed";
      toast.error("Login Error: " + msg, { duration: 10000 });
    }
  };

  const logout = async () => {
    await signOut(auth);
  };

  const addGameLink = async (gameId: string, playerId: string) => {
    if (!user) return;
    try {
      const linkPlayerIdFn = httpsCallable(functions, "linkPlayerId");
      await linkPlayerIdFn({ gameId, playerId });
    } catch (error) {
      console.error("Failed to link game:", error);
      throw error;
    }
  };

  const connectWallet = async () => {
    try {
      await wallet.connect();
    } catch (error) {
      console.error("Wallet connection failed:", error);
      throw error;
    }
  };

  const openLootBox = async (boxTier: number) => {
    if (!user) return false;
    try {
      const openLootBoxFn = httpsCallable(functions, "openLootBox");
      const result = await openLootBoxFn({ boxTier });
      const data = result.data as { success?: boolean };
      return Boolean(data.success);
    } catch (error) {
      console.error("Failed to open loot box:", error);
      return false;
    }
  };

  return (
    <AppContext.Provider
      value={{
        isLoggedIn,
        user,
        userProfile,
        login,
        logout,
        walletAddress,
        connectWallet,
        totalGetPoints,
        gameLinks,
        addGameLink,
        openLootBox,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useAppContext = () => {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error("useAppContext must be used within an AppProvider");
  }
  return context;
};
