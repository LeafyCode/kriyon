import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({
  activityChangedPaths: vi.fn(),
  defaultBranch: vi.fn(),
  diffSessionChanges: vi.fn(),
  diffWorkingTree: vi.fn(),
  repoToplevel: vi.fn(),
  unwatchWorkingTree: vi.fn(),
  upsertSession: vi.fn(),
  watchWorkingTree: vi.fn(),
}));

import {
  activityChangedPaths,
  defaultBranch,
  diffSessionChanges,
  diffWorkingTree,
  repoToplevel,
  unwatchWorkingTree,
  upsertSession,
  watchWorkingTree,
} from "../ipc/bridge.ts";
import type { SessionActivity, SessionDiff } from "../types.ts";
import { useChanges } from "./changes.ts";
import {
  applyWorkingTreeChange,
  forgetDefaultBranch,
  type RefreshReason,
  refreshSessionChanges,
  requestRefresh,
  useRevalidateOn,
} from "./changesRefresh.ts";
import { DEFAULT_LAYOUT, useLayout } from "./layout.ts";
import { type UiSession, useSessions } from "./sessions.ts";

const mockedDefaultBranch = vi.mocked(defaultBranch);
const mockedActivityChangedPaths = vi.mocked(activityChangedPaths);
const mockedDiffWorkingTree = vi.mocked(diffWorkingTree);
const mockedDiffSessionChanges = vi.mocked(diffSessionChanges);
const mockedRepoToplevel = vi.mocked(repoToplevel);
const mockedUnwatchWorkingTree = vi.mocked(unwatchWorkingTree);
const mockedUpsertSession = vi.mocked(upsertSession);
const mockedWatchWorkingTree = vi.mocked(watchWorkingTree);

/** The store's own `refresh`, captured before any test swaps it for a spy —
 * the coalescing/`fetchedAt` characterizations need the real implementation,
 * and `useChanges.setState({ refresh })` replaces the action permanently. */
const REAL_REFRESH = useChanges.getState().refresh;

/** The debounce every `live-edit` refresh settles behind, pinned here so a
 * change to it fails this suite rather than silently changing how live the
 * Changes view feels. */
const DEBOUNCE_MS = 500;

/** Every reason that refreshes *now*. `live-edit` is deliberately absent: it
 * is the one reason the coordinator debounces (see the timing tests). */
const IMMEDIATE_REASONS: RefreshReason[] = [
  "baseline-landed",
  "became-active",
  "fs-change",
  "manual",
  "saved",
  "scope",
];

/** The reasons the [Working-tree budget] refusal suppresses — the two the
 * filesystem can fire indefinitely. Everything else is user-driven and stays
 * live, since gitignoring the offending directory is the recovery route. */
const GATED_REASONS: RefreshReason[] = ["fs-change", "live-edit"];

function locatedSession(
  id: string,
  overrides: Partial<UiSession> = {}
): UiSession {
  return {
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "/repo",
    id,
    projectId: "default",
    status: "idle",
    summary: "",
    title: id,
    titleLocked: false,
    worktreePath: null,
    ...overrides,
  };
}

function emptyDiff(base = "HEAD"): SessionDiff {
  return { base, files: [] };
}

/** Park an over-budget diff on `sessionId`, exactly as a *successful* refresh
 * of an over-budget repo would: `status: "ready"` is part of the fixture, not
 * decoration — the suppression ignores a `budgetExceeded` carried on a stale
 * diff behind an errored refresh. */
function seedOverBudget(sessionId: string): void {
  useChanges.setState((state) => ({
    bySession: {
      ...state.bySession,
      [sessionId]: {
        ...state.bySession[sessionId],
        baselineLabel: "",
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
        fetchedAt: 1,
        hunkHashes: {},
        status: "ready" as const,
        totals: null,
        viewed: {},
      },
    },
  }));
}

/** An active, plain (non-worktree) session sitting in `/repo` — the fixture
 * every timing/gate characterization drives, since only the *active* session
 * is ever refreshed by a live trigger. */
function seedActiveSession(id = "s1"): void {
  const s = useSessions.getState();
  s.addSession(locatedSession(id));
  s.setActiveSession(id);
}

/** Swap the changes store's `refresh` for a spy and hand it back. */
function spyOnRefresh(): ReturnType<typeof vi.fn> {
  const refresh = vi.fn().mockResolvedValue(undefined);
  useChanges.setState({ refresh });
  return refresh;
}

beforeEach(() => {
  useSessions.setState({
    activeSessionId: null,
    activity: {},
    appendSeq: {},
    bootPhase: {},
    events: {},
    exited: {},
    memory: {},
    pendingSeedPrompt: {},
    projects: [],
    repoToplevel: {},
    repoToplevelCwd: {},
    sessions: {},
    sleeping: {},
    statusOrigin: {},
    touchedFiles: {},
    usage: {},
    viewed: {},
    warmPanes: [],
  });
  useLayout.setState({ layout: DEFAULT_LAYOUT });
  useChanges.setState({ bySession: {}, refresh: REAL_REFRESH, ui: {} });
  mockedDefaultBranch.mockReset().mockResolvedValue("main");
  mockedActivityChangedPaths.mockReset().mockResolvedValue([]);
  mockedDiffSessionChanges.mockReset().mockResolvedValue(emptyDiff());
  mockedDiffWorkingTree.mockReset().mockResolvedValue(emptyDiff());
  mockedRepoToplevel.mockReset().mockResolvedValue("/repo");
  mockedUnwatchWorkingTree.mockReset().mockResolvedValue(undefined);
  mockedUpsertSession.mockReset().mockResolvedValue(undefined);
  mockedWatchWorkingTree.mockReset().mockResolvedValue("/repo");
  forgetDefaultBranch();
  vi.useRealTimers();
});

// --- per-reason timing ---------------------------------------------------

