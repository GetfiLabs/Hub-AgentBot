"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Copy, LogIn, LogOut, RefreshCw, User, Home, Gamepad2, Coins, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useAppContext } from "@/context/AppContext";

const navLinks = [
  { name: "Home", path: "/", icon: Home },
  { name: "My Games", path: "/my-games", icon: Gamepad2 },
  { name: "Earn", path: "/earn", icon: Coins },
  { name: "Wallet", path: "/wallet", icon: Wallet },
];

const tickerHits = [
  ["8K1m…xP9L", "2,000,000"],
  ["4Hd2…tQ3a", "500,000"],
  ["9Mc3…rW7b", "100,000"],
  ["2Fj8…sD4c", "50,000"],
  ["7Zg5…yN1e", "10,000"],
  ["3Lp6…vK9f", "500,000"],
  ["5Rq1…mB7g", "2,500"],
  ["1Ct4…hJ3h", "100,000"],
  ["6Wx9…aP5i", "50,000"],
  ["8Vy7…cE2j", "500"],
  ["4Uz6…xM8k", "10,000"],
  ["2Bn3…rT1l", "2,000,000"],
  ["7Dw8…qF4m", "100,000"],
  ["9Xs5…bG9n", "500,000"],
  ["3Ky2…wS6o", "50,000"],
  ["6Jp7…hR1p", "2,500"],
  ["1At4…kD3q", "100"],
  ["5Gh9…mP8r", "500,000"],
  ["8Lm2…vT5s", "10,000"],
  ["4Rc7…nJ6t", "50,000"],
];

function WalletChip({ logout }: { logout: () => Promise<void> }) {
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const addr = wallet.publicKey?.toBase58() ?? "";
  const shortAddr = addr ? addr.slice(0, 3) : "";
  const fullShort = addr ? addr.slice(0, 5) + "…" + addr.slice(-6) : "";

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleCopy = () => {
    if (!addr) return;
    navigator.clipboard.writeText(addr);
    toast.success("Address copied!");
    setOpen(false);
  };
  const handleChangeWallet = () => {
    setVisible(true);
    setOpen(false);
  };
  const handleProfile = () => {
    setOpen(false);
    router.push("/profile");
  };
  const handleDisconnect = async () => {
    setOpen(false);
    await wallet.disconnect();
    await logout();
  };

  return (
    <div ref={ref} className="wallet-chip-wrap">
      <button
        type="button"
        className="wallet-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="wallet-dot" aria-hidden="true" />
        <span className="wallet-addr">
          <span>{shortAddr}</span>
          <span className="wallet-dots" style={{ opacity: 0.55, marginLeft: 1 }}>
            …
          </span>
        </span>
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <path
            d="M2 4l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div className="wallet-menu" role="menu">
          <div className="wmenu-head">
            <span className="wmenu-eyebrow">Connected wallet</span>
            <span className="wmenu-full">{fullShort}</span>
          </div>
          <button className="wmenu-item" onClick={handleProfile} role="menuitem" type="button">
            <User size={14} />
            Profile
          </button>
          <button className="wmenu-item" onClick={handleCopy} role="menuitem" type="button">
            <Copy size={14} />
            Copy address
          </button>
          <button className="wmenu-item" onClick={handleChangeWallet} role="menuitem" type="button">
            <RefreshCw size={14} />
            Change wallet
          </button>
          <div className="wmenu-sep" />
          <button
            className="wmenu-item wmenu-danger"
            onClick={handleDisconnect}
            role="menuitem"
            type="button"
          >
            <LogOut size={14} />
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

export default function Navbar() {
  const pathname = usePathname();
  const { isLoggedIn, logout } = useAppContext();

  const isActive = (path: string) => (path === "/" ? pathname === "/" : pathname?.startsWith(path));

  return (
    <>
      <header className="hdr" role="banner">
        <div className="hdr-inner">
          <Link href="/" className="brand" aria-label="GetFi home">
            <Image src="/G.png" alt="" width={26} height={26} className="brand-icon" priority />
            <Image
              src="/GetFi.svg"
              alt="GetFi"
              width={88}
              height={22}
              className="brand-logo"
              priority
            />
          </Link>

          <nav className="hdr-nav" aria-label="Primary">
            {navLinks.map((link) => (
              <Link
                key={link.path}
                href={link.path}
                className={`nav-link ${isActive(link.path) ? "is-active" : ""}`}
                aria-current={isActive(link.path) ? "page" : undefined}
              >
                {link.name}
              </Link>
            ))}
          </nav>

          <div className="hdr-right">
            {isLoggedIn ? (
              <WalletChip logout={logout} />
            ) : (
              <Link href="/auth/login" className="btn btn-ink" aria-label="Sign in">
                <LogIn size={14} />
                Connect wallet
              </Link>
            )}
          </div>
        </div>

        <div className="hdr-ticker" aria-hidden="true">
          <div className="ticker-track">
            {[...tickerHits, ...tickerHits].map(([hash, amt], i) => (
              <span key={i}>
                <span className="ticker-hash">{hash}</span> — {amt} <em>$GET</em> WON
              </span>
            ))}
          </div>
        </div>
      </header>

      {/* Mobile bottom nav */}
      <nav className="bottom-nav" aria-label="Mobile primary">
        {navLinks.map((link) => {
          const Icon = link.icon;
          return (
            <Link
              key={link.path}
              href={link.path}
              className={`bn-link ${isActive(link.path) ? "is-active" : ""}`}
            >
              {Icon && <Icon size={20} />}
              <span>{link.name}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
