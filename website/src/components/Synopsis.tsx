import { type CSSProperties, useCallback, useRef, useState } from "react";
import { BREW_COMMAND } from "../lib/site.ts";
import { useOnceVisible } from "../lib/useOnceVisible.ts";
import { ManSection } from "./ManSection.tsx";

export function Synopsis() {
  const ref = useRef<HTMLDivElement>(null);
  const [typing, setTyping] = useState(false);
  useOnceVisible(
    ref,
    useCallback(() => setTyping(true), [])
  );

  return (
    <ManSection id="synopsis" name="SYNOPSIS">
      <div className="synopsis">
        <div
          className="term term-lg"
          data-typing={typing}
          ref={ref}
          style={{ "--chars": BREW_COMMAND.length } as CSSProperties}
        >
          <div>
            <span className="term-prompt">$</span>{" "}
            <span className="term-type">{BREW_COMMAND}</span>
          </div>
          <div className="term-dim">==&gt; Installing Cask kriyon</div>
          <div>
            <span className="term-prompt">$</span>{" "}
            <span className="term-cmd">open -a Kriyon</span>
            <span aria-hidden="true" className="caret term-caret" />
          </div>
        </div>
        <dl className="facts">
          <dt>PLATFORM</dt>
          <dd>
            macOS 13+ · Windows: <a href="#contribute">help wanted</a>
          </dd>
          <dt>NEEDS</dt>
          <dd>claude CLI, signed in</dd>
          <dt>COST</dt>
          <dd className="tone-green">Free · your own plan</dd>
          <dt>ALSO</dt>
          <dd>
            <a href="#install">Signed .dmg</a>
          </dd>
        </dl>
      </div>
    </ManSection>
  );
}