describe("per-reason timing policy", () => {
  test("every reason but live-edit refreshes immediately", () => {
    seedActiveSession();
    const refresh = spyOnRefresh();

    for (const reason of IMMEDIATE_REASONS) {
      refresh.mockClear();
      requestRefresh("s1", reason);
      expect(refresh, `reason: ${reason}`).toHaveBeenCalledTimes(1);
    }
  });

  test("live-edit refreshes only once the debounce window has elapsed", () => {
    vi.useFakeTimers();
    seedActiveSession();
    const refresh = spyOnRefresh();

    requestRefresh("s1", "live-edit");

    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("a burst of live-edits inside the window settles to one refresh", () => {
    vi.useFakeTimers();
    seedActiveSession();
    const refresh = spyOnRefresh();

    requestRefresh("s1", "live-edit");
    vi.advanceTimersByTime(200);
    requestRefresh("s1", "live-edit");
    vi.advanceTimersByTime(200);
    requestRefresh("s1", "live-edit");
    expect(refresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("live-edit never arms for a session that isn't the active one", () => {
    vi.useFakeTimers();
    const s = useSessions.getState();
    s.addSession(locatedSession("s1"));
    s.addSession(locatedSession("s2"));
    s.setActiveSession("s2");
    const refresh = spyOnRefresh();

    requestRefresh("s1", "live-edit");
    vi.advanceTimersByTime(DEBOUNCE_MS * 2);

    expect(refresh).not.toHaveBeenCalled();
  });

  test("the active-session gate is re-checked when the debounce fires, not only when it is armed", () => {
    vi.useFakeTimers();
    const s = useSessions.getState();
    s.addSession(locatedSession("s1"));
    s.addSession(locatedSession("s2"));
    s.setActiveSession("s1");
    const refresh = spyOnRefresh();

    requestRefresh("s1", "live-edit");
    vi.advanceTimersByTime(200);
    // The user switches away mid-window: the armed timer must not spend a
    // `git diff` on a session that is no longer on screen.
    s.setActiveSession("s2");
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(refresh).not.toHaveBeenCalled();
  });
});

// --- the [Working-tree budget] refusal gate ------------------------------

describe("the [Working-tree budget] refusal gate", () => {
  test("suppresses exactly the filesystem-driven reasons", () => {
    vi.useFakeTimers();
    seedActiveSession();
    seedOverBudget("s1");
    const refresh = spyOnRefresh();

    for (const reason of GATED_REASONS) {
      refresh.mockClear();
      requestRefresh("s1", reason);
      vi.advanceTimersByTime(DEBOUNCE_MS * 2);
      expect(refresh, `reason: ${reason}`).not.toHaveBeenCalled();
    }
  });

  test("leaves every user-driven reason live, so recovery is one action away", () => {
    vi.useFakeTimers();
    seedActiveSession();
    seedOverBudget("s1");
    const refresh = spyOnRefresh();

    for (const reason of IMMEDIATE_REASONS.filter(
      (r) => !GATED_REASONS.includes(r)
    )) {
      refresh.mockClear();
      requestRefresh("s1", reason);
      expect(refresh, `reason: ${reason}`).toHaveBeenCalledTimes(1);
    }
  });

  test("only a refusal a *successful* refresh observed suppresses anything", () => {
    // A failed refresh keeps the previous diff on screen, so reading
    // `budgetExceeded` alone would let one unrelated failure park the
    // suppression forever — long after the user gitignored the directory.
    seedActiveSession();
    seedOverBudget("s1");
    useChanges.setState((state) => ({
      bySession: {
        ...state.bySession,
        s1: { ...state.bySession.s1, error: "git exploded", status: "error" },
      },
    }));
    const refresh = spyOnRefresh();

    requestRefresh("s1", "fs-change");

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("a live-edit debounce re-checks the budget gate when it fires", () => {
    // A timer armed before the refusal landed would otherwise sail past the
    // schedule-time gate and spend one more enumeration reaching an answer
    // that is already known.
    vi.useFakeTimers();
    seedActiveSession();
    const refresh = spyOnRefresh();

    requestRefresh("s1", "live-edit");
    vi.advanceTimersByTime(200);
    seedOverBudget("s1");
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(refresh).not.toHaveBeenCalled();
  });
});

// --- the working-tree watch's entry point --------------------------------

describe("applyWorkingTreeChange", () => {
  test("refreshes the active session whose cached toplevel is that repo", () => {
    seedActiveSession();
    useSessions.setState({ repoToplevel: { s1: "/repo" } });
    const refresh = spyOnRefresh();

    applyWorkingTreeChange("/repo");

    expect(refresh).toHaveBeenCalledWith("s1", "/repo", expect.anything());
  });

  test("refreshes nothing for a repo no active session is looking at", () => {
    seedActiveSession();
    useSessions.setState({ repoToplevel: { s1: "/repo" } });
    const refresh = spyOnRefresh();

    applyWorkingTreeChange("/some/other/repo");

    expect(refresh).not.toHaveBeenCalled();
  });

  test("refreshes nothing when the matching session isn't active", () => {
    const s = useSessions.getState();
    s.addSession(locatedSession("s1"));
    s.addSession(locatedSession("s2"));
    s.setActiveSession("s2");
    useSessions.setState({ repoToplevel: { s1: "/repo", s2: "/other" } });
    const refresh = spyOnRefresh();

    applyWorkingTreeChange("/repo");

    expect(refresh).not.toHaveBeenCalled();
  });
});

// --- in-flight + trailing coalescing -------------------------------------

describe("in-flight and trailing coalescing", () => {
  test("requests arriving during one run coalesce into exactly one trailing re-run", async () => {
    let resolveDiff!: (value: SessionDiff) => void;
    mockedDiffWorkingTree.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDiff = resolve;
      })
    );
    mockedDiffWorkingTree.mockResolvedValue(emptyDiff());

    const first = useChanges.getState().refresh("s1", "/repo");
    const queued = [
      useChanges.getState().refresh("s1", "/repo"),
      useChanges.getState().refresh("s1", "/repo"),
      useChanges.getState().refresh("s1", "/repo"),
    ];

    resolveDiff(emptyDiff());
    await Promise.all([first, ...queued]);

    expect(mockedDiffWorkingTree).toHaveBeenCalledTimes(2);
  });

  test("the trailing re-run carries the newest request's cwd and options", async () => {
    let resolveDiff!: (value: SessionDiff) => void;
    mockedDiffWorkingTree.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDiff = resolve;
      })
    );
    mockedDiffWorkingTree.mockResolvedValue(emptyDiff("main"));

    const first = useChanges.getState().refresh("s1", "/repo");
    const second = useChanges
      .getState()
      .refresh("s1", "/repo-wt", { base: "main" });

    resolveDiff(emptyDiff());
    await Promise.all([first, second]);

    expect(mockedDiffWorkingTree).toHaveBeenLastCalledWith("/repo-wt", "main");
  });

  test("a failed run still runs (and cleans up after) its trailing re-run", async () => {
    let rejectFirst!: (err: Error) => void;
    mockedDiffWorkingTree.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectFirst = reject;
      })
    );
    mockedDiffWorkingTree.mockResolvedValue(emptyDiff());

    const first = useChanges.getState().refresh("s1", "/repo");
    const second = useChanges.getState().refresh("s1", "/repo");

    rejectFirst(new Error("git exploded"));
    await Promise.all([first, second]);

    expect(mockedDiffWorkingTree).toHaveBeenCalledTimes(2);
    // Not wedged behind a settled promise that never cleared.
    await useChanges.getState().refresh("s1", "/repo");
    expect(mockedDiffWorkingTree).toHaveBeenCalledTimes(3);
  });
});

// --- the epoch signal ----------------------------------------------------

