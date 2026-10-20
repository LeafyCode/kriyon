import { type CSSProperties, useState } from "react";
import { tokens } from "../../theme/tokens.ts";
import type { Subagent } from "../../types.ts";
import { agoFromIso } from "../chrome.tsx";
import { ListPanel } from "./ListPanel.tsx";
import { durationLabel, elapsedLabel, toolLabel } from "./toolLabel.ts";
import { useNow } from "./useNow.ts";

const rowStyle: CSSProperties = {
  alignItems: "baseline",
  background: "none",
  border: "none",
  cursor: "default",
  display: "flex",
  gap: "8px",
  margin: 0,
  padding: 0,
  textAlign: "left",
  width: "100%",
};

const clickableRowStyle: CSSProperties = {
  ...rowStyle,
  cursor: "pointer",
};

const glyphStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  flex: "0 0 auto",
  fontSize: "11px",
};

const runningGlyphStyle: CSSProperties = {
  ...glyphStyle,
  color: tokens.color.accentBright,
};

const bodyStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "2px",
  minWidth: 0,
};

const kindStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  fontSize: "12.5px",
  fontWeight: 500,
};

const descStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "11px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const statusStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "11px",
};

const toolLineStyle: CSSProperties = {
  color: tokens.color.accentBright,
  fontSize: "11px",
};

const resultStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.mono,
  fontSize: "11px",
  marginTop: "4px",
  maxHeight: "180px",
  overflow: "auto",
  whiteSpace: "pre-wrap",
};

/** Short "N running, N done" count, omitting zero parts; `undefined` if both 0. */
function metaLabel(running: number, done: number): string | undefined {
  const parts: string[] = [];
  if (running > 0) {
    parts.push(`${running} running`);
  }
  if (done > 0) {
    parts.push(`${done} done`);
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/** Status line for a subagent row; live elapsed while running, exact when done. */
function statusLabel(subagent: Subagent, now: number): string {
  if (subagent.state === "running") {
    return `running ${elapsedLabel(subagent.startedAt, now)}`;
  }
  if (subagent.durationMs !== null) {
    return `done in ${durationLabel(subagent.durationMs)}`;
  }
  return subagent.endedAt ? `done · ${agoFromIso(subagent.endedAt)}` : "done";
}

function AgentRow({ subagent }: { subagent: Subagent }) {
  const [expanded, setExpanded] = useState(false);
  const now = useNow();
  const running = subagent.state === "running";
  const expandable = !running && subagent.result !== null;

  const body = (
    <span style={bodyStyle}>
      <span style={kindStyle}>{subagent.kind}</span>
      {subagent.description === null ? null : (
        <span style={descStyle}>{subagent.description}</span>
      )}
      {running && subagent.currentTool ? (
        <span style={toolLineStyle}>{toolLabel(subagent.currentTool)}</span>
      ) : null}
      <span style={statusStyle}>{statusLabel(subagent, now)}</span>
    </span>
  );

  const glyph = (
    <span style={running ? runningGlyphStyle : glyphStyle}>
      {running ? "•" : "✓"}
    </span>
  );

  if (!expandable) {
    return (
      <div style={rowStyle}>
        {glyph}
        {body}
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={() => setExpanded((prev) => !prev)}
        style={clickableRowStyle}
        type="button"
      >
        {glyph}
        {body}
      </button>
      {expanded ? <pre style={resultStyle}>{subagent.result}</pre> : null}
    </div>
  );
}

/**
 * Inspector section listing the subagents a session spawned, with running /
 * done status and click-to-reveal results for completed ones.
 */
export function AgentsPanel({
  first,
  subagents,
}: {
  first?: boolean;
  subagents: Subagent[];
}) {
  const running = subagents.filter((s) => s.state === "running").length;
  const done = subagents.length - running;

  return (
    <ListPanel
      empty="No subagents"
      first={first}
      getKey={(subagent) => subagent.toolUseId}
      items={subagents}
      label="Agents"
      meta={metaLabel(running, done)}
      renderItem={(subagent) => <AgentRow subagent={subagent} />}
    />
  );
}
