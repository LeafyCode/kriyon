import type { CSSProperties } from "react";
import { tokens } from "../../theme/tokens.ts";
import type { Task } from "../../types.ts";
import { ListPanel } from "./ListPanel.tsx";

/** Status glyphs, matching Claude Code's checklist idiom. */
const GLYPH: Record<Task["status"], string> = {
  completed: "☑",
  in_progress: "◔",
  pending: "○",
};

/** Glyph + text color per status: accent for active, dim for done, muted idle. */
const INK: Record<Task["status"], string> = {
  completed: tokens.color.ink.muted,
  in_progress: tokens.color.accentBright,
  pending: tokens.color.ink.muted,
};

const rowStyle: CSSProperties = {
  alignItems: "baseline",
  display: "flex",
  gap: tokens.space.sm,
};

const glyphStyle: CSSProperties = {
  fontSize: "12.5px",
  lineHeight: 1.3,
};

const textStyle: CSSProperties = {
  fontSize: "12.5px",
  lineHeight: 1.3,
};

const subLabelStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "11px",
  marginTop: "2px",
};

export function TaskRow({ task }: { task: Task }) {
  const ink = INK[task.status];
  const showActiveForm =
    task.status === "in_progress" && task.activeForm !== null;
  return (
    <div style={rowStyle}>
      <span style={{ ...glyphStyle, color: ink }}>{GLYPH[task.status]}</span>
      <div>
        <span
          style={{
            ...textStyle,
            color: ink,
            textDecoration:
              task.status === "completed" ? "line-through" : "none",
          }}
        >
          {task.text}
        </span>
        {showActiveForm ? (
          <div style={subLabelStyle}>{task.activeForm}</div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The session's checklist — one read-only row per task with a status glyph and
 * a `{completed}/{total}` progress meta. A best-effort projection of the
 * transcript's TodoWrite entries; renders in source order.
 */
export function TasksPanel({
  first,
  tasks,
}: {
  first?: boolean;
  tasks: Task[];
}) {
  const completed = tasks.filter((t) => t.status === "completed").length;
  const meta = tasks.length > 0 ? `${completed}/${tasks.length}` : undefined;

  return (
    <ListPanel
      empty="No tasks"
      first={first}
      // Positional checklist with no stable id; index is the key.
      getKey={(_task, index) => index}
      items={tasks}
      label="Tasks"
      meta={meta}
      renderItem={(task) => <TaskRow task={task} />}
    />
  );
}