describe("the refresh epoch (fetchedAt)", () => {
  test("advances on every successful refresh, not just the first", async () => {
    // Fake time, not `Date.now()`'s real resolution: two refreshes of an
    // already-mocked bridge land inside the same millisecond, which would
    // make a strict "advanced" assertion flaky against the very behavior it
    // exists to pin.
    vi.useFakeTimers();
    await useChanges.getState().refresh("s1", "/repo");
    const first = useChanges.getState().bySession.s1?.fetchedAt ?? 0;
    expect(first).toBeGreaterThan(0);

    vi.setSystemTime(Date.now() + 1000);
    await useChanges.getState().refresh("s1", "/repo");

    expect(useChanges.getState().bySession.s1?.fetchedAt).toBeGreaterThan(
      first
    );
  });

  test("is left untouched by a failed refresh, so staleness stays honest", async () => {
    await useChanges.getState().refresh("s1", "/repo");
    const landed = useChanges.getState().bySession.s1?.fetchedAt ?? 0;

    mockedDiffWorkingTree.mockRejectedValue(new Error("git exploded"));
    await useChanges.getState().refresh("s1", "/repo");

    const after = useChanges.getState().bySession.s1;
    expect(after?.fetchedAt).toBe(landed);
    expect(after?.status).toBe("error");
  });
});

// --- base + baseline resolution ------------------------------------------

describe("base and baseline resolution", () => {
  test("a plain session diffs against its own cwd with no base", () => {
    seedActiveSession();
    const refresh = spyOnRefresh();

    requestRefresh("s1", "manual");

    expect(refresh).toHaveBeenCalledWith("s1", "/repo", {
      baselineOid: null,
      onBaselineInvalid: expect.any(Function),
    });
  });

  test("a worktree session resolves the project's default branch as its base", async () => {
    const s = useSessions.getState();
    s.addProject({
      color: null,
      id: "p1",
      name: "p1",
      path: "/repo",
      setupCommand: null,
    });
    s.addSession(
      locatedSession("s1", { projectId: "p1", worktreePath: "/repo-wt/feat" })
    );
    s.setActiveSession("s1");
    const refresh = spyOnRefresh();

    requestRefresh("s1", "manual");
    await vi.waitFor(() => {
      expect(refresh).toHaveBeenCalledWith("s1", "/repo-wt/feat", {
        base: "main",
        baselineOid: null,
        onBaselineInvalid: expect.any(Function),
      });
    });
    expect(mockedDefaultBranch).toHaveBeenCalledWith("/repo");
  });

  test("the default branch is resolved once per project, not once per refresh", async () => {
    const s = useSessions.getState();
    s.addProject({
      color: null,
      id: "p1",
      name: "p1",
      path: "/repo",
      setupCommand: null,
    });
    s.addSession(
      locatedSession("s1", { projectId: "p1", worktreePath: "/repo-wt/feat" })
    );
    s.setActiveSession("s1");
    const refresh = spyOnRefresh();

    requestRefresh("s1", "manual");
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    requestRefresh("s1", "manual");
    requestRefresh("s1", "manual");
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(3));

    expect(mockedDefaultBranch).toHaveBeenCalledTimes(1);
  });

  test("a session's captured baselineOid is threaded through every refresh", () => {
    const s = useSessions.getState();
    s.addSession(locatedSession("s1", { baselineOid: "cafebabe" }));
    s.setActiveSession("s1");
    const refresh = spyOnRefresh();

    requestRefresh("s1", "manual");

    expect(refresh).toHaveBeenCalledWith("s1", "/repo", {
      baselineOid: "cafebabe",
      onBaselineInvalid: expect.any(Function),
    });
  });
});

// --- repo toplevel + working-tree watch plumbing -------------------------

describe("repo toplevel and working-tree watch plumbing", () => {
  test("a refresh resolves the session's repo toplevel once per cwd", async () => {
    seedActiveSession();
    spyOnRefresh();

    requestRefresh("s1", "manual");
    requestRefresh("s1", "manual");
    await vi.waitFor(() => {
      expect(useSessions.getState().repoToplevel.s1).toBe("/repo");
    });

    expect(mockedRepoToplevel).toHaveBeenCalledTimes(1);
    expect(mockedRepoToplevel).toHaveBeenCalledWith("/repo");
  });

  test("resolving a toplevel also starts that session's working-tree watch, once per cwd", () => {
    seedActiveSession();
    spyOnRefresh();

    requestRefresh("s1", "manual");
    requestRefresh("s1", "manual");

    expect(mockedWatchWorkingTree).toHaveBeenCalledTimes(1);
    expect(mockedWatchWorkingTree).toHaveBeenCalledWith("s1", "/repo");
  });

  test("removing a session releases its working-tree watch", () => {
    seedActiveSession();
    spyOnRefresh();
    requestRefresh("s1", "manual");

    useSessions.getState().removeSession("s1");

    expect(mockedUnwatchWorkingTree).toHaveBeenCalledWith("s1");
  });
});

// --- the live-edit trigger, end to end ------------------------------------
//
// These drive the *production* path — a `session-activity` transition landing
// in `applyActivity` — rather than calling `requestRefresh` directly, so the
// trigger detection (which completed tools count as working-tree mutations)
// and the policy stay pinned together.

/** An activity snapshot with the main agent mid-tool, matching what
 * `session-activity` carries between a tool's `PreToolUse` and `PostToolUse`. */
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

/** An activity snapshot with a single subagent in the given lifecycle state. */
function activityWithSubagent(
  toolUseId: string,
  state: "running" | "done"
): SessionActivity {
  return {
    main: { currentTool: null },
    pendingAsk: null,
    shells: [],
    subagents: [
      {
        agentId: null,
        currentTool: null,
        description: null,
        durationMs: null,
        endedAt: null,
        kind: "Explore",
        result: null,
        startedAt: null,
        state,
        toolUseId,
      },
    ],
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

test("a completed Bash tool live-refreshes the active session (a shell can write files) but records no touch", () => {
  // Regression (smoke QA): the agent created a file with a Bash command
  // (`curl -sL ... -o LICENSE`), which leaves no edit-tool transition, so the
  // Changes view never re-ran its git diff and the new file never appeared.
  // A shell can mutate the working tree, so its completion must trigger the
  // same live refresh an edit does â but Bash has no single file target, so
  // it stays out of touchedFiles attribution.
  vi.useFakeTimers();
  const refresh = vi.fn().mockResolvedValue(undefined);
  useChanges.setState({ refresh });
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));
  s.setActiveSession("s1");
  useLayout.getState().setTranscriptView("changes");

  s.applyActivity(
    "s1",
    activityWithMainTool("Bash", "curl -sL ... -o LICENSE")
  );
  s.applyActivity("s1", idleActivity());

  vi.advanceTimersByTime(1000);
  expect(refresh).toHaveBeenCalledWith("s1", "/repo", {
    baselineOid: null,
    onBaselineInvalid: expect.any(Function),
  });
  expect(useSessions.getState().touchedFiles.s1).toBeUndefined();
});

