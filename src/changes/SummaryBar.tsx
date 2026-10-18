import { type CSSProperties, useEffect, useState } from "react";
import { useChanges } from "../state/changes.ts";
import { button } from "../theme/recipes.ts";
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
    gap: tokens.space.md,
    height: "46px",
    padding: `0 ${tokens.space.md}`,
    transition: `background-color ${tokens.motion.hover}`,
  };
}

const totalsStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  fontSize: "12.5px",
};

const addStyle: CSSProperties = {
  color: tokens.color.add,
  fontFamily: tokens.font.mono,
};

const delStyle: CSSProperties = {
  color: tokens.color.del,
  fontFamily: tokens.font.mono,
};

/** The baseline and staleness labels are read, not decoration, so they sit at
 * `muted` — `faint` is below AA on this plane (ADR-0023). */
const baselineStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.mono,
  fontSize: "11.5px",
};

const spacerStyle: CSSProperties = { flex: 1 };

const staleStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.mono,
  fontSize: "11px",
};

const refreshButtonStyle: CSSProperties = button("secondary", "sm");

/** The outline-mode controls: quieter than the refresh button (ghost, no
 * border) since they're a secondary affordance next to it. */
const collapseButtonStyle: CSSProperties = button("ghost", "sm");

function filesChangedLabel(files: number): string {
  return `${files} file${files === 1 ? "" : "s"} changed`;
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
  isVisible = true,
  onRefresh,
  pulsing = false,
  sessionId,
  totals: displayTotals,
}: {
  isVisible?: boolean;
  onRefresh: () => void;
  pulsing?: boolean;
  sessionId: string;
  totals?: DiffTotals | null;
}) {
  const entry = useChanges((s) => s.bySession[sessionId]);
  const setAllCollapsed = useChanges((s) => s.setAllCollapsed);
  const totals = displayTotals ?? entry?.totals;
  const loading = entry?.status === "loading";
  const fetchedAt = entry?.fetchedAt;
  const hasFiles = Boolean(entry?.diff?.files.length);

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

  return (
    <div
      data-pulsing={pulsing}
      data-testid="summary-bar"
      style={rootStyle(pulsing)}
    >
      <span data-testid="summary-totals" style={totalsStyle}>
        {filesChangedLabel(totals?.files ?? 0)}
        {totals ? (
          <>
            {"  "}
            <span style={addStyle}>+{totals.additions}</span>{" "}
            <span style={delStyle}>−{totals.deletions}</span>
          </>
        ) : null}
      </span>
      <span data-testid="summary-baseline" style={baselineStyle}>
        {entry?.baselineLabel}
      </span>
      <span style={spacerStyle} />
      {showStale && entry ? (
        <span data-testid="summary-stale" style={staleStyle}>
          {formatAgo(elapsed)}
        </span>
      ) : null}
      <button
        className="kr-hover-surface"
        data-testid="summary-collapse-all"
        disabled={!hasFiles}
        onClick={() => setAllCollapsed(sessionId, true)}
        style={collapseButtonStyle}
        type="button"
      >
        Collapse all
      </button>
      <button
        className="kr-hover-surface"
        data-testid="summary-expand-all"
        disabled={!hasFiles}
        onClick={() => setAllCollapsed(sessionId, false)}
        style={collapseButtonStyle}
        type="button"
      >
        Expand all
      </button>
      <button
        className="kr-hover-surface"
        data-testid="summary-refresh"
        disabled={loading}
        onClick={onRefresh}
        style={refreshButtonStyle}
        type="button"
      >
        {loading ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}
