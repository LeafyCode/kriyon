import type { CSSProperties } from "react";
import type { NeedsYouEntry } from "../state/needsYou.ts";
import { formatDuration } from "../state/needsYou.ts";
import { statusMeta } from "../theme/status.ts";
import { tokens } from "../theme/tokens.ts";
import { ASK_KIND_VISUAL } from "./askKind.ts";

/** Text glyph for an entry's ask, from the shared ask-kind vocabulary; a
 *  middle dot when the entry has only a best-effort snippet, no exact ask. */
function askGlyph(entry: NeedsYouEntry): string {
  return entry.ask?.tier === "exact"
    ? ASK_KIND_VISUAL[entry.ask.kind].glyph
    : "·";
}

/**
 * The waiting row: an amber wash over the whole row (8%), lifting to the
 * tinted 12% fill when it is the active or keyboard-selected one. A blocked
 * session is the one thing on the screen that wants the user, so the row
 * carries the status rather than leaving it to a dot at the edge.
 */
function rowStyle(active: boolean, selected: boolean): CSSProperties {
  const meta = statusMeta("waiting");
  return {
    alignItems: "flex-start",
    background: selected || active ? meta.soft : (meta.wash ?? "transparent"),
    border: "none",
    borderRadius: tokens.radius.md,
    color: tokens.color.text,
    cursor: "pointer",
    display: "flex",
    fontFamily: tokens.font.sans,
    gap: tokens.space.sm,
    minHeight: "46px",
    padding: "7px 10px",
    textAlign: "left",
    width: "100%",
  };
}

// Amber at `#d29922` reads as a dot but not as a mark beside text — the
// glyph takes the lifted *ink* stop, like the sidebar's Needs-you rows.
const glyphStyle: CSSProperties = {
  color: statusMeta("waiting").ink,
  flex: "none",
  fontSize: "12px",
  lineHeight: "18px",
  width: "14px",
};

const titleStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  display: "block",
  fontSize: "12.5px",
  fontWeight: 500,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

function askStyle(tier: "exact" | "best_effort"): CSSProperties {
  return {
    color: tier === "exact" ? tokens.color.ink.primary : tokens.color.ink.muted,
    display: "block",
    fontSize: "11.5px",
    fontStyle: tier === "best_effort" ? "italic" : "normal",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
}

const metaStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  display: "block",
  fontFamily: tokens.font.mono,
  fontSize: "10.5px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const blockedStyle: CSSProperties = {
  color: statusMeta("waiting").ink,
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "10.5px",
  fontVariantNumeric: "tabular-nums",
};

/**
 * The shared Needs-you list: one enriched row per blocked session, rendered by
 * both the Command-center rail and the ⌘⇧K overlay. `onOpen` receives whether
 * the entry's ask is exact so the caller can route straight to the Raw view.
 */
export function NeedsYouList({
  activeSessionId,
  entries,
  onOpen,
  selectedIndex,
}: {
  activeSessionId: string | null;
  entries: NeedsYouEntry[];
  onOpen: (sessionId: string, exact: boolean) => void;
  selectedIndex?: number;
}) {
  return (
    <>
      {entries.map((entry, index) => (
        <button
          data-testid={`needs-you-${entry.sessionId}`}
          key={entry.sessionId}
          onClick={() => onOpen(entry.sessionId, entry.ask?.tier === "exact")}
          style={rowStyle(
            entry.sessionId === activeSessionId,
            index === selectedIndex
          )}
          type="button"
        >
          <span aria-hidden style={glyphStyle}>
            {askGlyph(entry)}
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={titleStyle}>{entry.title}</span>
            {entry.ask ? (
              <span
                data-testid={`needs-you-ask-${entry.sessionId}`}
                style={askStyle(entry.ask.tier)}
              >
                {entry.ask.text}
              </span>
            ) : null}
            <span style={metaStyle}>
              {entry.projectName}
              {entry.contextText ? ` · ${entry.contextText}` : ""}
            </span>
          </span>
          <span
            data-testid={`needs-you-blocked-${entry.sessionId}`}
            style={blockedStyle}
          >
            {formatDuration(entry.blockedForMs)}
          </span>
        </button>
      ))}
    </>
  );
}
