import { sectionLabel } from "../lib/sections.ts";
import { GITHUB_URL } from "../lib/site.ts";
import { LeafyCredit } from "./LeafyCredit.tsx";

/** The headline, as one sentence for tests and the page title to share. */
export const HEADLINE = "Run them all. Watch one screen.";

export function Hero() {
  return (
    <header className="hero" id="top">
      <div className="hero-inner" id="name">
        <div className="hero-meta">
          <span>
            § {sectionLabel("name")} — KRIYON(1) · OPEN SOURCE ·{" "}
            <span className="tone-amber">MADE IN SRI LANKA</span>
          </span>
          <LeafyCredit />
        </div>

        <h1 className="hero-title">
          <span className="rise">
            <span className="hero-title-lead">Run them all.</span>
          </span>{" "}
          <span className="rise">
            <span className="hero-title-second tone-blue">
              Watch one screen.
              <span aria-hidden="true" className="caret" />
            </span>
          </span>
        </h1>

        <div className="hero-body">
          <figure className="diff-card">
            <figcaption className="diff-card-head">
              <span>$ diff terminal-tabs kriyon</span>
              <span>5 LINES</span>
            </figcaption>
            <div className="diff-card-lines">
              <p className="diff-line diff-out">
                <span className="diff-sign">−</span>
                <s>a tab per session, and no idea which one needs you</s>
              </p>
              <p className="diff-line">
                <span className="diff-sign">+</span>every session, every
                project, in one window
              </p>
              <p className="diff-line">
                <span className="diff-sign">+</span>the one waiting on you, at
                the top, with what it is asking
              </p>
              <p className="diff-line">
                <span className="diff-sign">+</span>a diff and a record of what
                each one did <span className="tag-new">NEW</span>
              </p>
              <p className="diff-line">
                <span className="diff-sign">+</span>your own <b>claude</b> CLI,
                unchanged: every tool, every flag
              </p>
            </div>
          </figure>

          <div className="hero-aside">
            <p className="lede">
              <b>The desktop home for Claude Code.</b> Run sessions across all
              your projects in one window. Kriyon shows which one needs you and
              what each one changed, and leaves the <code>claude</code> you
              already use exactly as it is.
            </p>
            <div className="cta-row">
              <a className="btn-download" href="#install">
                <span aria-hidden="true" className="btn-download-icon">
                  ↓
                </span>
                <span className="btn-download-label">DOWNLOAD FOR MAC</span>
              </a>
              <a
                className="btn-outline"
                href={GITHUB_URL}
                rel="noreferrer"
                target="_blank"
              >
                ★ STAR ON GITHUB
              </a>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
