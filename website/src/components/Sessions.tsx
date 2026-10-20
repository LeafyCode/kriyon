import { useState } from "react";
import { SESSIONS, type SessionState } from "../lib/demo.ts";
import { ManSection } from "./ManSection.tsx";

const TONE: Record<SessionState, string> = {
  WORKING: "green",
  "NEEDS YOU": "amber",
  DONE: "muted",
};

export function Sessions() {
  const [picked, setPicked] = useState(1);

  return (
    <ManSection id="sessions" name="SESSIONS">
      <div className="split">
        <div className="split-text">
          <h3 className="slash-title">/status</h3>
          <p className="lede">
            Ten sessions across five projects is a normal day. Kriyon shows
            which one needs you, from the window or the menu bar, and keeps each
            session's record apart.
          </p>
        </div>
        <div className="status-board">
          <div className="status-head">
            <span>SYSTEM STATUS</span>
            <span>3 SESSIONS · 2 PROJECTS</span>
          </div>
          <fieldset className="status-rows">
            <legend className="sr-only">Demo sessions</legend>
            {SESSIONS.map((s, i) => (
              <button
                aria-pressed={i === picked}
                className="status-row"
                key={s.name}
                onClick={() => setPicked(i)}
                type="button"
              >
                <span
                  aria-hidden="true"
                  className={[
                    "status-dot",
                    `tone-bg-${TONE[s.state]}`,
                    s.state === "WORKING" && "pulse-dot",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                />
                <span className="status-name">{s.name}</span>
                <span className={`status-state tone-${TONE[s.state]}`}>
                  {s.state}
                </span>
              </button>
            ))}
          </fieldset>
          <output className="status-last">
            LAST ›{" "}
            <span
              className={
                SESSIONS[picked].state === "NEEDS YOU" ? "tone-amber-dark" : ""
              }
            >
              {SESSIONS[picked].last}
            </span>
          </output>
        </div>
      </div>
    </ManSection>
  );
}
