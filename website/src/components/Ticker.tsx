import { useState } from "react";
import { TICKER } from "../lib/demo.ts";

/**
 * The scrolling strip of demo events. The track is hidden from assistive
 * tech: it is doubled for a seamless loop, and the /what-claude-did table
 * below says the same things in order. The square on the left pauses it.
 */
export function Ticker() {
  const [paused, setPaused] = useState(false);

  return (
    <div className="ticker" data-paused={paused}>
      <button
        aria-label={
          paused ? "Play the activity ticker" : "Pause the activity ticker"
        }
        className="ticker-toggle"
        onClick={() => setPaused(!paused)}
        type="button"
      >
        <span aria-hidden="true">{paused ? "▶" : "❚❚"}</span>
      </button>
      <div className="ticker-window">
        <div aria-hidden="true" className="ticker-track">
          {[...TICKER, ...TICKER].map((e, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the list is doubled on purpose, so text repeats.
            <span className="ticker-item" key={i}>
              <span className={`tone-${e.tone}-dark`}>●</span>{" "}
              <span className="ticker-time">{e.time}</span> {e.text}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
