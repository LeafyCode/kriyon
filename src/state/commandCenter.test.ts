import { beforeEach, expect, test } from "vitest";
import type { ProjectRow } from "../types.ts";
import {
  buildStandings,
  groupByProject,
  mapStatus,
  needsYou,
  STALE_AFTER_MS,
  standingState,
  useCommandCenter,
} from "./commandCenter.ts";
import type { UiSession } from "./sessions.ts";

function makeSession(
  id: string,
  projectId: string,
  status: UiSession["status"],
  createdAt = 1
): UiSession {
  return {
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt,
    cwd: "",
    id,
    projectId,
    status,
    summary: "",
    title: id,
    titleLocked: false,
    worktreePath: null,
  };
}

function makeProject(id: string): ProjectRow {
  return {
    color: null,
    id,
    name: `Project ${id}`,
    path: `/${id}`,
    parkedAt: null,
    setupCommand: null,
  };
}

// --- Part 1: pure derivation ---

test("mapStatus maps every concrete status to its standing", () => {
  expect(mapStatus("running")).toBe("running");
  expect(mapStatus("waiting")).toBe("awaiting_input");
  expect(mapStatus("done")).toBe("changed");
  expect(mapStatus("error")).toBe("changed");
  expect(mapStatus("idle")).toBe("idle");
});

test("standingState is unknown when lastSeen is undefined", () => {
  expect(standingState("running", undefined, 1000)).toBe("unknown");
});

test("standingState is unknown when the watcher is stale", () => {
  const now = 100_000;
  expect(standingState("running", now - STALE_AFTER_MS - 1, now)).toBe(
    "unknown"
  );
});

test("a stale watcher shows unknown, never idle", () => {
  const now = 100_000;
  // An idle session whose watcher went quiet is shown honestly as unknown.
  const state = standingState("idle", now - STALE_AFTER_MS - 1, now);
  expect(state).toBe("unknown");
  expect(state).not.toBe("idle");
});

test("standingState maps the concrete status when the watcher is fresh", () => {
  const now = 100_000;
  expect(standingState("waiting", now - 100, now)).toBe("awaiting_input");
  expect(standingState("idle", now, now)).toBe("idle");
});

test("a far-future lastSeen is distrusted as unknown (clock jumped)", () => {
  const now = 100_000;
  // A clock jump forward pins lastSeen ahead of now; once the clock corrects, a
  // since-dead watcher must not keep showing a confident state. A stamp dated
  // beyond the stale window in the future is as untrustworthy as a stale one.
  expect(standingState("running", now + STALE_AFTER_MS + 1, now)).toBe(
    "unknown"
  );
});

test("a slightly-future lastSeen within the window stays fresh", () => {
  const now = 100_000;
  // Normal event/tick ordering can stamp lastSeen a touch after the render's
  // captured now; that small skew must not flicker the standing to unknown.
  expect(standingState("running", now + 100, now)).toBe("running");
});

test("buildStandings derives one entry per session", () => {
  const now = 100_000;
  const sessions: Record<string, UiSession> = {
    s1: makeSession("s1", "p1", "waiting", 5),
    s2: makeSession("s2", "p2", "idle", 7),
  };
  const lastSeen = { s1: now - 100 };
  const lastChange = { s1: now - 50 };

  const standings = buildStandings(
    sessions,
    new Set(),
    lastSeen,
    lastChange,
    now
  );

  const s1 = standings.find((s) => s.sessionId === "s1");
  const s2 = standings.find((s) => s.sessionId === "s2");
  expect(s1).toEqual({
    sessionId: "s1",
    projectId: "p1",
    worktree: null,
    state: "awaiting_input",
    lastChangeMs: now - 50,
    lastSeenMs: now - 100,
  });
  // s2 has no lastSeen → unknown; lastChange falls back to createdAt; lastSeen 0.
  expect(s2).toEqual({
    sessionId: "s2",
    projectId: "p2",
    worktree: null,
    state: "unknown",
    lastChangeMs: 7,
    lastSeenMs: 0,
  });
});

