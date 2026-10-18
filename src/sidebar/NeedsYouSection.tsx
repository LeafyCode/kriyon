import { CircleCheck, Hourglass, TriangleAlert } from "lucide-react";
import { type CSSProperties, memo, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { ASK_KIND_VISUAL } from "../needsYou/askKind.ts";
import { useLayout } from "../state/layout.ts";
import { useSessions } from "../state/sessions.ts";
import { sectionLabel } from "../theme/recipes.ts";
import { statusMeta } from "../theme/status.ts";
import { tokens } from "../theme/tokens.ts";
import {
  type NeedsYouItem,
  type NeedsYouKind,
  needsYouSectionItems,
} from "./needsYouItems.ts";

const sectionStyle: CSSProperties = {
  borderBottom: `1px solid ${tokens.color.line.soft}`,
  display: "flex",
  flex: "none",
  flexDirection: "column",
  gap: "3px",
  // The section must never crush the project tree below it — many blocked
  // sessions is exactly when the tree still needs to be reachable.
  maxHeight: "320px",
  overflowY: "auto",
  padding: "12px 10px 12px",
};

const headerStyle: CSSProperties = {
  ...sectionLabel(),
  alignItems: "center",
  display: "flex",
  gap: "6px",
  padding: "0 8px 7px",
};

const countStyle: CSSProperties = {
  background: statusMeta("waiting").soft,
  borderRadius: tokens.radius.pill,
  color: statusMeta("waiting").ink,
  fontFamily: tokens.font.mono,
  fontSize: "9.5px",
  fontWeight: 500,
  letterSpacing: "normal",
  lineHeight: 1,
  padding: "2px 6px",
};

/** Ink per row kind — questions and waits amber, failures red, finished green.
 *  The amber is the *label* stop, not the dot's: these are icons sitting next
 *  to text, and `#d29922` is too dark to read as a mark at 12px. */
const KIND_INK: Record<NeedsYouKind, string> = {
  question: statusMeta("waiting").ink,
  waiting: statusMeta("waiting").ink,
  error: tokens.color.status.error,
  done: tokens.color.status.done,
};

/** The Warp-style distinction: only an exact question gets the tinted wash.
 *  Published as `.kr-row`'s custom properties, not as an inline background —
 *  see `SessionRow.rowFillVars` for why. */
function rowStyle(kind: NeedsYouKind): CSSProperties {
  const question = kind === "question";
  return {
    alignItems: "center",
    ...({
      "--kr-row-bg": question
        ? (statusMeta("waiting").wash ?? "transparent")
        : "transparent",
      "--kr-row-hover": question ? statusMeta("waiting").soft : undefined,
    } as CSSProperties),
    border: "none",
    borderRadius: tokens.radius.md,
    cursor: "pointer",
    display: "flex",
    fontFamily: tokens.font.sans,
    gap: "8px",
    minWidth: 0,
    overflow: "hidden",
    // Not a fixed 30px: a question row carries its own words on a second
    // line, and clipping the ask to keep the rhythm would defeat the row.
    minHeight: "30px",
    padding: "6px 8px",
    textAlign: "left",
    width: "100%",
  };
}

const titleStyle: CSSProperties = {
  color: tokens.color.ink.secondary,
  display: "block",
  fontSize: "12.5px",
  fontWeight: 500,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** The question's own words, one quiet line under the title. */
const askTextStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  display: "block",
  fontSize: "11px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const projectStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  flex: "none",
  fontSize: "10.5px",
};

/**
 * Kind-specific glyph. Exact asks split by what they actually want: a real
 * question gets the speech bubble, a permission the key (approve in the
 * terminal), a plan approval the clipboard — same wash, different verb.
 */
function kindIcon(
  kind: NeedsYouKind,
  askKind: NeedsYouItem["askKind"]
): ReactNode {
  if (kind === "question") {
    const { Icon } = ASK_KIND_VISUAL[askKind ?? "question"];
    return <Icon size={13} />;
  }
  switch (kind) {
    case "waiting":
      return <Hourglass size={12} />;
    case "error":
      return <TriangleAlert size={13} />;
    case "done":
      return <CircleCheck size={13} />;
    default:
      return null;
  }
}

interface RowProps {
  askKind: NeedsYouItem["askKind"];
  askText: string | null;
  kind: NeedsYouKind;
  sessionId: string;
}

/** One Needs-you row; subscribes only to its own session's title/project. */
const NeedsYouRow = memo(function NeedsYouRow({
  askKind,
  askText,
  kind,
  sessionId,
}: RowProps) {
  const title = useSessions(
    (state) => state.sessions[sessionId]?.title ?? sessionId
  );
  const projectName = useSessions((state) => {
    const projectId = state.sessions[sessionId]?.projectId;
    return state.projects.find((p) => p.id === projectId)?.name ?? "";
  });
  const setActiveSession = useSessions((state) => state.setActiveSession);

  return (
    <button
      aria-label={`Go to ${title}`}
      className="kr-row"
      data-ask-kind={askKind ?? undefined}
      data-kind={kind}
      data-testid={`needs-you-${sessionId}`}
      onClick={() => {
        setActiveSession(sessionId);
        // Same rule as the project tree's rows (`Sidebar.tsx`): picking a
        // session shows the session view and lands on the transcript, rather
        // than the *new* session's Changes tab — and, since the sidebar now
        // outlives the view, rather than nothing at all when the click came
        // from Settings or Prompts.
        useLayout.getState().revealSessionView();
      }}
      style={rowStyle(kind)}
      type="button"
    >
      <span style={{ color: KIND_INK[kind], display: "flex", flex: "none" }}>
        {kindIcon(kind, askKind)}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={titleStyle}>{title}</span>
        {askText ? <span style={askTextStyle}>{askText}</span> : null}
      </span>
      <span style={projectStyle}>{projectName}</span>
    </button>
  );
});

/**
 * The sidebar's pinned Needs-you section (see CONTEXT.md): questions to
 * answer, plain input waits, failures, and finished runs the user hasn't
 * looked at yet. Absent entirely when nothing qualifies. The selector encodes
 * each item as JSON (robust to any ask text, unlike a delimiter) so
 * transcript/status churn only re-renders the section when membership
 * actually changes.
 */
export const NeedsYouSection = memo(function NeedsYouSection() {
  const encoded = useSessions(
    useShallow((state) =>
      needsYouSectionItems(state).map((item) => JSON.stringify(item))
    )
  );

  if (encoded.length === 0) {
    return null;
  }
  return (
    <div data-testid="needs-you-section" style={sectionStyle}>
      <div style={headerStyle}>
        <span style={{ flex: 1 }}>Needs you</span>
        <span style={countStyle}>{encoded.length}</span>
      </div>
      {encoded.map((row) => {
        const item = JSON.parse(row) as NeedsYouItem;
        return (
          <NeedsYouRow
            askKind={item.askKind}
            askText={item.askText}
            key={item.sessionId}
            kind={item.kind}
            sessionId={item.sessionId}
          />
        );
      })}
    </div>
  );
});
