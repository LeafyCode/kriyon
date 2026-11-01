import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({
  upsertSession: vi.fn(),
}));
// The [Changes refresh coordinator] is this store's collaborator, not part of
// it: `applyActivity`, `setBaseline` and `removeSession` each hand it one
// call and nothing more. Stubbing it here keeps this suite about session
// state alone — the policy behind those three calls is characterized end to
// end in `changesRefresh.test.ts`, against the real module.
vi.mock("./changesRefresh.ts", () => ({
  forgetSessionRefresh: vi.fn(),
  refreshOnBaselineLanded: vi.fn(),
  requestRefresh: vi.fn(),
}));

import { upsertSession } from "../ipc/bridge.ts";
import type { ProjectRow, SessionActivity, StudioEvent } from "../types.ts";
import { useChanges } from "./changes.ts";
import { DEFAULT_LAYOUT, useLayout } from "./layout.ts";
import {
  badgeCount,
  fullyParkedProjectIds,
  idleSession,
  isPutAway,
  isWorktreeSession,
  LIVE_TOUCH_GRACE_MS,
  relativizeTouchedPath,
  sessionClaudeFiles,
  sessionRow,
  sessionTouchedRelative,
  sessionWorkingDir,
  type UiSession,
  useSessions,
  worktreeName,
} from "./sessions.ts";
import { useUsageCards } from "./usageCards.ts";
import { MAX_WARM_PANES, sessionPaneMounts } from "./warmPanes.ts";

const mockedUpsertSession = vi.mocked(upsertSession);

function makeProject(id: string): ProjectRow {
  return {
    color: null,
    id,
    name: id,
    path: "",
    setupCommand: null,
  };
}

function makeSession(id: string, createdAt: number): UiSession {
  return {
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt,
    cwd: "",
    id,
    projectId: "default",
    status: "idle",
    summary: "",
    title: id,
    titleLocked: false,
    worktreePath: null,
  };
}

/** A tagged transcript prompt event with a stable id. */
function prompt(id: string, text: string): StudioEvent {
  return { id, kind: "prompt", text };
}

/** Build a session with a specific cwd/worktree for the location accessors. */
function located(worktreePath: string | null, cwd = "/repo"): UiSession {
  return { ...makeSession("loc", 1), cwd, worktreePath };
}

/** A UiSession with every persisted field set to a distinct, non-default
 * value — exercises `sessionRow`/`idleSession` round-tripping fields a
 * default-heavy (all-null) fixture would let slip through unnoticed. */
function fullyPopulatedSession(): UiSession {
  return {
    archivedAt: 1_700_000_000_000,
    baselineOid: "deadbeef",
    claudeSessionId: "claude-session-1",
    createdAt: 1_690_000_000_000,
    cwd: "/repo",
    id: "s-full",
    nestedUnder: "s-lead",
    parentSessionId: "s-parent",
    parkedAt: 1_730_000_000_000,
    projectId: "p-full",
    status: "running",
    summary: "mid-turn",
    title: "Fully Populated",
    titleLocked: true,
    worktreePath: "/repo/.worktrees/feat",
  };
}

test("idleSession(sessionRow(s)) round-trips every persisted field", () => {
  const s = fullyPopulatedSession();
  // status/summary are runtime-only (not in SessionRow), so idleSession
  // deliberately resets them rather than round-tripping them.
  expect(idleSession(sessionRow(s))).toEqual({
    ...s,
    status: "idle",
    summary: "",
  });
});

test("sessionWorkingDir prefers the worktree over the cwd", () => {
  expect(sessionWorkingDir(located("/wt"))).toBe("/wt");
  expect(sessionWorkingDir(located(null))).toBe("/repo");
});

test("an empty worktree path counts as no worktree, not a dir of ''", () => {
  // The two sentinels (null and "") must never diverge across the app: an
  // empty path means "runs in the project folder", exactly like null.
  expect(sessionWorkingDir(located(""))).toBe("/repo");
  expect(isWorktreeSession(located(""))).toBe(false);
  expect(worktreeName(located(""))).toBeNull();
});

test("sessionWorkingDir is '' for an absent session", () => {
  expect(sessionWorkingDir(undefined)).toBe("");
});

test("isWorktreeSession is true only for a set worktree path", () => {
  expect(isWorktreeSession(located("/wt"))).toBe(true);
  expect(isWorktreeSession(located(null))).toBe(false);
  expect(isWorktreeSession(undefined)).toBe(false);
});

test("worktreeName is the worktree path's last segment, or null", () => {
  expect(worktreeName(located("/a/b/feat-x"))).toBe("feat-x");
  expect(worktreeName(located("/a/b/feat-x/"))).toBe("feat-x");
  expect(worktreeName(located(null))).toBeNull();
});

beforeEach(() => {
  // Partial update keeps the action functions intact while resetting data.
  useSessions.setState({
    activeSessionId: null,
    activity: {},
    appendSeq: {},
    events: {},
    exited: {},
    pendingSeedPrompt: {},
    bootPhase: {},
    warmPanes: [],
    viewed: {},
    projects: [],
    sessions: {},
    statusOrigin: {},
    touchedFiles: {},
    touchedLive: {},
    touchedSynced: {},
    repoToplevel: {},
    repoToplevelCwd: {},
  });
  useLayout.setState({ layout: DEFAULT_LAYOUT });
  useChanges.setState({ bySession: {} });
  mockedUpsertSession.mockReset().mockResolvedValue(undefined);
  vi.useRealTimers();
});

function activityFixture(): SessionActivity {
  return {
    main: { currentTool: null },
    pendingAsk: null,
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
        state: "running",
        toolUseId: "a",
      },
      {
        agentId: null,
        currentTool: null,
        description: null,
        durationMs: null,
        endedAt: null,
        kind: "Plan",
        result: "done",
        startedAt: null,
        state: "done",
        toolUseId: "b",
      },
    ],
    shells: [
      {
        bashId: "s1",
        cmd: "pnpm dev",
        status: "running",
        exit: null,
        lastPolledAt: null,
      },
      {
        bashId: "s2",
        cmd: "cargo build",
        status: "exited",
        exit: 0,
        lastPolledAt: null,
      },
    ],
    tasks: [{ text: "wire ui", status: "in_progress", activeForm: null }],
  };
}

test("applyActivity stores the snapshot by session id", () => {
  const snap = activityFixture();
  useSessions.getState().applyActivity("s1", snap);
  expect(useSessions.getState().activity.s1).toBe(snap);
});