test("buildStandings omits archived sessions", () => {
  const now = Date.now();
  const base = {
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "/r",
    projectId: "p1",
    status: "running" as const,
    summary: "",
    title: "T",
    titleLocked: false,
    worktreePath: null,
  };
  const sessions = {
    live: { ...base, archivedAt: null, id: "live" },
    gone: { ...base, archivedAt: now - 1000, id: "gone" },
  };
  const standings = buildStandings(
    sessions,
    new Set(),
    { live: now, gone: now },
    {},
    now
  );
  expect(standings.map((s) => s.sessionId)).toEqual(["live"]);
});

test("buildStandings omits sessions of a parked project", () => {
  const now = Date.now();
  const base = {
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "/r",
    status: "running" as const,
    summary: "",
    title: "T",
    titleLocked: false,
    worktreePath: null,
  };
  const sessions = {
    live: { ...base, id: "live", projectId: "p1" },
    parked: { ...base, id: "parked", projectId: "pk" },
  };
  const standings = buildStandings(
    sessions,
    new Set(["pk"]),
    { live: now, parked: now },
    {},
    now
  );
  expect(standings.map((s) => s.sessionId)).toEqual(["live"]);
});

test("needsYou filters to awaiting_input standings only", () => {
  const now = 100_000;
  const sessions: Record<string, UiSession> = {
    s1: makeSession("s1", "p1", "waiting"),
    s2: makeSession("s2", "p1", "running"),
  };
  const lastSeen = { s1: now, s2: now };
  const standings = buildStandings(sessions, new Set(), lastSeen, {}, now);

  const blocked = needsYou(standings);
  expect(blocked.map((s) => s.sessionId)).toEqual(["s1"]);
});

test("groupByProject preserves project order and omits empty projects", () => {
  const now = 100_000;
  const sessions: Record<string, UiSession> = {
    s1: makeSession("s1", "p2", "running"),
    s2: makeSession("s2", "p1", "running"),
  };
  const lastSeen = { s1: now, s2: now };
  const standings = buildStandings(sessions, new Set(), lastSeen, {}, now);
  const projects = [makeProject("p1"), makeProject("p2"), makeProject("p3")];

  const groups = groupByProject(standings, projects);

  // p1 before p2 (projects order), p3 omitted (no standings).
  expect(groups.map((g) => g.project.id)).toEqual(["p1", "p2"]);
  expect(groups[0]?.standings.map((s) => s.sessionId)).toEqual(["s2"]);
  expect(groups[1]?.standings.map((s) => s.sessionId)).toEqual(["s1"]);
});

// --- Part 2: liveness store ---

beforeEach(() => {
  useCommandCenter.setState({ lastSeenMs: {}, lastChangeMs: {} });
});

test("recordHeartbeat keeps the max of existing and incoming", () => {
  const cc = useCommandCenter.getState();
  cc.recordHeartbeat("s1", 100);
  cc.recordHeartbeat("s1", 50);
  expect(useCommandCenter.getState().lastSeenMs.s1).toBe(100);
  cc.recordHeartbeat("s1", 200);
  expect(useCommandCenter.getState().lastSeenMs.s1).toBe(200);
});

test("recordSeen keeps the max of existing and now", () => {
  const cc = useCommandCenter.getState();
  cc.recordSeen("s1", 100);
  cc.recordSeen("s1", 80);
  expect(useCommandCenter.getState().lastSeenMs.s1).toBe(100);
});

test("recordStatusChange updates both lastChange and lastSeen", () => {
  const cc = useCommandCenter.getState();
  cc.recordStatusChange("s1", 300);
  expect(useCommandCenter.getState().lastChangeMs.s1).toBe(300);
  expect(useCommandCenter.getState().lastSeenMs.s1).toBe(300);
});

test("buildStandings reads unknown for a session whose hooks are off", () => {
  const now = 100_000;
  const sessions: Record<string, UiSession> = {
    s1: makeSession("s1", "p1", "idle", 5),
  };
  // The watcher is alive, but no hook can ever report a status.
  const standings = buildStandings(sessions, new Set(), { s1: now }, {}, now, {
    s1: "user",
  });
  expect(standings[0]?.state).toBe("unknown");
});
