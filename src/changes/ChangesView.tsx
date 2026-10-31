import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { scopeWantsUncommitted, useChanges } from "../state/changes.ts";
import { type RefreshReason, requestRefresh } from "../state/changesRefresh.ts";
import {
  type ChangesViewModel,
  changesView,
  cwdRelativePath,
  forgetChangesView,
} from "../state/changesView.ts";
import { useLayout } from "../state/layout.ts";
import {
  sessionClaudeFiles,
  sessionTouchedRelative,
  sessionWorkingDir,
  useSessions,
} from "../state/sessions.ts";
import { useRepoView } from "../state/useActiveSession.ts";
import { tokens } from "../theme/tokens.ts";
import { BudgetNotice } from "./BudgetNotice.tsx";
import { DiffFeed, type DiffFeedHandle } from "./DiffFeed.tsx";
import { FileBrowserTree } from "./FileBrowserTree.tsx";
import { FileTreePane } from "./FileTreePane.tsx";
import { FileViewer } from "./FileViewer.tsx";
import { JumpRail } from "./JumpRail.tsx";
import { SummaryBar } from "./SummaryBar.tsx";

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  minHeight: 0,
};

const bodyStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  minHeight: 0,
};

// Layout: tree (user-resizable, `fileTreeWidth` in the layout) | feed flex |
// jump rail 26px (JumpRail's JUMP_RAIL_WIDTH) — the feed takes whatever width
// is left between the two.
const feedStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  minWidth: 0,
};

/** DiffFeed must stay mounted even while FileViewer is showing (the pane
 * keep-alive rule: unmounting it would lose the virtualizer's scroll
 * state) — so it's always rendered, just display-toggled against a
 * `FileViewer` sibling rather than swapped out. */
function diffFeedWrapStyle(hidden: boolean): CSSProperties {
  return { display: hidden ? "none" : "block", height: "100%" };
}

/** What the pending-jump effect should do about the requested path. */
type JumpPlan =
  | "clear-filter"
  | "drop"
  | "hold"
  | "open"
  | "scroll"
  | "show-feed";

/** Exactly the [Changes view model] fields {@link planJump} reads — a `Pick`
 * rather than the whole model, so the effect below can list them as its deps
 * and stay unaffected by a view change it doesn't care about (a dirty dot
 * appearing, the totals moving). */
type JumpContext = Pick<
  ChangesViewModel,
  | "displayFiles"
  | "editsFilterActive"
  | "files"
  | "loadedOnce"
  | "showViewer"
  | "tab"
>;

/**
 * Decides a pending jump's fate against what the view can currently show —
 * pure, and pulled out of `ChangesView` both to keep the component within
 * this repo's Biome complexity budget and because this is the one branchy
 * piece of the view worth reading on its own.
 *
 * Membership is resolved against the unfiltered `files`, not `displayFiles`:
 * a jump target the My-edits-only filter is hiding is still a real file in
 * the diff. The outcomes:
 *
 * - `"open"` — a file is open in the editor, so the diff is hidden behind
 *   it. Clicking a changed file opens it; a jump to one does the same, and
 *   the viewer's own switch guard keeps an unsaved draft safe.
 * - `"show-feed"` — another scope is on screen: All changes lists a
 *   different diff, and on Files `DiffFeed` is hidden behind `FileViewer`
 *   (`scrollToFile` on a hidden virtualizer is a silent no-op). A jump names
 *   a file of the session diff, so the caller flips the tab back to AI
 *   changes ("changes") and leaves the request pending for the next run. Deliberately
 *   never "clear `selectedFile`": both make the feed visible, but
 *   `selectedFile` surviving a tab flip is the documented contract that
 *   keeps the viewer's draft/cursor/scroll alive (see its doc comment in
 *   `state/changes.ts`), so clearing it would destroy an in-progress edit as
 *   a side effect of jumping to another file. Flipping the tab is exactly
 *   what a user clicking "Changes" would do.
 * - `"clear-filter"` — the target is real but the My-edits-only filter is
 *   hiding its card, so it isn't in the DOM to scroll to. A click from the
 *   Inspector is a request to see that file, not to keep the rest of the
 *   feed hidden, so the caller clears the filter and lets the next run
 *   scroll.
 * - `"scroll"` — reachable: scroll to it and consume the request.
 * - `"drop"` — a diff has loaded and genuinely doesn't contain the path (it
 *   left the changeset between the sidebar rendering and the click). Held
 *   any longer, a later unrelated refresh that happened to include a file at
 *   the same path would auto-scroll the pane with no user action behind it.
 * - `"hold"` — nothing has loaded for this session yet, so a miss means
 *   "not fetched", not "absent": keep the request pending.
 */
