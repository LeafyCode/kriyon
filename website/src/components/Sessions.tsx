import { Fragment, useState } from "react";
import { SESSIONS, type SessionState } from "../lib/demo.ts";
import { ManSection } from "./ManSection.tsx";

const TONE: Record<SessionState, string> = {
  WORKING: "green",
  "NEEDS YOU": "amber",
  DONE: "muted",
};

function projectCount(): number {
  return new Set(SESSIONS.map((s) => s.project)).size;
}

/** The demo row the board opens on: the one waiting on you. */
const FIRST_PICK = SESSIONS.findIndex((s) => s.state === "NEEDS YOU");

export function Sessions() {
  const [picked, setPicked] = useState(FIRST_PICK);

  return (
    <ManSection id="sessions">
      <div className="split">
        <div className="split-text">
          <h3 className="slash-title">/status</h3>
          <p className="lede">
            Ten sessions across five projects is a normal day. Kriyon groups
            them by project, shows which one needs you and how far each one's
            task list has got, and keeps each session's record apart. A session
            can start another for parallel work; it is listed under the one that
            asked, and starts on its own only when you asked for it.
          </p>
          <p className="lede">
            When one is waiting on a permission, you answer it in that session's
            own terminal. Kriyon points you there and never answers for you.
          </p>
        </div>
        <div className="status-board">
          <div className="status-head">
            <span>SYSTEM STATUS</span>
            <span>
              {SESSIONS.length} SESSIONS · {projectCount()} PROJECTS
            </span>
          </div>
          <fieldset className="status-rows">
            <legend className="sr-only">Demo sessions</legend>
            {SESSIONS.map((s, i) => (
              <Fragment key={s.name}>
                {i === 0 || SESSIONS[i - 1]?.project !== s.project ? (
                  <div aria-hidden="true" className="status-project">
                    {s.project}
                  </div>
                ) : null}
                <button
                  aria-pressed={i === picked}
                  className="status-row"
                  data-nested={s.nested === true}
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
                  {s.tasks ? (
                    <span className="status-tasks">TASKS {s.tasks}</span>
                  ) : null}
                  <span className={`status-state tone-${TONE[s.state]}`}>
                    {s.state}
                  </span>
                </button>
              </Fragment>
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