test("badgeCount counts running subagents and running shells only", () => {
  // 1 running agent + 1 running shell; the done agent, exited shell, and the
  // in-progress task do not count toward the at-a-glance badge.
  expect(badgeCount(activityFixture())).toBe(2);
});

test("badgeCount of missing activity is zero", () => {
  expect(badgeCount(undefined)).toBe(0);
});

test("addProject appends if id not present", () => {
  const { addProject } = useSessions.getState();
  addProject(makeProject("a"));
  addProject(makeProject("a"));
  addProject(makeProject("b"));
  expect(useSessions.getState().projects.map((p) => p.id)).toEqual(["a", "b"]);
});

test("setProjectColor updates one project and produces a new projects array", () => {
  const { addProject } = useSessions.getState();
  addProject(makeProject("a"));
  addProject(makeProject("b"));
  const before = useSessions.getState().projects;

  useSessions.getState().setProjectColor("a", "#7fb3e6");

  const after = useSessions.getState().projects;
  // A fresh array reference so the persistence subscriber notices the change.
  expect(after).not.toBe(before);
  expect(after.find((p) => p.id === "a")?.color).toBe("#7fb3e6");
  expect(after.find((p) => p.id === "b")?.color).toBeNull();

  // Null returns the project to its automatic palette hue.
  useSessions.getState().setProjectColor("a", null);
  expect(
    useSessions.getState().projects.find((p) => p.id === "a")?.color
  ).toBeNull();
});

test("renameProject sets a trimmed name and ignores empty/no-op renames", () => {
  const s = useSessions.getState();
  s.addProject(makeProject("a"));
  s.addProject(makeProject("b"));

  useSessions.getState().renameProject("a", "  New name  ");
  const { projects } = useSessions.getState();
  expect(projects.find((p) => p.id === "a")?.name).toBe("New name");
  expect(projects.find((p) => p.id === "b")?.name).toBe(makeProject("b").name);

  // An all-whitespace name is ignored (the header would have nothing to show).
  const before = useSessions.getState().projects;
  useSessions.getState().renameProject("a", "   ");
  expect(useSessions.getState().projects).toBe(before);
});

test("renameSession sets a trimmed title and locks it", () => {
  const s = useSessions.getState();
  s.addSession(makeSession("s1", 1));

  useSessions.getState().renameSession("s1", "  My name  ");
  const session = useSessions.getState().sessions.s1;
  expect(session?.title).toBe("My name");
  expect(session?.titleLocked).toBe(true);

  // An empty rename is ignored.
  const before = useSessions.getState().sessions;
  useSessions.getState().renameSession("s1", "  ");
  expect(useSessions.getState().sessions).toBe(before);
});

test("applyTitle is ignored once the user has locked the title", () => {
  const s = useSessions.getState();
  s.addSession(makeSession("s1", 1));

  // A pre-rename auto-title still applies.
  useSessions.getState().applyTitle("s1", "Auto A");
  expect(useSessions.getState().sessions.s1?.title).toBe("Auto A");

  // After a manual rename, Claude re-titling the session must not clobber it.
  useSessions.getState().renameSession("s1", "Mine");
  useSessions.getState().applyTitle("s1", "Auto B");
  expect(useSessions.getState().sessions.s1?.title).toBe("Mine");
});

test("addSession inserts and sets the first session active", () => {
  const { addSession } = useSessions.getState();
  addSession(makeSession("s1", 1));
  expect(useSessions.getState().sessions.s1).toBeDefined();
  expect(useSessions.getState().activeSessionId).toBe("s1");

  addSession(makeSession("s2", 2));
  // Active stays on the first one (not the second).
  expect(useSessions.getState().activeSessionId).toBe("s1");
});

test("setActiveSession sets the active id", () => {
  const { addSession, setActiveSession } = useSessions.getState();
  addSession(makeSession("s1", 1));
  addSession(makeSession("s2", 2));
  setActiveSession("s2");
  expect(useSessions.getState().activeSessionId).toBe("s2");
});

test("a background session added but never active never mounts (no boot resume)", () => {
  const s = useSessions.getState();
  s.addSession(makeSession("s1", 1)); // first â active
  s.addSession(makeSession("s2", 2)); // background
  const st = useSessions.getState();
  // addSession must NOT pre-warm anything; only the active tab mounts.
  expect(st.warmPanes).toEqual([]);
  expect(sessionPaneMounts(st.activeSessionId, st.warmPanes, "s1")).toBe(true);
  expect(sessionPaneMounts(st.activeSessionId, st.warmPanes, "s2")).toBe(false);
});

test("switching away keeps the departing session warm (keep-alive)", () => {
  const s = useSessions.getState();
  s.addSession(makeSession("s1", 1));
  s.addSession(makeSession("s2", 2));
  s.setActiveSession("s2"); // leaving s1 keeps it warm
  const st = useSessions.getState();
  expect(st.activeSessionId).toBe("s2");
  expect(sessionPaneMounts(st.activeSessionId, st.warmPanes, "s1")).toBe(true);
  expect(sessionPaneMounts(st.activeSessionId, st.warmPanes, "s2")).toBe(true);
});

test("removeSession drops the removed id from the warm set", () => {
  const s = useSessions.getState();
  s.addSession(makeSession("s1", 1));
  s.addSession(makeSession("s2", 2));
  s.setActiveSession("s2"); // s1 warm
  s.setActiveSession("s1"); // s2 warm
  expect(useSessions.getState().warmPanes).toContain("s2");
  s.removeSession("s2");
  expect(useSessions.getState().warmPanes).not.toContain("s2");
});

test("removeSession prunes the closed session's Code Changes View state", () => {
  const s = useSessions.getState();
  s.addSession(makeSession("s1", 1));
  useChanges.setState({
    activeFile: { s1: "a.ts" },
    ui: { s1: { selectedFile: "a.ts", tab: "all" } },
  });

  s.removeSession("s1");

  const changes = useChanges.getState();
  expect(changes.activeFile).not.toHaveProperty("s1");
  expect(changes.ui).not.toHaveProperty("s1");
});

test("removeSession drops the closed session's usage card", () => {
  const s = useSessions.getState();
  s.addSession(makeSession("s1", 1));
  useUsageCards.getState().show("s1", { at: 1, command: "/usage" });

  s.removeSession("s1");

  expect(useUsageCards.getState().shown).not.toHaveProperty("s1");
});

