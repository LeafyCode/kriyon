import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Check,
  GitBranch,
  GripVertical,
  LoaderCircle,
  Moon,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { SleepPhase } from "../ipc/bridge.ts";
import { archiveSessionAndStop, prewarmSession } from "../state/actions.ts";
import { useChanges } from "../state/changes.ts";
import { useDrafts } from "../state/drafts.ts";
import { type SidebarMode, useLayout } from "../state/layout.ts";
import { useSessionProposals } from "../state/nestedSessions.ts";
import {
  sessionWorkingDir,
  useSessions,
  worktreeName,
} from "../state/sessions.ts";
import {
  packCommands,
  stopCostFor,
  unpackCommands,
} from "../state/stopCost.ts";
import { taskProgress } from "../state/taskProgress.ts";
import { useUi } from "../state/ui.ts";
import { sessionUsageView, type UsageTone, usageTone } from "../state/usage.ts";
import {
  type DirtyStatus,
  useWorktreeDirty,
} from "../state/useActiveSession.ts";
import { unseenCount } from "../state/viewedMarker.ts";
import { row30 } from "../theme/recipes.ts";
import {
  statusDotStyle,
  statusMeta,
  statusRingStyle,
} from "../theme/status.ts";
import { tokens } from "../theme/tokens.ts";
import type { SessionStatus } from "../types.ts";
import {
  anchoredMenuSurfaceStyle,
  useAnchoredMenu,
} from "../ui/AnchoredMenu.tsx";
import { DeleteActivityConfirm } from "./DeleteActivityConfirm.tsx";
import { InlineRename } from "./InlineRename.tsx";
import { formatCpu, type MemoryTone, memoryChipView } from "./memoryChip.ts";
import { SessionCloseConfirm } from "./SessionCloseConfirm.tsx";
import { closeConfirmFor, unsentWorkFor } from "./sessionClose.ts";
import { type ContextTone, contextLine } from "./sessionContext.ts";
import { sessionRowView } from "./sessionOrder.ts";
import { useWorktreeRemoval } from "./useWorktreeRemoval.ts";

/** How long the pointer rests on a row before its pty is opened early. Long
 *  enough that sweeping down the rail opens nothing. */
export const PREWARM_DWELL_MS = 150;

/** Open a row's pty once the pointer has rested on it ({@link prewarmSession}). */
function useHoverPrewarm(sessionId: string): {
  onPointerEnter: () => void;
  onPointerLeave: () => void;
} {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  useEffect(() => cancel, [cancel]);
  const onPointerEnter = useCallback(() => {
    cancel();
    timer.current = setTimeout(() => {
      timer.current = undefined;
      prewarmSession(sessionId);
    }, PREWARM_DWELL_MS);
  }, [cancel, sessionId]);
  return { onPointerEnter, onPointerLeave: cancel };
}

/** The `--kr-row-bg` / `--kr-row-hover` pair `.kr-row` paints from. */
function rowFillVars(
  active: boolean,
  wash: string | null,
  washHover: string
): CSSProperties {
  return {
    "--kr-row-bg": active ? tokens.color.surface.s3 : (wash ?? "transparent"),
    "--kr-row-hover": active
      ? tokens.color.surface.s3
      : (wash ?? null) && washHover,
  } as CSSProperties;
}

function sessionRowStyle(
  active: boolean,
  status: SessionStatus
): CSSProperties {
  // Linear-style selection: a neutral raised fill, with the accent confined to
  // the 2px bar. A blocked session gets a faint status-colored wash instead so
  // "needs me" reads at the row level, not a 7px dot.
  //
  // Both fills are published as custom properties for `.kr-row` rather than
  // set as `background` here: an inline background outranks every class rule,
  // so a washed row was the one row in the sidebar that did not respond to
  // hover at all. A washed row deepens to the same status's 12% `soft` on
  // hover; a plain one falls back to the neutral surface hover.
  const meta = statusMeta(status);
  return {
    alignItems: "center",
    ...rowFillVars(active, meta.wash, meta.soft),
    border: "1px solid transparent",
    borderRadius: tokens.radius.md,
    cursor: "pointer",
    display: "flex",
    gap: "8px",
    // The row's own leading columns (grip slot + status glyph) *are* the
    // indent — together with this padding they total the header's
    // chevron+swatch width, so the title lands flush under the project name
    // (5a/5b) with only the glyph hanging into the gutter. Also leaves the
    // active bar (left 3px) clear of the grip.
    padding: "6px 9px 6px 6px",
    position: "relative",
    transition: `background ${tokens.motion.hover}`,
    width: "100%",
  };
}

/**
 * dnd-kit's `attributes` include `aria-describedby`, which points at its
 * "press space to pick up" keyboard-drag instructions — untrue here (pointer
 * sensor only, no keyboard drag). Drop just that; keep role/tabIndex/
 * aria-roledescription so the grip reads as a sortable control.
 */
function gripAttributes(
  attributes: ReturnType<typeof useSortable>["attributes"]
): Record<string, unknown> {
  const { "aria-describedby": _describedBy, ...rest } = attributes;
  return rest;
}

