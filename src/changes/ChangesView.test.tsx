import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({
  activityChangedPaths: vi.fn().mockResolvedValue([]),
  blameFile: vi.fn().mockResolvedValue(null),
  readSessionBaseline: vi.fn().mockResolvedValue({ state: "notARepo" }),
  defaultBranch: vi.fn(),
  diffSessionChanges: vi.fn(),
  diffWorkingTree: vi.fn(),
  // The All-files tab (FileBrowserTree) and the file viewer (FileViewer) are
  // mounted by ChangesView once `tab`/`selectedFile` reach that state — kept
  // pending here (never resolving), the same style as `highlighter.ts`'s
  // mock below, since these tests only assert on the mount-time DOM, not on
  // loaded tree/file content.
  listDir: vi.fn().mockReturnValue(new Promise(() => undefined)),
  openPath: vi.fn(),
  readBaseline: vi.fn().mockReturnValue(new Promise(() => undefined)),
  readFile: vi.fn().mockReturnValue(new Promise(() => undefined)),
  // Fire-and-forget, called on every `refreshSessionChanges` (see
  // `ensureRepoToplevel`) — resolved by default so it never throws into a
  // test that doesn't care about the touched-file attribution feature;
  // tests exercising that feature override this per-case.
  // The empty pane asks whether the directory is a git repository at all, so
  // it can say "not a repository" instead of "no changes". Rejecting by
  // default would make every empty-state test claim that; these tests run
  // against a repo.
  repoStatus: vi.fn().mockResolvedValue({
    ahead: 0,
    behind: 0,
    branch: "main",
    dirtyCount: 0,
  }),
  repoToplevel: vi.fn().mockResolvedValue("/repo"),
  // Same fire-and-forget shape as `repoToplevel`: `ensureRepoToplevel` also
  // starts the session's [Working-tree watch], and `removeSession` releases
  // it. Neither is what these tests assert on, so both just resolve.
  unwatchWorkingTree: vi.fn().mockResolvedValue(undefined),
  watchWorkingTree: vi.fn().mockResolvedValue("/repo"),
}));
vi.mock("./highlighter.ts", () => ({
  highlightLines: vi.fn().mockReturnValue(new Promise(() => undefined)),
  // Synchronous cache peek; `undefined` keeps these tests on the async path.
  peekHighlight: vi.fn(),
  langForPath: () => "text",
}));
// Mirrors `FileViewer.test.tsx`'s own mock: a real controlled `<textarea>`
// wired to whatever `value`/`onChange` `FileViewer` actually passes, so the
// tab-flip-preserves-the-draft test below exercises real state, not a canned
// response — just without re-driving actual CodeMirror through jsdom, which
// only `CodeEditor.test.tsx` needs to do.
vi.mock("./CodeEditor.tsx", () => ({
  CodeEditor: ({
    onChange,
    value,
  }: {
    onChange: (next: string) => void;
    value: string;
  }) => <textarea onChange={(e) => onChange(e.target.value)} value={value} />,
}));

import {
  activityChangedPaths,
  defaultBranch,
  diffSessionChanges,
  diffWorkingTree,
  listDir,
  readFile,
  repoStatus,
  repoToplevel,
} from "../ipc/bridge.ts";
import { EMPTY_ENTRY, useChanges } from "../state/changes.ts";
import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { idleSession, useSessions } from "../state/sessions.ts";
import type { FileDiff, ProjectRow, SessionActivity } from "../types.ts";
import { ChangesView } from "./ChangesView.tsx";

const mockedDefaultBranch = vi.mocked(defaultBranch);
const mockedRepoStatus = vi.mocked(repoStatus);
const mockedDiffSessionChanges = vi.mocked(diffSessionChanges);
const mockedDiffWorkingTree = vi.mocked(diffWorkingTree);
const mockedListDir = vi.mocked(listDir);
const mockedReadFile = vi.mocked(readFile);
const mockedRepoToplevel = vi.mocked(repoToplevel);

// Hoisted per Biome's `useTopLevelRegex` — reused by the touched-file
// attribution describe block below.
const THIS_SESSION_LABEL = /this session/i;
const MY_EDITS_ONLY_NAME = /only claude's edits/i;
const NO_FILES_TOUCHED_TEXT =
  "Claude hasn't changed any files in this session.";
const EDIT_FILE_BUTTON_RE = /edit file/i;

/** The store's real `refresh` action, captured before any test overwrites it
 * with a `vi.fn()` — `setState` shallow-merges, so a mock installed by one
 * test would otherwise leak into the next via the shared store singleton.
 * `beforeEach` restores this so every test starts from the genuine action
 * (a test that wants a mock still installs its own). */
const REAL_REFRESH = useChanges.getState().refresh;

/** A rendered file card, found by the `data-diff-path` DiffFeed stamps on
 * every card it mounts — the public query seam for "is this file's card in
 * the DOM right now" (a virtualized card outside the rendered range simply
 * isn't there yet). */
