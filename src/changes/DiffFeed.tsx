import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type CSSProperties,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import {
  EMPTY_COLLAPSED,
  isEditableFile,
  selectCollapsed,
  useChanges,
} from "../state/changes.ts";
import { EMPTY_TOUCHED_RELATIVE } from "../state/sessions.ts";
import { tokens } from "../theme/tokens.ts";
import type { FileDiff } from "../types.ts";
import { DiffFileCard } from "./DiffFileCard.tsx";

const OVERSCAN = 4;
/** Rough per-card height before it's measured for real; only affects the
 * scrollbar's initial size estimate, never what's rendered. */
const ESTIMATED_CARD_HEIGHT = 220;

/** Ratio steps the viewport-intersection observer fires callbacks at, so a
 * card's "how visible is it right now" ratio is known at more than just the
 * enter/exit edges — the jump rail's active dot picks the most-visible
 * intersecting card, which needs that granularity to track scrolling. */
const INTERSECTION_THRESHOLDS = [0, 0.25, 0.5, 0.75, 1];

/** Stable DOM id for a file's card — set on the rendered card, but not a
 * public jump mechanism: a virtualized card outside the rendered range
 * doesn't exist in the DOM yet, so jumping goes through
 * {@link DiffFeedHandle.scrollToFile} instead (see below). Nothing queries
 * this id — it exists only as a stable DOM anchor; `data-diff-path` below is
 * the attribute callers (and tests) should actually query by. */
function diffFileElementId(sessionId: string, path: string): string {
  return `diff-file-${sessionId}-${path}`;
}

/** Imperative jump handle a tree row drives to bring an off-screen file's
 * card into view — necessary because the feed is virtualized, so
 * `scrollIntoView` on a not-yet-rendered card is a silent no-op. */
export interface DiffFeedHandle {
  /** Scroll so `path`'s card is in view, via the virtualizer's own
   * `scrollToIndex` (which renders the item before scrolling to it, unlike
   * DOM-id lookups that only work for cards already in the DOM). No-ops if
   * `path` isn't in the current `files` list. */
  scrollToFile: (path: string) => void;
}

const scrollStyle: CSSProperties = {
  height: "100%",
  overflowY: "auto",
};

function railStyle(totalSize: number): CSSProperties {
  return {
    height: `${totalSize}px`,
    position: "relative",
    width: "100%",
  };
}

/**
 * `paddingBottom` (not `marginBottom`) on the same absolutely-positioned,
 * `translateY`-driven div the virtualizer measures via `measureElement`:
 * margin on an out-of-flow box positioned this way never affects layout and
 * is invisible in the real app, while padding is part of `offsetHeight`
 * (border-box) — the exact metric the virtualizer measures with — so it
 * both renders and is accounted for in the next item's offset.
 */
function itemStyle(start: number): CSSProperties {
  return {
    left: 0,
    paddingBottom: tokens.space.md,
    position: "absolute",
    top: 0,
    transform: `translateY(${start}px)`,
    width: "100%",
  };
}

/**
 * Virtualized feed of {@link DiffFileCard}s for one session's diff. Reads
 * and writes each file's collapse state through the changes store
 * (`bySession[sessionId].collapsed`), falling back to the auto-collapse
 * default for any file the user hasn't toggled explicitly — via the store's
 * `selectCollapsed`, the single source of truth for a file's *effective*
 * collapsed state (never read `collapsed[path]` directly: it's `undefined`
 * until the user's first toggle).
 *
 * Also drives the jump rail's viewed/active state (Task 10) via an
 * `IntersectionObserver` rooted at the scroll container, observing each
 * rendered card as it mounts/unmounts. This has to live here rather than in
 * the rail itself: virtualization means only cards near the viewport exist
 * in the DOM at all, so a rail-owned observer watching *all* files would
 * simply never see the ones scrolled far away — but that is exactly what an
 * observer scoped to whatever DiffFeed happens to have mounted gets right
 * for free. A card intersecting at all marks its file `viewed` in the
 * store (persists past the observer's reach once the card unmounts again);
 * the single most-visible currently-intersecting card (highest
 * `intersectionRatio`) is reported upward as the "active" file via
 * `onActiveFileChange`, which by construction can only ever be a file whose
 * card is actually on screen right now.
 */
