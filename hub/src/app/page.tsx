"use client";

import Link from "next/link";
import Image from "next/image";
import { useAppContext } from "@/context/AppContext";

export default function Home() {
  const { gameLinks } = useAppContext();
  const linkedCount = gameLinks.length;

  return (
    <div className="app-shell page-anim">
      <article className="hero">
        <div className="hero-eyebrow">
          <span className="ey-dot" />
          The GetFi player portal
        </div>
        <h1 className="hero-title">
          Turn the <em>G</em> you collect across
          <br />
          the GetFi games into <span className="rust">$GET</span>.
        </h1>
        <p className="hero-sub">
          The official portal for the GetFi ecosystem. Your Gs are your gaming loyalty points.
          Convert them into on-chain $GET tokens to interact with our digital marketplace and future
          titles. Transparent, secure, and built strictly to enhance your gameplay.
        </p>
        <div className="hero-actions">
          <Link href="/earn" className="btn btn-rust">
            Open the Vault
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                d="M3 8h10M9 4l4 4-4 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
          <Link href="/my-games" className="btn btn-ghost">
            Link a game
          </Link>
        </div>

        <ul className="hero-meta">
          <li>
            <span className="hm-num">1</span>
            <span className="hm-lbl">live title</span>
          </li>
          <li>
            <span className="hm-num">3</span>
            <span className="hm-lbl">in production</span>
          </li>
          <li>
            <span className="hm-num">10</span>
            <span className="hm-lbl">prize tiers</span>
          </li>
          <li>
            <span className="hm-num">∞</span>
            <span className="hm-lbl">marketplace soon</span>
          </li>
        </ul>
      </article>

      <section className="games-section">
        <header className="section-head">
          <div>
            <span className="eyebrow">— our games</span>
            <h2 className="section-title">
              A small catalog. <em>Made carefully.</em>
            </h2>
          </div>
          <p className="section-blurb">
            Every title in this catalog earns G. As the studio ships more, this page becomes the
            GetFi marketplace — for now it is intentionally short.
          </p>
        </header>

        <div className="games-grid">
          <Link href="/my-games" className="game-card game-card--live" aria-label="Roll Raider">
            <div className="game-cover game-cover--rr">
              <Image
                src="/rr-cover.png"
                alt="Roll Raider"
                fill
                style={{ objectFit: "cover", objectPosition: "center top" }}
                priority
              />
              <span className="game-status game-status--live">
                <span className="live-dot" />
                Live
              </span>
            </div>
            <div className="game-meta">
              <div className="game-titles">
                <h3>Roll Raider</h3>
                <span className="game-genre">Dice-rogue · iOS · Android · PWA</span>
              </div>
              <div className="game-stat">
                <span className="gs-num">{linkedCount > 0 ? "you · in" : "14.2k"}</span>
                <span className="gs-lbl">players linked</span>
              </div>
            </div>
          </Link>

          {[
            { title: "Untitled · 02", genre: "Idle craft · in production", stat: "Q3 — beta wave" },
            {
              title: "Untitled · 03",
              genre: "Tactics · in production",
              stat: "Q4 — closed playtest",
            },
            { title: "Untitled · 04", genre: "Arcade · in production", stat: "Early 2027" },
          ].map((g) => (
            <article key={g.title} className="game-card game-card--soon">
              <div className="game-cover game-cover--soon">
                <div className="game-cover-bg" aria-hidden="true">
                  <span className="placeholder-tag">title · soon</span>
                </div>
                <span className="game-status game-status--soon">Soon</span>
              </div>
              <div className="game-meta">
                <div className="game-titles">
                  <h3>{g.title}</h3>
                  <span className="game-genre">{g.genre}</span>
                </div>
                <div className="game-stat-soon">{g.stat}</div>
              </div>
            </article>
          ))}
        </div>

        <footer className="section-foot">
          <span className="ssm-num">04</span>
          <span className="ssm-rule" />
          <span className="ssm-text">
            titles in the catalog · marketplace expansion planned 2027
          </span>
        </footer>
      </section>
    </div>
  );
}