test("the warm set is bounded â the coldest pane is evicted past the cap", () => {
  const s = useSessions.getState();
  // Create the active session plus MAX_WARM_PANES + 1 others.
  s.addSession(makeSession("active", 0));
  const extras = Array.from({ length: MAX_WARM_PANES + 1 }, (_, i) => `w${i}`);
  for (const [i, id] of extras.entries()) {
    s.addSession(makeSession(id, i + 1));
  }
  // Visit each extra (leaving the previous one warm), oldest first.
  for (const id of extras) {
    s.setActiveSession(id);
  }
  const { warmPanes } = useSessions.getState();
  // The warm set never grows past the cap; the least-recently-left ("active",
  // departed first when we switched to w0) is evicted.
  expect(warmPanes).toHaveLength(MAX_WARM_PANES);
  expect(warmPanes).not.toContain("active");
  expect(warmPanes).toContain("w0");
});

test("applyStatus updates status and summary for the right session", () => {
  const { addSession, applyStatus } = useSessions.getState();
  addSession(makeSession("s1", 1));
  addSession(makeSession("s2", 2));

  applyStatus("s1", "running", "$ ls -la");
  expect(useSessions.getState().sessions.s1?.status).toBe("running");
  expect(useSessions.getState().sessions.s1?.summary).toBe("$ ls -la");
  // The other session is untouched.
  expect(useSessions.getState().sessions.s2?.status).toBe("idle");
  expect(useSessions.getState().sessions.s2?.summary).toBe("");

  // No-op for an unknown id.
  applyStatus("missing", "error", "boom");
  expect(useSessions.getState().sessions.missing).toBeUndefined();
});

test("applyStatus records whether a status was replayed or seen live", () => {
  const { addSession, applyStatus } = useSessions.getState();
  addSession(makeSession("origin1", 1));

  applyStatus("origin1", "done", "", true);
  expect(useSessions.getState().statusOrigin.origin1).toBe("seeded");

  // A live update supersedes the replay: the session did something this run.
  applyStatus("origin1", "done", "", false);
  expect(useSessions.getState().statusOrigin.origin1).toBe("live");
});

test("a late-arriving seed cannot re-suppress a live finish", () => {
  // The backend seeds on its own thread, so a seeded update can land after a
  // live one for the same session. If it won, a finish that genuinely happened
  // this run would drop back out of Needs-you.
  const { addSession, applyStatus } = useSessions.getState();
  addSession(makeSession("origin2", 1));

  applyStatus("origin2", "done", "", false);
  applyStatus("origin2", "done", "", true);

  expect(useSessions.getState().statusOrigin.origin2).toBe("live");
});

test("removeSession drops the session's status-origin mark", () => {
  const { addSession, applyStatus, removeSession } = useSessions.getState();
  addSession(makeSession("origin3", 1));
  applyStatus("origin3", "done", "", true);

  removeSession("origin3");

  expect(useSessions.getState().statusOrigin.origin3).toBeUndefined();
});

test("appendEvent dedupes by id so replaying the transcript is idempotent", () => {
  const { appendEvent } = useSessions.getState();
  // The same line re-read (remount / `claude --resume` re-tail) carries the same
  // id, so it must not stack â even though the text is identical.
  appendEvent("s1", prompt("u1:0", "hello"));
  appendEvent("s1", prompt("u1:0", "hello"));
  appendEvent("s1", prompt("u2:0", "hello"));
  expect(useSessions.getState().events.s1).toEqual([
    prompt("u1:0", "hello"),
    prompt("u2:0", "hello"),
  ]);
});

test("appendEvents applies a burst in a single store update", () => {
  const { appendEvents } = useSessions.getState();
  let updates = 0;
  const unsubscribe = useSessions.subscribe(() => {
    updates += 1;
  });
  appendEvents("s1", [
    prompt("u1:0", "one"),
    prompt("u2:0", "two"),
    prompt("u3:0", "three"),
  ]);
  unsubscribe();
  expect(updates).toBe(1);
  expect(useSessions.getState().events.s1).toEqual([
    prompt("u1:0", "one"),
    prompt("u2:0", "two"),
    prompt("u3:0", "three"),
  ]);
});

test("appendEvents dedupes replayed ids within and across bursts", () => {
  const { appendEvent, appendEvents } = useSessions.getState();
  appendEvent("s1", prompt("u1:0", "one"));
  appendEvents("s1", [
    prompt("u1:0", "one"),
    prompt("u2:0", "two"),
    prompt("u2:0", "two"),
  ]);
  expect(useSessions.getState().events.s1).toEqual([
    prompt("u1:0", "one"),
    prompt("u2:0", "two"),
  ]);
});

test("appendEvents with only re-seen ids does not notify subscribers", () => {
  const { appendEvent, appendEvents } = useSessions.getState();
  appendEvent("s1", prompt("u1:0", "one"));
  let updates = 0;
  const unsubscribe = useSessions.subscribe(() => {
    updates += 1;
  });
  appendEvents("s1", [prompt("u1:0", "one")]);
  unsubscribe();
  expect(updates).toBe(0);
});

test("appendEvents keeps the buffer capped at the event limit", () => {
  const { appendEvents } = useSessions.getState();
  const burst = Array.from({ length: 1005 }, (_, i) =>
    prompt(`u${i}:0`, `line ${i}`)
  );
  appendEvents("s1", burst);
  const events = useSessions.getState().events.s1 ?? [];
  expect(events).toHaveLength(1000);
  expect(events[0]).toEqual(prompt("u5:0", "line 5"));
});

test("applySleeping records the phase and clears it on wake", () => {
  const { applySleeping } = useSessions.getState();
  applySleeping("s1", "asleep");
  expect(useSessions.getState().sleeping.s1).toBe("asleep");
  applySleeping("s1", "awake");
  expect(useSessions.getState().sleeping.s1).toBeUndefined();
});

test("applySleeping distinguishes a stuck session from a sleeping one", () => {
  // A session Kriyon could not wake must be tellable from one peacefully
  // asleep â otherwise the row sits moon-marked forever with no explanation.
  const { applySleeping } = useSessions.getState();
  applySleeping("s1", "asleep");
  applySleeping("s1", "stuck");
  expect(useSessions.getState().sleeping.s1).toBe("stuck");
  applySleeping("s1", "awake");
  expect(useSessions.getState().sleeping.s1).toBeUndefined();
});