export function DiffFeed({
  files,
  onActiveFileChange,
  onEditFile,
  onSilentRefresh,
  ref,
  sessionId,
  touchedRelative = EMPTY_TOUCHED_RELATIVE,
}: {
  files: FileDiff[];
  /** Called with the currently most-visible intersecting file's path, or
   * `null` once nothing intersects — the jump rail's "you are here" dot. */
  onActiveFileChange?: (path: string | null) => void;
  /** Called with a file's path when its card's "Edit file" button is
   * clicked — `ChangesView` wires this to opening that path in the editor.
   * Undefined renders no edit button on any card; a card whose file
   * {@link isEditableFile} rejects renders none either way. */
  onEditFile?: (path: string) => void;
  /** Called when a refresh actually lands new content for this session (a
   * fresh `bySession[id].diff` object — see `doRefresh` in
   * `state/changesRefresh.ts`) while the feed was scrolled away from the top.
   * `ChangesView` uses this to pulse the summary bar: the refreshed content
   * landed off-screen, so the pulse is the only visible sign anything
   * changed, in place of scrolling the feed to show it. Never called for the
   * initial mount (nothing to compare against yet), a refresh landing at the
   * top (nothing to preserve, nothing worth flagging), or a purely local
   * change to the `files` prop that re-slices the same diff (the "My edits
   * only" filter — no remote content arrived). */
  onSilentRefresh?: () => void;
  ref?: Ref<DiffFeedHandle>;
  sessionId: string;
  /** Repo-relative paths this session's own edit tools touched (see
   * `sessionTouchedRelative` in `state/sessions.ts`) — drives each card's
   * "✎ this session" badge. Defaults to the empty set, so a caller that
   * doesn't pass it renders no badges at all. */
  touchedRelative?: Set<string>;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const collapsedMap = useChanges(
    (s) => s.bySession[sessionId]?.collapsed ?? EMPTY_COLLAPSED
  );
  const toggleCollapsed = useChanges((s) => s.toggleCollapsed);
  const markViewed = useChanges((s) => s.markViewed);
  // The "did new content actually arrive?" signal, and deliberately not the
  // `files` prop's identity: `files` is `ChangesView`'s `displayFiles`, which
  // also gets a fresh array whenever a purely local view change re-slices the
  // same diff (the "My edits only" filter) — pulsing the summary bar for that
  // would signal a refresh that never happened. `bySession[id].diff` is a new
  // object only on a *successful* fetch (see `doRefresh` in
  // `state/changesRefresh.ts`; a failed one keeps the previous object), which is
  // exactly the condition the pulse means.
  const fetchedDiff = useChanges((s) => s.bySession[sessionId]?.diff);

  // One stable, path-taking toggle handler shared by every card, so a memoized
  // `DiffFileCard` isn't handed a fresh `() => …` closure per render (which
  // would re-render every visible card on every scroll frame).
  const handleToggle = useCallback(
    (path: string) => toggleCollapsed(sessionId, path),
    [toggleCollapsed, sessionId]
  );
  // Same stability requirement as `handleToggle` above, for the same reason:
  // one shared callback per `onEditFile` identity, not a fresh `() =>
  // onEditFile(file.path)` closure built per card on every render (which
  // would defeat `DiffFileCard`'s memoization on every scroll frame). Kept
  // separate from `onEdit` below (rather than always passing `handleEdit`)
  // so a caller that omits `onEditFile` still gets no edit button at all,
  // instead of one wired to a no-op.
  const handleEdit = useCallback(
    (path: string) => onEditFile?.(path),
    [onEditFile]
  );

  const virtualizer = useVirtualizer({
    count: files.length,
    estimateSize: () => ESTIMATED_CARD_HEIGHT,
    getScrollElement: () => parentRef.current,
    // Key each virtual item by its file path, not its index: `files` gets a
    // new array on every refresh, and a path key lets React reconcile a card
    // to the same file across that change (correct collapse/measure identity)
    // even when files are added, removed, or reordered.
    getItemKey: (index) => files[index].path,
    overscan: OVERSCAN,
  });

  // `files` gets a brand-new array identity on every refresh (see
  // `doRefresh` in `state/changesRefresh.ts`), success or not. Explicitly restore
  // the virtualizer's own scroll offset across that transition rather than
  // trusting it to hold on its own — defense against a shorter diff (or any
  // future change to how the feed is gated on `status`) silently dragging
  // the visible position back toward the top. A no-op scrollToOffset call
  // to the offset the feed is already at is harmless, so this runs on every
  // files change rather than only ones that turn out to need it.
  const onSilentRefreshRef = useRef(onSilentRefresh);
  onSilentRefreshRef.current = onSilentRefresh;
  const prevFilesRef = useRef(files);
  const prevFetchedDiffRef = useRef(fetchedDiff);
  useEffect(() => {
    const filesChanged = prevFilesRef.current !== files;
    prevFilesRef.current = files;
    const contentArrived = prevFetchedDiffRef.current !== fetchedDiff;
    prevFetchedDiffRef.current = fetchedDiff;
    // Skip the initial mount (nothing to compare against) and anything
    // landing while already at the top — there's no scroll worth preserving
    // and no reason to pulse the summary bar for an update the user can
    // already see.
    if ((virtualizer.scrollOffset ?? 0) <= 0) {
      return;
    }
    if (filesChanged) {
      virtualizer.scrollToOffset(virtualizer.scrollOffset ?? 0, {
        align: "start",
      });
    }
    // Only a genuinely new diff counts as "content arrived off screen" — a
    // local re-slice of the same diff restores scroll above but stays silent.
    if (contentArrived) {
      onSilentRefreshRef.current?.();
    }
  }, [files, fetchedDiff, virtualizer]);

  // path → currently-mounted card element, so a card that remounts at the
  // same path (scrolled away and back) is unobserved/re-observed correctly,
  // and so cards mounted before the observer itself exists (see the effect
  // below) can be observed retroactively.
  const observedElsRef = useRef<Map<string, Element>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const intersectingRatiosRef = useRef<Map<string, number>>(new Map());
  const activeFileRef = useRef<string | null>(null);
  const onActiveFileChangeRef = useRef(onActiveFileChange);
  onActiveFileChangeRef.current = onActiveFileChange;

  // Ref callbacks (below) run during commit, before this effect — on first
  // mount they land in `observedElsRef` with no observer yet to hand them
  // to. Creating the observer here (once the scroll container itself is
  // mounted, needed as `root`) and observing whatever's already in the map
  // catches that first batch; every card mounted after this point is
  // observed directly by the ref callback instead.
  useEffect(() => {
    const root = parentRef.current;
    if (!root) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const path = (entry.target as HTMLElement).dataset.diffPath;
          if (!path) {
            continue;
          }
          if (entry.isIntersecting) {
            intersectingRatiosRef.current.set(path, entry.intersectionRatio);
            markViewed(sessionId, path);
          } else {
            intersectingRatiosRef.current.delete(path);
          }
        }
        let bestPath: string | null = null;
        let bestRatio = 0;
        for (const [path, ratio] of intersectingRatiosRef.current) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestPath = path;
          }
        }
        if (bestPath !== activeFileRef.current) {
          activeFileRef.current = bestPath;
          onActiveFileChangeRef.current?.(bestPath);
        }
      },
      { root, threshold: INTERSECTION_THRESHOLDS }
    );
    observerRef.current = observer;
    for (const el of observedElsRef.current.values()) {
      observer.observe(el);
    }
    return () => {
      observer.disconnect();
      observerRef.current = null;
      intersectingRatiosRef.current.clear();
      activeFileRef.current = null;
    };
  }, [sessionId, markViewed]);

  const observeCard = useCallback((path: string, el: HTMLDivElement | null) => {
    const prev = observedElsRef.current.get(path);
    if (prev && prev !== el) {
      observerRef.current?.unobserve(prev);
      intersectingRatiosRef.current.delete(path);
    }
    if (el) {
      observedElsRef.current.set(path, el);
      observerRef.current?.observe(el);
    } else {
      observedElsRef.current.delete(path);
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      scrollToFile: (path: string) => {
        const index = files.findIndex((f) => f.path === path);
        if (index !== -1) {
          virtualizer.scrollToIndex(index, {
            align: "start",
            behavior: "smooth",
          });
        }
      },
    }),
    [files, virtualizer]
  );

  return (
    <div data-testid="diff-feed" ref={parentRef} style={scrollStyle}>
      <div style={railStyle(virtualizer.getTotalSize())}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const file = files[virtualRow.index];
          const collapsed = selectCollapsed(collapsedMap, file);
          return (
            <div
              data-diff-path={file.path}
              data-index={virtualRow.index}
              id={diffFileElementId(sessionId, file.path)}
              key={virtualRow.key}
              ref={(el) => {
                virtualizer.measureElement(el);
                observeCard(file.path, el);
              }}
              style={itemStyle(virtualRow.start)}
            >
              <DiffFileCard
                collapsed={collapsed}
                file={file}
                onEdit={
                  onEditFile && isEditableFile(file) ? handleEdit : undefined
                }
                onToggle={handleToggle}
                touchedBySession={touchedRelative.has(file.path)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
