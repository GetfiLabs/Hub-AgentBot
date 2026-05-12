export const APP_NAME = "GetFi Hub";
export const APP_DESCRIPTION = "Web3 dApp Bridge for GetFi Gaming Ecosystem";

export const SOLANA_NETWORK = "devnet" as const;

export const LOOT_BOX_TIERS = [
  { id: 1, cost: 50, reward: 5, name: "Scout", accent: "var(--muted)" },
  { id: 2, cost: 100, reward: 10, name: "Runner", accent: "var(--cyan)" },
  { id: 3, cost: 200, reward: 20, name: "Signal", accent: "var(--mint)" },
  { id: 4, cost: 500, reward: 50, name: "Vector", accent: "var(--violet)" },
  { id: 5, cost: 1000, reward: 100, name: "Prime", accent: "var(--amber)" },
  { id: 6, cost: 2000, reward: 200, name: "Apex", accent: "var(--coral)" },
  { id: 7, cost: 5000, reward: 500, name: "Myth", accent: "var(--mint)" },
  { id: 8, cost: 50000, reward: 5000, name: "Origin", accent: "var(--cyan)" },
  { id: 9, cost: 250000, reward: 25000, name: "Genesis", accent: "var(--amber)" },
] as const;

export const ROUTES = {
  HOME: "/",
  EARN: "/earn",
  MY_GAMES: "/my-games",
  WALLET: "/wallet",
  DASHBOARD: "/dashboard",
  PROFILE: "/profile",
} as const;