test("applyResources replaces the per-session memory and CPU maps", () => {
  const { applyResources } = useSessions.getState();
  applyResources({
    cpu: { s1: 12.5 },
    sessions: { s1: 431, s2: 250 },
    totalCpuPct: 12.5,
    totalMb: 681,
  });
  expect(useSessions.getState().memory).toEqual({ s1: 431, s2: 250 });
  expect(useSessions.getState().cpu).toEqual({ s1: 12.5 });
  // A later sweep fully replaces both maps — a closed session's entry must not
  // linger from a previous sweep.
  applyResources({
    cpu: {},
    sessions: { s1: 440 },
    totalCpuPct: null,
    totalMb: 440,
  });
  expect(useSessions.getState().memory).toEqual({ s1: 440 });
  expect(useSessions.getState().cpu).toEqual({});
});

test("applyTitle updates the title and is a no-op if absent or unchanged", () => {
  const { addSession, applyTitle } = useSessions.getState();
  addSession(makeSession("s1", 1));
  applyTitle("s1", "Fix session persistence");
  expect(useSessions.getState().sessions.s1?.title).toBe(
    "Fix session persistence"
  );
  applyTitle("missing", "x");
  expect(useSessions.getState().sessions.missing).toBeUndefined();
});

test("applyClaudeId records Claude's session id for later resume", () => {
  const { addSession, applyClaudeId } = useSessions.getState();
  addSession(makeSession("s1", 1));
  applyClaudeId("s1", "claude-abc");
  expect(useSessions.getState().sessions.s1?.claudeSessionId).toBe(
    "claude-abc"
  );
});

test("noteSessionExited marks a known session, and a live status clears it", () => {
  const { addSession, applyStatus, noteSessionExited } = useSessions.getState();
  addSession(makeSession("s1", 1));

  noteSessionExited("s1");
  expect(useSessions.getState().exited.s1).toBe(true);
  // An id the store has never seen (a Project terminal pane shares the
  // handler) leaves no mark behind.
  noteSessionExited("pane-1");
  expect(useSessions.getState().exited["pane-1"]).toBeUndefined();

  // A replayed status proves nothing — it was rebuilt from the events file.
  applyStatus("s1", "running", "Workingâ¦", true);
  expect(useSessions.getState().exited.s1).toBe(true);

  // A live hook can only come from a running claude: it is back.
  applyStatus("s1", "running", "Workingâ¦");
  expect(useSessions.getState().exited.s1).toBe(false);
});

test("removing the active session selects the newest remaining", () => {
  const { addSession, setActiveSession, removeSession } =
    useSessions.getState();
  addSession(makeSession("s1", 10));
  addSession(makeSession("s2", 30));
  addSession(makeSession("s3", 20));
  setActiveSession("s1");

  removeSession("s1");
  expect(useSessions.getState().sessions.s1).toBeUndefined();
  // s2 has the highest createdAt among the remaining.
  expect(useSessions.getState().activeSessionId).toBe("s2");
});

test("removing a non-active session keeps the active id", () => {
  const { addSession, setActiveSession, removeSession } =
    useSessions.getState();
  addSession(makeSession("s1", 1));
  addSession(makeSession("s2", 2));
  setActiveSession("s1");
  removeSession("s2");
  expect(useSessions.getState().activeSessionId).toBe("s1");
});

test("removing the last session leaves activeSessionId null", () => {
  const { addSession, removeSession } = useSessions.getState();
  addSession(makeSession("s1", 1));
  removeSession("s1");
  expect(useSessions.getState().sessions.s1).toBeUndefined();
  expect(useSessions.getState().activeSessionId).toBeNull();
});

test("appendEvent appends events in order and creates the array if absent", () => {
  const { appendEvent } = useSessions.getState();
  const e1: StudioEvent = prompt("u1:0", "first");
  const e2: StudioEvent = { id: "u2:0", kind: "assistant", text: "second" };

  appendEvent("s1", e1);
  appendEvent("s1", e2);

  expect(useSessions.getState().events.s1).toEqual([e1, e2]);
});

test("appendEvent isolates events per session", () => {
  const { appendEvent } = useSessions.getState();
  const a = prompt("u1:0", "a");
  const b = prompt("u2:0", "b");

  appendEvent("s1", a);
  appendEvent("s2", b);

  expect(useSessions.getState().events.s1).toEqual([a]);
  expect(useSessions.getState().events.s2).toEqual([b]);
});

test("appendEvent caps the per-session array at MAX_EVENTS, keeping the latest", () => {
  const { appendEvent } = useSessions.getState();
  const MAX_EVENTS = 1000;
  const total = MAX_EVENTS + 50;
  for (let i = 0; i < total; i += 1) {
    appendEvent("s1", prompt(`u${i}:0`, `e${i}`));
  }

  const events = useSessions.getState().events.s1 ?? [];
  expect(events).toHaveLength(MAX_EVENTS);
  // The oldest 50 were dropped, so the first kept event is e50.
  const [first] = events;
  expect(first?.kind === "prompt" ? first.text : undefined).toBe(
    `e${total - MAX_EVENTS}`
  );
});

test("an event id evicted by the cap is treated as new if it reappears", () => {
  // The Set-based dedup must mirror the retained array: once the cap drops an
  // id it is no longer "seen", so the same id appended later is added afresh
  // (matching the array-scan behavior it replaces).
  const { appendEvent } = useSessions.getState();
  const MAX_EVENTS = 1000;
  // Fill one past the cap so the oldest id (u0:0) is evicted.
  for (let i = 0; i <= MAX_EVENTS; i += 1) {
    appendEvent("s1", prompt(`u${i}:0`, `e${i}`));
  }
  appendEvent("s1", prompt("u0:0", "again"));

  const events = useSessions.getState().events.s1 ?? [];
  const [last] = events.slice(-1);
  expect(last?.id).toBe("u0:0");
  expect(last?.kind === "prompt" ? last.text : undefined).toBe("again");
});

test("appending to one session keeps another session's events reference stable", () => {
  // Narrow per-session selectors rely on this: a tick on s1 must not hand s2 a
  // new array reference, or every row would re-render on any session's event.
  const { appendEvent } = useSessions.getState();
  appendEvent("s2", prompt("a:0", "x"));
  const before = useSessions.getState().events.s2;
  appendEvent("s1", prompt("b:0", "y"));
  expect(useSessions.getState().events.s2).toBe(before);
});

