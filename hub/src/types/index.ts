export type { UserProfile, GameLink } from "@/context/AppContext";

export type LootBoxTier = {
  id: number;
  cost: number;
  reward: number;
  name: string;
  accent: string;
};

export type TransactionRecord = {
  id: string;
  type?: string;
  amount?: number;
  description?: string;
  requestId?: string;
  timestamp?: unknown;
};

export type NavLink = {
  name: string;
  path: string;
  icon: React.ComponentType<{ className?: string }>;
};

export type ActivityItem = {
  id: string;
  type: "earn" | "spend";
  description: string;
  amount: number;
  time: string;
};

export type Achievement = {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  color: string;
};
