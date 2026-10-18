import { APP_VERSION, GITHUB_URL, LEAFYCODE_URL } from "../lib/site.ts";

const SPEC_ROWS: [string, string][] = [
  ["FORMAT", "Signed & notarized macOS DMG"],
  ["REQUIRES", "macOS 13+ · your own claude CLI"],
  ["BUNDLE / IDLE", "~7 MB / ~45 MB"],
  ["ACCOUNTS / SERVERS", "None / none"],
  ["FILE ACCESS", "Sandboxed to project roots"],
  ["WHO ANSWERS CLAUDE", "Always you, in the terminal"],
  ["THEMES", "Indigo · blue · teal · graphite"],
];

export function OpenSource() {
  return (
    <section className="open" id="open">
      <div className="open-grid">
        <div data-reveal={0}>
          <h2 className="open-title">
            Free.
            <br />
            Open.
            <br />
            <span className="gradient-text">Yours.</span>
          </h2>
          <p className="open-tagline">— small, honest, and yours to read.</p>
          <p className="open-copy">
            Kriyon is an independent open-source project by{" "}
            <a href={LEAFYCODE_URL} rel="noreferrer" target="_blank">
              Leafy Code International
            </a>
            . It never types answers for you, never stores your credentials, and
            never touches files outside your project roots. The whole thing is
            on GitHub — issues and PRs welcome.
          </p>
          <a
            className="open-cta"
            href={GITHUB_URL}
            rel="noreferrer"
            target="_blank"
          >
            READ THE SOURCE ↗
          </a>
        </div>
        <div className="spec-sheet" data-reveal={1}>
          <p className="spec-title">SPECIFICATION SHEET — {APP_VERSION}</p>
          <dl className="spec-rows">
            {SPEC_ROWS.map(([term, detail]) => (
              <div className="spec-row" key={term}>
                <dt>{term}</dt>
                <dd>{detail}</dd>
              </div>
            ))}
            <div className="spec-row">
              <dt>PRICE</dt>
              <dd className="spec-price">$0 — open source</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}
