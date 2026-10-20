import { GITHUB_URL, RELEASES_URL } from "../lib/site.ts";

export function Download() {
  return (
    <section className="download" id="download">
      <div className="download-glow" />
      <p className="download-eyebrow" data-reveal={0}>
        FINAL SCENE — YOUR NEXT SESSION STARTS CALMER
      </p>
      <h2 data-reveal={1}>
        Get <span className="gradient-text">Kriyon.</span>
      </h2>
      <div className="download-ctas" data-reveal={2}>
        <a
          className="btn-primary"
          href={RELEASES_URL}
          rel="noreferrer"
          target="_blank"
        >
          DOWNLOAD FOR MACOS ↓
        </a>
        <a
          className="btn-ghost"
          href={GITHUB_URL}
          rel="noreferrer"
          target="_blank"
        >
          VIEW SOURCE ↗
        </a>
        <span className="download-fine-print">
          SIGNED & NOTARIZED DMG · MACOS 13+
          <br />
          WINDOWS & LINUX — COMING SOON
        </span>
      </div>
    </section>
  );
}
