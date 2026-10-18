import { useState } from "react";
import { GITHUB_URL } from "../lib/site.ts";
import { ShotImage } from "./ShotImage.tsx";

const TICKER_ITEMS = [
  <span className="ticker-amber" key="needs">
    ● NEEDS YOU: 2
  </span>,
  <span key="running">RUNNING: 3</span>,
  <span key="diff">
    <span className="diff-add">+226</span> <span className="diff-del">−31</span>{" "}
    ACROSS 4 FILES
  </span>,
  <span key="tests">38 TESTS PASSED</span>,
  <span key="merged">FEAT/OFFLINE-RETRY → MERGED</span>,
  <span key="context">CONTEXT 36%</span>,
  <span key="survive">SESSIONS SURVIVE CRASHES</span>,
  <span className="ticker-lav" key="chord">
    ⌘⇧K FROM ANYWHERE
  </span>,
  <span key="truth">THE TERMINAL IS THE TRUTH</span>,
];

function heroDelay(index: number) {
  return { animationDelay: `${index * 100}ms` };
}

export function Hero() {
  return (
    <header className="hero" id="top">
      <div className="hero-grid">
        <div className="hero-copy">
          <p className="hero-eyebrow" data-hero style={heroDelay(0)}>
            <span className="pulse-dot" />
            OPEN SOURCE · A MAC APP FOR THE claude CLI
          </p>
          <h1 className="hero-title">
            <span data-hero style={heroDelay(1)}>
              Run ten
            </span>
            <span
              className="hero-title-gradient gradient-text"
              data-hero
              style={heroDelay(2)}
            >
              Claude Code
            </span>
            <span data-hero style={heroDelay(3)}>
              sessions.
            </span>
            <span className="hero-title-serif" data-hero style={heroDelay(4)}>
              stay one person.
            </span>
          </h1>
          <p className="hero-lede" data-hero style={heroDelay(5)}>
            Kriyon wraps your own <span className="inline-code">claude</span>{" "}
            command line in a calm, cinematic window. Run many sessions across
            projects, see exactly what each one changed, and know the moment one
            needs you.
          </p>
          <p className="hero-usage" data-hero style={heroDelay(6)}>
            All sessions use your own Claude plan and its usage limits.
          </p>
          <div className="hero-ctas" data-hero style={heroDelay(7)}>
            <a className="btn-primary" href="#download">
              DOWNLOAD FOR MACOS ↓
            </a>
            <a
              className="btn-ghost"
              href={GITHUB_URL}
              rel="noreferrer"
              target="_blank"
            >
              ★ STAR ON GITHUB
            </a>
          </div>
          <p className="hero-fine-print" data-hero style={heroDelay(8)}>
            FREE · USES YOUR OWN AUTHENTICATED CLI · NOTHING TO SIGN INTO
          </p>
        </div>
        <div className="hero-visual hero-visual-in">
          <div className="hero-shot">
            {/* The LCP element. `sizes` is inflated past the 46% grid column
                because `.hero-shot` is scaled 1.12x — the painted box is wider
                than the layout box, and the browser picks its rung from this. */}
            <ShotImage
              alt="Kriyon — a live Claude Code session"
              fetchPriority="high"
              lazy={false}
              name="02-live-session"
              sizes="(max-width: 880px) 100vw, 62vw"
            />
          </div>
          <div className="hero-chip hero-chip-top">
            <span>
              <span className="chip-dot" />
              NEEDS YOU — plan approval · 4m
            </span>
          </div>
          <div className="hero-chip hero-chip-bottom">
            <span>
              <span className="diff-add">✓</span> 38 tests passed ·{" "}
              <span className="diff-add">+226</span>{" "}
              <span className="diff-del">−31</span>
            </span>
          </div>
        </div>
      </div>
      <Ticker />
    </header>
  );
}

/**
 * The scrolling status strip. WCAG 2.2.2 wants a pause mechanism reachable by
 * everyone, not just a mouse — hovering pauses it too, but the button is what
 * makes it keyboard- and touch-operable. The strip itself is decorative
 * (`aria-hidden`): every claim in it is made in prose elsewhere on the page.
 */
function Ticker() {
  const [paused, setPaused] = useState(false);

  return (
    <div className="ticker">
      <div
        aria-hidden
        className="ticker-track"
        data-paused={paused ? "" : undefined}
      >
        <div className="ticker-group">{TICKER_ITEMS}</div>
        <div className="ticker-group">{TICKER_ITEMS}</div>
      </div>
      <button
        className="ticker-pause"
        onClick={() => setPaused((on) => !on)}
        type="button"
      >
        {paused ? "▶ PLAY" : "❚❚ PAUSE"}
      </button>
    </div>
  );
}