test("clearEvents resets a session's events to empty", () => {
  const { appendEvent, clearEvents } = useSessions.getState();
  appendEvent("s1", prompt("u1:0", "a"));
  appendEvent("s1", prompt("u2:0", "b"));
  appendEvent("s2", prompt("u3:0", "keep"));

  clearEvents("s1");

  expect(useSessions.getState().events.s1).toEqual([]);
  // Other sessions are untouched.
  expect(useSessions.getState().events.s2).toHaveLength(1);
});

const phaseOf = (id: string) => useSessions.getState().bootPhase[id] ?? "idle";

test("applyBootEvent launches idle â booting and a real start â live", () => {
  const s = useSessions.getState();
  s.addSession(makeSession("s1", 1));

  s.applyBootEvent("s1", "launch");
  expect(phaseOf("s1")).toBe("booting");

  s.applyBootEvent("s1", "started");
  expect(phaseOf("s1")).toBe("live");
});

test("applyBootEvent is a no-op that keeps the same state reference", () => {
  const s = useSessions.getState();
  s.addSession(makeSession("s1", 1));
  const before = useSessions.getState();
  // dismissFailed from idle changes nothing.
  s.applyBootEvent("s1", "dismissFailed");
  expect(useSessions.getState()).toBe(before);
});

test("applyStatus clears a booting overlay (a live status means claude is up)", () => {
  const s = useSessions.getState();
  s.addSession(makeSession("s1", 1));
  s.applyBootEvent("s1", "launch");

  s.applyStatus("s1", "running", "Workingâ¦");
  expect(phaseOf("s1")).toBe("live");
  expect(useSessions.getState().sessions.s1?.status).toBe("running");
});

test("applyStatus never clears a detected resume failure", () => {
  const s = useSessions.getState();
  s.addSession(makeSession("s1", 1));
  s.applyBootEvent("s1", "launch");
  s.applyBootEvent("s1", "resumeFailed");
  expect(phaseOf("s1")).toBe("resumeFailed");

  // A stray status while the recovery prompt is up must leave it standing.
  s.applyStatus("s1", "running", "Workingâ¦");
  expect(phaseOf("s1")).toBe("resumeFailed");
});

test("a resume failure replaces the loading overlay with the recovery prompt", () => {
  const s = useSessions.getState();
  s.addSession(makeSession("s1", 1));
  s.applyBootEvent("s1", "launch");

  s.applyBootEvent("s1", "resumeFailed");
  expect(phaseOf("s1")).toBe("resumeFailed");
});

test("dismissing the recovery prompt settles back to idle", () => {
  const s = useSessions.getState();
  s.addSession(makeSession("s1", 1));
  s.applyBootEvent("s1", "launch");
  s.applyBootEvent("s1", "resumeFailed");

  s.applyBootEvent("s1", "dismissFailed");
  expect(phaseOf("s1")).toBe("idle");
});

test("the boot timeout clears a booting overlay but never a detected failure", () => {
  const s = useSessions.getState();
  s.addSession(makeSession("s1", 1));

  // Booting â the safety net force-clears to live.
  s.applyBootEvent("s1", "launch");
  s.applyBootEvent("s1", "timeout");
  expect(phaseOf("s1")).toBe("live");

  // Failure standing â the timeout must not erase it.
  s.applyBootEvent("s1", "launch");
  s.applyBootEvent("s1", "resumeFailed");
  s.applyBootEvent("s1", "timeout");
  expect(phaseOf("s1")).toBe("resumeFailed");
});

test("switching sessions stamps the departing session and re-stamps the arrival", () => {
  const now = Date.now();
  useSessions.setState({
    activeSessionId: "s1",
    appendSeq: { s2: 1 },
    events: {
      s2: [{ id: "1:0", kind: "assistant", text: "Waiting on you." }],
    },
    // s2 was last viewed 6 min ago at append-seq 0 (one event has landed since).
    viewed: { s2: { appendSeq: 0, ms: now - 6 * 60_000, tasksDone: 0 } },
  });
  useSessions.getState().setActiveSession("s2");
  const state = useSessions.getState();
  expect(state.viewed.s1?.ms).toBeGreaterThan(0);
  // The arrival is now considered viewed as of the live append counter.
  expect(state.viewed.s2?.appendSeq).toBe(1);
});

// Archiving stops the session's processes (see `archiveSessionAndStop`), so its
// terminal must not stay on screen or stay mounted: a pane still wired to the
// stopped host would sit dead, and would stay blank after an un-archive.
test("archiving the active session hands the selection to the newest live one", () => {
  useSessions.setState({
    activeSessionId: "s2",
    sessions: {
      s1: makeSession("s1", 1),
      s2: makeSession("s2", 2),
      old: { ...makeSession("old", 3), archivedAt: 5 },
    },
    warmPanes: ["s1"],
  });

  useSessions.getState().archiveSession("s2");

  const state = useSessions.getState();
  // Not "old": it is newer, but archived sessions are out of sight.
  expect(state.activeSessionId).toBe("s1");
  expect(state.sessions.s2?.archivedAt).toBeGreaterThan(0);
});

test("archiving a warm session drops its mount and leaves the selection alone", () => {
  useSessions.setState({
    activeSessionId: "s1",
    sessions: { s1: makeSession("s1", 1), s2: makeSession("s2", 2) },
    warmPanes: ["s2"],
  });

  useSessions.getState().archiveSession("s2");

  const state = useSessions.getState();
  expect(state.activeSessionId).toBe("s1");
  expect(state.warmPanes).toEqual([]);
});

test("archiving the only live session leaves nothing selected", () => {
  useSessions.setState({
    activeSessionId: "s1",
    sessions: { s1: makeSession("s1", 1) },
    warmPanes: [],
  });

  useSessions.getState().archiveSession("s1");

  expect(useSessions.getState().activeSessionId).toBeNull();
});

test("archiveSession stamps archivedAt and unarchive clears it", () => {
  const now = 1_720_000_000_000;
  useSessions.setState({
    sessions: {
      s1: {
        archivedAt: null,
        baselineOid: null,
        claudeSessionId: null,
        createdAt: 1,
        cwd: "/repo",
        id: "s1",
        projectId: "p1",
        status: "idle",
        summary: "",
        title: "One",
        titleLocked: false,
        worktreePath: null,
      },
    },
  });
  useSessions.getState().archiveSession("s1");
  expect(useSessions.getState().sessions.s1?.archivedAt).toBeGreaterThan(0);
  useSessions.getState().unarchiveSession("s1");
  expect(useSessions.getState().sessions.s1?.archivedAt).toBeNull();
  expect(now).toBeGreaterThan(0); // anchor the clock reference
});

