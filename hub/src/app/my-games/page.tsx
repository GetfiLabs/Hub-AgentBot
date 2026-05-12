"use client";

import { FormEvent, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { Lock } from "lucide-react";
import { useAppContext } from "@/context/AppContext";
import { fetchRollRaiderStats, type RollRaiderStats } from "@/services/firebase";

export default function MyGames() {
  const { isLoggedIn, totalGetPoints, gameLinks, addGameLink } = useAppContext();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [playerId, setPlayerId] = useState("");
  const [mounted, setMounted] = useState(false);
  const [liveStats, setLiveStats] = useState<RollRaiderStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);

  useEffect(() => {
    // Standard SSR-safe mount flag for createPortal(document.body) — runs once.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  // Lock body scroll while the modal is open.
  useEffect(() => {
    if (!isModalOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isModalOpen]);

  // Pull canonical Roll Raider stats. Roll Raider is the source of truth for
  // currency (G) and level — Hub mirror in `game_links` is best-effort.
  useEffect(() => {
    const link = gameLinks.find((g) => g.gameId === "roll_raider");
    if (!link?.playerId) {
      setLiveStats(null);
      return;
    }
    let cancelled = false;
    setStatsError(null);
    fetchRollRaiderStats(link.playerId)
      .then((res) => {
        if (!cancelled) setLiveStats(res.data);
      })
      .catch((err) => {
        if (!cancelled) {
          setLiveStats(null);
          setStatsError(err?.message || "Failed to load live stats");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [gameLinks]);

  const handleAddGame = async (event: FormEvent) => {
    event.preventDefault();
    if (!playerId.trim()) return;
    await addGameLink("roll_raider", playerId.trim());
    setPlayerId("");
    setIsModalOpen(false);
  };

  if (!isLoggedIn) {
    return (
      <div className="app-shell page-anim" style={{ paddingTop: 48 }}>
        <div
          className="panel"
          style={{ maxWidth: 480, margin: "12vh auto", padding: 32, textAlign: "center" }}
        >
          <Lock size={36} color="var(--gold)" style={{ margin: "0 auto" }} />
          <h1 className="page-title" style={{ fontSize: 28, marginTop: 16 }}>
            Login required
          </h1>
          <p style={{ color: "var(--muted)", marginTop: 8 }}>
            Connect your GetFi account before syncing games.
          </p>
        </div>
      </div>
    );
  }

  const rrLink = gameLinks.find((g) => g.gameId === "roll_raider");
  const totalCollectedG = gameLinks.reduce((sum, g) => sum + g.inGameGetBalance, 0);

  return (
    <div className="app-shell page-anim">
      <header className="page-head">
        <div>
          <span className="eyebrow">— your library</span>
          <h2 className="page-title">My Games</h2>
        </div>
        <button className="btn btn-rust" type="button" onClick={() => setIsModalOpen(true)}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M8 3v10M3 8h10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            />
          </svg>
          Add game
        </button>
      </header>

      <section className="stats-strip">
        <div className="stat">
          <span className="stat-eyebrow">Total G earned</span>
          <span className="stat-value">
            <Image src="/G.png" alt="" width={26} height={26} className="stat-glyph" />
            {totalGetPoints.toLocaleString()}
          </span>
          <span className="stat-trend stat-trend--up">
            + {totalCollectedG.toLocaleString()} · across linked games
          </span>
        </div>
        <div className="stat">
          <span className="stat-eyebrow">Games linked</span>
          <span className="stat-value">
            {gameLinks.length} <span className="stat-unit">/ 4 in catalog</span>
          </span>
          <span className="stat-trend stat-trend--mute">
            {gameLinks.length > 0 ? "Roll Raider linked" : "—"}
          </span>
        </div>
        <div className="stat">
          <span className="stat-eyebrow">Total time played</span>
          <span className="stat-value">
            {gameLinks.length > 0 ? "—" : "0"}
            <span className="stat-unit">h</span>
          </span>
          <span className="stat-trend stat-trend--mute">across all linked titles</span>
        </div>
        <div className="stat">
          <span className="stat-eyebrow">Last sync</span>
          <span className="stat-value stat-value-sm">{rrLink ? "Just now" : "—"}</span>
          <span className="stat-trend stat-trend--mute">
            {rrLink ? `Roll Raider · Player ${rrLink.playerId}` : "Awaiting first link"}
          </span>
        </div>
      </section>

      <section className="library">
        {rrLink ? (
          <article className="lib-card">
            <div className="lib-cover lib-cover--rr">
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
            <div className="lib-body">
              <header className="lib-head">
                <h3>Roll Raider</h3>
                <span className="lib-pid">
                  Player ID · <span className="mono">{rrLink.playerId}</span>
                </span>
              </header>
              <dl className="lib-stats">
                <div>
                  <dt>G collected</dt>
                  <dd>
                    <span className="ink-num">
                      {(liveStats?.currency ?? rrLink.inGameGetBalance).toLocaleString()}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Highest level</dt>
                  <dd>
                    Floor <span className="ink-num">{liveStats?.level ?? rrLink.maxLevel}</span>
                  </dd>
                </div>
                <div>
                  <dt>High score</dt>
                  <dd>
                    <span className="ink-num">
                      {(liveStats?.maxScore ?? rrLink.highScore).toLocaleString()}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>
                    <span className="ink-num">
                      {statsError ? "stale" : liveStats ? "live" : "syncing"}
                    </span>
                  </dd>
                </div>
              </dl>
              <footer className="lib-foot">
                <span className="ts-bar" aria-hidden="true">
                  <i style={{ ["--w" as string]: "78%" } as React.CSSProperties} />
                </span>
                <span className="ts-text">Floor {rrLink.maxLevel + 1} · 78% complete</span>
              </footer>
            </div>
          </article>
        ) : (
          <article className="lib-card">
            <div className="lib-cover lib-cover--rr">
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
            <div className="lib-body">
              <header className="lib-head">
                <h3>Roll Raider</h3>
                <span className="lib-pid">Not linked yet</span>
              </header>
              <p style={{ color: "var(--muted)", fontSize: 13 }}>
                Open the game, head to Settings → Account, then add your Player ID here.
              </p>
              <footer className="lib-foot">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(true)}
                  className="btn btn-rust btn-sm"
                >
                  Link Roll Raider
                </button>
              </footer>
            </div>
          </article>
        )}

        <article className="lib-card">
          <div className="lib-cover lib-cover--soon">
            <div className="game-cover-bg" aria-hidden="true">
              <span className="placeholder-tag">key art · 4:3</span>
            </div>
            <span className="game-status game-status--beta">Closed beta</span>
          </div>
          <div className="lib-body">
            <header className="lib-head">
              <h3>Untitled · 02</h3>
              <span className="lib-pid">
                Player ID · <span className="mono">042B-11</span>
              </span>
            </header>
            <dl className="lib-stats">
              <div>
                <dt>G collected</dt>
                <dd>
                  <span className="ink-num">—</span>
                </dd>
              </div>
              <div>
                <dt>Highest level</dt>
                <dd>
                  Tier <span className="ink-num">—</span>
                </dd>
              </div>
              <div>
                <dt>High score</dt>
                <dd>—</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>Closed beta</dd>
              </div>
            </dl>
            <footer className="lib-foot">
              <span className="ts-bar" aria-hidden="true">
                <i style={{ ["--w" as string]: "42%" } as React.CSSProperties} />
              </span>
              <span className="ts-text">Tier 7 · 42% complete</span>
            </footer>
          </div>
        </article>

        <article className="lib-card lib-card--empty">
          <button type="button" className="lib-empty-btn" onClick={() => setIsModalOpen(true)}>
            <span className="le-plus" aria-hidden="true">
              +
            </span>
            <span className="le-title">Link another game</span>
            <span className="le-sub">
              Find your Player ID inside any GetFi title under Settings → Account.
            </span>
          </button>
        </article>
      </section>

      {mounted && isModalOpen
        ? createPortal(
          <div
            className="modal-scrim"
            onClick={(e) => {
              if (e.target === e.currentTarget) setIsModalOpen(false);
            }}
          >
            <form className="modal" onSubmit={handleAddGame}>
              <button
                type="button"
                className="modal-close"
                aria-label="Close"
                onClick={() => setIsModalOpen(false)}
              >
                ×
              </button>
              <span className="eyebrow">— link a game</span>
              <h3>Add a GetFi title</h3>
              <p className="modal-sub">
                Open the game, head to <em>Settings → Account</em>, copy your Player ID and paste
                below. We&apos;ll handle the rest.
              </p>
              <label className="field">
                <span className="field-label">Game</span>
                <select defaultValue="roll_raider">
                  <option value="roll_raider">Roll Raider</option>
                  <option disabled>Untitled · 02 (closed beta)</option>
                  <option disabled>Untitled · 03 (soon)</option>
                  <option disabled>Untitled · 04 (soon)</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">Player ID</span>
                <input
                  type="text"
                  value={playerId}
                  onChange={(e) => setPlayerId(e.target.value)}
                  placeholder="e.g. RR-PLAYER-0001"
                />
              </label>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setIsModalOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-rust" disabled={!playerId.trim()}>
                  Link Player ID
                </button>
              </div>
            </form>
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}
