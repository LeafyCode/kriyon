import {
  DISCUSSIONS_URL,
  GITHUB_URL,
  GOOD_FIRST_ISSUES_URL,
  HELP_WANTED_URL,
  LEAFYCODE_NAME,
  LEAFYCODE_URL,
} from "../lib/site.ts";
import { ManSection } from "./ManSection.tsx";

const STARTS = [
  {
    n: "01",
    tone: "green",
    href: GOOD_FIRST_ISSUES_URL,
    title: "Good first issues",
    text: "Small, well-scoped and labelled. A good way to learn the codebase.",
  },
  {
    n: "02",
    tone: "amber",
    href: HELP_WANTED_URL,
    title: "Help bring it to Windows",
    text: "Mac only for now. Tauri runs on Windows; the terminal and process layer need hands.",
  },
  {
    n: "03",
    tone: "blue",
    href: DISCUSSIONS_URL,
    title: "Ideas and questions",
    text: "Talk it through in Discussions before a big change. Read CONTRIBUTING.md first.",
  },
] as const;

export function Contribute() {
  return (
    <ManSection id="contribute">
      <div className="split split-end">
        <div className="split-text">
          <h3 className="slash-title">/contribute</h3>
          <p className="lede">
            Kriyon is built in the open by{" "}
            <a href={LEAFYCODE_URL} rel="noreferrer" target="_blank">
              {LEAFYCODE_NAME}
            </a>{" "}
            in Sri Lanka, and it gets better with every pull request. Fix a bug,
            write a test, sharpen the docs, or help bring it to Windows.
          </p>
        </div>
        <div className="term">
          <div>
            <span className="term-prompt">$</span>{" "}
            <span className="term-cmd">git clone {GITHUB_URL}.git</span>
          </div>
          <div>
            <span className="term-prompt">$</span>{" "}
            <span className="term-cmd">cd kriyon &amp;&amp; pnpm install</span>
          </div>
          <div>
            <span className="term-prompt">$</span>{" "}
            <span className="term-cmd">node scripts/sidecar-ptyd.mjs</span>{" "}
            <span className="term-dim"># builds the terminal daemon</span>
          </div>
          <div>
            <span className="term-prompt">$</span>{" "}
            <span className="term-cmd">pnpm check</span>{" "}
            <span className="term-dim"># lint, types, every test</span>
          </div>
        </div>
      </div>
      <div className="starts">
        {STARTS.map((s) => (
          <a
            className={`start start-${s.tone}`}
            href={s.href}
            key={s.n}
            rel="noreferrer"
            target="_blank"
          >
            <span className={`label tone-${s.tone}`}>START.{s.n}</span>
            <span className="start-title">{s.title}</span>
            <span className="start-text">{s.text}</span>
          </a>
        ))}
      </div>
    </ManSection>
  );
}