test("consumePendingSeedPrompt returns the seed once, then undefined", () => {
  useSessions.setState({ pendingSeedPrompt: {} });
  useSessions.getState().setPendingSeedPrompt("s1", "Continue the work");
  expect(useSessions.getState().pendingSeedPrompt.s1).toBe("Continue the work");
  expect(useSessions.getState().consumePendingSeedPrompt("s1")).toBe(
    "Continue the work"
  );
  // consumed: removed from the map and undefined on a second read.
  expect(useSessions.getState().pendingSeedPrompt.s1).toBeUndefined();
  expect(useSessions.getState().consumePendingSeedPrompt("s1")).toBeUndefined();
});

// --- touchedFiles attribution -------------------------------------------
//
// The *refresh* half of this signal (which completed tools re-run the diff,
// and how soon) is the [Changes refresh coordinator]'s — see
// `changesRefresh.test.ts`. What stays here is what the session store itself
// owns: which completions are worth attributing to the session.

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

/** An activity snapshot with no tool running â what `PostToolUse` clears to. */
function idleActivity(): SessionActivity {
  return {
    main: { currentTool: null },
    pendingAsk: null,
    shells: [],
    subagents: [],
    tasks: [],
  };
}

test("applyActivity records a touched file when an edit tool's PostToolUse clears", () => {
  const s = useSessions.getState();
  s.applyActivity("s1", activityWithMainTool("Edit", "src/foo.ts"));
  // Still mid-tool: nothing completed yet.
  expect(useSessions.getState().touchedFiles.s1).toBeUndefined();

  s.applyActivity("s1", idleActivity());
  expect(useSessions.getState().touchedFiles.s1).toEqual(["src/foo.ts"]);
});

test("applyActivity ignores PostToolUse for non-edit tools", () => {
  const s = useSessions.getState();
  s.applyActivity("s1", activityWithMainTool("Bash", "pnpm test"));
  s.applyActivity("s1", idleActivity());
  expect(useSessions.getState().touchedFiles.s1).toBeUndefined();
});

test("applyActivity dedupes touchedFiles, preserving first-touch order", () => {
  const s = useSessions.getState();
  s.applyActivity("s1", activityWithMainTool("Edit", "a.ts"));
  s.applyActivity("s1", idleActivity());
  s.applyActivity("s1", activityWithMainTool("Write", "b.ts"));
  s.applyActivity("s1", idleActivity());
  // a.ts touched again â must not move to the end or duplicate.
  s.applyActivity("s1", activityWithMainTool("Edit", "a.ts"));
  s.applyActivity("s1", idleActivity());
  expect(useSessions.getState().touchedFiles.s1).toEqual(["a.ts", "b.ts"]);
});

// --- setRepoToplevel ---------------------------------------------------

test("a claim records the cwd alone, and its resolve records the toplevel alone", () => {
  const s = useSessions.getState();

  s.setRepoToplevel("s1", "/repo");
  expect(useSessions.getState().repoToplevelCwd.s1).toBe("/repo");
  expect(useSessions.getState().repoToplevel.s1).toBeUndefined();

  s.setRepoToplevel("s1", "/repo", "/repo");
  expect(useSessions.getState().repoToplevel.s1).toBe("/repo");
});

test("a stale resolve never reverts a newer claim", () => {
  // The claim is what stops `ensureRepoToplevel` spending a second
  // `repo_toplevel` — and a second `watchWorkingTree` — on a directory it has
  // already handled. It is monotonic per session: if the session's cwd moves
  // A → B while A's lookup is still in flight, A's late answer must not put
  // the guard back on A, or the next refresh re-spawns both for B.
  const s = useSessions.getState();
  s.setRepoToplevel("s1", "/a");
  s.setRepoToplevel("s1", "/b");

  s.setRepoToplevel("s1", "/a", "/a-root");

  expect(useSessions.getState().repoToplevelCwd.s1).toBe("/b");
});

// --- sessionTouchedRelative + the repoToplevel cache --------------------

test("sessionTouchedRelative relativizes absolute touchedFiles against the cached repo toplevel, dropping entries outside the repo", () => {
  useSessions.setState({
    repoToplevel: { s1: "/repo" },
    touchedFiles: { s1: ["/repo/src/a.ts", "/other/x.ts"] },
  });

  const rel = sessionTouchedRelative("s1");

  expect(rel.has("src/a.ts")).toBe(true);
  expect(rel.has("x.ts")).toBe(false);
  expect(rel.size).toBe(1);
});

test("sessionTouchedRelative is empty before a toplevel has been cached for the session", () => {
  useSessions.setState({
    repoToplevel: {},
    touchedFiles: { s1: ["/repo/src/a.ts"] },
  });

  expect(sessionTouchedRelative("s1").size).toBe(0);
});

test("sessionTouchedRelative is empty for a session with no touched files", () => {
  useSessions.setState({ repoToplevel: { s1: "/repo" }, touchedFiles: {} });

  expect(sessionTouchedRelative("s1").size).toBe(0);
});

test("sessionTouchedRelative returns the same Set instance across calls when neither touchedFiles nor the toplevel changed", () => {
  useSessions.setState({
    repoToplevel: { s1: "/repo" },
    touchedFiles: { s1: ["/repo/src/a.ts"] },
  });

  const first = sessionTouchedRelative("s1");
  const second = sessionTouchedRelative("s1");

  expect(second).toBe(first);
});

test("sessionTouchedRelative recomputes once touchedFiles gets a fresh array (a new touch)", () => {
  useSessions.setState({
    repoToplevel: { s1: "/repo" },
    touchedFiles: { s1: ["/repo/src/a.ts"] },
  });
  const first = sessionTouchedRelative("s1");

  useSessions.setState((state) => ({
    touchedFiles: {
      ...state.touchedFiles,
      s1: ["/repo/src/a.ts", "/repo/src/b.ts"],
    },
  }));
  const second = sessionTouchedRelative("s1");

  expect(second).not.toBe(first);
  expect(second.has("src/b.ts")).toBe(true);
});