test("a completed MCP tool live-refreshes the active session (an MCP server can write files)", () => {
  // MCP tools run as the main agent's tool (name `mcp__server__tool`) and can
  // mutate the working tree (a filesystem/git server), so their completion
  // must re-run the diff just like Bash. Only provably read-only built-ins are
  // excluded from the trigger.
  vi.useFakeTimers();
  const refresh = vi.fn().mockResolvedValue(undefined);
  useChanges.setState({ refresh });
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));
  s.setActiveSession("s1");
  useLayout.getState().setTranscriptView("changes");

  s.applyActivity(
    "s1",
    activityWithMainTool("mcp__fs__write_file", "notes.md")
  );
  s.applyActivity("s1", idleActivity());

  vi.advanceTimersByTime(1000);
  expect(refresh).toHaveBeenCalledWith("s1", "/repo", {
    baselineOid: null,
    onBaselineInvalid: expect.any(Function),
  });
});

test("a completed read-only tool (Read) does not refresh the diff â it can't change the tree", () => {
  // Guards the trigger boundary: the hot read tools (Read/Grep/Glob/...) must
  // not churn the diff on every completion.
  vi.useFakeTimers();
  const refresh = vi.fn().mockResolvedValue(undefined);
  useChanges.setState({ refresh });
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));
  s.setActiveSession("s1");
  useLayout.getState().setTranscriptView("changes");

  s.applyActivity("s1", activityWithMainTool("Read", "src/foo.ts"));
  s.applyActivity("s1", idleActivity());

  vi.advanceTimersByTime(1000);
  expect(refresh).not.toHaveBeenCalled();
});

test("a subagent finishing live-refreshes the active session (its edits leave no main-tool transition)", () => {
  // A Task/Agent subagent is tracked in `subagents[]`, not `main.currentTool`,
  // so its file edits produce no main-tool completion. Detect the subagent's
  // running -> done transition and refresh, or its work stays invisible until
  // the next unrelated refresh.
  vi.useFakeTimers();
  const refresh = vi.fn().mockResolvedValue(undefined);
  useChanges.setState({ refresh });
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));
  s.setActiveSession("s1");
  useLayout.getState().setTranscriptView("changes");

  s.applyActivity("s1", activityWithSubagent("t1", "running"));
  s.applyActivity("s1", activityWithSubagent("t1", "done"));

  vi.advanceTimersByTime(1000);
  expect(refresh).toHaveBeenCalledWith("s1", "/repo", {
    baselineOid: null,
    onBaselineInvalid: expect.any(Function),
  });
});

test("a completed edit debounces a changes refresh for the active session, 500ms after it settles", () => {
  vi.useFakeTimers();
  const refresh = vi.fn().mockResolvedValue(undefined);
  useChanges.setState({ refresh });
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));
  s.setActiveSession("s1");
  useLayout.getState().setTranscriptView("changes");

  s.applyActivity("s1", activityWithMainTool("Edit", "src/foo.ts"));
  s.applyActivity("s1", idleActivity());

  expect(refresh).not.toHaveBeenCalled();
  vi.advanceTimersByTime(499);
  expect(refresh).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(refresh).toHaveBeenCalledWith("s1", "/repo", {
    baselineOid: null,
    onBaselineInvalid: expect.any(Function),
  });
});

test("a completed edit still live-refreshes the active session when the transcript view isn't Changes", () => {
  // Regression test: the sidebar (Inspector) reads the active session's
  // diff regardless of which tab is showing, so a live edit must keep it
  // current even while Raw (the default) is on screen â not just
  // record the touch and wait for the user to open the Changes tab.
  vi.useFakeTimers();
  const refresh = vi.fn().mockResolvedValue(undefined);
  useChanges.setState({ refresh });
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));
  s.setActiveSession("s1");
  useLayout.getState().setTranscriptView("raw");

  s.applyActivity("s1", activityWithMainTool("Edit", "src/foo.ts"));
  s.applyActivity("s1", idleActivity());

  vi.advanceTimersByTime(1000);
  expect(refresh).toHaveBeenCalledWith("s1", "/repo", {
    baselineOid: null,
    onBaselineInvalid: expect.any(Function),
  });
  expect(useSessions.getState().touchedFiles.s1).toEqual(["src/foo.ts"]);
});

test("a completed edit for a session that isn't active does not refresh, only records the touch", () => {
  vi.useFakeTimers();
  const refresh = vi.fn().mockResolvedValue(undefined);
  useChanges.setState({ refresh });
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));
  s.addSession(locatedSession("s2"));
  s.setActiveSession("s2");
  useLayout.getState().setTranscriptView("changes");

  s.applyActivity("s1", activityWithMainTool("Edit", "src/foo.ts"));
  s.applyActivity("s1", idleActivity());

  vi.advanceTimersByTime(1000);
  expect(refresh).not.toHaveBeenCalled();
  expect(useSessions.getState().touchedFiles.s1).toEqual(["src/foo.ts"]);
});

test("a burst of edits within the debounce window triggers only one refresh", () => {
  vi.useFakeTimers();
  const refresh = vi.fn().mockResolvedValue(undefined);
  useChanges.setState({ refresh });
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));
  s.setActiveSession("s1");
  useLayout.getState().setTranscriptView("changes");

  s.applyActivity("s1", activityWithMainTool("Edit", "a.ts"));
  s.applyActivity("s1", idleActivity());
  vi.advanceTimersByTime(200);
  s.applyActivity("s1", activityWithMainTool("Edit", "b.ts"));
  s.applyActivity("s1", idleActivity());
  vi.advanceTimersByTime(200);
  expect(refresh).not.toHaveBeenCalled();

  vi.advanceTimersByTime(500);
  expect(refresh).toHaveBeenCalledTimes(1);
});

test("switching the transcript tab away mid-debounce does not cancel the pending refresh (the session is still active)", () => {
  // The gate is active-session-only, not active-session-and-Changes-tab (see
  // `sessionIsActive`), so leaving the Changes tab while the same session
  // stays active must not cancel a pending live refresh â the sidebar still
  // needs the fresh diff.
  vi.useFakeTimers();
  const refresh = vi.fn().mockResolvedValue(undefined);
  useChanges.setState({ refresh });
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));
  s.setActiveSession("s1");
  useLayout.getState().setTranscriptView("changes");

  s.applyActivity("s1", activityWithMainTool("Edit", "src/foo.ts"));
  s.applyActivity("s1", idleActivity());

  vi.advanceTimersByTime(200);
  useLayout.getState().setTranscriptView("raw");
  vi.advanceTimersByTime(300);

  expect(refresh).toHaveBeenCalledWith("s1", "/repo", {
    baselineOid: null,
    onBaselineInvalid: expect.any(Function),
  });
});

test("switching the active session away mid-debounce cancels the pending refresh", () => {
  vi.useFakeTimers();
  const refresh = vi.fn().mockResolvedValue(undefined);
  useChanges.setState({ refresh });
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));
  s.addSession(locatedSession("s2"));
  s.setActiveSession("s1");
  useLayout.getState().setTranscriptView("changes");

  s.applyActivity("s1", activityWithMainTool("Edit", "src/foo.ts"));
  s.applyActivity("s1", idleActivity());

  vi.advanceTimersByTime(200);
  // The user switches to a different session before the debounce fires â
  // s1's Changes view is no longer on screen.
  s.setActiveSession("s2");
  vi.advanceTimersByTime(300);

  expect(refresh).not.toHaveBeenCalled();
});