/**
 * Layers dnd-kit's transform/transition/dragging state on top of the row's
 * status styling. Pulled out of the component so the drag ternary doesn't
 * count against SessionRow's own cognitive-complexity budget.
 */
function sortableSessionRowStyle(
  active: boolean,
  status: SessionStatus,
  sortableRow: ReturnType<typeof useSortable>
): CSSProperties {
  return {
    ...sessionRowStyle(active, status),
    transform: CSS.Transform.toString(sortableRow.transform),
    transition: sortableRow.transition,
    ...(sortableRow.isDragging
      ? { opacity: 0.75, position: "relative", zIndex: tokens.z.sticky }
      : null),
  };
}

/**
 * The active row's leading bar. `accentBright` rather than `accent`: on the
 * flat plane the mid accent is barely a step off the 6% fill behind it, and
 * this 2px rule is the only thing marking which session you are in.
 */
const activeBarStyle: CSSProperties = {
  background: tokens.color.accentBright,
  borderRadius: "2px",
  bottom: "8px",
  left: "3px",
  position: "absolute",
  top: "8px",
  width: "2px",
};

/**
 * Title ink by state — the "color only where action is needed" rule (design
 * 5a/5b): live/blocked work reads at `primary`, idle sits at `muted`, an
 * unread finish keeps `secondary` so it still asks to be opened, and a
 * finished-and-read row fades all the way to `faint` — out of the eye's way.
 */
function titleInk(
  active: boolean,
  status: SessionStatus,
  doneUnseen: boolean
): string {
  if (active) {
    return tokens.color.ink.bright;
  }
  if (status === "done") {
    return doneUnseen ? tokens.color.ink.secondary : tokens.color.ink.faint;
  }
  if (status === "idle") {
    return tokens.color.ink.muted;
  }
  return tokens.color.ink.primary;
}

/** A calm hollow ring for idle/not-yet-started work — present, but no color. */
const idleDotStyle: CSSProperties = statusRingStyle();

/**
 * The status column is exactly one dot wide, and the ✓ is centred *inside* it
 * rather than allowed to set its own width. A 12px glyph in an auto-width slot
 * pushed a finished row's title 5px right of every other row's, breaking the
 * one alignment the 5a/5b design rests on — titles flush under the project
 * name, glyphs alone hanging in the gutter. The icon overflows the slot
 * symmetrically, so it still reads full-size.
 */
const doneCheckSlotStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flex: "none",
  justifyContent: "center",
  width: "7px",
};

/**
 * The leading state mark — color only where action is needed: a live/blocked
 * dot, a calm hollow ring for idle work, a ✓ for a finish (bright while unread,
 * faded once seen).
 */
/** The row's loading spinner, shared by a waking resume and a booting launch. */
function ResumeSpinner({ testId }: { testId: string }): ReactNode {
  return (
    <span style={doneCheckSlotStyle}>
      <LoaderCircle
        data-testid={testId}
        size={11}
        style={{
          animation: "kr-spin 0.7s linear infinite",
          color: tokens.color.ink.dim,
          flex: "none",
        }}
      />
    </span>
  );
}

function SidebarStatusGlyph({
  booting,
  doneUnseen,
  hooksOff,
  sessionId,
  sleeping,
  status,
}: {
  booting: boolean;
  doneUnseen: boolean;
  /** [Hooks off]: the status is unknowable, so no stale one may show. */
  hooksOff: boolean;
  sessionId: string;
  sleeping: SleepPhase | undefined;
  status: SessionStatus;
}): ReactNode {
  // A resume is loading — waking a [Sleeping session] (claude typed back in) or
  // a fresh [Boot phase] launch. Either way the row reads "loading" with a
  // spinner. Checked before the sleeping moon so a waking row never flashes it.
  if (sleeping === "waking" || booting) {
    return (
      <ResumeSpinner
        testId={
          booting
            ? `booting-spinner-${sessionId}`
            : `waking-spinner-${sessionId}`
        }
      />
    );
  }
  if (sleeping) {
    // A [Sleeping session]: its claude is stopped to reclaim memory; the row
    // stays, and clicking it resumes right where it left off. `stuck` means the
    // resume kept failing — the user has to restart it themselves, so the glyph
    // must not look like an ordinary sleeping row.
    const stuck = sleeping === "stuck";
    return (
      <span style={doneCheckSlotStyle}>
        <Moon
          data-testid={
            stuck ? `sleeping-stuck-${sessionId}` : `sleeping-moon-${sessionId}`
          }
          size={11}
          style={{
            color: stuck ? tokens.color.status.error : tokens.color.ink.dim,
            flex: "none",
          }}
        />
      </span>
    );
  }
  if (hooksOff) {
    return (
      <span data-testid={`status-unknown-${sessionId}`} style={idleDotStyle} />
    );
  }
  if (status === "done") {
    return (
      <span style={doneCheckSlotStyle}>
        <Check
          data-testid={`done-check-${sessionId}`}
          size={10}
          style={{
            // Unread keeps the green ("something finished for you"); read fades
            // to ghost so a reviewed row stops competing with live work.
            color: doneUnseen
              ? tokens.color.status.done
              : tokens.color.ink.faint,
            flex: "none",
          }}
        />
      </span>
    );
  }
  if (status === "idle") {
    return (
      <span data-testid={`status-dot-${sessionId}`} style={idleDotStyle} />
    );
  }
  return (
    <span
      data-testid={`status-dot-${sessionId}`}
      style={statusDotStyle(status)}
    />
  );
}