test("removeSession leaves no per-session state behind", () => {
  // Every map keyed by session id has to be pruned together. `events` alone
  // holds up to MAX_EVENTS parsed transcript entries, so a project clear that
  // closes twenty sessions used to strand twenty rings until quit. Asserting
  // the whole shape (rather than the two maps that were already pruned) is
  // what keeps a newly added map from silently joining the leak.
  const s = useSessions.getState();
  s.addProject(makeProject("default"));
  s.addSession(makeSession("gone", 1));
  s.addSession(makeSession("stays", 2));
  for (const id of ["gone", "stays"]) {
    useSessions.getState().appendEvent(id, prompt(`${id}-e1`, "hi"));
    useSessions.getState().applyStatus(id, "done", "");
    useSessions.getState().applyActivity(id, {
      main: { currentTool: null },
      pendingAsk: null,
      shells: [],
      subagents: [],
      tasks: [],
    });
    useSessions.getState().applyUsage(id, {
      contextWindowSize: 200_000,
      inputTokens: 5,
      model: "opus",
      outputTokens: 5,
      sessionId: null,
      usedPercentage: 10,
    });
    useSessions.getState().applySleeping(id, "asleep");
    useSessions.getState().noteSessionExited(id);
    useSessions.getState().setPendingSeedPrompt(id, "seed");
    useSessions.getState().setActiveSession(id);
  }
  useSessions.setState((state) => ({
    cpu: { ...state.cpu, gone: 3, stays: 3 },
    memory: { ...state.memory, gone: 12, stays: 12 },
    repoToplevel: { ...state.repoToplevel, gone: "/r", stays: "/r" },
    repoToplevelCwd: { ...state.repoToplevelCwd, gone: "/r", stays: "/r" },
    touchedFiles: { ...state.touchedFiles, gone: ["a"], stays: ["a"] },
  }));

  useSessions.getState().removeSession("gone");

  const after = useSessions.getState();
  const perSession = [
    after.activity,
    after.appendSeq,
    after.bootPhase,
    after.cpu,
    after.events,
    after.exited,
    after.memory,
    after.pendingSeedPrompt,
    after.repoToplevel,
    after.repoToplevelCwd,
    after.sessions,
    after.sleeping,
    after.statusOrigin,
    after.touchedFiles,
    after.usage,
    after.viewed,
  ];
  for (const map of perSession) {
    expect("gone" in map).toBe(false);
  }
  // The surviving session keeps every one of its own entries.
  expect(after.sessions.stays).toBeDefined();
  expect(after.events.stays).toBeDefined();
  expect(after.usage.stays).toBeDefined();
});

test("applyHooksOff records the scope and clears it when hooks run", () => {
  const { addSession, applyHooksOff } = useSessions.getState();
  addSession(makeSession("s1", 1));
  applyHooksOff("s1", "user");
  expect(useSessions.getState().hooksOff.s1).toBe("user");
  applyHooksOff("s1", null);
  expect(useSessions.getState().hooksOff.s1).toBeUndefined();
});

test("applyHooksOff ignores ids that are not sessions", () => {
  // A Project terminal pane is created through the same command, but runs no
  // claude and is never removed through `removeSession`.
  useSessions.getState().applyHooksOff("pane-1", "user");
  expect(useSessions.getState().hooksOff["pane-1"]).toBeUndefined();
});

test("setTouchedFromActivity makes the Activity log the record of Claude's files", () => {
  useSessions.setState({
    sessions: { s1: idleSession(base("s1")) },
    // A denied edit the live stream counted; the log, which only counts
    // finished steps, doesn't have it.
    touchedFiles: { s1: ["/repo/denied.ts"] },
  });
  useSessions.getState().setTouchedFromActivity("s1", ["/repo/gen.ts"]);
  expect(useSessions.getState().touchedFiles.s1).toEqual(["/repo/gen.ts"]);
  expect(useSessions.getState().touchedSynced.s1).toBe(true);
});

test("setTouchedFromActivity keeps the same array when nothing changed", () => {
  useSessions.setState({
    sessions: { s1: idleSession(base("s1")) },
    touchedFiles: { s1: ["/repo/a.ts", "/repo/b.ts"] },
    touchedSynced: { s1: true },
  });
  const before = useSessions.getState().touchedFiles.s1;
  useSessions
    .getState()
    .setTouchedFromActivity("s1", ["/repo/b.ts", "/repo/a.ts"]);
  expect(useSessions.getState().touchedFiles.s1).toBe(before);
});

test("setTouchedFromActivity ignores a session that has been closed", () => {
  useSessions.setState({ sessions: {}, touchedFiles: {}, touchedSynced: {} });
  useSessions.getState().setTouchedFromActivity("gone", ["/repo/a.ts"]);
  expect(useSessions.getState().touchedFiles.gone).toBeUndefined();
  expect(useSessions.getState().touchedSynced.gone).toBeUndefined();
});

test("sessionClaudeFiles is unknown until Claude's files can be matched to the repo", () => {
  useSessions.setState({
    repoToplevel: {},
    sessions: { s1: idleSession(base("s1")) },
    touchedFiles: {},
    touchedSynced: {},
  });
  // No repo root yet.
  expect(sessionClaudeFiles("s1")).toBeNull();
  // A root, but the Activity log hasn't answered yet.
  useSessions.setState({ repoToplevel: { s1: "/repo" } });
  expect(sessionClaudeFiles("s1")).toBeNull();
  // The log answered: Claude changed nothing — a real, empty answer.
  useSessions.setState({ touchedSynced: { s1: true } });
  expect(sessionClaudeFiles("s1")?.size).toBe(0);
  // Recorded paths none of which match the repo (a symlinked project path):
  // unknown again, rather than "Claude changed nothing".
  useSessions.setState({ touchedFiles: { s1: ["/elsewhere/a.ts"] } });
  expect(sessionClaudeFiles("s1")).toBeNull();
  useSessions.setState({ touchedFiles: { s1: ["/repo/a.ts"] } });
  expect([...(sessionClaudeFiles("s1") ?? [])]).toEqual(["a.ts"]);
});

test("relativizeTouchedPath sees through macOS's /private firmlink either way", () => {
  expect(relativizeTouchedPath("/tmp/repo/a.ts", "/private/tmp/repo")).toBe(
    "a.ts"
  );
  expect(relativizeTouchedPath("/private/tmp/repo/a.ts", "/tmp/repo")).toBe(
    "a.ts"
  );
  expect(relativizeTouchedPath("/elsewhere/a.ts", "/private/tmp/repo")).toBe(
    null
  );
});

function base(id: string) {
  return {
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "/repo",
    id,
    projectId: "p1",
    title: id,
    titleLocked: false,
    worktreePath: null,
  };
}

