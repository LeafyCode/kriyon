import { ChevronDown, ChevronUp } from "lucide-react";
import { type CSSProperties, useState } from "react";
import { TaskRow } from "../inspector/activity/TasksPanel.tsx";
import { useSessions } from "../state/sessions.ts";
import { taskProgress } from "../state/taskProgress.ts";
import { tokens } from "../theme/tokens.ts";

/**
 * The [Task strip]: the active session's open task list, pinned between the
 * session header and the terminal so "how far along is it" never needs the
 * Inspector open. One line — count, bar, current item — that unfolds to the
 * whole list. Gone while there is no list, and once every task is done.
 */
export function TaskStrip() {
  const tasks = useSessions((state) =>
    state.activeSessionId
      ? state.activity[state.activeSessionId]?.tasks
      : undefined
  );
  const [open, setOpen] = useState(false);
  const progress = taskProgress(tasks);
  if (!(tasks && progress) || progress.finished) {
    return null;
  }
  return (
    <div data-testid="task-strip" style={stripStyle}>
      <button
        aria-expanded={open}
        aria-label={open ? "Hide tasks" : `Show all ${progress.total} tasks`}
        className="kr-focusable kr-hover-surface"
        onClick={() => setOpen((was) => !was)}
        style={lineStyle}
        type="button"
      >
        <span style={countStyle}>{progress.label}</span>
        <span
          aria-label="Tasks done"
          aria-valuemax={progress.total}
          aria-valuemin={0}
          aria-valuenow={progress.done}
          role="progressbar"
          style={barStyle}
        >
          <span
            style={{
              ...barFillStyle,
              width: `${(progress.done / progress.total) * 100}%`,
            }}
          />
        </span>
        <span style={currentStyle}>{progress.current}</span>
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      {open ? (
        <div style={listStyle}>
          {tasks.map((task, index) => (
            // Positional checklist with no stable id, as in the Inspector.
            // biome-ignore lint/suspicious/noArrayIndexKey: tasks carry no id.
            <TaskRow key={index} task={task} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const stripStyle: CSSProperties = {
  background: tokens.color.chrome.content,
  borderBottom: `1px solid ${tokens.color.line.soft}`,
  flex: "none",
};

const lineStyle: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: "none",
  color: tokens.color.ink.faint,
  cursor: "pointer",
  display: "flex",
  gap: tokens.space.md,
  height: "30px",
  padding: `0 ${tokens.space.xl}`,
  textAlign: "left",
  width: "100%",
};

const countStyle: CSSProperties = {
  color: tokens.color.ink.secondary,
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "11px",
};

const barStyle: CSSProperties = {
  background: tokens.color.surface.s3,
  borderRadius: tokens.radius.pill,
  flex: "none",
  height: "3px",
  overflow: "hidden",
  width: "64px",
};

const barFillStyle: CSSProperties = {
  background: tokens.color.accentBright,
  display: "block",
  height: "100%",
};

const currentStyle: CSSProperties = {
  color: tokens.color.ink.secondary,
  flex: 1,
  fontSize: "12px",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const listStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "6px",
  maxHeight: "40vh",
  overflowY: "auto",
  padding: `${tokens.space.xs} ${tokens.space.xl} ${tokens.space.md}`,
};