test("a worktree session's debounced refresh resolves the repo's default branch as its base", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn().mockResolvedValue(undefined);
  useChanges.setState({ refresh });
  mockedDefaultBranch.mockResolvedValue("main");
  const s = useSessions.getState();
  s.addProject({
    color: null,
    id: "p1",
    name: "p1",
    path: "/repo",
    setupCommand: null,
  });
  s.addSession(
    locatedSession("s1", { projectId: "p1", worktreePath: "/repo-wt/feat" })
  );
  s.setActiveSession("s1");
  useLayout.getState().setTranscriptView("changes");

  s.applyActivity("s1", activityWithMainTool("Edit", "src/foo.ts"));
  s.applyActivity("s1", idleActivity());

  await vi.advanceTimersByTimeAsync(500);
  expect(mockedDefaultBranch).toHaveBeenCalledWith("/repo");
  expect(refresh).toHaveBeenCalledWith("s1", "/repo-wt/feat", {
    base: "main",
    baselineOid: null,
    onBaselineInvalid: expect.any(Function),
  });
});

test("a session's debounced refresh threads its baselineOid through to useChanges().refresh", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn().mockResolvedValue(undefined);
  useChanges.setState({ refresh });
  const s = useSessions.getState();
  s.addSession(locatedSession("s1", { baselineOid: "cafebabe" }));
  s.setActiveSession("s1");
  useLayout.getState().setTranscriptView("changes");

  s.applyActivity("s1", activityWithMainTool("Edit", "src/foo.ts"));
  s.applyActivity("s1", idleActivity());

  await vi.advanceTimersByTimeAsync(500);
  expect(refresh).toHaveBeenCalledWith("s1", "/repo", {
    baselineOid: "cafebabe",
    onBaselineInvalid: expect.any(Function),
  });
});

test("a worktree session's debounced refresh threads its baselineOid alongside the resolved base", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn().mockResolvedValue(undefined);
  useChanges.setState({ refresh });
  mockedDefaultBranch.mockResolvedValue("main");
  const s = useSessions.getState();
  s.addProject({
    color: null,
    id: "p1",
    name: "p1",
    path: "/repo",
    setupCommand: null,
  });
  s.addSession(
    locatedSession("s1", {
      baselineOid: "cafebabe",
      projectId: "p1",
      worktreePath: "/repo-wt/feat",
    })
  );
  s.setActiveSession("s1");
  useLayout.getState().setTranscriptView("changes");

  s.applyActivity("s1", activityWithMainTool("Edit", "src/foo.ts"));
  s.applyActivity("s1", idleActivity());

  await vi.advanceTimersByTimeAsync(500);
  expect(refresh).toHaveBeenCalledWith("s1", "/repo-wt/feat", {
    base: "main",
    baselineOid: "cafebabe",
    onBaselineInvalid: expect.any(Function),
  });
});

// --- I1 (round-two review, BLOCKER): pruned baseline clears the stored oid

test("refreshSessionChanges' onBaselineInvalid callback clears the session's baselineOid and re-persists the row", async () => {
  // Mirrors `useChanges().refresh`'s real contract: it calls
  // `options.onBaselineInvalid()` when `diffSessionChanges` reports the
  // baseline object as pruned. Invoking the captured callback here exercises
  // exactly that contract without needing the real `diffSessionChanges`
  // failure plumbing (already covered end to end in `changes.test.ts`).
  const refresh = vi.fn((_id: string, _cwd: string, options) => {
    options.onBaselineInvalid?.();
    return Promise.resolve();
  });
  useChanges.setState({ refresh });
  const s = useSessions.getState();
  s.addSession(locatedSession("s1", { baselineOid: "cafebabe" }));

  await refreshSessionChanges("s1");

  expect(useSessions.getState().sessions.s1?.baselineOid).toBeNull();
  expect(mockedUpsertSession).toHaveBeenCalledWith(
    expect.objectContaining({ baselineOid: null, id: "s1" })
  );
});

test("refreshSessionChanges' onBaselineInvalid callback is a no-op when the session has since been removed", async () => {
  const refresh = vi.fn((_id: string, _cwd: string, options) => {
    options.onBaselineInvalid?.();
    return Promise.resolve();
  });
  useChanges.setState({ refresh });
  const s = useSessions.getState();
  s.addSession(locatedSession("s1", { baselineOid: "cafebabe" }));

  const promise = refreshSessionChanges("s1");
  s.removeSession("s1");
  await promise;

  expect(useSessions.getState().sessions.s1).toBeUndefined();
});

test("a normal refresh (no pruned baseline) never calls onBaselineInvalid, so baselineOid is left untouched", async () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  useChanges.setState({ refresh });
  const s = useSessions.getState();
  s.addSession(locatedSession("s1", { baselineOid: "cafebabe" }));

  await refreshSessionChanges("s1");

  expect(useSessions.getState().sessions.s1?.baselineOid).toBe("cafebabe");
  expect(mockedUpsertSession).not.toHaveBeenCalled();
});

// --- setBaseline's null -> set re-refresh (first-view baseline race) ----

test("setBaseline re-refreshes the session's diff when a baseline first lands", async () => {
  // The race this exists for: `createSession` activates the session (which
  // mounts `ChangesView` and fires its rising-edge refresh) *before*
  // `captureBaseline` resolves, so that first diff is the legacy
  // whole-working-tree one. The oid landing has to re-refresh, or the user's
  // pre-existing dirt is what a brand new session shows first.
  const refresh = vi.fn().mockResolvedValue(undefined);
  useChanges.setState({ refresh });
  const s = useSessions.getState();
  s.addSession(locatedSession("s1", { baselineOid: null }));

  s.setBaseline("s1", "cafebabe");
  await Promise.resolve();

  expect(refresh).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledWith("s1", "/repo", {
    baselineOid: "cafebabe",
    onBaselineInvalid: expect.any(Function),
  });
});

test("setBaseline does not re-refresh when the session already had a baseline", async () => {
  // Hydration/resume paths (and any re-capture) already have their oid by
  // the time `ChangesView` mounts â a second fetch there is pure waste.
  const refresh = vi.fn().mockResolvedValue(undefined);
  useChanges.setState({ refresh });
  const s = useSessions.getState();
  s.addSession(locatedSession("s1", { baselineOid: "cafebabe" }));

  s.setBaseline("s1", "deadbeef");
  await Promise.resolve();

  expect(refresh).not.toHaveBeenCalled();
});