test("a live edit the Activity log hasn't taken in yet survives a sync, for a short grace", () => {
  const now = 1_000_000;
  useSessions.setState({
    sessions: { s1: idleSession(base("s1")) },
    touchedFiles: { s1: ["/repo/fresh.ts"] },
    touchedLive: { s1: { "/repo/fresh.ts": now } },
    touchedSynced: {},
  });
  // The log ingests every few seconds; a sync half a second later doesn't
  // have the edit yet.
  useSessions.getState().setTouchedFromActivity("s1", [], now + 500);
  expect(useSessions.getState().touchedFiles.s1).toEqual(["/repo/fresh.ts"]);

  // Past the grace, the log's answer stands: an edit it never recorded (a
  // denied one) is dropped.
  useSessions
    .getState()
    .setTouchedFromActivity("s1", [], now + LIVE_TOUCH_GRACE_MS + 1);
  expect(useSessions.getState().touchedFiles.s1).toEqual([]);
  expect(useSessions.getState().touchedLive.s1).toEqual({});
});

// --- Parking (ADR-0052) ---

function inProject(
  id: string,
  projectId: string,
  createdAt: number
): UiSession {
  return { ...makeSession(id, createdAt), projectId };
}

test("isPutAway is true for an archived or a parked session", () => {
  expect(isPutAway(inProject("a", "p", 1))).toBe(false);
  expect(isPutAway({ ...inProject("b", "p", 1), archivedAt: 5 })).toBe(true);
  expect(isPutAway({ ...inProject("c", "p", 1), parkedAt: 5 })).toBe(true);
});

test("a project is fully parked only when none of its sessions is on the rail", () => {
  const sessions = {
    a: { ...inProject("a", "pa", 1), parkedAt: 5 },
    b: { ...inProject("b", "pa", 2), parkedAt: 5 },
    c: { ...inProject("c", "pb", 3), parkedAt: 5 },
    d: inProject("d", "pb", 4),
    e: { ...inProject("e", "pc", 5), archivedAt: 5 },
  };
  expect([...fullyParkedProjectIds(sessions)]).toEqual(["pa"]);
});

test("parking a project parks its rail sessions, drops their warm panes and moves the selection off them", () => {
  useSessions.setState({
    activeSessionId: "a2",
    projects: [makeProject("pa"), makeProject("pb")],
    sessions: {
      a1: inProject("a1", "pa", 1),
      a2: inProject("a2", "pa", 9),
      old: { ...inProject("old", "pa", 3), archivedAt: 4 },
      b1: inProject("b1", "pb", 2),
    },
    warmPanes: ["a1", "b1"],
  });

  useSessions.getState().parkProject("pa");

  const state = useSessions.getState();
  expect(state.sessions.a1?.parkedAt).toBeGreaterThan(0);
  expect(state.sessions.a2?.parkedAt).toBeGreaterThan(0);
  // Archived stays archived, not parked.
  expect(state.sessions.old?.parkedAt).toBeUndefined();
  expect(state.sessions.b1?.parkedAt).toBeUndefined();
  expect(state.activeSessionId).toBe("b1");
  expect(state.warmPanes).toEqual(["b1"]);
});

test("unparking a project brings back every parked session and starts nothing", () => {
  useSessions.setState({
    activeSessionId: null,
    projects: [makeProject("pa")],
    sessions: {
      a1: { ...inProject("a1", "pa", 1), parkedAt: 10 },
      a2: { ...inProject("a2", "pa", 2), parkedAt: 10 },
    },
    warmPanes: [],
  });

  useSessions.getState().unparkProject("pa");

  const state = useSessions.getState();
  expect(state.sessions.a1?.parkedAt).toBeNull();
  expect(state.sessions.a2?.parkedAt).toBeNull();
  expect(state.activeSessionId).toBeNull();
  expect(state.warmPanes).toEqual([]);
});

test("opening a parked session brings back only that one", () => {
  useSessions.setState({
    activeSessionId: null,
    projects: [makeProject("pa")],
    sessions: {
      a1: { ...inProject("a1", "pa", 1), parkedAt: 10 },
      a2: { ...inProject("a2", "pa", 2), parkedAt: 10 },
    },
    warmPanes: [],
  });

  // The Parked section, the palette, a notification and the Needs-you rail all
  // open a session this way; opening one is what launches it.
  useSessions.getState().setActiveSession("a1");

  const state = useSessions.getState();
  expect(state.activeSessionId).toBe("a1");
  expect(state.sessions.a1?.parkedAt).toBeNull();
  // The rest of the project stays parked, out of the way.
  expect(state.sessions.a2?.parkedAt).toBe(10);
});

test("opening a parked nested session brings back its leads with it", () => {
  useSessions.setState({
    activeSessionId: null,
    projects: [makeProject("pa")],
    sessions: {
      lead: { ...inProject("lead", "pa", 1), parkedAt: 10 },
      mid: { ...inProject("mid", "pa", 2), nestedUnder: "lead", parkedAt: 10 },
      leaf: { ...inProject("leaf", "pa", 3), nestedUnder: "mid", parkedAt: 10 },
      other: { ...inProject("other", "pa", 4), parkedAt: 10 },
    },
    warmPanes: [],
  });

  useSessions.getState().setActiveSession("leaf");

  const { sessions } = useSessions.getState();
  expect(sessions.leaf?.parkedAt).toBeNull();
  expect(sessions.mid?.parkedAt).toBeNull();
  expect(sessions.lead?.parkedAt).toBeNull();
  expect(sessions.other?.parkedAt).toBe(10);
});

test("archiving the active session never hands the selection to a parked one", () => {
  useSessions.setState({
    activeSessionId: "s1",
    projects: [makeProject("live")],
    sessions: {
      s0: inProject("s0", "live", 1),
      s1: inProject("s1", "live", 2),
      parked: { ...inProject("parked", "live", 9), parkedAt: 10 },
    },
    warmPanes: [],
  });

  useSessions.getState().archiveSession("s1");

  expect(useSessions.getState().activeSessionId).toBe("s0");
});

test("closing the active session never hands the selection to a parked one", () => {
  useSessions.setState({
    activeSessionId: "s1",
    projects: [makeProject("live"), makeProject("pk")],
    sessions: {
      s0: inProject("s0", "live", 1),
      s1: inProject("s1", "live", 2),
      parked: { ...inProject("parked", "pk", 9), parkedAt: 10 },
    },
    warmPanes: [],
  });

  useSessions.getState().removeSession("s1");

  // Selecting it would launch it while it still sits in the Parked list.
  expect(useSessions.getState().activeSessionId).toBe("s0");
});
