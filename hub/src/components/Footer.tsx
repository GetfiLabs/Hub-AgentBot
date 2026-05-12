import Link from "next/link";
import { Vault } from "lucide-react";
import { ROUTES } from "@/constants";

const footerLinks = [
  {
    title: "Product",
    links: [
      { name: "Dashboard", href: ROUTES.DASHBOARD },
      { name: "Earn", href: ROUTES.EARN },
      { name: "My Games", href: ROUTES.MY_GAMES },
      { name: "Wallet", href: ROUTES.WALLET },
    ],
  },
  {
    title: "Resources",
    links: [
      { name: "How It Works", href: "/#how-it-works" },
      { name: "Features", href: "/#features" },
      { name: "FAQ", href: "/#faq" },
    ],
  },
  {
    title: "Legal",
    links: [
      { name: "Privacy Policy", href: "/privacy" },
      { name: "Terms of Service", href: "/terms" },
      { name: "Cookie Policy", href: "/cookies" },
    ],
  },
];

export default function Footer() {
  return (
    <footer
      role="contentinfo"
      className="relative border-t"
      style={{
        background: "linear-gradient(180deg, transparent, rgba(5,7,13,0.8) 40%, rgba(5,7,13,0.95))",
        borderColor: "color-mix(in srgb, var(--line) 35%, transparent)",
      }}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[var(--cyan)]/40 to-transparent" />
      <div className="app-shell py-12 md:py-16">
        <div className="grid gap-10 md:grid-cols-[1.5fr_1fr_1fr_1fr]">
          <div>
            <Link href="/" className="flex items-center gap-3" aria-label="GetFi Hub home">
              <div
                className="grid h-9 w-9 place-items-center rounded-xl border border-cyan-300/35"
                style={{
                  background:
                    "linear-gradient(135deg, rgba(61,231,255,0.18), rgba(180,139,255,0.12))",
                  boxShadow: "0 0 24px -6px var(--cyan-glow)",
                }}
              >
                <Vault className="h-5 w-5 text-[var(--cyan)]" />
              </div>
              <div className="leading-tight">
                <div className="text-base font-black tracking-tight text-heading">
                  Get<span className="text-gradient">Fi</span> Hub
                </div>
                <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[var(--muted)]">
                  Game · Yield · Console
                </div>
              </div>
            </Link>
            <p className="mt-4 max-w-xs text-sm leading-6 text-[var(--muted)]">
              Turn your game progress into verifiable blockchain rewards. Powered by Solana, an
              on-chain commit-reveal RNG, and Token-2022 infrastructure.
            </p>
          </div>

          {footerLinks.map((group) => (
            <div key={group.title}>
              <h3 className="text-sm font-black uppercase tracking-wide text-heading">
                {group.title}
              </h3>
              <nav aria-label={group.title}>
                <ul className="mt-4 space-y-3">
                  {group.links.map((link) => (
                    <li key={link.name}>
                      <Link
                        href={link.href}
                        className="text-sm text-[var(--muted)] transition-colors hover:text-[var(--cyan)]"
                      >
                        {link.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            </div>
          ))}
        </div>

        <div
          className="mt-12 flex flex-col items-center justify-between gap-4 border-t pt-8 md:flex-row"
          style={{ borderColor: "color-mix(in srgb, var(--line) 30%, transparent)" }}
        >
          <p className="text-sm text-[var(--muted)]">
            &copy; {new Date().getFullYear()} GetFi Hub. All rights reserved.
          </p>
          <div className="flex items-center gap-6">
            <a
              href="https://x.com/getfi"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-[var(--muted)] transition hover:text-heading"
              aria-label="GetFi on X (Twitter)"
            >
              X / Twitter
            </a>
            <a
              href="https://discord.gg/getfi"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-[var(--muted)] transition hover:text-heading"
              aria-label="GetFi Discord server"
            >
              Discord
            </a>
            <a
              href="https://github.com/getfi"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-[var(--muted)] transition hover:text-heading"
              aria-label="GetFi on GitHub"
            >
              GitHub
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
