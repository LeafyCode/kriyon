import { type CSSProperties, useState } from "react";
import { tokens } from "../../theme/tokens.ts";
import type { BackgroundShell } from "../../types.ts";
import { agoFromIso } from "../chrome.tsx";
import { ListPanel } from "./ListPanel.tsx";

const rowButtonStyle: CSSProperties = {
  appearance: "none",
  background: "none",
  border: "none",
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  gap: "2px",
  padding: 0,
  textAlign: "left",
  width: "100%",
};

const cmdStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  fontFamily: tokens.font.mono,
  fontSize: "12.5px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const statusStyle: CSSProperties = {
  fontSize: "11px",
};

const bashIdStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.mono,
  fontSize: "11px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** The glyph + accent color for a shell's best-effort status. */
function statusGlyph(shell: BackgroundShell): { glyph: string; color: string } {
  switch (shell.status) {
    case "running":
      return { color: tokens.color.accentBright, glyph: "•" };
    case "exited":
      return shell.exit === 0
        ? { color: tokens.color.ink.muted, glyph: "✓" }
        : { color: tokens.color.del, glyph: "✗" };
    case "killed":
      return { color: tokens.color.del, glyph: "✗" };
    default:
      return { color: tokens.color.ink.muted, glyph: "✓" };
  }
}

/**
 * The status line — honest about staleness, since the transcript never reports
 * completion directly (see ADR 0002). `lastPolledAt` is the only signal.
 */
function statusText(shell: BackgroundShell): string {
  const polled = agoFromIso(shell.lastPolledAt);
  switch (shell.status) {
    case "running":
      return shell.lastPolledAt
        ? `running · last polled ${polled}`
        : "running · not yet polled";
    case "exited":
      return `exited ${shell.exit ?? "?"} · ${polled}`;
    case "killed":
      return `killed · ${polled}`;
    default:
      return `unknown · last polled ${polled}`;
  }
}

function Row({ shell }: { shell: BackgroundShell }) {
  const [revealed, setRevealed] = useState(false);
  const { glyph, color } = statusGlyph(shell);

  return (
    <button
      onClick={() => setRevealed((open) => !open)}
      style={rowButtonStyle}
      type="button"
    >
      <span style={cmdStyle}>{shell.cmd}</span>
      <span style={{ ...statusStyle, color }}>
        {glyph} {statusText(shell)}
      </span>
      {revealed ? <span style={bashIdStyle}>{shell.bashId}</span> : null}
    </button>
  );
}

/**
 * Background shells launched with `run_in_background`. Status is best-effort:
 * the transcript never reports completion, so each row is honest about when it
 * was last polled. There is no stored output to show — clicking a row reveals
 * its `bashId` instead.
 */
export function BackgroundPanel({
  first,
  shells,
}: {
  first?: boolean;
  shells: BackgroundShell[];
}) {
  return (
    <ListPanel
      empty="No background shells"
      first={first}
      getKey={(shell) => shell.bashId}
      items={shells}
      label="Background"
      meta={shells.length || undefined}
      renderItem={(shell) => <Row shell={shell} />}
    />
  );
}
