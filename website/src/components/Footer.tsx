import {
  APP_VERSION,
  CHANGELOG_URL,
  GITHUB_URL,
  ISSUES_URL,
  LEAFYCODE,
  LEAFYCODE_NAME,
  LEAFYCODE_URL,
} from "../lib/site.ts";
import { LeafyMark } from "./LeafyCredit.tsx";

const DISCLAIMER =
  "Kriyon is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC. Kriyon runs your own, unmodified Claude Code install; you sign in through Anthropic's own flow and your use is governed by your agreement with Anthropic.";

/**
 * Rendered as a sibling of `<main>`, never inside it: a `<footer>` only maps to
 * the `contentinfo` landmark when its nearest sectioning ancestor is `<body>`.
 */
export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-bar">
        <span className="footer-cell">
          Kriyon {APP_VERSION.replace("v", "")}
        </span>
        <span className="footer-cell footer-mid">
          <LeafyMark className="footer-mark" />A{" "}
          <a href={LEAFYCODE_URL} rel="noreferrer" target="_blank">
            {LEAFYCODE_NAME.toUpperCase()}
          </a>{" "}
          PROJECT · MADE IN SRI LANKA
        </span>
        <span className="footer-cell footer-end">KRIYON(1)</span>
      </div>
      <div className="footer-fine">
        <nav aria-label="Project links" className="footer-links">
          <a href={GITHUB_URL} rel="noreferrer" target="_blank">
            GITHUB
          </a>
          <a href={CHANGELOG_URL} rel="noreferrer" target="_blank">
            CHANGELOG
          </a>
          <a href={ISSUES_URL} rel="noreferrer" target="_blank">
            ISSUES
          </a>
          <a href={`mailto:${LEAFYCODE.email}`}>
            {LEAFYCODE.email.toUpperCase()}
          </a>
        </nav>
        <p className="footer-legal">{DISCLAIMER}</p>
      </div>
    </footer>
  );
}