function findDiffCard(path: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-diff-path="${path}"]`);
}

const project: ProjectRow = {
  color: null,
  id: "p1",
  name: "proj",
  path: "/repo",
  setupCommand: null,
};

function file(path: string, overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    binary: false,
    hunks: [
      {
        header: "@@ -1,1 +1,1 @@",
        lines: [{ kind: "context", text: "line" }],
      },
    ],
    oldPath: null,
    path,
    status: "modified",
    ...overrides,
  };
}

/** Alias for {@link file} used by tests that are specifically exercising the
 * All-files tab's file-viewer wiring, where "this is a changed file's diff"
 * reads clearer than the generic name. */
const fileDiff = file;

/** Seeds a session with a ready, loaded diff plus the session/project rows
 * `ChangesView` needs to resolve `cwd` — the shared shape every "ready"
 * test below builds by hand, parameterized by session id for tests that
 * need one beyond the fixed "s1" of {@link plainSession}. `cwd` defaults to
 * the repo root; the Edit-from-diff path-translation test below is the one
 * case that needs a session rooted in a repo *subdirectory*. */
function seedReadySession(
  sessionId: string,
  files: FileDiff[],
  cwd = "/repo"
): void {
  useChanges.setState({
    refresh: vi.fn().mockResolvedValue(undefined),
    bySession: {
      [sessionId]: {
        ...EMPTY_ENTRY,
        baselineLabel: "HEAD · uncommitted",
        diff: { base: "HEAD", files },
        fetchedAt: Date.now(),
        status: "ready",
        totals: { additions: 0, deletions: 0, files: files.length },
      },
    },
  });
  useSessions.setState({
    activeSessionId: sessionId,
    projects: [project],
    sessions: {
      [sessionId]: idleSession({
        archivedAt: null,
        baselineOid: null,
        claudeSessionId: null,
        createdAt: Date.now(),
        cwd,
        id: sessionId,
        projectId: "p1",
        title: sessionId,
        titleLocked: false,
        worktreePath: null,
      }),
    },
  });
}

/** Renders `ChangesView` for `sessionId` — the shared entry point for tests
 * that don't need to inspect the returned render result. */
function renderChangesView(sessionId: string) {
  return render(<ChangesView sessionId={sessionId} />);
}

function plainSession() {
  useSessions.setState({
    activeSessionId: "s1",
    projects: [project],
    sessions: {
      s1: idleSession({
        archivedAt: null,
        baselineOid: null,
        claudeSessionId: null,
        createdAt: Date.now(),
        cwd: "/repo",
        id: "s1",
        projectId: "p1",
        title: "s1",
        titleLocked: false,
        worktreePath: null,
      }),
    },
  });
}

/** Like {@link plainSession}, but with a captured `baselineOid` — the shape
 * every session round-two's baseline-diff feature actually targets. */
function baselineSession(oid = "cafebabe") {
  useSessions.setState({
    activeSessionId: "s1",
    projects: [project],
    sessions: {
      s1: idleSession({
        archivedAt: null,
        baselineOid: oid,
        claudeSessionId: null,
        createdAt: Date.now(),
        cwd: "/repo",
        id: "s1",
        projectId: "p1",
        title: "s1",
        titleLocked: false,
        worktreePath: null,
      }),
    },
  });
}

/** An activity snapshot with an edit tool mid-flight on the main agent. */
function activityWithMainTool(
  toolName: string,
  target: string | null
): SessionActivity {
  return {
    main: { currentTool: { startedAt: null, target, toolName } },
    pendingAsk: null,
    shells: [],
    subagents: [],
    tasks: [],
  };
}

/** An activity snapshot with no tool running — what `PostToolUse` clears to. */
function idleActivity(): SessionActivity {
  return {
    main: { currentTool: null },
    pendingAsk: null,
    shells: [],
    subagents: [],
    tasks: [],
  };
}

describe("ChangesView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(activityChangedPaths).mockResolvedValue([]);
    useSessions.setState({
      activeSessionId: null,
      projects: [],
      repoToplevel: {},
      repoToplevelCwd: {},
      sessions: {},
      touchedFiles: {},
    });
    // zustand's `setState` shallow-merges: every per-session slice below
    // must be reset alongside `bySession`, or state set by one test (a
    // pending jump, an All-files tab switch, a file selection) leaks into
    // the next — every test in this file reuses session id "s1", so
    // nothing else guards against it.
    useChanges.setState({
      bySession: {},
      expandedDirs: {},
      refresh: REAL_REFRESH,
      // Most of this file is about the view, not attribution, and seeds no
      // touched files — so "Only Claude's edits" (on by default, ADR 0050)
      // starts off here. The filter's own tests clear this back to the
      // default.
      ui: { s1: { myEditsOnly: false } },
    });
    useLayout.setState({ layout: DEFAULT_LAYOUT });
    // @tanstack/react-virtual measures via offsetHeight/offsetWidth in jsdom
    // (see DiffFeed.test.tsx); stub both so a rendered diff actually shows.
    // The scroll container gets a real viewport size; every other element
    // (each card) reports the same height DiffFeed estimates for it, so
    // measurement doesn't fight the estimate and drag the virtualizer into
    // runaway remeasurement.
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.testid === "diff-feed" ? 800 : 220;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.testid === "diff-feed" ? 800 : 220;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      value: 600,
    });
    // jsdom's scrollHeight is always 0, which clamps the virtualizer's
    // `getMaxScrollOffset()` (scrollHeight − clientHeight) to 0 and forces
    // every computed scroll target back to 0. A large stub keeps that
    // clamp out of the way so scrollToIndex's target actually holds.
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      value: 100_000,
    });
    // jsdom doesn't implement scrollTo at all (not even a no-op) — the
    // virtualizer's scrollToIndex calls `scrollElement.scrollTo({ top,
    // behavior })` and relies on the resulting native "scroll" event to
    // learn the new offset and recompute which rows are in range. Stub it
    // so scrollToIndex actually moves the feed under test, the same way a
    // real browser would.
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value(this: HTMLElement, options?: ScrollToOptions): void {
        const top =
          typeof options === "object" && options ? (options.top ?? 0) : 0;
        this.scrollTop = top;
        this.dispatchEvent(new Event("scroll"));
      },
    });
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: restores jsdom's own getter, a plain `= undefined` would leave a shadowing own-property behind.
    delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
    // biome-ignore lint/performance/noDelete: restores jsdom's own getter, a plain `= undefined` would leave a shadowing own-property behind.
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    // biome-ignore lint/performance/noDelete: restores jsdom's own getter, a plain `= undefined` would leave a shadowing own-property behind.
    delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
    // biome-ignore lint/performance/noDelete: restores jsdom's own getter, a plain `= undefined` would leave a shadowing own-property behind.
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    // biome-ignore lint/performance/noDelete: restores jsdom's (lack of a) own property, a plain `= undefined` would leave a shadowing own-property behind.
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    vi.useRealTimers();
  });

  it("refreshes with no base for a plain (non-worktree) session", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    useChanges.setState({ refresh });
    plainSession();
    useLayout.getState().setTranscriptView("changes");

    render(<ChangesView sessionId="s1" />);

    await waitFor(() => {
      expect(refresh).toHaveBeenCalledWith("s1", "/repo", {
        baselineOid: null,
        onBaselineInvalid: expect.any(Function),
      });
    });
    expect(mockedDefaultBranch).not.toHaveBeenCalled();
  });

  it("resolves the repo's default branch and refreshes with it for a worktree session", async () => {
    mockedDefaultBranch.mockResolvedValue("main");
    const refresh = vi.fn().mockResolvedValue(undefined);
    useChanges.setState({ refresh });
    useSessions.setState({
      activeSessionId: "s1",
      projects: [project],
      sessions: {
        s1: idleSession({
          archivedAt: null,
          baselineOid: null,
          claudeSessionId: null,
          createdAt: Date.now(),
          cwd: "/repo-wt",
          id: "s1",
          projectId: "p1",
          title: "feature",
          titleLocked: false,
          worktreePath: "/repo-wt",
        }),
      },
    });
    useLayout.getState().setTranscriptView("changes");

    render(<ChangesView sessionId="s1" />);

    await waitFor(() => {
      expect(mockedDefaultBranch).toHaveBeenCalledWith("/repo");
      expect(refresh).toHaveBeenCalledWith("s1", "/repo-wt", {
        base: "main",
        baselineOid: null,
        onBaselineInvalid: expect.any(Function),
      });
    });
  });

  it("uses the session's captured baseline (diffSessionChanges), not the legacy whole-tree diff, on mount", async () => {
    // Regression test for the round-two gap: opening the Changes view (the
    // mount/became-active fetch trigger) must route a session with a
    // captured `baselineOid` through `diffSessionChanges`, exactly like the
    // live-edit path already does — not fall back to the legacy
    // `diffWorkingTree` until some later live edit happens to fire the other
    // refresh path.
    mockedDiffSessionChanges.mockResolvedValue({
      base: "cafebabe",
      baseSha: "cafeb00",
      files: [file("src/live.ts")],
    });
    baselineSession("cafebabe");
    useLayout.getState().setTranscriptView("changes");

    render(<ChangesView sessionId="s1" />);

    await waitFor(() => {
      expect(mockedDiffSessionChanges).toHaveBeenCalledWith(
        "/repo",
        "cafebabe"
      );
    });
    expect(mockedDiffWorkingTree).not.toHaveBeenCalled();
  });

  it("clicking the manual refresh button also uses the session's captured baseline", async () => {
    mockedDiffSessionChanges.mockResolvedValue({
      base: "cafebabe",
      files: [],
    });
    baselineSession("cafebabe");
    useLayout.getState().setTranscriptView("changes");

    render(<ChangesView sessionId="s1" />);
    await waitFor(() => {
      expect(mockedDiffSessionChanges).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByTestId("summary-refresh"));

    await waitFor(() => {
      expect(mockedDiffSessionChanges).toHaveBeenCalledTimes(2);
    });
    expect(mockedDiffWorkingTree).not.toHaveBeenCalled();
  });

  it("renders the tree, feed, and summary bar for the session's diff", () => {
    useChanges.setState({
      refresh: vi.fn().mockResolvedValue(undefined),
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: {
            base: "HEAD",
            files: [file("src/main.ts")],
          },
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: 1 },
          viewed: {},
        },
      },
    });
    plainSession();

    render(<ChangesView sessionId="s1" />);

    expect(screen.getByTestId("file-tree-pane")).toBeInTheDocument();
    expect(screen.getByTestId("diff-feed")).toBeInTheDocument();
    expect(screen.getByTestId("summary-bar")).toBeInTheDocument();
    expect(screen.getAllByText("src/main.ts").length).toBeGreaterThan(0);
  });

  it("renders a jump rail dot per file alongside the tree and feed", () => {
    useChanges.setState({
      refresh: vi.fn().mockResolvedValue(undefined),
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: {
            base: "HEAD",
            files: [file("src/a.ts"), file("src/b.ts")],
          },
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: 2 },
          viewed: {},
        },
      },
    });
    plainSession();

    render(<ChangesView sessionId="s1" />);

    expect(screen.getByTestId("jump-rail")).toBeInTheDocument();
    expect(screen.getAllByTestId("jump-rail-dot")).toHaveLength(2);
  });

  it("clicking a jump rail dot for an off-screen file scrolls the virtualized feed to its card", async () => {
    const files = Array.from({ length: 30 }, (_, i) =>
      file(`src/file${String(i).padStart(2, "0")}.ts`)
    );
    useChanges.setState({
      refresh: vi.fn().mockResolvedValue(undefined),
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: { base: "HEAD", files },
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: files.length },
          viewed: {},
        },
      },
    });
    plainSession();

    render(<ChangesView sessionId="s1" />);

    expect(findDiffCard("src/file25.ts")).toBeNull();

    fireEvent.click(screen.getAllByTestId("jump-rail-dot")[25]);

    await waitFor(() => {
      expect(findDiffCard("src/file25.ts")).not.toBeNull();
    });
  });

  it("clicking an off-screen deleted file in the tree scrolls the virtualized feed to its card", async () => {
    // A deleted file has nothing to open, so its row jumps to its diff —
    // every other row opens the file instead.
    const files = Array.from({ length: 30 }, (_, i) =>
      file(`src/file${String(i).padStart(2, "0")}.ts`)
    );
    files[25] = { ...files[25], status: "deleted" };
    useChanges.setState({
      refresh: vi.fn().mockResolvedValue(undefined),
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: { base: "HEAD", files },
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: files.length },
          viewed: {},
        },
      },
    });
    plainSession();

    render(<ChangesView sessionId="s1" />);

    // With an 800px viewport and ~220px estimated card height (plus
    // overscan), file 25's card isn't rendered yet — this is the whole
    // point of virtualization, and the premise of this test.
    expect(findDiffCard("src/file25.ts")).toBeNull();

    fireEvent.click(screen.getByText("file25.ts"));

    await waitFor(() => {
      expect(findDiffCard("src/file25.ts")).not.toBeNull();
    });
  });

  it("pulses the summary bar and preserves scroll when a refresh lands while the feed is scrolled away from the top", () => {
    vi.useFakeTimers();
    const files = Array.from({ length: 30 }, (_, i) => file(`src/file${i}.ts`));
    useChanges.setState({
      refresh: vi.fn().mockResolvedValue(undefined),
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: { base: "HEAD", files },
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: files.length },
          viewed: {},
        },
      },
    });
    plainSession();

    render(<ChangesView sessionId="s1" />);
    expect(screen.getByTestId("summary-bar")).toHaveAttribute(
      "data-pulsing",
      "false"
    );

    const feed = screen.getByTestId("diff-feed");
    fireEvent.scroll(feed, { target: { scrollTop: 3000 } });

    // A refresh lands off-screen: the same shape a live-edit refresh or a
    // manual click produces (a fresh `diff.files` array), while the user is
    // still scrolled down reviewing an earlier file.
    const prevEntry = useChanges.getState().bySession.s1;
    act(() => {
      useChanges.setState({
        bySession: {
          s1: {
            ...prevEntry,
            diff: { base: "HEAD", files: [...files] },
            fetchedAt: Date.now(),
          },
        },
      });
    });

    expect(feed.scrollTop).toBe(3000);
    expect(screen.getByTestId("summary-bar")).toHaveAttribute(
      "data-pulsing",
      "true"
    );

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByTestId("summary-bar")).toHaveAttribute(
      "data-pulsing",
      "false"
    );
  });

  it("does not pulse the summary bar when a refresh lands while already at the top", () => {
    const files = Array.from({ length: 30 }, (_, i) => file(`src/file${i}.ts`));
    useChanges.setState({
      refresh: vi.fn().mockResolvedValue(undefined),
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: { base: "HEAD", files },
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: files.length },
          viewed: {},
        },
      },
    });
    plainSession();

    render(<ChangesView sessionId="s1" />);

    const prevEntry = useChanges.getState().bySession.s1;
    act(() => {
      useChanges.setState({
        bySession: {
          s1: {
            ...prevEntry,
            diff: { base: "HEAD", files: [...files] },
            fetchedAt: Date.now(),
          },
        },
      });
    });

    expect(screen.getByTestId("summary-bar")).toHaveAttribute(
      "data-pulsing",
      "false"
    );
  });

  it("shows an error banner without discarding the previously loaded diff", () => {
    useChanges.setState({
      refresh: vi.fn().mockResolvedValue(undefined),
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: { base: "HEAD", files: [file("src/main.ts")] },
          error: "git exploded",
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "error",
          totals: { additions: 0, deletions: 0, files: 1 },
          viewed: {},
        },
      },
    });
    plainSession();

    render(<ChangesView sessionId="s1" />);

    expect(screen.getByTestId("changes-error")).toHaveTextContent(
      "git exploded"
    );
    // The stale-but-fine diff from before the failed refresh stays visible.
    expect(screen.getByTestId("diff-feed")).toBeInTheDocument();
    expect(screen.getAllByText("src/main.ts").length).toBeGreaterThan(0);
  });

  it("shows a distinct not-yet-loaded placeholder before any diff has arrived, with the tab strip and tree still reachable", () => {
    useChanges.setState({ refresh: vi.fn().mockResolvedValue(undefined) });
    plainSession();

    render(<ChangesView sessionId="s1" />);

    expect(screen.getByTestId("changes-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("changes-empty")).not.toBeInTheDocument();
    // Regression guard: the tab strip (and so the All-files browser) used to
    // be gated behind the diff having loaded, making it unreachable for
    // however long the first fetch takes.
    expect(screen.getByTestId("file-tree-pane")).toBeInTheDocument();
  });

  it("says the directory is not a repository, rather than that nothing changed", async () => {
    // Reported from a real session: Claude created a file in a folder git
    // knows nothing about, and the view said "No changes" — true, useless,
    // and indistinguishable from "your edit didn't land".
    mockedRepoStatus.mockRejectedValue("not a git repository");
    // A path no earlier test has cached a status for: the repo-status
    // resource is module-level and its cache outlives a single test, so
    // reusing `/repo` would serve a neighbour's successful fetch.
    useChanges.setState({
      refresh: vi.fn().mockResolvedValue(undefined),
      bySession: {
        s1: {
          baselineLabel: "HEAD",
          collapsed: {},
          diff: { base: "HEAD", files: [] },
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: 0 },
          viewed: {},
        },
      },
    });
    plainSession();
    useSessions.setState((state) => ({
      sessions: {
        ...state.sessions,
        s1: { ...state.sessions.s1, cwd: "/not-a-repo" },
      },
    }));

    render(<ChangesView sessionId="s1" />);

    await waitFor(() =>
      expect(screen.getByTestId("changes-empty")).toHaveTextContent(
        "Not a git repository"
      )
    );
  });

  it("shows an honest empty state once a diff has loaded with zero files, with the tab strip and tree still reachable", () => {
    useChanges.setState({
      refresh: vi.fn().mockResolvedValue(undefined),
      bySession: {
        s1: {
          baselineLabel: "main @ abc1234",
          collapsed: {},
          diff: { base: "main", files: [] },
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: 0 },
          viewed: {},
        },
      },
    });
    plainSession();

    render(<ChangesView sessionId="s1" />);

    expect(screen.getByTestId("changes-empty")).toHaveTextContent(
      "No changes vs main @ abc1234."
    );
    expect(screen.getByTestId("changes-empty")).not.toHaveTextContent(
      "Not a git repository"
    );
    expect(screen.queryByTestId("changes-loading")).not.toBeInTheDocument();
    // Regression guard for the "all files list seems to be not working"
    // complaint: a clean working tree — every session before Claude's first
    // edit — used to hide the tab strip entirely, right when a user is most
    // likely to want the All-files browser.
    expect(screen.getByTestId("file-tree-pane")).toBeInTheDocument();
  });

  it("explains an over-budget working tree, naming the directory to gitignore", () => {
    // The reported freeze's user-facing half. Before the [Working-tree
    // budget] this repo hung the app; the least it can do now is say which
    // directory caused it, since that is the whole fix.
    useChanges.setState({
      refresh: vi.fn().mockResolvedValue(undefined),
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: {
            base: "HEAD",
            budgetExceeded: {
              fileLimit: 10_000,
              untrackedDirs: ["opt/", "vendor-sdk/"],
              untrackedFiles: 10_268,
            },
            files: [],
          },
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: 0 },
          viewed: {},
        },
      },
    });
    plainSession();

    render(<ChangesView sessionId="s1" />);

    const notice = screen.getByTestId("changes-over-budget");
    expect(notice).toHaveTextContent("opt/");
    // Computed the same way the component computes it — a literal "10,000"
    // pins the en-US grouping separator and goes red under de_DE ("10.000").
    expect(notice).toHaveTextContent((10_000).toLocaleString());
    // Not an error banner: nothing failed, the view is deliberately declining
    // to read gigabytes of un-ignored files.
    expect(screen.queryByTestId("changes-error")).not.toBeInTheDocument();
    // And the All-files browser stays usable, exactly as for the empty and
    // first-load-error states.
    expect(screen.getByTestId("file-tree-pane")).toBeInTheDocument();
  });

  it("still explains an over-budget tree when git names no directory", () => {
    // The common shape, not an edge case: when the untracked files sit loose in
    // the repo root, `ls-files --directory` lists files, every one of which the
    // directory filter drops — so the notice has to stand on its own.
    useChanges.setState({
      refresh: vi.fn().mockResolvedValue(undefined),
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: {
            base: "HEAD",
            budgetExceeded: {
              fileLimit: 10_000,
              untrackedDirs: [],
              untrackedFiles: 10_268,
            },
            files: [],
          },
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: 0 },
          viewed: {},
        },
      },
    });
    plainSession();

    render(<ChangesView sessionId="s1" />);

    const notice = screen.getByTestId("changes-over-budget");
    expect(notice).toHaveTextContent("untracked files");
    expect(notice).not.toHaveTextContent(".gitignore");
  });

  it("does not also claim 'No changes' while refusing to diff the untracked half", () => {
    // The contradiction this suppresses: an over-budget tree with no tracked
    // edits has `files: []`, which is the empty state's trigger — so the view
    // said "No changes vs HEAD · uncommitted" directly beneath a notice saying
    // 87,523 files went undiffed.
    useChanges.setState({
      refresh: vi.fn().mockResolvedValue(undefined),
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: {
            base: "HEAD",
            budgetExceeded: {
              fileLimit: 10_000,
              untrackedDirs: ["opt/"],
              untrackedFiles: 10_268,
            },
            files: [],
          },
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: 0 },
          viewed: {},
        },
      },
    });
    plainSession();

    render(<ChangesView sessionId="s1" />);

    expect(screen.getByTestId("changes-over-budget")).toBeInTheDocument();
    expect(screen.queryByTestId("changes-empty")).not.toBeInTheDocument();
  });

  it("offers a refresh from inside the notice, since the fix for it is a suppressed change", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    useChanges.setState({
      refresh,
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: {
            base: "HEAD",
            budgetExceeded: {
              fileLimit: 10_000,
              untrackedDirs: ["opt/"],
              untrackedFiles: 10_268,
            },
            files: [],
          },
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: 0 },
          viewed: {},
        },
      },
    });
    plainSession();
    render(<ChangesView sessionId="s1" />);
    refresh.mockClear();

    fireEvent.click(screen.getByTestId("changes-over-budget-refresh"));

    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });
  });

  it("says 'file', not 'files', when exactly one untracked file was omitted", () => {
    useChanges.setState({
      refresh: vi.fn().mockResolvedValue(undefined),
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: { base: "HEAD", files: [], omittedUntracked: 1 },
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: 0 },
          viewed: {},
        },
      },
    });
    plainSession();

    render(<ChangesView sessionId="s1" />);

    expect(screen.getByTestId("changes-omitted")).toHaveTextContent(
      "1 untracked file not shown"
    );
  });

  it("reports untracked files whose content was omitted rather than dropping them silently", () => {
    useChanges.setState({
      refresh: vi.fn().mockResolvedValue(undefined),
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: { base: "HEAD", files: [], omittedUntracked: 7 },
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: 0 },
          viewed: {},
        },
      },
    });
    plainSession();

    render(<ChangesView sessionId="s1" />);

    expect(screen.getByTestId("changes-omitted")).toHaveTextContent("7");
  });

  it("says nothing about the budget for an ordinary diff", () => {
    useChanges.setState({
      refresh: vi.fn().mockResolvedValue(undefined),
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          // The shape the Rust side actually sends on an ordinary diff: the
          // fields present and empty, not absent.
          diff: {
            base: "HEAD",
            budgetExceeded: null,
            files: [],
            omittedUntracked: 0,
          },
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: 0 },
          viewed: {},
        },
      },
    });
    plainSession();

    render(<ChangesView sessionId="s1" />);

    expect(screen.queryByTestId("changes-over-budget")).not.toBeInTheDocument();
    expect(screen.queryByTestId("changes-omitted")).not.toBeInTheDocument();
  });

  it("keeps the tree pane reachable after a first-load error, when there has never been a loaded diff", () => {
    // Regression guard: a session in a non-git directory (or any other
    // first-fetch failure) used to hide the tab strip entirely too, since
    // the old gate was `loadedOnce && !isEmpty` with no exception for
    // `hasError` — `loadedOnce` stays false forever if the very first fetch
    // is the one that fails.
    useChanges.setState({
      refresh: vi.fn().mockResolvedValue(undefined),
      bySession: {
        s1: {
          baselineLabel: "",
          collapsed: {},
          diff: null,
          error: "not a git repository",
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "error",
          totals: null,
          viewed: {},
        },
      },
    });
    plainSession();

    render(<ChangesView sessionId="s1" />);

    expect(screen.getByTestId("changes-error")).toHaveTextContent(
      "not a git repository"
    );
    expect(screen.getByTestId("file-tree-pane")).toBeInTheDocument();
  });

  it("refreshes on mount for the active session even while Raw (the default tab) is showing", async () => {
    // Regression test for the empty-sidebar bug: the Inspector's changed-
    // files list reads `bySession[activeSessionId].diff.files` regardless of
    // which transcript tab is showing, and Raw is the default (see
    // `DEFAULT_LAYOUT.transcriptView`) — so a live session the user never
    // switched to the Changes tab for must still have its diff fetched, or
    // the sidebar renders nothing while the aggregate `git status` count
    // right above it shows a nonzero total.
    const refresh = vi.fn().mockResolvedValue(undefined);
    useChanges.setState({ refresh });
    plainSession();
    useLayout.getState().setTranscriptView("raw");

    render(<ChangesView sessionId="s1" />);

    await waitFor(() => {
      expect(refresh).toHaveBeenCalledWith("s1", "/repo", {
        baselineOid: null,
        onBaselineInvalid: expect.any(Function),
      });
    });
  });

  it("populates the store's diff (what the sidebar reads) via a real fetch while Raw is showing", async () => {
    // Same regression as above, but exercised through the real `refresh`
    // action (not a mock) end to end, proving the store entry the Inspector
    // reads is actually populated — not just that some function got called.
    mockedDiffWorkingTree.mockResolvedValue({
      base: "HEAD",
      files: [file("src/live.ts")],
    });
    plainSession();
    useLayout.getState().setTranscriptView("raw");

    render(<ChangesView sessionId="s1" />);

    await waitFor(() => {
      expect(
        useChanges.getState().bySession.s1?.diff?.files.map((f) => f.path)
      ).toEqual(["src/live.ts"]);
    });
  });

  it("does not refresh on mount for a session that isn't the active one", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    useChanges.setState({ refresh });
    plainSession();
    // A second, active session takes over — s1's pane is warm-mounted but
    // off screen (see `sessionPaneMounts`), even though the global tab is
    // "changes".
    useSessions.setState({ activeSessionId: "s2" });
    useLayout.getState().setTranscriptView("changes");

    render(<ChangesView sessionId="s1" />);

    expect(refresh).not.toHaveBeenCalled();
  });

  it("with several sessions open, only the active one fetches", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    useChanges.setState({ refresh });
    useSessions.setState({
      activeSessionId: "s1",
      projects: [project],
      sessions: {
        s1: idleSession({
          archivedAt: null,
          baselineOid: null,
          claudeSessionId: null,
          createdAt: Date.now(),
          cwd: "/repo",
          id: "s1",
          projectId: "p1",
          title: "s1",
          titleLocked: false,
          worktreePath: null,
        }),
        s2: idleSession({
          archivedAt: null,
          baselineOid: null,
          claudeSessionId: null,
          createdAt: Date.now(),
          cwd: "/repo2",
          id: "s2",
          projectId: "p1",
          title: "s2",
          titleLocked: false,
          worktreePath: null,
        }),
        s3: idleSession({
          archivedAt: null,
          baselineOid: null,
          claudeSessionId: null,
          createdAt: Date.now(),
          cwd: "/repo3",
          id: "s3",
          projectId: "p1",
          title: "s3",
          titleLocked: false,
          worktreePath: null,
        }),
      },
    });
    useLayout.getState().setTranscriptView("raw");

    // Mirrors `SessionPane` mounting every open session's `ChangesView` at
    // once, display-toggled rather than conditionally rendered.
    render(
      <>
        <ChangesView sessionId="s1" />
        <ChangesView sessionId="s2" />
        <ChangesView sessionId="s3" />
      </>
    );

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith("s1", "/repo", {
      baselineOid: null,
      onBaselineInvalid: expect.any(Function),
    });
  });

  it("switching to Changes for an already-active session doesn't re-trigger a second fetch", async () => {
    // The mount-time fetch already covers it (active session, regardless of
    // which tab is showing — see this file's top doc comment); later
    // switching the tab to Changes must not fire a second one.
    const refresh = vi.fn().mockResolvedValue(undefined);
    useChanges.setState({ refresh });
    plainSession();
    useLayout.getState().setTranscriptView("raw");

    render(<ChangesView sessionId="s1" />);
    await waitFor(() => {
      expect(refresh).toHaveBeenCalledWith("s1", "/repo", {
        baselineOid: null,
        onBaselineInvalid: expect.any(Function),
      });
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    act(() => {
      useLayout.getState().setTranscriptView("changes");
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refetch on an unrelated re-render while the pane stays visible", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    useChanges.setState({ refresh });
    plainSession();
    useLayout.getState().setTranscriptView("changes");

    render(<ChangesView sessionId="s1" />);
    expect(refresh).toHaveBeenCalledTimes(1);

    // Toggling a file's collapsed state re-renders the tree/feed but must not
    // re-trigger a fetch — the pane never left the visible state.
    act(() => {
      useChanges.getState().toggleCollapsed("s1", "src/main.ts");
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a pending jump scrolls the feed to that file and is then cleared", async () => {
    const files = Array.from({ length: 30 }, (_, i) =>
      file(`src/file${String(i).padStart(2, "0")}.ts`)
    );
    useChanges.setState({
      refresh: vi.fn().mockResolvedValue(undefined),
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: { base: "HEAD", files },
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: files.length },
          viewed: {},
        },
      },
    });
    plainSession();

    render(<ChangesView sessionId="s1" />);

    expect(findDiffCard("src/file25.ts")).toBeNull();

    act(() => {
      useChanges.getState().requestJump("s1", "src/file25.ts");
    });

    await waitFor(() => {
      expect(findDiffCard("src/file25.ts")).not.toBeNull();
    });
    expect(useChanges.getState().ui.s1?.pendingJump).toBeUndefined();
  });

  it("consuming a jump doesn't snap the feed back to where it was scrolled", async () => {
    // The jump's own follow-through, and the reason `displayFiles` must keep
    // its array identity across a store write that isn't a refresh:
    // `consumeJump` writes the store, and if that handed `DiffFeed` a fresh
    // `files` array its scroll-restore effect would fire
    // `scrollToOffset(virtualizer.scrollOffset)` — still the PRE-jump offset,
    // since the virtualizer only learns the new one from the scroll event —
    // dragging the feed straight back and cancelling the jump. Only
    // reproducible while scrolled away from the top, which is exactly when a
    // jump is worth making.
    const files = Array.from({ length: 30 }, (_, i) =>
      file(`src/file${String(i).padStart(2, "0")}.ts`)
    );
    seedReadySession("s1", files);
    render(<ChangesView sessionId="s1" />);

    const feed = screen.getByTestId("diff-feed");
    fireEvent.scroll(feed, { target: { scrollTop: 3000 } });

    // Spied after the initial scroll, so only the jump's own calls are seen.
    const scrollToSpy = vi.spyOn(HTMLElement.prototype, "scrollTo");
    act(() => {
      useChanges.getState().requestJump("s1", "src/file25.ts");
    });

    await waitFor(() => {
      expect(findDiffCard("src/file25.ts")).not.toBeNull();
    });
    expect(useChanges.getState().ui.s1?.pendingJump).toBeUndefined();
    // The jump moved the feed further down…
    expect(
      scrollToSpy.mock.calls.some(
        ([options]) => ((options as ScrollToOptions)?.top ?? 0) > 3000
      )
    ).toBe(true);
    // …and nothing put it back. `scrollToOffset(3000)` is precisely the
    // snap-back's signature (see DiffFeed's own scroll-restore test).
    expect(scrollToSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ top: 3000 })
    );
    expect(feed.scrollTop).toBeGreaterThan(3000);
  });

  it("a pending jump requested before the diff loads scrolls once the file appears", async () => {
    useChanges.setState({ refresh: vi.fn().mockResolvedValue(undefined) });
    plainSession();

    render(<ChangesView sessionId="s1" />);

    act(() => {
      useChanges.getState().requestJump("s1", "src/late.ts");
    });

    // The diff hasn't loaded yet — no feed to scroll — but the request must
    // survive rather than being dropped.
    expect(screen.getByTestId("changes-loading")).toBeInTheDocument();
    expect(useChanges.getState().ui.s1?.pendingJump).toBe("src/late.ts");

    act(() => {
      useChanges.setState({
        bySession: {
          s1: {
            baselineLabel: "HEAD · uncommitted",
            collapsed: {},
            diff: { base: "HEAD", files: [file("src/late.ts")] },
            fetchedAt: Date.now(),
            hunkHashes: {},
            status: "ready",
            totals: { additions: 0, deletions: 0, files: 1 },
            viewed: {},
          },
        },
      });
    });

    await waitFor(() => {
      expect(findDiffCard("src/late.ts")).not.toBeNull();
    });
    expect(useChanges.getState().ui.s1?.pendingJump).toBeUndefined();
  });

  it("keeps a pending jump requested before any diff has loaded, even across an unrelated re-render", () => {
    useChanges.setState({ refresh: vi.fn().mockResolvedValue(undefined) });
    plainSession();

    render(<ChangesView sessionId="s1" />);

    act(() => {
      useChanges.getState().requestJump("s1", "src/late.ts");
    });
    expect(useChanges.getState().ui.s1?.pendingJump).toBe("src/late.ts");

    // An unrelated re-render (e.g. another store tick) must not be
    // mistaken for "the load completed and the path is absent" — no diff
    // has landed for this session at all yet.
    act(() => {
      useChanges.getState().markViewed("s1", "src/unrelated.ts");
    });

    expect(useChanges.getState().ui.s1?.pendingJump).toBe("src/late.ts");
  });

  it("drops a pending jump once a completed load doesn't contain the requested path, instead of holding it indefinitely", () => {
    // Regression test: a jump requested for a file that leaves the changeset
    // between the sidebar rendering and the click must not sit pending
    // forever — a later unrelated refresh that happens to include a
    // different file at the same path would otherwise auto-scroll the pane
    // with no user action behind it.
    useChanges.setState({
      refresh: vi.fn().mockResolvedValue(undefined),
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: { base: "HEAD", files: [file("src/main.ts")] },
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: 1 },
          viewed: {},
        },
      },
    });
    plainSession();

    render(<ChangesView sessionId="s1" />);

    act(() => {
      useChanges.getState().requestJump("s1", "src/gone.ts");
    });

    expect(useChanges.getState().ui.s1?.pendingJump).toBeUndefined();
    expect(findDiffCard("src/gone.ts")).toBeNull();
  });

  it("primary flow: an edit while Raw is showing records the touch and live-refreshes the active session's diff", () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    useChanges.setState({ refresh });
    plainSession();
    useLayout.getState().setTranscriptView("raw");

    render(<ChangesView sessionId="s1" />);
    // The mount-time fetch (for the sidebar) fires immediately, before any
    // edit — clear it so the assertions below isolate the live-edit refresh.
    refresh.mockClear();

    // Claude finishes an edit while the user is looking at the terminal.
    act(() => {
      useSessions
        .getState()
        .applyActivity("s1", activityWithMainTool("Edit", "src/foo.ts"));
      useSessions.getState().applyActivity("s1", idleActivity());
    });
    // Still debouncing — not yet.
    expect(refresh).not.toHaveBeenCalled();
    expect(useSessions.getState().touchedFiles.s1).toEqual(["src/foo.ts"]);

    act(() => {
      vi.advanceTimersByTime(600);
    });
    // The session is still active (just not showing Changes), so the
    // sidebar's data is kept current without the user opening the tab.
    expect(refresh).toHaveBeenCalledWith("s1", "/repo", {
      baselineOid: null,
      onBaselineInvalid: expect.any(Function),
    });
  });

  it("an edit for a session that isn't active records the touch but never live-refreshes", () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    useChanges.setState({ refresh });
    plainSession();
    // A second session takes over as active — s1 is warm-mounted, off screen.
    useSessions.setState({ activeSessionId: "s2" });
    useLayout.getState().setTranscriptView("raw");

    render(<ChangesView sessionId="s1" />);
    refresh.mockClear();

    act(() => {
      useSessions
        .getState()
        .applyActivity("s1", activityWithMainTool("Edit", "src/foo.ts"));
      useSessions.getState().applyActivity("s1", idleActivity());
      vi.advanceTimersByTime(600);
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(useSessions.getState().touchedFiles.s1).toEqual(["src/foo.ts"]);
  });

  test("selecting a file in the all-files tab shows the viewer and keeps the feed mounted", async () => {
    seedReadySession("s1", [fileDiff("src/a.ts")]);
    renderChangesView("s1");

    act(() => {
      useChanges.getState().setTab("s1", "all");
      useChanges.getState().selectFile("s1", "src/a.ts");
    });

    await waitFor(() => {
      expect(screen.getByTestId("file-viewer")).toBeTruthy();
    });
    // Kept mounted, not unmounted — the project's pane keep-alive rule.
    expect(screen.getByTestId("diff-feed")).toBeTruthy();
  });

  test("clicking a diff card's edit button opens that file in the viewer, staying on the same tab", async () => {
    seedReadySession("s1", [fileDiff("src/a.ts")]);
    renderChangesView("s1");

    expect(useChanges.getState().ui.s1?.tab ?? "changes").toBe("changes");
    expect(useChanges.getState().ui.s1?.selectedFile).toBeUndefined();

    // Scoped to the card, not the tree row — Task 12 adds the same "Edit
    // file" affordance to both surfaces (FileTreePane's row and DiffFeed's
    // card), so an unscoped query matches two buttons.
    const card = within(screen.getByTestId("diff-feed"));
    fireEvent.click(card.getByRole("button", { name: EDIT_FILE_BUTTON_RE }));

    expect(useChanges.getState().ui.s1?.selectedFile).toBe("src/a.ts");
    expect(useChanges.getState().ui.s1?.tab ?? "changes").toBe("changes");
    await waitFor(() => {
      expect(screen.getByTestId("file-viewer")).toBeInTheDocument();
    });
  });

  test("clicking a changed file opens it beside the list, which stays put with the file marked", async () => {
    seedReadySession("s1", [fileDiff("src/a.ts"), fileDiff("src/b.ts")]);
    renderChangesView("s1");

    const list = within(screen.getByTestId("file-tree-pane-changes"));
    fireEvent.click(list.getByText("b.ts"));

    expect(useChanges.getState().ui.s1?.selectedFile).toBe("src/b.ts");
    expect(useChanges.getState().ui.s1?.tab ?? "changes").toBe("changes");
    await waitFor(() => {
      expect(screen.getByTestId("file-viewer")).toBeVisible();
    });
    expect(screen.getByTestId("diff-feed").parentElement).toHaveStyle({
      display: "none",
    });
    const rows = list.getAllByTestId("file-tree-file-row");
    expect(rows[1]).toHaveAttribute("aria-current", "true");
    expect(rows[0]).not.toHaveAttribute("aria-current");

    // Closing it goes back to the diff list.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("diff-feed").parentElement).toHaveStyle({
      display: "block",
    });
  });

  test("an Inspector jump while a file is open opens the jumped-to file", () => {
    seedReadySession("s1", [fileDiff("src/a.ts"), fileDiff("src/b.ts")]);
    renderChangesView("s1");
    fireEvent.click(
      within(screen.getByTestId("file-tree-pane-changes")).getByText("a.ts")
    );

    act(() => useChanges.getState().requestJump("s1", "src/b.ts"));

    expect(useChanges.getState().ui.s1?.selectedFile).toBe("src/b.ts");
    expect(useChanges.getState().ui.s1?.pendingJump).toBeUndefined();
  });

  test("translates a repo-toplevel-relative diff path into a cwd-relative one for a session rooted in a subdirectory", async () => {
    // Diff/tree paths are git's own output — relative to the repo toplevel.
    // `FileViewer` resolves against the *session cwd*. For a session opened
    // on a subdirectory the two differ, and Edit used to hand the viewer
    // `app/src/a.ts` under cwd `/repo/app` → "path does not exist".
    seedReadySession("s1", [fileDiff("app/src/a.ts")], "/repo/app");
    useSessions.setState({ repoToplevel: { s1: "/repo" } });
    renderChangesView("s1");

    const card = within(screen.getByTestId("diff-feed"));
    fireEvent.click(card.getByRole("button", { name: EDIT_FILE_BUTTON_RE }));

    expect(useChanges.getState().ui.s1?.selectedFile).toBe("src/a.ts");
    await waitFor(() => {
      expect(screen.getByTestId("file-viewer")).toBeInTheDocument();
    });
    expect(mockedReadFile).toHaveBeenCalledWith("/repo/app", "src/a.ts");
  });

  test("dots the Changes-tab row of a file with unsaved edits, translating the path", () => {
    // The store publishes the open editor's path as `FileViewer` resolves it
    // — cwd-relative — while a Changes row's path is git's, relative to the
    // repo toplevel. Comparing the two raw would light the dot on the wrong
    // row (or, here, on none at all).
    seedReadySession(
      "s1",
      [fileDiff("app/src/a.ts"), fileDiff("app/src/b.ts")],
      "/repo/app"
    );
    useSessions.setState({ repoToplevel: { s1: "/repo" } });
    useChanges.setState({ dirtyFiles: { s1: "src/a.ts" } });
    renderChangesView("s1");

    const rows = within(
      screen.getByTestId("file-tree-pane-changes")
    ).getAllByTestId("file-tree-file-row");
    expect(within(rows[0]).getByTestId("tree-dirty-dot")).toBeInTheDocument();
    expect(
      within(rows[1]).queryByTestId("tree-dirty-dot")
    ).not.toBeInTheDocument();
  });

  test("leaves a diff path alone when the session cwd is the repo toplevel", () => {
    // The overwhelmingly common case: translation must be a no-op, not a
    // source of new breakage for every session that isn't in a subdirectory.
    seedReadySession("s1", [fileDiff("src/a.ts")]);
    useSessions.setState({ repoToplevel: { s1: "/repo" } });
    renderChangesView("s1");

    const card = within(screen.getByTestId("diff-feed"));
    fireEvent.click(card.getByRole("button", { name: EDIT_FILE_BUTTON_RE }));

    expect(useChanges.getState().ui.s1?.selectedFile).toBe("src/a.ts");
  });

  test("the all-files tab is reachable and usable with a clean working tree (the user's original complaint)", async () => {
    // A clean working tree: a diff has loaded, but with zero files — the
    // exact state every session is in before Claude's first edit, and the
    // one the old `loadedOnce && !isEmpty` gate hid the entire tab strip
    // (and so the browser) behind.
    mockedListDir.mockResolvedValueOnce([
      { ignored: false, isDir: false, name: "README.md" },
    ]);
    mockedReadFile.mockResolvedValueOnce({
      binary: false,
      content: "hello",
      lossy: false,
      mtime: 1_700_000_000_000,
      size: 5,
      truncated: false,
    });
    useChanges.setState({
      refresh: vi.fn().mockResolvedValue(undefined),
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: { base: "HEAD", files: [] },
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: 0 },
          viewed: {},
        },
      },
    });
    plainSession();

    render(<ChangesView sessionId="s1" />);
    expect(screen.getByTestId("changes-empty")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("file-tree-tab-all"));
    fireEvent.click(await screen.findByText("README.md"));

    await waitFor(() => {
      expect(screen.getByTestId("file-viewer")).toBeInTheDocument();
    });
    expect(screen.getByTestId("file-viewer-path")).toHaveTextContent(
      "README.md"
    );
  });

  test("flipping from the all-files tab back to changes and back again keeps the file browser mounted and does not refetch its listings", async () => {
    mockedListDir.mockResolvedValueOnce([
      { ignored: false, isDir: false, name: "README.md" },
    ]);
    seedReadySession("s1", [fileDiff("src/a.ts")]);
    renderChangesView("s1");

    act(() => {
      useChanges.getState().setTab("s1", "all");
    });
    expect(await screen.findByText("README.md")).toBeInTheDocument();
    expect(mockedListDir).toHaveBeenCalledTimes(1);

    act(() => {
      useChanges.getState().setTab("s1", "changes");
    });
    // Display-toggled, not unmounted — the pane keep-alive rule this
    // project already applies to DiffFeed/Terminal.
    expect(screen.getByTestId("file-browser-tree")).toBeInTheDocument();
    expect(screen.getByTestId("file-tree-pane-all").parentElement).toBe(
      screen.getByTestId("file-tree-pane")
    );
    expect(screen.getByTestId("file-tree-pane-all")).toHaveStyle({
      display: "none",
    });

    act(() => {
      useChanges.getState().setTab("s1", "all");
    });
    expect(screen.getByTestId("file-tree-pane-all")).toHaveStyle({
      display: "flex",
    });
    expect(screen.getByText("README.md")).toBeInTheDocument();
    // No second root listDir call — the cache survived the flip.
    expect(mockedListDir).toHaveBeenCalledTimes(1);
  });

  test("an open file stays open, draft and all, across a tab flip", async () => {
    mockedReadFile.mockResolvedValueOnce({
      binary: false,
      content: "hello",
      lossy: false,
      mtime: 1_700_000_000_000,
      size: 5,
      truncated: false,
    });
    seedReadySession("s1", [fileDiff("src/a.ts")]);
    renderChangesView("s1");

    act(() => {
      useChanges.getState().setTab("s1", "all");
      useChanges.getState().selectFile("s1", "src/a.ts");
    });

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "hello-edited" } });
    expect(screen.getByTestId("dirty-indicator")).toBeInTheDocument();

    act(() => {
      useChanges.getState().setTab("s1", "changes");
    });

    // The file stays open beside the AI changes list, as in an editor's
    // git panel; the diff waits behind it until the file is closed.
    const viewer = screen.getByTestId("file-viewer");
    expect(viewer.parentElement).toHaveStyle({ display: "block" });
    expect(screen.getByTestId("diff-feed").parentElement).toHaveStyle({
      display: "none",
    });

    act(() => {
      useChanges.getState().setTab("s1", "all");
    });

    expect(screen.getByTestId("file-viewer").parentElement).toHaveStyle({
      display: "block",
    });
    // The draft survived the round trip — no unmount, no reload, no
    // discard-confirmation prompt.
    expect(screen.getByRole("textbox")).toHaveValue("hello-edited");
    expect(screen.getByTestId("dirty-indicator")).toBeInTheDocument();
    expect(mockedReadFile).toHaveBeenCalledTimes(1);
  });

  test("the jump rail is hidden, not just present, while the file viewer is open", async () => {
    seedReadySession("s1", [fileDiff("src/a.ts")]);
    renderChangesView("s1");

    expect(screen.getByTestId("jump-rail")).not.toHaveStyle({
      display: "none",
    });

    act(() => {
      useChanges.getState().setTab("s1", "all");
      useChanges.getState().selectFile("s1", "src/a.ts");
    });

    await waitFor(() => {
      expect(screen.getByTestId("file-viewer")).toBeInTheDocument();
    });
    // Actually hidden (display:none), not merely present but inert — a
    // rail with display:none can't receive a real click, so its
    // `scrollToFile` calls on the now-hidden feed can't fire at all.
    expect(screen.getByTestId("jump-rail")).toHaveStyle({ display: "none" });
  });

  describe("touched-file attribution", () => {
    /** Seeds session "s1" with a ready three-file diff, plus a resolved
     * repo toplevel and a touched-file set naming which of those files (by
     * repo-relative path) this session's own edit tools touched. */
    function seedWithTouched(
      files: FileDiff[],
      touchedRelativePaths: string[]
    ): void {
      seedReadySession("s1", files);
      useSessions.setState({
        repoToplevel: { s1: "/repo" },
        touchedFiles: {
          s1: touchedRelativePaths.map((p) => `/repo/${p}`),
        },
      });
    }

    /** The header's "My edits only" switch, by its accessible name. */
    function getMyEditsToggle(): HTMLElement {
      return screen.getByRole("switch", { name: MY_EDITS_ONLY_NAME });
    }

    const threeFiles = [fileDiff("a.ts"), fileDiff("b.ts"), fileDiff("c.ts")];

    it('badges only the files this session touched, with an aria-label matching "this session"', () => {
      seedWithTouched(threeFiles, ["a.ts"]);

      renderChangesView("s1");

      expect(
        within(findDiffCard("a.ts") as HTMLElement).getByLabelText(
          THIS_SESSION_LABEL
        )
      ).toBeInTheDocument();
      expect(
        within(findDiffCard("b.ts") as HTMLElement).queryByLabelText(
          THIS_SESSION_LABEL
        )
      ).toBeNull();
      expect(
        within(findDiffCard("c.ts") as HTMLElement).queryByLabelText(
          THIS_SESSION_LABEL
        )
      ).toBeNull();
    });

    it("renders no badge for any file when the session hasn't touched anything", () => {
      seedReadySession("s1", threeFiles);
      useSessions.setState({ repoToplevel: { s1: "/repo" }, touchedFiles: {} });

      renderChangesView("s1");

      expect(screen.queryByLabelText(THIS_SESSION_LABEL)).toBeNull();
    });

    it("AI changes starts with \"Only Claude's edits\" on, leaving the user's own edits out", () => {
      seedWithTouched(threeFiles, ["a.ts"]);
      act(() => useChanges.setState({ ui: {} }));

      renderChangesView("s1");

      expect(getMyEditsToggle()).toHaveAttribute("aria-checked", "true");
      expect(findDiffCard("a.ts")).not.toBeNull();
      expect(findDiffCard("b.ts")).toBeNull();
      expect(findDiffCard("c.ts")).toBeNull();

      // Off shows everything that changed since the session started.
      fireEvent.click(getMyEditsToggle());
      expect(findDiffCard("b.ts")).not.toBeNull();
    });

    it("filters the file list down to this session's touched files once toggled on", () => {
      seedWithTouched(threeFiles, ["a.ts"]);

      renderChangesView("s1");
      fireEvent.click(getMyEditsToggle());

      expect(findDiffCard("a.ts")).not.toBeNull();
      expect(findDiffCard("b.ts")).toBeNull();
      expect(findDiffCard("c.ts")).toBeNull();
    });

    it("I5 (round-two review, BLOCKER): recomputes the header's totals from the filtered file list once 'My edits only' is on, instead of the unfiltered entry.totals", () => {
      // A deliberately unfiltered `entry.totals` (as `doRefresh` would store
      // it — see `computeTotals` in `state/changes.ts`) that must NOT be
      // what the header reads once the filter narrows the feed down to one
      // file: showing "3 files changed +30 −4" above a one-file feed is
      // exactly the discrepancy I5 flags.
      seedWithTouched(threeFiles, ["a.ts"]);
      useChanges.setState((s) => ({
        bySession: {
          ...s.bySession,
          s1: s.bySession.s1
            ? {
                ...s.bySession.s1,
                totals: { additions: 30, deletions: 4, files: 3 },
              }
            : s.bySession.s1,
        },
      }));

      renderChangesView("s1");
      expect(screen.getByTestId("summary-totals")).toHaveTextContent(
        "3 files changed"
      );

      fireEvent.click(getMyEditsToggle());

      // Only "a.ts" (the touched file) survives the filter — the header
      // must say so, not keep claiming 3.
      expect(screen.getByTestId("summary-totals")).toHaveTextContent(
        "1 file changed"
      );
      expect(screen.getByTestId("summary-totals")).not.toHaveTextContent(
        "3 files changed"
      );

      // Toggling back off restores the unfiltered totals.
      fireEvent.click(getMyEditsToggle());
      expect(screen.getByTestId("summary-totals")).toHaveTextContent(
        "3 files changed"
      );
    });

    it("toggling back off restores the full file list", () => {
      seedWithTouched(threeFiles, ["a.ts"]);

      renderChangesView("s1");
      const toggle = getMyEditsToggle();
      fireEvent.click(toggle);
      expect(findDiffCard("b.ts")).toBeNull();

      fireEvent.click(toggle);

      expect(toggle).toHaveAttribute("aria-checked", "false");
      expect(findDiffCard("a.ts")).not.toBeNull();
      expect(findDiffCard("b.ts")).not.toBeNull();
      expect(findDiffCard("c.ts")).not.toBeNull();
    });

    it("shows a dedicated empty state when the filter hides every file, rather than the baseline empty message", () => {
      // Every file is real (diff has 3 files), but none were touched by
      // this session — must not read as "no changes vs <baseline>".
      seedReadySession("s1", threeFiles);
      useSessions.setState({ repoToplevel: { s1: "/repo" }, touchedFiles: {} });

      renderChangesView("s1");
      fireEvent.click(getMyEditsToggle());

      expect(screen.getByTestId("changes-empty")).toHaveTextContent(
        NO_FILES_TOUCHED_TEXT
      );
    });

    it("neither applies the filter nor shows its empty message on the All-files tab, where the toggle isn't rendered", () => {
      // The dead end this guards: with the filter on and every file hidden,
      // the All-files tab used to show "No files touched by this session."
      // while the switch that caused it is gated on `tab === "changes"` —
      // the user could see the message but had no way to clear it.
      seedReadySession("s1", threeFiles);
      useSessions.setState({ repoToplevel: { s1: "/repo" }, touchedFiles: {} });

      renderChangesView("s1");
      fireEvent.click(getMyEditsToggle());
      expect(screen.getByTestId("changes-empty")).toHaveTextContent(
        NO_FILES_TOUCHED_TEXT
      );

      act(() => {
        useChanges.getState().setTab("s1", "all");
      });

      expect(
        screen.queryByRole("switch", { name: MY_EDITS_ONLY_NAME })
      ).toBeNull();
      expect(screen.queryByTestId("changes-empty")).toBeNull();
      expect(findDiffCard("a.ts")).not.toBeNull();

      // The filter itself is remembered, not cleared — flipping back to the
      // Changes tab restores it, toggle and all.
      act(() => {
        useChanges.getState().setTab("s1", "changes");
      });
      expect(getMyEditsToggle()).toHaveAttribute("aria-checked", "true");
      expect(screen.getByTestId("changes-empty")).toHaveTextContent(
        NO_FILES_TOUCHED_TEXT
      );
    });

    it("relativizes touchedFiles against a worktree session's own cwd (the worktree root), not the project root", async () => {
      // Two diff files, each only correctly attributed under one of the two
      // candidate roots: "a.ts" was touched at a path relative to the
      // *worktree* root ("/repo-wt/feat"), "decoy.ts" at a path relative to
      // the *project* root ("/repo") instead — a path this session never
      // actually touched relative to its own cwd. Asserting on the cwd arg
      // alone (the original version of this test) would still pass if
      // relativization used the wrong root, since both roots resolve some
      // touched path or other; using two files whose correct/incorrect
      // attribution diverge between the two roots is what actually pins
      // down *which* root got used.
      seedReadySession("s1", [fileDiff("a.ts"), fileDiff("decoy.ts")]);
      useSessions.setState({
        sessions: {
          s1: idleSession({
            archivedAt: null,
            baselineOid: null,
            claudeSessionId: null,
            createdAt: Date.now(),
            cwd: "/repo",
            id: "s1",
            projectId: "p1",
            title: "s1",
            titleLocked: false,
            worktreePath: "/repo-wt/feat",
          }),
        },
        touchedFiles: {
          s1: ["/repo-wt/feat/a.ts", "/repo/decoy.ts"],
        },
      });
      mockedRepoToplevel.mockResolvedValueOnce("/repo-wt/feat");
      // The Activity log, which owns this record, agrees with it.
      vi.mocked(activityChangedPaths).mockResolvedValue([
        "/repo-wt/feat/a.ts",
        "/repo/decoy.ts",
      ]);

      renderChangesView("s1");

      expect(mockedRepoToplevel).toHaveBeenCalledWith("/repo-wt/feat");

      await waitFor(() => {
        expect(
          within(findDiffCard("a.ts") as HTMLElement).getByLabelText(
            THIS_SESSION_LABEL
          )
        ).toBeInTheDocument();
      });
      // The project-root-relative entry must not produce a badge on its
      // file: relative to the worktree root, "/repo/decoy.ts" doesn't start
      // with "/repo-wt/feat/" and is correctly dropped.
      expect(
        within(findDiffCard("decoy.ts") as HTMLElement).queryByLabelText(
          THIS_SESSION_LABEL
        )
      ).toBeNull();
    });
  });

  describe("the 'My edits only' toggle's visibility", () => {
    it("is hidden before the diff has ever loaded", () => {
      plainSession();
      useChanges.setState({
        bySession: {
          s1: {
            baselineLabel: "",
            collapsed: {},
            diff: null,
            fetchedAt: 0,
            hunkHashes: {},
            status: "loading",
            totals: null,
            viewed: {},
          },
        },
      });

      renderChangesView("s1");

      expect(
        screen.queryByRole("switch", { name: MY_EDITS_ONLY_NAME })
      ).toBeNull();
    });

    it("is hidden on the All-files tab, where FileBrowserTree ignores the filter entirely", () => {
      seedReadySession("s1", [fileDiff("a.ts")]);
      // Claude's files are known (the Activity log answered: none).
      useSessions.setState({
        repoToplevel: { s1: "/repo" },
        touchedSynced: { s1: true },
      });

      renderChangesView("s1");
      expect(
        screen.getByRole("switch", { name: MY_EDITS_ONLY_NAME })
      ).toBeInTheDocument();

      act(() => {
        useChanges.getState().setTab("s1", "all");
      });

      expect(
        screen.queryByRole("switch", { name: MY_EDITS_ONLY_NAME })
      ).toBeNull();
    });

    it("is visible on the Changes tab once a diff has loaded", () => {
      seedReadySession("s1", [fileDiff("a.ts")]);
      // Claude's files are known (the Activity log answered: none).
      useSessions.setState({
        repoToplevel: { s1: "/repo" },
        touchedSynced: { s1: true },
      });

      renderChangesView("s1");

      expect(
        screen.getByRole("switch", { name: MY_EDITS_ONLY_NAME })
      ).toBeInTheDocument();
    });
  });

  describe("the 'My edits only' toggle's label", () => {
    it("clicking the visible label text toggles the switch, not just the track", () => {
      seedReadySession("s1", [fileDiff("a.ts"), fileDiff("b.ts")]);
      useSessions.setState({
        repoToplevel: { s1: "/repo" },
        touchedFiles: { s1: ["/repo/a.ts"] },
      });

      renderChangesView("s1");
      const toggle = screen.getByRole("switch", { name: MY_EDITS_ONLY_NAME });
      expect(toggle).toHaveAttribute("aria-checked", "false");

      fireEvent.click(screen.getByText("Only Claude's edits"));

      expect(toggle).toHaveAttribute("aria-checked", "true");
      expect(findDiffCard("b.ts")).toBeNull();
    });
  });

  describe("a jump while a file is open on the All-files tab", () => {
    it("opens the jumped-to file when a file is already open, rather than scrolling a hidden feed", async () => {
      const files = Array.from({ length: 30 }, (_, i) =>
        fileDiff(`src/file${String(i).padStart(2, "0")}.ts`)
      );
      seedReadySession("s1", files);
      renderChangesView("s1");

      act(() => {
        useChanges.getState().setTab("s1", "all");
        useChanges.getState().selectFile("s1", "src/file00.ts");
      });
      await waitFor(() => {
        expect(screen.getByTestId("file-viewer")).toBeInTheDocument();
      });

      act(() => {
        useChanges.getState().requestJump("s1", "src/file25.ts");
      });

      await waitFor(() => {
        expect(useChanges.getState().ui.s1?.selectedFile).toBe("src/file25.ts");
      });
      expect(useChanges.getState().ui.s1?.pendingJump).toBeUndefined();
      expect(useChanges.getState().ui.s1?.tab).toBe("all");
    });
  });

  describe("a jump under the 'My edits only' filter", () => {
    it("clears the filter (rather than silently no-opping) when the jump target isn't in this session's touched files", async () => {
      const files = [fileDiff("a.ts"), fileDiff("b.ts")];
      seedReadySession("s1", files);
      useSessions.setState({
        repoToplevel: { s1: "/repo" },
        // Only "a.ts" was touched by this session — "b.ts" is a real file
        // in the diff, just filtered out once the switch is on.
        touchedFiles: { s1: ["/repo/a.ts"] },
      });

      renderChangesView("s1");
      fireEvent.click(screen.getByRole("switch", { name: MY_EDITS_ONLY_NAME }));
      expect(findDiffCard("b.ts")).toBeNull();

      act(() => {
        useChanges.getState().requestJump("s1", "b.ts");
      });

      await waitFor(() => {
        expect(
          screen.getByRole("switch", { name: MY_EDITS_ONLY_NAME })
        ).toHaveAttribute("aria-checked", "false");
      });
      await waitFor(() => {
        expect(findDiffCard("b.ts")).not.toBeNull();
      });
      expect(useChanges.getState().ui.s1?.pendingJump).toBeUndefined();
    });

    it("scrolls directly, without touching the filter, when the jump target is already visible under it", async () => {
      const files = [fileDiff("a.ts"), fileDiff("b.ts")];
      seedReadySession("s1", files);
      useSessions.setState({
        repoToplevel: { s1: "/repo" },
        touchedFiles: { s1: ["/repo/a.ts"] },
      });

      renderChangesView("s1");
      fireEvent.click(screen.getByRole("switch", { name: MY_EDITS_ONLY_NAME }));

      act(() => {
        useChanges.getState().requestJump("s1", "a.ts");
      });

      await waitFor(() => {
        expect(useChanges.getState().ui.s1?.pendingJump).toBeUndefined();
      });
      expect(
        screen.getByRole("switch", { name: MY_EDITS_ONLY_NAME })
      ).toHaveAttribute("aria-checked", "true");
      expect(findDiffCard("b.ts")).toBeNull();
    });
  });

  describe("the three scopes", () => {
    it("switching to All changes fetches the uncommitted work", () => {
      seedReadySession("s1", [fileDiff("a.ts")]);
      plainSession();
      renderChangesView("s1");
      const refresh = useChanges.getState().refresh as ReturnType<typeof vi.fn>;
      const before = refresh.mock.calls.length;

      fireEvent.click(screen.getByTestId("file-tree-tab-uncommitted"));

      expect(refresh.mock.calls.length).toBe(before + 1);
    });

    it("shows the uncommitted files and what they are measured against", () => {
      seedReadySession("s1", [fileDiff("a.ts")]);
      plainSession();
      useChanges.setState((s) => ({
        bySession: {
          s1: {
            ...s.bySession.s1,
            uncommitted: {
              diff: {
                base: "HEAD",
                files: [fileDiff("a.ts"), fileDiff("b.ts")],
              },
              label: "HEAD · uncommitted",
            },
          },
        },
      }));
      renderChangesView("s1");

      fireEvent.click(screen.getByTestId("file-tree-tab-uncommitted"));

      expect(
        screen.getAllByTestId("file-tree-file-row").map((r) => r.title)
      ).toEqual(["a.ts", "b.ts"]);
      expect(screen.getByTestId("summary-totals")).toHaveTextContent(
        "2 files changed"
      );
      expect(screen.getByTestId("summary-baseline")).toHaveTextContent(
        "HEAD · uncommitted"
      );
    });

    it("a jump to one of the session's files while All changes shows goes back to AI changes", () => {
      seedReadySession("s1", [fileDiff("a.ts")]);
      plainSession();
      renderChangesView("s1");
      fireEvent.click(screen.getByTestId("file-tree-tab-uncommitted"));

      act(() => useChanges.getState().requestJump("s1", "a.ts"));

      expect(useChanges.getState().ui.s1?.tab).toBe("changes");
    });
  });
});