test("setBaseline clearing a pruned baseline never re-refreshes (no loop)", async () => {
  // `onBaselineInvalid` calls `setBaseline(id, null)` from inside a refresh;
  // re-refreshing on that would spin.
  const refresh = vi.fn().mockResolvedValue(undefined);
  useChanges.setState({ refresh });
  const s = useSessions.getState();
  s.addSession(locatedSession("s1", { baselineOid: "cafebabe" }));

  s.setBaseline("s1", null);
  await Promise.resolve();

  expect(refresh).not.toHaveBeenCalled();
});

test("setBaseline does not re-refresh a session with no working directory", async () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  useChanges.setState({ refresh });
  const s = useSessions.getState();
  s.addSession(locatedSession("s1", { baselineOid: null, cwd: "" }));

  s.setBaseline("s1", "cafebabe");
  await Promise.resolve();

  expect(refresh).not.toHaveBeenCalled();
});

test("refreshSessionChanges fetches repoToplevel once per session cwd, not once per call", async () => {
  mockedRepoToplevel.mockResolvedValue("/repo");
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));

  await refreshSessionChanges("s1");
  await refreshSessionChanges("s1");

  expect(mockedRepoToplevel).toHaveBeenCalledTimes(1);
  expect(mockedRepoToplevel).toHaveBeenCalledWith("/repo");
  expect(useSessions.getState().repoToplevel.s1).toBe("/repo");
});

test("refreshSessionChanges refetches repoToplevel when the session's cwd changes", async () => {
  mockedRepoToplevel
    .mockResolvedValueOnce("/repo")
    .mockResolvedValueOnce("/repo-wt/feat");
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));

  await refreshSessionChanges("s1");
  s.addSession(locatedSession("s1", { worktreePath: "/repo-wt/feat" }));
  await refreshSessionChanges("s1");

  expect(mockedRepoToplevel).toHaveBeenCalledTimes(2);
  expect(mockedRepoToplevel).toHaveBeenNthCalledWith(1, "/repo");
  expect(mockedRepoToplevel).toHaveBeenNthCalledWith(2, "/repo-wt/feat");
  expect(useSessions.getState().repoToplevel.s1).toBe("/repo-wt/feat");
});

test("a failed repoToplevel fetch permanently caches the miss for that cwd â a later call for the same cwd never retries", async () => {
  mockedRepoToplevel.mockRejectedValueOnce(new Error("not a repo"));
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));

  await refreshSessionChanges("s1");
  // The rejection settles on a microtask beyond `refreshSessionChanges`'s
  // own await (it's fire-and-forget) â flush it before asserting.
  await Promise.resolve();
  await Promise.resolve();
  expect(useSessions.getState().repoToplevel.s1).toBeUndefined();

  // A second refresh for the exact same cwd (e.g. the next live-edit
  // debounce tick) must not spawn another `repo_toplevel` â a session
  // sitting in a non-git directory would otherwise re-spawn one every
  // refresh forever (this app has prior form on spawn cascades).
  await refreshSessionChanges("s1");
  await Promise.resolve();

  expect(mockedRepoToplevel).toHaveBeenCalledTimes(1);
  expect(useSessions.getState().repoToplevel.s1).toBeUndefined();
});

test("a cwd change after a failed repoToplevel fetch still gets a fresh attempt", async () => {
  mockedRepoToplevel
    .mockRejectedValueOnce(new Error("not a repo"))
    .mockResolvedValueOnce("/repo-wt/feat");
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));

  await refreshSessionChanges("s1");
  await Promise.resolve();
  await Promise.resolve();
  expect(useSessions.getState().repoToplevel.s1).toBeUndefined();

  // A genuinely new cwd (a worktree session picking up its worktree path)
  // isn't the cwd the failure was cached against, so it still gets a fresh
  // attempt rather than inheriting the old cwd's permanent miss.
  s.addSession(locatedSession("s1", { worktreePath: "/repo-wt/feat" }));
  await refreshSessionChanges("s1");
  await Promise.resolve();

  expect(mockedRepoToplevel).toHaveBeenCalledTimes(2);
  expect(mockedRepoToplevel).toHaveBeenNthCalledWith(2, "/repo-wt/feat");
  expect(useSessions.getState().repoToplevel.s1).toBe("/repo-wt/feat");
});

// --- the working-tree watch ---------------------------------------------

test("resolving a session's repo toplevel also starts its working-tree watch", async () => {
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));

  await refreshSessionChanges("s1");

  expect(mockedWatchWorkingTree).toHaveBeenCalledWith("s1", "/repo");
});

test("the working-tree watch is started once per session cwd, not once per refresh", async () => {
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));

  await refreshSessionChanges("s1");
  await refreshSessionChanges("s1");
  await refreshSessionChanges("s1");

  expect(mockedWatchWorkingTree).toHaveBeenCalledTimes(1);
});

test("removing a session releases its working-tree watch", async () => {
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));
  await refreshSessionChanges("s1");

  useSessions.getState().removeSession("s1");

  expect(mockedUnwatchWorkingTree).toHaveBeenCalledWith("s1");
});

test("a working-tree change refreshes the active session in that repo", async () => {
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));
  s.setActiveSession("s1");
  await refreshSessionChanges("s1");
  mockedDefaultBranch.mockClear();

  const refreshSpy = vi.spyOn(useChanges.getState(), "refresh");
  // zustand copies every state property onto the new object each `set`, so a
  // spy installed here survives `mockRestore` and is re-found by the next
  // `vi.spyOn` — complete with the previous test's recorded calls.
  refreshSpy.mockClear();
  applyWorkingTreeChange("/repo");

  expect(refreshSpy).toHaveBeenCalledWith("s1", "/repo", expect.anything());
  refreshSpy.mockRestore();
});

test("the default branch is resolved once per project, not once per refresh", async () => {
  // It used to be awaited on the critical path of every refresh -- fs-change,
  // live-edit, became-active, manual -- costing 1-3 git spawns each time for a
  // value that changes about as often as someone renames `main`.
  const s = useSessions.getState();
  s.addProject({
    color: null,
    id: "p1",
    name: "p1",
    path: "/repo",
    setupCommand: null,
  });
  s.addSession(
    locatedSession("s1", { projectId: "p1", worktreePath: "/repo-wt/feat" })
  );
  s.setActiveSession("s1");
  mockedDefaultBranch.mockClear();
  mockedDefaultBranch.mockResolvedValue("main");
  useChanges.setState({ refresh: vi.fn().mockResolvedValue(undefined) });
  forgetDefaultBranch();

  await refreshSessionChanges("s1");
  await refreshSessionChanges("s1");
  await refreshSessionChanges("s1");

  expect(mockedDefaultBranch).toHaveBeenCalledTimes(1);
});

