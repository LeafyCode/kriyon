import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "../lib/motion.ts";
import { formatSecs, pad } from "../lib/time.ts";
import { useIsVisible } from "../lib/useIsVisible.ts";

type RowStatus = "needs" | "running" | "done";

interface Row {
  project: string;
  /** Elapsed wait in seconds; null renders LIVE (running) or — (done). */
  secs: number | null;
  status: RowStatus;
  task: string;
}

const INITIAL_ROWS: Row[] = [
  {
    task: "APPROVE DB MIGRATION PLAN",
    project: "atlas-api",
    status: "needs",
    secs: 252,
  },
  {
    task: "CHOOSE ONBOARDING EMPTY STATE",
    project: "orbit-web",
    status: "needs",
    secs: 700,
  },
  {
    task: "BUILD COMMAND PALETTE",
    project: "orbit-web",
    status: "running",
    secs: null,
  },
  {
    task: "ADD OFFLINE RETRY POLICY",
    project: "pulse-mobile",
    status: "running",
    secs: null,
  },
  {
    task: "REFRESH API REFERENCE DOCS",
    project: "docs-site",
    status: "done",
    secs: null,
  },
];

/* The two rows the flip loop animates, by position in INITIAL_ROWS. */
const ROW_DB_PLAN = 0;
const ROW_OFFLINE_RETRY = 3;

const STATUS_LABEL: Record<RowStatus, string> = {
  needs: "NEEDS YOU",
  running: "RUNNING",
  done: "DONE",
};

const FLIP_MS = 170;
const LOOP_MS = 4200;
const TICK_MS = 1000;
/* A row left on screen all afternoon must not tick past a plausible wait. */
const MAX_WAIT_SECS = 59 * 60 + 59;

/** Status chip that flips (rotateX) whenever the target status changes. */
function StatusChip({ status }: { status: RowStatus }) {
  const [shown, setShown] = useState(status);
  const [flipping, setFlipping] = useState(false);

  useEffect(() => {
    if (status === shown) {
      return;
    }
    setFlipping(true);
    const timer = setTimeout(() => {
      setShown(status);
      setFlipping(false);
    }, FLIP_MS);
    return () => clearTimeout(timer);
  }, [status, shown]);

  return (
    <span
      className={`board-status board-status-${shown}`}
      style={{ transform: flipping ? "rotateX(88deg)" : "rotateX(0)" }}
    >
      {STATUS_LABEL[shown]}
    </span>
  );
}

function RowDot({ status }: { status: RowStatus }) {
  if (status === "done") {
    return <span className="board-dot-done" />;
  }
  return (
    <span className="board-dot-wrap">
      <span className={`board-dot board-dot-${status}`} />
      {status === "needs" && <span className="board-halo" />}
    </span>
  );
}

function rowTime(row: Row) {
  if (row.secs !== null) {
    return formatSecs(row.secs);
  }
  return row.status === "done" ? "—" : "LIVE";
}

/**
 * The command-center mock. The clock and wait timers tick every second while
 * the board is on screen; sessions also flip between NEEDS YOU and RUNNING on a
 * 4.2s loop unless the visitor asked for reduced motion.
 *
 * The clock seeds from a constant, not `new Date()`, so the server render and
 * the first client render agree — the first tick only happens once visible.
 */
export function Board() {
  const [rows, setRows] = useState(INITIAL_ROWS);
  const [clock, setClock] = useState("00:00:00");
  const figureRef = useRef<HTMLElement>(null);
  const visible = useIsVisible(figureRef);
  const reducedMotion = useReducedMotion();

  // The rest of the page shouldn't re-render every second for an unseen mock.
  useEffect(() => {
    if (!visible) {
      return;
    }
    const tick = () => {
      const now = new Date();
      setClock(
        `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
      );
      setRows((prev) =>
        prev.map((row) =>
          row.secs === null
            ? row
            : { ...row, secs: Math.min(row.secs + 1, MAX_WAIT_SECS) }
        )
      );
    };
    tick();
    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
  }, [visible]);

  useEffect(() => {
    if (!visible || reducedMotion) {
      return;
    }
    const setRow = (index: number, status: RowStatus, secs: number | null) => {
      setRows((prev) =>
        prev.map((row, i) => (i === index ? { ...row, status, secs } : row))
      );
    };
    let step = 0;
    const timer = setInterval(() => {
      step = (step + 1) % 4;
      if (step === 1) {
        setRow(ROW_OFFLINE_RETRY, "needs", 0);
      }
      if (step === 2) {
        setRow(ROW_DB_PLAN, "running", null);
      }
      if (step === 3) {
        setRow(ROW_OFFLINE_RETRY, "running", null);
        setRow(ROW_DB_PLAN, "needs", 0);
      }
    }, LOOP_MS);
    return () => clearInterval(timer);
  }, [visible, reducedMotion]);

  const needsCount = rows.filter((row) => row.status === "needs").length;

  return (
    <section className="board" id="board">
      <div className="board-grid">
        <div>
          <p className="eyebrow board-eyebrow" data-reveal={0}>
            THE BOARD · NEEDS YOU
          </p>
          <h2 data-reveal={1}>
            Know the moment you're needed.{" "}
            <span className="serif-italic">And only then.</span>
          </h2>
          <p className="scene-split-copy" data-reveal={2}>
            Every session waiting on you gathers at the top: a question, a
            permission, a plan to approve. Kriyon reconstructs the real ask,
            confirms the session is actually blocked, and withdraws the alert
            the moment it goes back to work. No phantom counts. No stale
            prompts.
          </p>
          <p className="scene-meta" data-reveal={3}>
            ⌘⇧K FROM ANYWHERE · NOTIFICATIONS THAT RETRACT · HONEST "UNKNOWN"
          </p>
        </div>
        <figure className="board-figure" data-reveal={1} ref={figureRef}>
          <div className="board-glow" />
          {/* decorative live mock — the copy and figcaption carry the message */}
          <div aria-hidden className="board-panel">
            <div className="board-header">
              <span className="board-header-title">
                {"KRIYON // COMMAND CENTER"}
              </span>
              <span className="board-header-count">NEEDS YOU {needsCount}</span>
              <span className="board-header-clock">{clock}</span>
            </div>
            <div className="board-rows">
              {rows.map((row) => (
                <div
                  className={
                    row.status === "done"
                      ? "board-row board-row-done"
                      : "board-row"
                  }
                  key={row.task}
                >
                  <RowDot status={row.status} />
                  <span className="board-task">
                    {row.task} <span>/ {row.project}</span>
                  </span>
                  <span className="board-time">{rowTime(row)}</span>
                  <StatusChip status={row.status} />
                </div>
              ))}
            </div>
          </div>
          <figcaption className="board-caption">
            STATES FLIP LIVE · ALERTS RETRACT THEMSELVES
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