/**
 * The row's second line: live context, the [Session footprint] chip, and the
 * worktree branch chip. Extracted so SessionRow's render stays within the
 * complexity budget as chips accrue.
 */
function SessionMetaLine({
  branchLabel,
  budgetMb,
  context,
  cpuPct,
  dirty,
  memoryMb,
  sessionId,
}: {
  branchLabel: string | null;
  budgetMb: number;
  context: { text: string; tone: ContextTone } | null;
  cpuPct: number | undefined;
  dirty: boolean;
  memoryMb: number | undefined;
  sessionId: string;
}): ReactNode {
  const memoryChip = memoryChipView(memoryMb, budgetMb);
  const tasks = useSessions((state) => state.activity[sessionId]?.tasks);
  const progress = taskProgressTitle(tasks);
  const ctxPct = useSessions(
    (state) => sessionUsageView(state.usage[sessionId]).ctxPct
  );
  const suggested = useSessionProposals(
    (state) =>
      state.proposals.filter((p) => p.leadSessionId === sessionId).length
  );
  if (
    !(
      context ||
      branchLabel ||
      memoryChip ||
      progress ||
      ctxPct !== null ||
      suggested > 0
    )
  ) {
    return null;
  }
  return (
    <span style={metaLineStyle}>
      {suggested > 0 ? (
        <span
          data-testid={`suggested-chip-${sessionId}`}
          style={suggestedChipStyle}
          title="Claude suggested starting a session from this one; open it to decide"
        >
          {suggested} suggested
        </span>
      ) : null}
      {progress ? (
        <span
          data-testid={`task-progress-${sessionId}`}
          style={taskProgressStyle}
          title={progress.title}
        >
          {progress.label}
        </span>
      ) : null}
      {context ? (
        <span style={contextTextStyle(context.tone)}>{context.text}</span>
      ) : null}
      {ctxPct === null ? null : (
        <span
          data-testid={`context-chip-${sessionId}`}
          style={contextChipStyle(usageTone(ctxPct))}
          title="How full this session's context window is, from Claude's last reply"
        >
          {ctxPct}% ctx
        </span>
      )}
      {memoryChip ? (
        <span
          data-testid={`memory-chip-${sessionId}`}
          style={memoryChipStyle(memoryChip.tone)}
          title="Memory this session's processes are using"
        >
          {memoryChip.label}
        </span>
      ) : null}
      {memoryChip ? (
        <span
          data-testid={`cpu-chip-${sessionId}`}
          style={cpuChipStyle}
          title="CPU this session's processes are using (100% = one core)"
        >
          {formatCpu(cpuPct)}
        </span>
      ) : null}
      {branchLabel ? (
        <span style={worktreeChipStyle} title="Runs in its own worktree">
          <GitBranch size={10} />
          {branchLabel}
          {dirty ? (
            <span
              data-testid={`worktree-dirty-${sessionId}`}
              style={worktreeDirtyDotStyle}
              title="Uncommitted changes"
            />
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

/** The [Handoff link] badge: muted, mono, clickable above the row's overlay.
 *  `kr-link` gives it the accent and an underline on hover, so it reads as a
 *  link and not as a caption. */
const handoffLinkStyle = {
  "--kr-link": tokens.color.ink.muted,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  display: "block",
  fontFamily: tokens.font.mono,
  fontSize: "10.5px",
  maxWidth: "100%",
  overflow: "hidden",
  padding: 0,
  pointerEvents: "auto",
  position: "relative",
  textAlign: "left",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as CSSProperties;

/**
 * "↓ from <title>" under a [Follow-up session]'s title — its [Handoff link].
 * The follow-up is newer, so it is listed above its predecessor: the arrow
 * points down to it. Clicking selects the predecessor. Hidden once the
 * predecessor is gone.
 */
function HandoffLinkBadge({
  onSelect,
  parentId,
  sessionId,
}: {
  onSelect: (id: string) => void;
  parentId: string | null | undefined;
  sessionId: string;
}): ReactNode {
  const parentTitle = useSessions((state) =>
    parentId ? state.sessions[parentId]?.title : undefined
  );
  if (!(parentId && parentTitle !== undefined)) {
    return null;
  }
  return (
    <button
      className="kr-link"
      data-no-dnd="true"
      data-testid={`handoff-link-${sessionId}`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(parentId);
      }}
      style={handoffLinkStyle}
      title={`Go to “${parentTitle}”`}
      type="button"
    >
      ↓ from {parentTitle}
    </button>
  );
}

/** The "new" pill on an unread finished row in triage mode. */
const newBadgeStyle: CSSProperties = {
  background: tokens.color.surface.s2,
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.muted,
  flex: "none",
  fontSize: "9.5px",
  letterSpacing: "0.02em",
  padding: "1px 5px",
};

/** The changed-files count badge (Task 10) — the same pill shape as
 * `newBadgeStyle`, but in mono: tokens.ts's own convention is that anything
 * machine-shaped ("paths, ids, counts, code") carries JetBrains Mono, and a
 * file count is exactly that. */
const filesChangedBadgeStyle: CSSProperties = {
  background: tokens.color.surface.s2,
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.muted,
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "9.5px",
  padding: "1px 5px",
};

/**
 * The row's files-touched count badge (Task 10): a raw count from
 * `touchedFiles` — files Claude's edit tools touched this session, not
 * reconciled against the Code Changes View's diffs (`touchedFiles` holds
 * absolute paths while a diff's files are repo-relative, and the row only
 * needs "how many", not which ones). Labeled "touched", never "changed": it
 * counts a different thing than the Changes view's own totals (the whole
 * working tree, including the user's own pre-existing edits), and claiming
 * the same word for both is what let them visibly contradict each other.
 *
 * `touchedFiles` is cumulative and never cleared — not on commit, not on
 * undo — so a raw count alone would keep claiming files are outstanding
 * after the user has committed everything. Gated on `dirty` (this session's
 * actual working-tree state, computed once by `SessionRow` via the same
 * live signal the worktree dot uses, and handed down as a prop — a second,
 * independent `useWorktreeDirty` subscription here would double every
 * `git status` spawn the row triggers) so the badge disappears the moment
 * the tree it's about is *positively known* to be clean, instead of going
 * on asserting a stale fact. An `"unknown"` tree (the check errored, e.g. a
 * non-git directory) is not treated as clean — showing the count is the
 * honest fallback when we can't confirm it's gone stale.
 *
 * Reads its own `touchedFiles` slice self-contained like
 * {@link SidebarStatusGlyph}, so `SessionRow` doesn't carry this branch in
 * its own cognitive-complexity budget.
 */
function FilesChangedBadge({
  dirty,
  sessionId,
}: {
  dirty: DirtyStatus;
  sessionId: string;
}): ReactNode {
  const touchedCount = useSessions(
    (state) => state.touchedFiles[sessionId]?.length ?? 0
  );
  if (touchedCount === 0 || dirty === "clean") {
    return null;
  }
  return (
    <span
      data-testid={`files-changed-badge-${sessionId}`}
      style={filesChangedBadgeStyle}
      title={`${touchedCount} file${touchedCount === 1 ? "" : "s"} touched this session`}
    >
      {touchedCount}
    </span>
  );
}

function sessionTitleStyle(color: string, bold: boolean): CSSProperties {
  return {
    color,
    // `display: block` is what makes overflow/ellipsis actually clip: an inline
    // span shrink-wraps its text and spills past its flex parent, so the title
    // ran off the rail and under the activity badge. A block fills the
    // (minWidth:0) parent and truncates within it.
    display: "block",
    fontSize: "12.5px",
    // 500 / 400, never 600 — the UI face ships no semibold and the browser
    // would synthesize one.
    fontWeight: bold ? 500 : 400,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
}

/**
 * Ink per {@link ContextTone}: attention states loud; live work stays quiet
 * gray (design 5a) — the pulsing green dot already says "running", so an
 * accent-colored subtitle would be a second voice for the same fact.
 */
const TONE_INK: Record<ContextTone, string> = {
  error: tokens.color.status.error,
  live: tokens.color.ink.muted,
  muted: tokens.color.ink.faint,
  waiting: tokens.color.status.waiting,
};

const metaLineStyle: CSSProperties = {
  alignItems: "baseline",
  display: "flex",
  gap: "7px",
  minWidth: 0,
};

function contextTextStyle(tone: ContextTone): CSSProperties {
  return {
    color: TONE_INK[tone],
    flex: "0 1 auto",
    fontSize: "11.5px",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
}

/** Ink for the [Session footprint] chip, escalating with its tone. */
const MEMORY_TONE_INK: Record<MemoryTone, string> = {
  quiet: tokens.color.ink.faint,
  elevated: tokens.color.status.waiting,
  high: tokens.color.status.error,
};

function memoryChipStyle(tone: MemoryTone): CSSProperties {
  return {
    color: MEMORY_TONE_INK[tone],
    flex: "none",
    fontFamily: tokens.font.mono,
    fontSize: "10.5px",
  };
}

/** The row's task chip while a list is still open: "3/7", with the current
 *  item in the tooltip; `null` once the list is done. */
function taskProgressTitle(
  tasks: Parameters<typeof taskProgress>[0]
): { label: string; title: string } | null {
  const progress = taskProgress(tasks);
  if (!progress || progress.finished) {
    return null;
  }
  const head = `Tasks: ${progress.done} of ${progress.total} done`;
  return {
    label: progress.label,
    title: progress.current ? `${head} · ${progress.current}` : head,
  };
}

const suggestedChipStyle: CSSProperties = {
  color: tokens.color.accentBright,
  flex: "none",
  fontSize: "10.5px",
};

const taskProgressStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "10.5px",
};

/** Ink for the context chip: quiet until the window is 80% full. */
const CONTEXT_TONE_INK: Record<UsageTone, string> = {
  full: tokens.color.status.error,
  high: tokens.color.status.waiting,
  normal: tokens.color.ink.faint,
};

function contextChipStyle(tone: UsageTone): CSSProperties {
  return {
    color: CONTEXT_TONE_INK[tone],
    flex: "none",
    fontFamily: tokens.font.mono,
    fontSize: "10.5px",
  };
}

const cpuChipStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "10.5px",
};

const worktreeChipStyle: CSSProperties = {
  alignItems: "center",
  color: tokens.color.ink.faint,
  display: "flex",
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "10.5px",
  gap: "3px",
};

/** The uncommitted-changes dot beside a worktree row's branch name. */
const worktreeDirtyDotStyle: CSSProperties = {
  background: tokens.color.worktreeDirty,
  borderRadius: "50%",
  flex: "none",
  height: "5px",
  width: "5px",
};

const confirmTextStyle: CSSProperties = {
  color: tokens.color.ink.secondary,
  display: "block",
  fontSize: "11.5px",
  lineHeight: 1.5,
  padding: "4px 8px 6px",
};

/**
 * The row's hover-revealed actions (close ×, ⋯ menu) sit in an absolutely
 * positioned cluster, not in the flex flow: an in-flow reveal would reserve its
 * width on every row (it only fades opacity, never leaves layout), truncating
 * every title ~50px early even while hidden. Anchored to the (relative) row's
 * right edge with a fade so it reads cleanly over a long title's tail.
 */
const rowActionsStyle: CSSProperties = {
  alignItems: "center",
  background: `linear-gradient(to right, transparent, ${tokens.color.chrome.sidebar} 40%)`,
  bottom: 0,
  display: "flex",
  gap: "2px",
  paddingLeft: "20px",
  paddingRight: "6px",
  position: "absolute",
  right: 0,
  top: 0,
};

/** The row's hover-revealed icon buttons (close ×, actions ⋯) share one look. */
const rowIconButtonStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: tokens.color.ink.faint,
  cursor: "pointer",
  flex: "none",
  fontSize: "13px",
  lineHeight: 1,
  padding: "0 2px",
};

/** The hover-revealed "⋯" overflow menu, anchored to its (relative) row. */
const menuStyle: CSSProperties = {
  ...anchoredMenuSurfaceStyle,
  minWidth: "150px",
  padding: "4px",
};

const menuItemStyle: CSSProperties = {
  ...row30(),
  background: "transparent",
  border: "none",
  color: tokens.color.ink.primary,
  cursor: "pointer",
  textAlign: "left",
  width: "100%",
};

/**
 * The row's select target: a full-bleed overlay button (absolute inset:0), not
 * an in-flow flex child. Sized by flex it only covered the row's middle ~15px,
 * so a click in the 6px padding strips — or one WKWebView nudged a few px off
 * target while a terminal held focus — hit the handler-less container and did
 * nothing (the sidebar two-click bug). inset:0 covers the whole padded row, so
 * every pixel selects. Selection fires on click only — never onPointerDown:
 * the row is also the drag handle, and a press that begins a drag must not
 * activate (and thereby resume/launch) the session it grabbed.
 */
const rowSelectStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  cursor: "pointer",
  inset: 0,
  margin: 0,
  padding: 0,
  position: "absolute",
};

/**
 * Leading drag-grip slot: a fixed-width column present on every row so the
 * grip fading in on hover never shifts the title. `kr-reveal-cluster` fades it
 * with the row's hover; while dragging we force it visible. `pointerEvents:auto`
 * re-enables input inside the click-through row content so the grip — not the
 * select overlay beneath it — receives the drag press. `position: "relative"`
 * is load-bearing, not decorative: the row's select button (`rowSelectStyle`)
 * is `position: absolute`, and CSS paints positioned elements above
 * non-positioned in-flow siblings regardless of DOM order — so without this,
 * the button paints over the grip and swallows the pointerdown before
 * dnd-kit's listeners ever see it. Making the grip positioned too (z-index
 * stays auto) puts both in the same "positioned, z-index:auto" paint band,
 * where tree order decides — the grip is later in the DOM than the button,
 * so it wins and the press reaches its drag listeners.
 */
function dragHandleStyle(dragging: boolean): CSSProperties {
  return {
    alignItems: "center",
    color: tokens.color.ink.dim,
    cursor: "grab",
    display: "flex",
    flex: "none",
    justifyContent: "center",
    opacity: dragging ? 1 : undefined,
    pointerEvents: "auto",
    position: "relative",
    width: GRIP_SLOT,
  };
}

/**
 * Width of the leading grip column, shared by the live handle and the spacer
 * that stands in for it on non-sortable rows — they must stay identical or a
 * folded Done row's title would sit off the column the rows above it set.
 * Part of the leading-column budget that lands the title flush under the
 * project name (see `sessionRowStyle`), so it is not a free knob.
 */
const GRIP_SLOT = "12px";

/**
 * The leading drag-grip slot: the sortable row's activator control, or (when
 * the row isn't sortable) an equal-width spacer so the title never shifts.
 * Pulled out of SessionRow so the sortable ternary doesn't count against its
 * own cognitive-complexity budget (see sortableSessionRowStyle above).
 */
function DragHandle({
  sessionId,
  sortable,
  sortableRow,
  title,
}: {
  sessionId: string;
  sortable: boolean;
  sortableRow: ReturnType<typeof useSortable>;
  title: string;
}): ReactNode {
  if (!sortable) {
    return <span style={{ flex: "none", width: GRIP_SLOT }} />;
  }
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: role="button" comes from the spread dnd-kit `attributes` below, invisible to the linter.
    <span
      aria-label={`Reorder ${title}`}
      className="kr-reveal-cluster"
      data-testid={`drag-handle-${sessionId}`}
      ref={sortableRow.setActivatorNodeRef}
      style={dragHandleStyle(sortableRow.isDragging)}
      {...gripAttributes(sortableRow.attributes)}
      {...sortableRow.listeners}
    >
      <GripVertical size={12} />
    </span>
  );
}

/**
 * The row's visible content sits above the overlay button but is click-through
 * (pointerEvents: none) so every click reaches the button beneath. It stays in
 * flow, so the content — not the absolute button — sets the row's height.
 */
const rowContentStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flex: 1,
  gap: "8px",
  minWidth: 0,
  pointerEvents: "none",
  textAlign: "left",
};

/** How far each level of [Nested session] steps in. */
const NEST_INDENT_PX = 14;

/** A nested row steps in under the session it came from, with a hairline
 *  down its left edge so the group reads as one. */
function nestedContentStyle(depth: number): CSSProperties {
  if (depth === 0) {
    return rowContentStyle;
  }
  return {
    ...rowContentStyle,
    borderLeft: `1px solid ${tokens.color.line.base}`,
    marginLeft: `${depth * NEST_INDENT_PX - 7}px`,
    paddingLeft: "7px",
  };
}

/**
 * The row's hover-revealed "⋯" overflow menu: rename, spawn a follow-up,
 * archive, and (for a worktree session) remove the worktree. Extracted from
 * {@link SessionRow} so its per-item handlers and the worktree conditional stay
 * out of the row's own cognitive-complexity budget.
 */
function SessionActionsMenu({
  close,
  onDeleteActivity,
  onRename,
  removal,
  sessionId,
  worktreePath,
}: {
  close: () => void;
  onDeleteActivity: () => void;
  onRename: () => void;
  removal: ReturnType<typeof useWorktreeRemoval>;
  sessionId: string;
  worktreePath: string | null;
}): ReactNode {
  return (
    <div data-no-dnd="true" role="menu" style={menuStyle}>
      <button
        className="kr-hover-surface"
        data-testid={`rename-session-menu-${sessionId}`}
        onClick={(event) => {
          event.stopPropagation();
          onRename();
        }}
        role="menuitem"
        style={menuItemStyle}
        type="button"
      >
        Rename
      </button>
      <button
        className="kr-hover-surface"
        data-testid={`spawn-followup-${sessionId}`}
        onClick={(event) => {
          event.stopPropagation();
          close();
          useUi.getState().openSpawn({ predecessorId: sessionId });
        }}
        role="menuitem"
        style={menuItemStyle}
        type="button"
      >
        Spawn follow-up
      </button>
      <button
        className="kr-hover-surface"
        data-testid={`split-off-${sessionId}`}
        onClick={(event) => {
          event.stopPropagation();
          close();
          useUi
            .getState()
            .openSpawn({ predecessorId: sessionId }, { nest: true });
        }}
        role="menuitem"
        style={menuItemStyle}
        title="Start a session for one piece of this work, nested under this one"
        type="button"
      >
        Split off a session…
      </button>
      <button
        className="kr-hover-surface"
        data-testid={`archive-${sessionId}`}
        onClick={(event) => {
          event.stopPropagation();
          close();
          archiveSessionAndStop(sessionId);
        }}
        role="menuitem"
        style={menuItemStyle}
        type="button"
      >
        Archive
      </button>
      <button
        className="kr-hover-surface"
        data-testid={`delete-activity-${sessionId}`}
        onClick={(event) => {
          event.stopPropagation();
          close();
          onDeleteActivity();
        }}
        role="menuitem"
        style={menuItemStyle}
        type="button"
      >
        Delete activity…
      </button>
      {worktreePath ? (
        <button
          className="kr-hover-surface"
          data-testid={`remove-worktree-${sessionId}`}
          onClick={(event) => {
            event.stopPropagation();
            close();
            removal.remove(false).catch(() => {
              // Failures surface via the confirm step or a toast.
            });
          }}
          role="menuitem"
          style={menuItemStyle}
          type="button"
        >
          Remove worktree
        </button>
      ) : null}
    </div>
  );
}

interface SessionRowProps {
  /** The sidebar's calm/triage mode; drives the unread-finish "new" badge. */
  mode: SidebarMode;
  /** How deep it sits under its lead session in this list (the ordering's
   *  `nestDepth`); 0, the default, is top level. */
  nestDepth?: number;
  onCloseSession: (id: string) => void;
  onSelect: (id: string) => void;
  sessionId: string;
  /** Row may be drag-reordered — off while filtering and for folded Done rows. */
  sortable: boolean;
}

/**
 * One sidebar session row. Subscribes only to its own session's slices, so a
 * busy session's status/event/activity ticks re-render that one row and never
 * the rest of the sidebar. Memoized against its (stable) callback props.
 * During an active drag, dnd-kit re-renders the group's rows for the reflow
 * animation — the isolation claim above covers status/event ticks, not drag.
 */
export const SessionRow = memo(function SessionRow({
  mode,
  nestDepth = 0,
  onCloseSession,
  onSelect,
  sessionId,
  sortable,
}: SessionRowProps) {
  const sortableRow = useSortable({ disabled: !sortable, id: sessionId });
  const session = useSessions((state) => state.sessions[sessionId]);
  const active = useSessions((state) => state.activeSessionId === sessionId);
  const activity = useSessions((state) => state.activity[sessionId]);
  const hooksOff = useSessions((state) => state.hooksOff[sessionId]);
  const memoryMb = useSessions((state) => state.memory[sessionId]);
  const cpuPct = useSessions((state) => state.cpu[sessionId]);
  const budgetMb = useLayout((state) => state.layout.memoryBudgetMb);
  const sleeping = useSessions((state) => state.sleeping[sessionId]);
  // Booting = claude is (re)launching for this row — a fresh spawn or a
  // resume-from-history. Same "loading" situation as waking a [Sleeping
  // session], so the row shows the same spinner.
  const booting = useSessions(
    (state) => (state.bootPhase[sessionId] ?? "idle") === "booting"
  );
  // Only Done rows consult unseen, so gate the subscription on the status: a
  // running row would otherwise re-render on every appended event (appendSeq
  // ticks) even though sessionRowView ignores unseen for non-Done rows.
  const unseen = useSessions((state) =>
    state.sessions[sessionId]?.status === "done"
      ? unseenCount(state.viewed[sessionId], state.appendSeq[sessionId] ?? 0)
      : 0
  );
  const menu = useAnchoredMenu();
  const [editing, setEditing] = useState(false);
  const commitRename = useCallback(
    (next: string) => {
      setEditing(false);
      useSessions.getState().renameSession(sessionId, next);
    },
    [sessionId]
  );
  const removal = useWorktreeRemoval(sessionId);
  const prewarm = useHoverPrewarm(sessionId);
  // The two "would this close silently discard something?" signals — see
  // {@link unsentWorkFor}. A blank composer draft or an empty stashed-drafts
  // record both read as "nothing here", same as never having touched them.
  const draft = useDrafts((state) => state.drafts[sessionId]);
  const dirtyFile = useChanges((state) => state.dirtyFiles[sessionId]);
  const fileDrafts = useChanges((state) => state.fileDrafts[sessionId]);
  const unsentWork = unsentWorkFor({ dirtyFile, draft, fileDrafts });
  // What closing would *stop*. Selected as primitives (a boolean and a joined
  // string), never the cost object itself: a fresh object per store read would
  // re-render this row on every unrelated update.
  const engagement = useSessions(
    (state) => stopCostFor(state.sessions[sessionId], state).engagement
  );
  const runningCommands = useSessions((state) =>
    packCommands(stopCostFor(state.sessions[sessionId], state).commands)
  );
  const closeConfirm = closeConfirmFor(unsentWork, {
    commands: unpackCommands(runningCommands),
    engagement,
  });
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [deletingActivity, setDeletingActivity] = useState(false);
  // The row's single dirty-state subscription (see `useWorktreeDirty`'s doc
  // comment on the git-status storm it exists to prevent): computed once
  // here from the session's actual working directory — its worktree when it
  // has one, else its cwd, same precedence `sessionWorkingDir` codifies
  // everywhere else — and shared by both the worktree dot below and
  // `FilesChangedBadge`, instead of each subscribing independently.
  const dirty = useWorktreeDirty(
    sessionWorkingDir(session),
    session?.status ?? "idle"
  );
  // Stable across renders (menu.anchorRef is a fixed ref object,
  // sortableRow.setNodeRef has stable identity from dnd-kit) so the row div
  // isn't detached/reattached from both refs on every render.
  const setRowRef = useCallback(
    (node: HTMLDivElement | null) => {
      menu.anchorRef.current = node;
      sortableRow.setNodeRef(node);
    },
    [menu.anchorRef, sortableRow.setNodeRef]
  );

  if (!session) {
    return null;
  }

  const view = sessionRowView(session.status, unseen, mode);
  // A finished row is a single quiet line: the ✓ carries the state, so the live
  // context line (tools, agents) would only add noise. A session whose hooks
  // are off always shows its line: it is the only sign the status is a guess.
  const context =
    view.showContext || hooksOff
      ? contextLine(session.status, session.summary, activity, hooksOff)
      : null;
  const branchLabel = worktreeName(session);

  return (
    <div
      className="kr-reveal-parent kr-row"
      data-active={active ? "true" : "false"}
      data-status={session.status}
      data-testid="session-row"
      onPointerEnter={prewarm.onPointerEnter}
      onPointerLeave={prewarm.onPointerLeave}
      ref={setRowRef}
      style={sortableSessionRowStyle(active, session.status, sortableRow)}
      tabIndex={-1}
    >
      {active ? <span style={activeBarStyle} /> : null}
      {editing ? null : (
        <button
          aria-label={`Open ${session.title}`}
          onClick={() => onSelect(sessionId)}
          // The overlay covers the whole row, so a double-click anywhere on it
          // (dominated by the title) opens the inline rename. The Rename menu
          // item is the equivalent keyboard-accessible path.
          onDoubleClick={() => setEditing(true)}
          style={rowSelectStyle}
          type="button"
        />
      )}
      <div data-nest-depth={nestDepth} style={nestedContentStyle(nestDepth)}>
        <DragHandle
          sessionId={sessionId}
          sortable={sortable}
          sortableRow={sortableRow}
          title={session.title}
        />
        <SidebarStatusGlyph
          booting={booting}
          doneUnseen={view.doneUnseen}
          hooksOff={hooksOff !== undefined}
          sessionId={sessionId}
          sleeping={sleeping}
          status={session.status}
        />
        <span style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <InlineRename
              ariaLabel={`Rename ${session.title}`}
              onCancel={() => setEditing(false)}
              onCommit={commitRename}
              testId={`rename-session-${sessionId}`}
              value={session.title}
            />
          ) : (
            <span
              style={sessionTitleStyle(
                sleeping
                  ? tokens.color.ink.faint
                  : titleInk(active, session.status, view.doneUnseen),
                active
              )}
            >
              {session.title}
            </span>
          )}
          <SessionMetaLine
            branchLabel={branchLabel}
            budgetMb={budgetMb}
            context={context}
            cpuPct={cpuPct}
            dirty={dirty === "dirty"}
            memoryMb={memoryMb}
            sessionId={sessionId}
          />
          <HandoffLinkBadge
            onSelect={onSelect}
            parentId={session.parentSessionId}
            sessionId={sessionId}
          />
        </span>
      </div>
      {view.showNewBadge ? (
        <span data-testid={`new-badge-${sessionId}`} style={newBadgeStyle}>
          new
        </span>
      ) : null}
      <FilesChangedBadge dirty={dirty} sessionId={sessionId} />
      <span
        className="kr-reveal-cluster"
        data-no-dnd="true"
        style={rowActionsStyle}
      >
        <button
          aria-label={`Close ${session.title}`}
          data-testid={`close-session-${sessionId}`}
          onClick={(event) => {
            event.stopPropagation();
            if (closeConfirm) {
              setConfirmingClose(true);
              return;
            }
            onCloseSession(sessionId);
          }}
          style={rowIconButtonStyle}
          type="button"
        >
          <X size={13} />
        </button>
        <button
          aria-label={`Actions for ${session.title}`}
          data-testid={`session-menu-${sessionId}`}
          onClick={(event) => {
            event.stopPropagation();
            menu.toggle();
          }}
          style={rowIconButtonStyle}
          type="button"
          {...menu.triggerAria}
        >
          ⋯
        </button>
      </span>
      {menu.open ? (
        <SessionActionsMenu
          close={menu.close}
          onDeleteActivity={() => setDeletingActivity(true)}
          onRename={() => {
            menu.close();
            setEditing(true);
          }}
          removal={removal}
          sessionId={sessionId}
          worktreePath={session.worktreePath}
        />
      ) : null}
      {removal.confirming ? (
        <div
          data-no-dnd="true"
          data-testid={`confirm-remove-worktree-${sessionId}`}
          style={menuStyle}
        >
          <span style={confirmTextStyle}>
            Uncommitted changes in this worktree will be lost. The branch and
            its commits are kept.
          </span>
          <button
            className="kr-hover-surface"
            data-testid={`confirm-remove-worktree-go-${sessionId}`}
            onClick={(event) => {
              event.stopPropagation();
              removal.remove(true).catch(() => {
                // Failures surface via a toast inside the removal flow.
              });
            }}
            style={{ ...menuItemStyle, color: tokens.color.status.error }}
            type="button"
          >
            Discard changes & remove
          </button>
          <button
            className="kr-hover-surface"
            onClick={(event) => {
              event.stopPropagation();
              removal.cancel();
            }}
            style={menuItemStyle}
            type="button"
          >
            Cancel
          </button>
        </div>
      ) : null}
      {confirmingClose && closeConfirm ? (
        <SessionCloseConfirm
          body={closeConfirm.body}
          confirmLabel={closeConfirm.confirmLabel}
          details={closeConfirm.details}
          onCancel={() => setConfirmingClose(false)}
          onConfirm={() => {
            setConfirmingClose(false);
            onCloseSession(sessionId);
          }}
          sessionTitle={session.title}
        />
      ) : null}
      {deletingActivity ? (
        <DeleteActivityConfirm
          onClose={() => setDeletingActivity(false)}
          sessionId={sessionId}
          sessionTitle={session.title}
        />
      ) : null}
    </div>
  );
});
