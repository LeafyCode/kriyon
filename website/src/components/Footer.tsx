import {
  APP_VERSION,
  CHANGELOG_URL,
  GITHUB_URL,
  ISSUES_URL,
  LEAFYCODE_URL,
} from "../lib/site.ts";

const DISCLAIMER =
  "Kriyon is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC. Kriyon runs your own, unmodified Claude Code install; you sign in through Anthropic's own flow and your use is governed by your agreement with Anthropic.";

/**
 * Rendered as a sibling of `<main>`, never inside it: a `<footer>` only maps to
 * the `contentinfo` landmark when its nearest sectioning ancestor is `<body>`.
 */
export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <span className="footer-brand">
          <img
            alt=""
            height={18}
            loading="lazy"
            src="/logo-purple.svg"
            width={16}
          />{" "}
          KRIYON {APP_VERSION} — BUILT IN THE OPEN BY{" "}
          <a
            className="footer-credit"
            href={LEAFYCODE_URL}
            rel="noreferrer"
            target="_blank"
          >
            LEAFY CODE INTERNATIONAL
          </a>
        </span>
        <a href={GITHUB_URL} rel="noreferrer" target="_blank">
          GITHUB
        </a>
        <a href={CHANGELOG_URL} rel="noreferrer" target="_blank">
          CHANGELOG
        </a>
        <a href={ISSUES_URL} rel="noreferrer" target="_blank">
          ISSUES
        </a>
        <p className="footer-legal">{DISCLAIMER}</p>
      </div>
    </footer>
  );
}