test("forgetting a memoized default branch makes the next refresh resolve it again", async () => {
  const s = useSessions.getState();
  s.addProject({
    color: null,
    id: "p1",
    name: "p1",
    path: "/repo",
    setupCommand: null,
  });
  s.addSession(
    locatedSession("s1", { projectId: "p1", worktreePath: "/repo-wt/feat" })
  );
  s.setActiveSession("s1");
  mockedDefaultBranch.mockClear();
  mockedDefaultBranch.mockResolvedValue("main");
  useChanges.setState({ refresh: vi.fn().mockResolvedValue(undefined) });
  forgetDefaultBranch();

  await refreshSessionChanges("s1");
  forgetDefaultBranch();
  await refreshSessionChanges("s1");

  expect(mockedDefaultBranch).toHaveBeenCalledTimes(2);
});

test("a completed edit also stops refreshing a repo already over the [Working-tree budget]", async () => {
  // The higher-frequency half of the gate, and the one the fs-change test
  // does not reach: `live-edit` fires from `applyActivity` on every completed
  // mutating tool. Deleting it from `requestRefresh` left the whole suite green.
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));
  s.setActiveSession("s1");
  await refreshSessionChanges("s1");
  seedOverBudget("s1");

  const refreshSpy = vi.spyOn(useChanges.getState(), "refresh");
  refreshSpy.mockClear();
  requestRefresh("s1", "live-edit");
  await vi.waitFor(() => {
    expect(refreshSpy).not.toHaveBeenCalled();
  });
  refreshSpy.mockRestore();
});

test("a failed refresh does not park the [Working-tree budget] suppression forever", async () => {
  // `doRefresh`'s catch keeps the previous diff on screen, so a refusal plus
  // one later unrelated failure would otherwise suppress fs-change and
  // live-edit permanently — long after the user gitignored the directory.
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));
  s.setActiveSession("s1");
  await refreshSessionChanges("s1");
  seedOverBudget("s1");
  useChanges.setState((state) => ({
    bySession: {
      ...state.bySession,
      s1: { ...state.bySession.s1, error: "git exploded", status: "error" },
    },
  }));

  const refreshSpy = vi.spyOn(useChanges.getState(), "refresh");
  refreshSpy.mockClear();
  applyWorkingTreeChange("/repo");

  expect(refreshSpy).toHaveBeenCalledWith("s1", "/repo", expect.anything());
  refreshSpy.mockRestore();
});

test("a working-tree change stops refreshing a repo already over the [Working-tree budget]", async () => {
  // The treadmill this closes: an over-budget repo is exactly the one whose
  // un-ignored directory something keeps writing into, so the watch keeps
  // firing — and every fire costs another bounded-but-real enumeration to
  // reach the same refusal. Once the answer is known, automatic triggers stop
  // asking; the manual button still works, so gitignoring the directory and
  // hitting refresh recovers.
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));
  s.setActiveSession("s1");
  await refreshSessionChanges("s1");
  seedOverBudget("s1");

  const refreshSpy = vi.spyOn(useChanges.getState(), "refresh");
  refreshSpy.mockClear();
  applyWorkingTreeChange("/repo");
  expect(refreshSpy).not.toHaveBeenCalled();

  // The manual path is deliberately still live — it is the recovery route.
  refreshSpy.mockClear();
  await refreshSessionChanges("s1");
  expect(refreshSpy).toHaveBeenCalledWith("s1", "/repo", expect.anything());
  refreshSpy.mockRestore();
});

test("a working-tree change in another repo refreshes nothing", async () => {
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));
  s.setActiveSession("s1");
  await refreshSessionChanges("s1");

  const refreshSpy = vi.spyOn(useChanges.getState(), "refresh");
  // zustand copies every state property onto the new object each `set`, so a
  // spy installed here survives `mockRestore` and is re-found by the next
  // `vi.spyOn` — complete with the previous test's recorded calls.
  refreshSpy.mockClear();
  applyWorkingTreeChange("/some/other/repo");

  expect(refreshSpy).not.toHaveBeenCalled();
  refreshSpy.mockRestore();
});

test("a working-tree change for a non-active session refreshes nothing", async () => {
  // Same bound every other live trigger holds: an inactive session records
  // nothing and spends no `git diff` â it re-fetches when it becomes active.
  const s = useSessions.getState();
  s.addSession(locatedSession("s1"));
  s.addSession(locatedSession("s2"));
  s.setActiveSession("s2");
  await refreshSessionChanges("s1");
  useSessions.setState({ repoToplevel: { s1: "/repo", s2: "/other" } });

  const refreshSpy = vi.spyOn(useChanges.getState(), "refresh");
  // zustand copies every state property onto the new object each `set`, so a
  // spy installed here survives `mockRestore` and is re-found by the next
  // `vi.spyOn` — complete with the previous test's recorded calls.
  refreshSpy.mockClear();
  applyWorkingTreeChange("/repo");

  expect(refreshSpy).not.toHaveBeenCalled();
  refreshSpy.mockRestore();
});

// --- the revalidation protocol -------------------------------------------

/** Stamp a landed refresh epoch for `sessionId`, exactly as `doRefresh`'s
 * success branch does — the one signal {@link useRevalidateOn} watches. */
function landEpoch(sessionId: string, epoch: number): void {
  act(() => {
    useChanges.setState((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: {
          baselineLabel: "",
          collapsed: {},
          diff: null,
          fetchedAt: epoch,
          hunkHashes: {},
          status: "ready" as const,
          totals: null,
          viewed: {},
        },
      },
    }));
  });
}