function planJump(view: JumpContext, path: string): JumpPlan {
  if (!view.files.some((f) => f.path === path)) {
    return view.loadedOnce ? "drop" : "hold";
  }
  if (view.showViewer) {
    return "open";
  }
  if (view.tab !== "changes") {
    return "show-feed";
  }
  if (
    view.editsFilterActive &&
    !view.displayFiles.some((f) => f.path === path)
  ) {
    return "clear-filter";
  }
  return "scroll";
}

// Mirrors ReviewPanel's `mutedStyle` convention for status text (faint ink,
// 12.5px) — just adapted to a block placement rather than sitting inline
// next to a button.
const noticeStyle: CSSProperties = {
  // `muted`, not `faint`: when one of these is showing it is the only thing
  // in the column, so it is by definition being read (ADR-0023's AA note).
  color: tokens.color.ink.muted,
  fontSize: "12.5px",
  padding: tokens.space.lg,
};

const errorBannerStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "12.5px",
  padding: `${tokens.space.sm} ${tokens.space.md}`,
};

/** How long `SummaryBar`'s pulse stays lit after a silent refresh, before
 * fading back out — a UI-timing constant, not a design token (`tokens.motion`
 * holds CSS transition strings for styling, not raw millisecond durations for
 * a JS timer); mirrors `CHANGES_REFRESH_DEBOUNCE_MS` in `state/changesRefresh.ts`. */
const PULSE_HOLD_MS = 900;

/** What the empty pane says when git has no view of the working directory. */
const NOT_A_REPO =
  "Not a git repository — Kriyon reads changes from git, so nothing here is tracked.";

/**
 * Top-level Code Changes View layout for one session: the directory tree,
 * the virtualized diff feed, and the summary bar, wired to the session's
 * working directory and the `changes` store.
 *
 * What to render is not decided here. `changesView` (`state/changesView.ts`)
 * resolves the whole [Changes view model] — the visible files, the filtered
 * display list, the totals that must describe exactly that list, and the one
 * `pane` naming what the diff column shows — and this component lays it out.
 * What *is* still owned here is everything with a lifetime: the fetch
 * trigger, the refresh pulse's timer, the lazily-latched All-files mount, and
 * the pending-jump effect.
 *
 * Base and baseline resolution are delegated entirely to
 * `refreshSessionChanges` in `state/changesRefresh.ts` — the same helper the
 * live-edit refresh path uses — rather than duplicated here: a worktree
 * session diffs against the repo's default branch, resolved via
 * `defaultBranch` from the project root (a worktree session's own `cwd` is
 * the worktree path itself, not the repo root, so the base name comes from
 * the `projects` store keyed by `projectId`); a plain session diffs against
 * `HEAD`. Either way, a session with a captured `baselineOid` routes through
 * the session-scoped `diffSessionChanges` instead (see `RefreshOptions` in
 * `state/changesRefresh.ts`) — sharing the one helper is what keeps this trigger,
 * the manual refresh button below, and the live-edit debounce from ever
 * disagreeing about which diff source a given session should use.
 *
 * Fetches this session's diff as soon as it *becomes the active session* —
 * not when its Changes tab becomes the one on screen. The Inspector's right
 * sidebar (`ChangedFilesList`) reads `visibleFiles(bySession[id]?.diff)`
 * unconditionally for whichever session is active, regardless of which
 * transcript tab is showing (Raw is the default — see `DEFAULT_LAYOUT` in
 * `state/layout.ts`), so gating the fetch on the Changes tab left that
 * sidebar empty for the common case: a live session the user has never
 * switched to Changes for, even though the aggregate `git status` count
 * right above it in the Inspector shows a nonzero total. Panes here are
 * never unmounted, only display-toggled (see `SessionPane`), so every open
 * session's `ChangesView` mounts once at session creation; the trigger below
 * still only fires for *this* session actually being the active one — a
 * background (warm-mounted, non-active) session's `ChangesView` never
 * fetches — which is what keeps this bounded to one `git diff` at a time
 * rather than one per open session at boot. `isVisible` (below) is a
 * narrower condition — active *and* the Changes tab — used only for work
 * that's genuinely wasted when nobody's looking at this pane (`SummaryBar`'s
 * live "updated Xs ago" ticker). The live-edit refresh path mirrors this
 * same active-session-only gate — see `scheduleChangesRefresh` in
 * `state/changesRefresh.ts`.
 */
