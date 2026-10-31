import { ChevronsDownUp, ChevronsUpDown, RotateCw } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { useChanges } from "../state/changes.ts";
import { iconButton } from "../theme/recipes.ts";
import { accentAlpha, tokens } from "../theme/tokens.ts";
import type { DiffTotals } from "../types.ts";

/** Below this age, the fetch is fresh enough that no "updated Xs ago" label
 * shows at all. */
const STALE_THRESHOLD_MS = 10_000;

/** How often the "updated Xs ago" label re-renders on its own, so it ticks
 * live rather than freezing at whatever it read on mount/last unrelated
 * re-render. */
const TICK_INTERVAL_MS = 1000;

/** "updated 45s ago" / "updated 3m ago" — minutes once seconds roll over. */
function formatAgo(elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) {
    return `updated ${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  return `updated ${minutes}m ago`;
}

/** The pulse's resting vs. lit background — a brief accent tint fading back
 * to the ordinary surface, driven by `transition` rather than a `@keyframes`
 * animation: `pulsing` is a plain boolean the parent flips on and off around
 * a timeout, so a CSS transition (which just animates toward whatever the
 * current value is) is all it takes, no animation lifecycle to coordinate. */
function rootStyle(pulsing: boolean): CSSProperties {
  return {
    alignItems: "center",
    // Untinted at rest: on a plane this flat a permanent surface wash reads
    // as a second, competing header. The bar is told from the feed by its
    // hairline and its 46px, and the only time it carries a fill is the
    // pulse below.
    background: pulsing ? accentAlpha(0.14) : "transparent",
    borderBottom: `1px solid ${tokens.color.line.soft}`,
    display: "flex",
    flex: "none",
    fontFamily: tokens.font.sans,
    gap: tokens.space.sm,
    height: "40px",
    padding: `0 ${tokens.space.md}`,
    transition: `background-color ${tokens.motion.hover}`,
  };
}

/** Nothing in the bar wraps: a narrow column clips the comparison label
 * (it has a tooltip) and keeps every other piece whole on one line. */
const oneLine: CSSProperties = { flex: "none", whiteSpace: "nowrap" };

const totalsStyle: CSSProperties = {
  ...oneLine,
  alignItems: "baseline",
  color: tokens.color.ink.primary,
  display: "flex",
  fontSize: "12.5px",
  fontWeight: 500,
  gap: "8px",
};

const countsStyle: CSSProperties = {
  display: "flex",
  fontFamily: tokens.font.mono,
  fontSize: "11.5px",
  fontWeight: 400,
  gap: "6px",
};

const addStyle: CSSProperties = { color: tokens.color.add };
const delStyle: CSSProperties = { color: tokens.color.del };

/** "since session start" — read, not decoration, so `muted`, not `faint`
 * (ADR-0023). The only piece that gives way when space runs out. */
const baselineStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  cursor: "default",
  fontSize: "12px",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const spacerStyle: CSSProperties = { flex: 1, minWidth: tokens.space.sm };

const staleStyle: CSSProperties = {
  ...oneLine,
  color: tokens.color.ink.muted,
  fontSize: "11.5px",
};

const iconButtonStyle: CSSProperties = {
  ...iconButton(),
  height: "26px",
  width: "26px",
};

const dividerStyle: CSSProperties = {
  alignSelf: "center",
  background: tokens.color.line.soft,
  flex: "none",
  height: "16px",
  width: "1px",
};

const toggleLabelStyle: CSSProperties = {
  ...oneLine,
  alignItems: "center",
  color: tokens.color.ink.muted,
  cursor: "pointer",
  display: "flex",
  fontSize: "12px",
  gap: "8px",
};

/** The switch's track — accent-filled when on, and off the same sunken well
 * every other input sits in, so "off" reads as an empty groove. */
function switchTrackStyle(checked: boolean): CSSProperties {
  return {
    background: checked ? tokens.color.accent : tokens.color.inputWell,
    border: `1px solid ${tokens.color.line.base}`,
    borderRadius: tokens.radius.pill,
    cursor: "pointer",
    display: "inline-flex",
    flex: "none",
    height: "16px",
    padding: "1px",
    transition: `background-color ${tokens.motion.hover}`,
    width: "28px",
  };
}

function switchThumbStyle(checked: boolean): CSSProperties {
  return {
    background: tokens.color.onAccent,
    borderRadius: "50%",
    height: "12px",
    transform: checked ? "translateX(12px)" : "translateX(0)",
    transition: `transform ${tokens.motion.hover}`,
    width: "12px",
  };
}

function filesChangedLabel(files: number): string {
  return `${files} file${files === 1 ? "" : "s"} changed`;
}

/** The tooltip on the comparison label: the exact point, and how fresh. */
function baselineTitle(
  label: string | undefined,
  fetchedAt: number | undefined,
  now: number
): string {
  const lines = label ? [`Compared with ${label}`] : [];
  if (fetchedAt) {
    lines.push(formatAgo(Math.max(0, now - fetchedAt)));
  }
  return lines.join("\n");
}

/**
 * The Code Changes View's header strip: totals ("4 files changed +59 −11"),
 * the diff's trust-anchoring baseline label (verbatim from the store — see
 * `computeBaselineLabel` in `state/changes.ts`, never recomputed here), a
 * manual refresh button, and a staleness hint once the last *successful*
 * fetch (`entry.fetchedAt` — never advanced by a failed one, see its doc
 * comment in `state/changes.ts`) is more than {@link STALE_THRESHOLD_MS}
 * old. That hint ticks live off its own clock rather than the fetch time
 * frozen at whatever render last happened to run.
 *
 * `pulsing` is a purely presentational flag `ChangesView` sets for a moment
 * after a refresh lands while the diff feed was scrolled away from the top
 * (see `DiffFeed`'s `onSilentRefresh`): the new content landed off-screen,
 * so this briefly tints the bar as the only visible sign anything changed,
 * instead of the feed jumping to show it.
 *
 * `isVisible` (default `true`, so a caller that doesn't care about this
 * still gets the old always-on behavior) gates the live "updated Xs ago"
 * ticker: `ChangesView` is never unmounted, only display-toggled (see
 * `SessionPane`), so without this every open session would run its own
 * unconditional 1s `setInterval` forever, ticking a bar nobody is looking
 * at. The ticker only runs while both this pane is actually on screen *and*
 * there's a fetch timestamp to measure staleness against — nothing to tick
 * for otherwise.
 *
 * `totals` (I5, round-two review, BLOCKER) is the [Changes view model]'s
 * on-screen totals, not this bar's own reading of `entry.totals`. The
 * difference matters the moment the "My edits only" filter is on: `entry.totals`
 * is computed from the unfiltered `visibleFiles` while
 * `FileTreePane`/`DiffFeed`/`JumpRail` all render the filtered subset, so this
 * header used to read e.g. "12 files changed +300 −40" directly above a feed
 * showing 3 files, same label, no indication of the discrepancy. Being handed
 * the number rather than deciding it here is what keeps the bar describing
 * exactly the population every other surface in the view is showing — one
 * number, one meaning, decided once in `state/changesView.ts`. Optional, and
 * falling back to `entry.totals`, so a caller that doesn't care about the
 * filter still gets the honest whole-diff totals (mirroring `isVisible`).
 */
export function SummaryBar({
  baselineLabel,
  comparedTo,
  diffControls = true,
  editsToggle,
  isVisible = true,
  onRefresh,
  paths,
  pulsing = false,
  sessionId,
  totals: displayTotals,
}: {
  /** What the diff on screen is measured against, from the active scope;
   * falls back to the session diff's own label. */
  baselineLabel?: string;
  /** The same comparison in plain words, shown in the bar; falls back to the
   * session diff's own. */
  comparedTo?: string;
  /** The AI changes tab's "Only Claude's edits" switch, when it applies. */
  editsToggle?: { checked: boolean; onToggle: () => void };
  /** Whether the diff feed is what's below — its Collapse all / Expand all
   * only mean something then. With a file open in the editor they are left
   * out rather than offered to do nothing. */
  diffControls?: boolean;
  isVisible?: boolean;
  onRefresh: () => void;
  /** The files the scope on screen lists — what Collapse all and Expand all
   * act on. Without it they act on the whole session diff. */
  paths?: readonly string[];
  pulsing?: boolean;
  sessionId: string;
  totals?: DiffTotals | null;
}) {
  const entry = useChanges((s) => s.bySession[sessionId]);
  const setAllCollapsed = useChanges((s) => s.setAllCollapsed);
  const totals = displayTotals ?? entry?.totals;
  const loading = entry?.status === "loading";
  const fetchedAt = entry?.fetchedAt;
  const hasFiles = paths
    ? paths.length > 0
    : Boolean(entry?.diff?.files.length);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!(isVisible && fetchedAt)) {
      return;
    }
    // Resync immediately on (re)start — becoming visible again, or a new
    // fetch landing — instead of waiting up to a full tick for `now` to
    // catch up from whenever it was last frozen.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [isVisible, fetchedAt]);

  const elapsed = entry?.fetchedAt ? now - entry.fetchedAt : 0;
  const showStale = Boolean(entry?.fetchedAt) && elapsed > STALE_THRESHOLD_MS;

  const label = baselineLabel ?? entry?.baselineLabel;
  const files = totals?.files ?? 0;

  return (
    <div
      data-pulsing={pulsing}
      data-testid="summary-bar"
      style={rootStyle(pulsing)}
    >
      <span data-testid="summary-totals" style={totalsStyle}>
        {totals && files === 0 ? "No changes" : filesChangedLabel(files)}
        {totals && files > 0 ? (
          <span style={countsStyle}>
            <span style={addStyle}>+{totals.additions}</span>
            <span style={delStyle}>−{totals.deletions}</span>
          </span>
        ) : null}
      </span>
      <span
        data-testid="summary-baseline"
        style={baselineStyle}
        title={baselineTitle(label, fetchedAt, now)}
      >
        {comparedTo || entry?.comparedTo || label}
      </span>
      <span style={spacerStyle} />
      {showStale && entry ? (
        <span data-testid="summary-stale" style={staleStyle}>
          {formatAgo(elapsed)}
        </span>
      ) : null}
      {editsToggle ? (
        // A `<label>`, so the visible text is the switch's accessible name
        // and clicking it toggles too — a bigger target than the track.
        <label style={toggleLabelStyle}>
          <button
            aria-checked={editsToggle.checked}
            data-testid="my-edits-only-toggle"
            onClick={editsToggle.onToggle}
            role="switch"
            style={switchTrackStyle(editsToggle.checked)}
            type="button"
          >
            <span style={switchThumbStyle(editsToggle.checked)} />
          </button>
          <span>Only Claude's edits</span>
        </label>
      ) : null}
      {editsToggle ? <span aria-hidden style={dividerStyle} /> : null}
      {diffControls ? (
        <>
          <button
            aria-label="Collapse all"
            className="kr-hover-surface"
            data-testid="summary-collapse-all"
            disabled={!hasFiles}
            onClick={() => setAllCollapsed(sessionId, true, paths)}
            style={iconButtonStyle}
            title="Collapse all"
            type="button"
          >
            <ChevronsDownUp size={15} strokeWidth={1.75} />
          </button>
          <button
            aria-label="Expand all"
            className="kr-hover-surface"
            data-testid="summary-expand-all"
            disabled={!hasFiles}
            onClick={() => setAllCollapsed(sessionId, false, paths)}
            style={iconButtonStyle}
            title="Expand all"
            type="button"
          >
            <ChevronsUpDown size={15} strokeWidth={1.75} />
          </button>
        </>
      ) : null}
      <button
        aria-label="Refresh"
        className="kr-hover-surface"
        data-testid="summary-refresh"
        disabled={loading}
        onClick={onRefresh}
        style={iconButtonStyle}
        title={loading ? "Refreshing…" : "Refresh"}
        type="button"
      >
        <RotateCw size={14} strokeWidth={1.75} />
      </button>
    </div>
  );
}