describe("useRevalidateOn", () => {
  test("the first observation is a no-op, however old the epoch already is", () => {
    // Both consumers mount long after the session's first diff landed (the
    // All-files tab is lazy; a file is opened mid-session), and their own
    // first fetch IS the fresh one — revalidating off an epoch that was
    // already on the store is a pure duplicate.
    landEpoch("s1", 500);
    const fn = vi.fn();

    renderHook(() => useRevalidateOn("s1", fn));

    expect(fn).not.toHaveBeenCalled();
  });

  test("a genuine bump calls fn exactly once", () => {
    landEpoch("s1", 500);
    const fn = vi.fn();
    renderHook(() => useRevalidateOn("s1", fn));

    landEpoch("s1", 1000);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("an unchanged epoch calls nothing, however often the store churns", () => {
    landEpoch("s1", 500);
    const fn = vi.fn();
    const { rerender } = renderHook(() => useRevalidateOn("s1", fn));

    // A re-render, and a store write that leaves this session's epoch alone.
    rerender();
    landEpoch("s2", 900);
    landEpoch("s1", 500);

    expect(fn).not.toHaveBeenCalled();
  });

  test("epoch 0 never fires — a session whose first diff has not landed", () => {
    // `0` is "no fetch has ever succeeded", not a timestamp: firing on it
    // would revalidate against content that was never fetched.
    const fn = vi.fn();
    renderHook(() => useRevalidateOn("s1", fn));

    landEpoch("s1", 0);

    expect(fn).not.toHaveBeenCalled();
  });

  test("another session's refresh never fires this session's revalidation", () => {
    landEpoch("s1", 500);
    landEpoch("s2", 500);
    const fn = vi.fn();
    renderHook(() => useRevalidateOn("s1", fn));

    landEpoch("s2", 1000);

    expect(fn).not.toHaveBeenCalled();
  });

  test("switching session re-baselines: the new session's first epoch is a no-op", () => {
    landEpoch("s1", 500);
    landEpoch("s2", 900);
    const fn = vi.fn();
    const { rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useRevalidateOn(sessionId, fn),
      { initialProps: { sessionId: "s1" } }
    );

    rerender({ sessionId: "s2" });
    expect(fn).not.toHaveBeenCalled();

    // …and the new session's own next bump does fire.
    landEpoch("s2", 1200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("an undefined session never fires", () => {
    // `useFileEditorSession` runs without a session id in the standalone
    // viewer; it has no diff to revalidate against.
    const fn = vi.fn();
    renderHook(() => useRevalidateOn(undefined, fn));

    landEpoch("", 1000);

    expect(fn).not.toHaveBeenCalled();
  });

  test("calls the newest render's fn, not the one it mounted with", () => {
    // Both consumers close over refs and state that change every render
    // (the open file's target, the tree's fetch callback), so a stale
    // closure would revalidate the wrong thing.
    landEpoch("s1", 500);
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = renderHook(
      ({ fn }: { fn: () => void }) => useRevalidateOn("s1", fn),
      { initialProps: { fn: first } }
    );

    rerender({ fn: latest });
    landEpoch("s1", 1000);

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });
});

describe("the All changes scope (uncommitted work)", () => {
  const sessionDiff: SessionDiff = {
    base: "HEAD",
    files: [
      {
        binary: false,
        hunks: [],
        oldPath: null,
        path: "session.ts",
        status: "added",
      },
    ],
  };
  const workingDiff: SessionDiff = {
    base: "HEAD",
    files: [
      {
        binary: false,
        hunks: [],
        oldPath: null,
        path: "older.ts",
        status: "modified",
      },
    ],
  };

  test("with a session snapshot, it fetches the uncommitted diff too while All changes is showing", async () => {
    useSessions
      .getState()
      .addSession(locatedSession("s1", { baselineOid: "cafe" }));
    useSessions.getState().setActiveSession("s1");
    useChanges.getState().setTab("s1", "uncommitted");
    mockedDiffSessionChanges.mockResolvedValue(sessionDiff);
    mockedDiffWorkingTree.mockResolvedValue(workingDiff);

    await refreshSessionChanges("s1");

    const entry = useChanges.getState().bySession.s1;
    expect(entry?.diff).toBe(sessionDiff);
    expect(entry?.uncommitted?.diff).toBe(workingDiff);
    expect(entry?.uncommitted?.label).toBe("HEAD · uncommitted");
    expect(mockedDiffWorkingTree).toHaveBeenCalledWith("/repo", undefined);
  });

  test("the Files tab wants it too, for the tree's git colours", async () => {
    useSessions
      .getState()
      .addSession(locatedSession("s1", { baselineOid: "cafe" }));
    useSessions.getState().setActiveSession("s1");
    useChanges.getState().setTab("s1", "all");
    mockedDiffWorkingTree.mockResolvedValue(workingDiff);

    await refreshSessionChanges("s1");

    expect(useChanges.getState().bySession.s1?.uncommitted?.diff).toBe(
      workingDiff
    );
  });

  test("on the AI changes tab it costs nothing extra", async () => {
    useSessions
      .getState()
      .addSession(locatedSession("s1", { baselineOid: "cafe" }));
    useSessions.getState().setActiveSession("s1");

    await refreshSessionChanges("s1");

    expect(mockedDiffWorkingTree).not.toHaveBeenCalled();
    expect(useChanges.getState().bySession.s1?.uncommitted).toBeUndefined();
  });

  test("without a snapshot the one diff already is the uncommitted one, fetched once", async () => {
    seedActiveSession();
    useChanges.getState().setTab("s1", "uncommitted");
    mockedDiffWorkingTree.mockResolvedValue(workingDiff);

    await refreshSessionChanges("s1");

    expect(mockedDiffWorkingTree).toHaveBeenCalledTimes(1);
    expect(useChanges.getState().bySession.s1?.uncommitted?.diff).toBe(
      workingDiff
    );
  });

  test("a failed uncommitted fetch is reported on its own and leaves the session diff alone", async () => {
    useSessions
      .getState()
      .addSession(locatedSession("s1", { baselineOid: "cafe" }));
    useSessions.getState().setActiveSession("s1");
    useChanges.getState().setTab("s1", "uncommitted");
    mockedDiffSessionChanges.mockResolvedValue(sessionDiff);
    mockedDiffWorkingTree.mockRejectedValue(new Error("git broke"));

    await refreshSessionChanges("s1");

    const entry = useChanges.getState().bySession.s1;
    expect(entry?.status).toBe("ready");
    expect(entry?.diff).toBe(sessionDiff);
    expect(entry?.uncommitted?.error).toBe("git broke");
  });
});

test("a refresh learns from the Activity log which files Claude changed, Bash and subagents included", async () => {
  seedActiveSession();
  mockedActivityChangedPaths.mockResolvedValue(["/repo/gen.ts"]);

  await refreshSessionChanges("s1");

  await vi.waitFor(() =>
    expect(useSessions.getState().touchedFiles.s1).toEqual(["/repo/gen.ts"])
  );
  expect(mockedActivityChangedPaths).toHaveBeenCalledWith("s1");
});

test("an unavailable Activity log never fails the refresh", async () => {
  seedActiveSession();
  mockedActivityChangedPaths.mockRejectedValue(new Error("no store"));

  await refreshSessionChanges("s1");

  expect(useChanges.getState().bySession.s1?.status).toBe("ready");
});

describe("what the diff is compared with, in plain words", () => {
  test("a session with a start snapshot: since session start", async () => {
    useSessions
      .getState()
      .addSession(locatedSession("s1", { baselineOid: "cafe" }));
    useSessions.getState().setActiveSession("s1");
    await refreshSessionChanges("s1");
    expect(useChanges.getState().bySession.s1?.comparedTo).toBe(
      "since session start"
    );
  });

  test("a plain session without one: vs last commit, and All changes says the same", async () => {
    seedActiveSession();
    useChanges.getState().setTab("s1", "uncommitted");
    await refreshSessionChanges("s1");
    const entry = useChanges.getState().bySession.s1;
    expect(entry?.comparedTo).toBe("vs last commit");
    expect(entry?.uncommitted?.comparedTo).toBe("vs last commit");
  });

  test("a worktree session: vs its base branch", async () => {
    const s = useSessions.getState();
    s.addProject({
      color: null,
      id: "p1",
      name: "p1",
      path: "/repo",
      setupCommand: null,
    });
    s.addSession(
      locatedSession("s1", { projectId: "p1", worktreePath: "/repo-wt/x" })
    );
    s.setActiveSession("s1");
    await refreshSessionChanges("s1");
    expect(useChanges.getState().bySession.s1?.comparedTo).toBe("vs main");
  });
});