export function ChangesView({ sessionId }: { sessionId: string }) {
  const isActiveSession = useSessions((s) => s.activeSessionId === sessionId);
  const transcriptView = useLayout((s) => s.layout.transcriptView);
  // Scalar/stable selectors, so an unrelated session-row update (a status
  // flip, a title landing) can't re-render this subtree. `cwd` is read as a
  // string rather than through the whole `UiSession`; `repoToplevel` resolves
  // once per session; and `sessionTouchedRelative` re-reads
  // `touchedFiles`/`repoToplevel` off the store itself (ignoring the snapshot
  // zustand hands the selector), returning the exact same `Set` instance
  // until one of those two fields actually changes — its own `WeakMap`
  // memoization, see `state/sessions.ts`.
  const cwd = useSessions((s) => {
    const session = s.sessions[sessionId];
    return session ? sessionWorkingDir(session) : "";
  });
  const repoToplevel = useSessions((s) => s.repoToplevel[sessionId] ?? "");
  // The same shared resource the Details rail and the header read, so this is
  // a third subscriber to one `git status`, not a third spawn of it.
  const repo = useRepoView(cwd);
  // For the "this session" badges on diff cards.
  const touchedRelative = useSessions(() => sessionTouchedRelative(sessionId));
  // For the AI changes filter: `null` while Claude's files can't be known,
  // so the filter stands down instead of hiding everything.
  const claudeFiles = useSessions(() => sessionClaudeFiles(sessionId));
  // The one subscription that replaced thirteen. `changesView` is memoized on
  // exactly the fields it reads (see `state/changesView.ts`), so the store
  // ticks this view doesn't care about — `setActiveFile` and `markViewed`,
  // both written on every card the user scrolls past — return the identical
  // object and re-render nothing.
  const view = useChanges((s) =>
    changesView(s, sessionId, {
      cwd,
      repoToplevel,
      touchedRelative: claudeFiles,
    })
  );
  // Release this session's memo entry when its pane goes away, so a closed
  // session's diff isn't retained here after `dropSession` drops it from the
  // store. The cache is keyed by session id (there is no single input object
  // that outlives every recompute to key it weakly on), which makes this the
  // one place that knows when an entry stops being needed.
  useEffect(() => () => forgetChangesView(sessionId), [sessionId]);
  const consumeJump = useChanges((s) => s.consumeJump);
  const setTab = useChanges((s) => s.setTab);
  const selectFile = useChanges((s) => s.selectFile);
  const toggleMyEditsOnly = useChanges((s) => s.toggleMyEditsOnly);
  const diffFeedRef = useRef<DiffFeedHandle>(null);
  // The file currently intersecting the diff feed's viewport (DiffFeed's own
  // IntersectionObserver reports it) lives in the changes store, not this
  // component's state: only `JumpRail` reads it, so keeping it here would
  // re-render this whole subtree (SummaryBar, FileTreePane, DiffFeed,
  // FileViewer) on every scroll-past-a-card. `setActiveFile` is a stable
  // store action, so passing it down doesn't subscribe this component to the
  // value it writes.
  const setActiveFile = useChanges((s) => s.setActiveFile);

  // Briefly lit by DiffFeed's `onSilentRefresh` — a refresh that landed
  // while the feed was scrolled away from the top, so the new content isn't
  // visible without this. Cleared by a timer rather than any store signal,
  // since it's a one-shot UI pulse, not state worth persisting.
  const [pulsing, setPulsing] = useState(false);
  const pulseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSilentRefresh = useCallback(() => {
    setPulsing(true);
    if (pulseTimeoutRef.current !== null) {
      clearTimeout(pulseTimeoutRef.current);
    }
    pulseTimeoutRef.current = setTimeout(() => {
      setPulsing(false);
      pulseTimeoutRef.current = null;
    }, PULSE_HOLD_MS);
  }, []);
  useEffect(
    () => () => {
      if (pulseTimeoutRef.current !== null) {
        clearTimeout(pulseTimeoutRef.current);
      }
    },
    []
  );

  // Shared by both `FileTreePane`'s tree rows and `DiffFeed`'s cards (see
  // `DiffFeed`'s own doc comment on `handleEdit`): a memoized `DiffFileCard`
  // needs this reference stable across a scroll re-render, not a fresh
  // inline arrow function rebuilt on every `ChangesView` render.
  //
  // The path both surfaces hand over is toplevel-relative; `FileViewer`
  // resolves against `cwd`. See {@link cwdRelativePath}. `repoToplevel` is
  // read off the store at click time rather than subscribed to: it changes
  // once per session and a subscription would only churn this callback's
  // identity (and with it every memoized card) for nothing.
  //
  // Opens the file beside whatever list is showing, without changing tabs —
  // the way an editor's git panel opens a changed file.
  const handleOpenFile = useCallback(
    (path: string) => {
      const toplevel = useSessions.getState().repoToplevel[sessionId] ?? "";
      selectFile(sessionId, cwdRelativePath(path, toplevel, cwd));
    },
    [selectFile, sessionId, cwd]
  );

  // Delegates entirely to the shared helper (see this component's top doc
  // comment) rather than resolving base/baseline here — both the mount/
  // became-active effect below and `SummaryBar`'s manual refresh button
  // call this same callback, so routing it through `refreshSessionChanges`
  // once is what keeps every trigger baseline-scoped together, instead of
  // only the live-edit path getting `session.baselineOid` threaded through.
  const doRefresh = useCallback(
    (reason: RefreshReason) => requestRefresh(sessionId, reason),
    [sessionId]
  );

  // This pane is actually on screen: the currently selected session, with
  // the Changes tab showing (mirrors `SessionPane`'s `showChanges` + the
  // outer `isActive` wrapper). Narrower than the fetch trigger below — see
  // this component's top doc comment for why the two must diverge.
  const isVisible = isActiveSession && transcriptView === "changes";

  // The fetch trigger: this session becoming the active one, independent of
  // which tab is showing (see the top doc comment). A background session's
  // `ChangesView` also runs this effect (it's mounted, just display:none),
  // but `isActiveSession` stays false for it, so it never fetches.
  const wasActiveRef = useRef(false);
  useEffect(() => {
    // Fire only on the rising edge (not-active → active), so an unrelated
    // re-render while already active never re-triggers a fetch, and
    // deactivating and reactivating (switching to another session and back)
    // is required before the next fetch — never on every render.
    if (isActiveSession && !wasActiveRef.current) {
      doRefresh("became-active");
    }
    wasActiveRef.current = isActiveSession;
  }, [isActiveSession, doRefresh]);

  // Latches true the first time this session's tab becomes "all", and never
  // resets — so `FileBrowserTree` mounts lazily (background sessions that
  // never visit the All-files tab never issue a `listDir` call) but, once
  // mounted, stays mounted for the rest of this pane's life. Set during
  // render (not an effect) via React's supported "adjust state while
  // rendering" pattern: `setState` with an unchanged value is a no-op, so
  // this only actually re-renders on the false→true transition, not on
  // every render while already true. Paired with `FileTreePane`'s
  // `subPaneStyle`, which display-toggles rather than conditionally renders
  // its "all" sub-pane — the two together are what let `FileBrowserTree`'s
  // listings cache survive a tab flip instead of refetching everything.
  const [filesTabMounted, setFilesTabMounted] = useState(view.tab === "all");
  if (view.tab === "all" && !filesTabMounted) {
    setFilesTabMounted(true);
  }

  // A jump requested from a sibling subtree (e.g. the Inspector) via the
  // `changes` store — see `pendingJump`'s doc comment for why it lives there
  // instead of on `SessionChanges`. A jump can be requested before the diff
  // has finished loading, so a miss on `files` alone doesn't drop it: only
  // once a diff has actually loaded for this session (`loadedOnce`) does a
  // miss mean the path is genuinely absent (e.g. it left the changeset
  // between the sidebar rendering and the click) rather than "not fetched
  // yet". Holding the request past that point would let a later, unrelated
  // refresh that happens to include a file at the same path auto-scroll the
  // pane with no user action behind it — so it's dropped here instead.
  //
  // See {@link planJump} for what each outcome means and why.
  // Deps are the fields `planJump` actually reads, not the whole `view`:
  // consuming a jump writes the store and so produces a new view, and
  // re-running this effect on that (or on an unrelated dirty dot) is churn at
  // best and a re-entrant jump at worst.
  const {
    displayFiles,
    editsFilterActive,
    files,
    loadedOnce,
    showViewer,
    tab,
  } = view;
  const { pendingJump } = view;
  useEffect(() => {
    if (pendingJump === undefined) {
      return;
    }
    const plan = planJump(
      { displayFiles, editsFilterActive, files, loadedOnce, showViewer, tab },
      pendingJump
    );
    if (plan === "open") {
      handleOpenFile(pendingJump);
      consumeJump(sessionId);
      return;
    }
    if (plan === "show-feed") {
      setTab(sessionId, "changes");
      return;
    }
    if (plan === "clear-filter") {
      toggleMyEditsOnly(sessionId);
      return;
    }
    if (plan === "hold") {
      return;
    }
    if (plan === "scroll") {
      diffFeedRef.current?.scrollToFile(pendingJump);
    }
    consumeJump(sessionId);
  }, [
    consumeJump,
    displayFiles,
    editsFilterActive,
    files,
    loadedOnce,
    pendingJump,
    sessionId,
    setTab,
    showViewer,
    tab,
    toggleMyEditsOnly,
    handleOpenFile,
  ]);

  // Opening a scope that lists uncommitted work (All changes, or Files for
  // its git colours) fetches it now rather than at the next refresh — the
  // routine refresh skips it while nobody is looking. Only on the switch
  // itself, so a failed fetch is not retried in a loop.
  const wantsUncommitted = scopeWantsUncommitted(tab);
  useEffect(() => {
    if (wantsUncommitted && isActiveSession) {
      requestRefresh(sessionId, "scope");
    }
  }, [wantsUncommitted, isActiveSession, sessionId]);

  return (
    <div data-testid="changes-view" style={rootStyle}>
      <SummaryBar
        baselineLabel={view.baselineLabel}
        comparedTo={view.comparedTo}
        diffControls={!view.showViewer}
        editsToggle={
          view.showEditsToggle
            ? {
                checked: view.myEditsOnly,
                onToggle: () => toggleMyEditsOnly(sessionId),
              }
            : undefined
        }
        isVisible={isVisible}
        onRefresh={() => doRefresh("manual")}
        pulsing={pulsing}
        sessionId={sessionId}
        totals={view.totals}
      />
      {view.error ? (
        <div data-testid="changes-error" style={errorBannerStyle}>
          {view.error}
        </div>
      ) : null}
      <BudgetNotice diff={view.diff} onRefresh={() => doRefresh("manual")} />
      {/* Unlike the old `loadedOnce && !isEmpty` gate this replaced, the tab
          strip and whichever tree the active tab calls for must be reachable
          no matter the diff's load state — a clean working tree (every
          session before Claude's first edit) or a first-load error (a
          session in a non-git directory) are exactly the moments a user is
          most likely to want the All-files browser. Only the diff-feed
          column below is gated on there being a diff to show. */}
      <div style={bodyStyle}>
        <FileTreePane
          dirtyPaths={view.dirtyPaths}
          files={view.displayFiles}
          onJumpToFile={(path) => diffFeedRef.current?.scrollToFile(path)}
          onOpenFile={handleOpenFile}
          onTabChange={(next) => setTab(sessionId, next)}
          selectedPath={view.selectedFileDiff?.path}
          tab={view.tab}
        >
          {filesTabMounted ? (
            <FileBrowserTree
              cwd={cwd}
              decorations={view.decorations}
              sessionId={sessionId}
            />
          ) : null}
        </FileTreePane>
        <div style={feedStyle}>
          {view.feedMounted ? (
            <div style={diffFeedWrapStyle(view.showViewer)}>
              <DiffFeed
                files={view.displayFiles}
                onActiveFileChange={(path) => setActiveFile(sessionId, path)}
                onEditFile={handleOpenFile}
                onSilentRefresh={handleSilentRefresh}
                ref={diffFeedRef}
                sessionId={sessionId}
                touchedRelative={touchedRelative}
              />
            </div>
          ) : null}
          {view.selectedFile ? (
            <div style={diffFeedWrapStyle(!view.showViewer)}>
              <FileViewer
                cwd={cwd}
                fileDiff={view.selectedFileDiff}
                onClose={() => selectFile(sessionId, undefined)}
                path={view.selectedFile}
                sessionId={sessionId}
              />
            </div>
          ) : null}
          {view.pane === "empty" ? (
            <div data-testid="changes-empty" style={noticeStyle}>
              {/* "No changes" is true but unhelpful in a directory git knows
                  nothing about: the session may well have written files, and
                  every one of them is invisible here because there is no
                  baseline to diff against. Say that instead — it is the
                  difference between "nothing happened" and "I can't tell". */}
              {repo.missing ? NOT_A_REPO : view.emptyMessage}
            </div>
          ) : null}
          {view.pane === "loading" ? (
            <div data-testid="changes-loading" style={noticeStyle}>
              Loading changes…
            </div>
          ) : null}
        </div>
        <JumpRail
          files={view.displayFiles}
          hidden={view.showViewer}
          onJumpToFile={(path) => diffFeedRef.current?.scrollToFile(path)}
          sessionId={sessionId}
        />
      </div>
    </div>
  );
}
