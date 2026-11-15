/**
 * A paired computer's session read as entries ([Readable view]): the
 * prompts, Claude's text, its steps and reports, and a question showing,
 * which is answered only in the terminal. The terminal stays the source of
 * truth; this is a lighter way to follow along.
 */
import { type CSSProperties, useEffect, useRef } from "react";
import { button } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { Markdown } from "../ui/Markdown.tsx";
import type { ReadableSummary, ShownEntry } from "./readableSummary.ts";

export function RemoteReadable({
  onTerminal,
  summary,
}: {
  /** Show the terminal instead: where a question is answered. */
  onTerminal: () => void;
  summary: ReadableSummary | undefined;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // Follow the newest entry, as the terminal does, unless the person
  // scrolled up to read.
  const following = useRef(true);
  useEffect(() => {
    const list = listRef.current;
    if (list && summary && following.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, [summary]);

  if (summary === undefined) {
    return <p style={quietStyle}>Loading the session…</p>;
  }
  if (summary.entries.length === 0) {
    return <p style={quietStyle}>Nothing in this session yet.</p>;
  }
  return (
    <div
      onScroll={(event) => {
        following.current = atBottom(event.currentTarget);
      }}
      ref={listRef}
      style={listStyle}
    >
      {summary.entries.map((entry) => (
        <Entry entry={entry} key={entry.seq} onTerminal={onTerminal} />
      ))}
    </div>
  );
}

/** How near the bottom still counts as at it, in pixels. */
const BOTTOM_SLACK = 8;

/** Whether a scrolled list shows its end. */
export function atBottom(list: {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}): boolean {
  return list.scrollHeight - list.scrollTop - list.clientHeight <= BOTTOM_SLACK;
}

function Entry({
  entry,
  onTerminal,
}: {
  entry: ShownEntry;
  onTerminal: () => void;
}) {
  switch (entry.kind) {
    case "you":
      return <div style={youStyle}>{entry.text}</div>;
    case "claude":
      return (
        <div style={claudeStyle}>
          <Markdown text={entry.text} />
          {entry.done ? null : <span style={quietStyle}>Writing…</span>}
        </div>
      );
    case "step":
      return (
        <div style={stepStyle}>
          <span style={stepNameStyle}>{entry.name}</span>
          <span style={stepTargetStyle}>{entry.target}</span>
          {entry.state === "done" ? null : (
            <span style={entry.state === "failed" ? failedStyle : runningStyle}>
              {entry.state === "failed" ? "Failed" : "Running"}
            </span>
          )}
        </div>
      );
    case "report":
      return (
        <div style={stepStyle}>
          <span style={stepTargetStyle}>{entry.summary}</span>
          <span style={quietStyle}>{entry.outcome}</span>
        </div>
      );
    case "asking":
      return (
        <div style={askingStyle}>
          {entry.header ? (
            <span style={askHeaderStyle}>{entry.header}</span>
          ) : null}
          <span>{entry.question}</span>
          {entry.options.length > 0 ? (
            <ul style={optionsStyle}>
              {entry.options.map((option) => (
                <li key={option}>{option}</li>
              ))}
            </ul>
          ) : null}
          <div>
            <button
              className="kr-hover-surface"
              onClick={onTerminal}
              style={button("secondary", "sm")}
              type="button"
            >
              Answer in the terminal
            </button>
          </div>
        </div>
      );
    default:
      return <div style={noteStyle}>{entry.text}</div>;
  }
}

const listStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  gap: tokens.space.md,
  minHeight: 0,
  overflowY: "auto",
  padding: tokens.space.lg,
};

const quietStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  fontSize: "12px",
  margin: 0,
};

const youStyle: CSSProperties = {
  alignSelf: "flex-end",
  background: tokens.color.surface.active,
  borderRadius: tokens.radius.lg,
  color: tokens.color.ink.primary,
  fontSize: "13px",
  maxWidth: "80%",
  padding: `${tokens.space.sm} ${tokens.space.md}`,
  whiteSpace: "pre-wrap",
};

const claudeStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.xs,
};

const stepStyle: CSSProperties = {
  alignItems: "baseline",
  color: tokens.color.ink.secondary,
  display: "flex",
  fontSize: "12px",
  gap: tokens.space.sm,
  minWidth: 0,
};

const stepNameStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  flex: "none",
  fontFamily: tokens.font.mono,
};

const stepTargetStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const runningStyle: CSSProperties = {
  color: tokens.color.status.runningInk,
  flex: "none",
};

const failedStyle: CSSProperties = {
  color: tokens.color.status.error,
  flex: "none",
};

const askingStyle: CSSProperties = {
  background: tokens.color.status.waitingWash,
  border: `1px solid ${tokens.color.status.waitingSoft}`,
  borderRadius: tokens.radius.lg,
  color: tokens.color.ink.primary,
  display: "flex",
  flexDirection: "column",
  fontSize: "13px",
  gap: tokens.space.sm,
  padding: tokens.space.md,
};

const askHeaderStyle: CSSProperties = {
  color: tokens.color.status.waitingInk,
  fontSize: "12px",
};

const optionsStyle: CSSProperties = {
  color: tokens.color.ink.secondary,
  margin: 0,
  paddingLeft: tokens.space.lg,
};

const noteStyle: CSSProperties = {
  ...quietStyle,
  textAlign: "center",
};
