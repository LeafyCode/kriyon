import { STACK } from "../lib/demo.ts";
import { GITHUB_URL } from "../lib/site.ts";
import { ManSection } from "./ManSection.tsx";

export function Source() {
  return (
    <ManSection id="source">
      <div className="man-head">
        <h3 className="slash-title">/source</h3>
        <a
          className="mono-link"
          href={GITHUB_URL}
          rel="noreferrer"
          target="_blank"
        >
          GITHUB.COM/LEAFYCODE/KRIYON ↗
        </a>
      </div>
      <div className="stack">
        {STACK.map((col) => (
          <div className="stack-col" key={col.head}>
            <h4 className={`stack-head tone-${col.tone}`}>{col.head}</h4>
            <ul>
              {col.items.map((item) => (
                <li className="stack-item" key={item}>
                  <span>{item}</span>
                  <span aria-hidden="true" className={`tone-${col.tone}`}>
                    ●
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="see-also">
        SEE ALSO · claude(1), git(1), git-worktree(1), brew(1)
      </p>
    </ManSection>
  );
}
