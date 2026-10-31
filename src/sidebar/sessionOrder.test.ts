import { describe, expect, it, test } from "vitest";
import type { UiSession } from "../state/sessions.ts";
import type { ProjectRow, SessionStatus } from "../types.ts";
import {
  dropOrder,
  EMPTY_ORDER,
  type HideInputs,
  inactiveProjectIds,
  nestRows,
  type OrderInputs,
  orderMatched,
  orderSessions,
  partitionOld,
  pickFocusSession,
  projectUrgency,
  sessionRank,
  sessionRowView,
  sortProjects,
} from "./sessionOrder.ts";

function session(
  id: string,
  status: SessionStatus,
  createdAt: number,
  projectId = "p"
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

function project(id: string, name: string): ProjectRow {
  return {
    color: null,
    id,
    name,
    path: `/${id}`,
    parkedAt: null,
    setupCommand: null,
  };
}

const noneUnseen = () => 0;

/** A neutral, no-op hide bundle for tests that don't exercise the staleness
 *  fold — `off` short-circuits before `now` is ever read. */
const OFF_HIDE: HideInputs = {
  activeSessionId: null,
  lastChangeMs: {},
  now: 0,
  threshold: "off",
};

test("sessionRank floats blocked work above running above idle above done", () => {
  expect(sessionRank("waiting")).toBeLessThan(sessionRank("running"));
  expect(sessionRank("error")).toBeLessThan(sessionRank("running"));
  expect(sessionRank("running")).toBeLessThan(sessionRank("idle"));
  expect(sessionRank("idle")).toBeLessThan(sessionRank("done"));
});

test("projectUrgency ranks blocked over running over idle over finished", () => {
  expect(projectUrgency([session("a", "waiting", 1)])).toBe(0);
  expect(projectUrgency([session("a", "error", 1)])).toBe(0);
  expect(projectUrgency([session("a", "running", 1)])).toBe(1);
  expect(projectUrgency([session("a", "idle", 1)])).toBe(2);
  expect(projectUrgency([session("a", "done", 1)])).toBe(3);
  expect(projectUrgency([])).toBe(3);
  // Archived sessions never lend a project urgency.
  expect(
    projectUrgency([{ ...session("a", "waiting", 1), archivedAt: 5 }])
  ).toBe(3);
});

test("calm mode keeps projects alphabetical regardless of urgency", () => {
  const projects = [project("p2", "beta"), project("p1", "alpha")];
  const byProject = new Map<string, UiSession[]>([
    ["p1", [session("s1", "done", 1, "p1")]],
    ["p2", [session("s2", "waiting", 1, "p2")]],
  ]);
  expect(
    sortProjects(projects, byProject, "calm", []).map((p) => p.id)
  ).toEqual(["p1", "p2"]);
});

test("triage mode floats attention-needing projects above calmer ones", () => {
  const projects = [project("p1", "alpha"), project("p2", "beta")];
  const byProject = new Map<string, UiSession[]>([
    ["p1", [session("s1", "done", 1, "p1")]],
    ["p2", [session("s2", "waiting", 1, "p2")]],
  ]);
  // beta needs the user, so it floats over the alphabetically-first alpha.
  expect(
    sortProjects(projects, byProject, "triage", []).map((p) => p.id)
  ).toEqual(["p2", "p1"]);
});

test("a manual project order wins over calm's alphabetical ordering", () => {
  const projects = [project("p1", "alpha"), project("p2", "beta")];
  const byProject = new Map<string, UiSession[]>();
  // Arranged beta-before-alpha; calm would sort alpha first, but manual wins.
  expect(
    sortProjects(projects, byProject, "calm", ["p2", "p1"]).map((p) => p.id)
  ).toEqual(["p2", "p1"]);
});

test("a manual project order wins over triage's urgency float", () => {
  const projects = [project("p1", "alpha"), project("p2", "beta")];
  const byProject = new Map<string, UiSession[]>([
    // alpha is blocked; triage would float it, but the manual order pins it low.
    ["p1", [session("s1", "waiting", 1, "p1")]],
    ["p2", [session("s2", "done", 1, "p2")]],
  ]);
  expect(
    sortProjects(projects, byProject, "triage", ["p2", "p1"]).map((p) => p.id)
  ).toEqual(["p2", "p1"]);
});

test("projects absent from the manual order sort alphabetically on top", () => {
  const projects = [
    project("p1", "arranged"),
    project("p3", "zeta"),
    project("p2", "acme"),
  ];
  const byProject = new Map<string, UiSession[]>();
  // Only p1 is arranged; the two new projects (acme, zeta) sort A→Z above it.
  expect(
    sortProjects(projects, byProject, "calm", ["p1"]).map((p) => p.id)
  ).toEqual(["p2", "p3", "p1"]);
});

test("calm mode shows every session newest-first, collapsing nothing", () => {
  const sessions = [
    session("old", "done", 1),
    session("mid", "running", 2),
    session("new", "idle", 3),
  ];
  const { rows, collapsedDone } = orderSessions(
    sessions,
    noneUnseen,
    "calm",
    "date",
    EMPTY_ORDER
  );
  expect(rows).toEqual(["new", "mid", "old"]);
  expect(collapsedDone).toEqual([]);
});

test("triage mode floats active work up and folds read Done away", () => {
  const sessions = [
    session("done-read", "done", 5),
    session("idle", "idle", 4),
    session("running", "running", 3),
    session("waiting", "waiting", 2),
  ];
  const { rows, collapsedDone } = orderSessions(
    sessions,
    noneUnseen,
    "triage",
    "date",
    EMPTY_ORDER
  );
  expect(rows).toEqual(["waiting", "running", "idle"]);
  expect(collapsedDone).toEqual(["done-read"]);
});

test("triage keeps unseen Done as a row but folds read Done away", () => {
  const sessions = [
    session("done-unseen", "done", 2),
    session("done-read", "done", 1),
  ];
  const unseen = (id: string) => (id === "done-unseen" ? 3 : 0);
  const { rows, collapsedDone } = orderSessions(
    sessions,
    unseen,
    "triage",
    "date",
    EMPTY_ORDER
  );
  expect(rows).toEqual(["done-unseen"]);
  expect(collapsedDone).toEqual(["done-read"]);
});

test("archived sessions never appear in either bucket", () => {
  const sessions = [
    { ...session("archived", "running", 2), archivedAt: 9 },
    session("open", "idle", 1),
  ];
  const { rows, collapsedDone } = orderSessions(
    sessions,
    noneUnseen,
    "triage",
    "date",
    EMPTY_ORDER
  );
  expect(rows).toEqual(["open"]);
  expect(collapsedDone).toEqual([]);
});

test("sessionRowView flags an unread finish and badges it only in triage", () => {
  expect(sessionRowView("done", 3, "triage")).toEqual({
    doneUnseen: true,
    showContext: false,
    showNewBadge: true,
  });
  // The badge follows the sidebar mode, not ordering: calm never badges.
  expect(sessionRowView("done", 3, "calm")).toEqual({
    doneUnseen: true,
    showContext: false,
    showNewBadge: false,
  });
});

test("sessionRowView: a read finish is unbadged and hides its context line", () => {
  expect(sessionRowView("done", 0, "triage")).toEqual({
    doneUnseen: false,
    showContext: false,
    showNewBadge: false,
  });
});

test("sessionRowView: live rows show context and never a badge", () => {
  expect(sessionRowView("running", 0, "triage")).toEqual({
    doneUnseen: false,
    showContext: true,
    showNewBadge: false,
  });
});

test("sessionRowView: an idle row is a single quiet line — no context", () => {
  // Design 5a: idle work sits as one muted line; a "Idle" subtitle under every
  // parked session is pure noise.
  expect(sessionRowView("idle", 5, "triage")).toEqual({
    doneUnseen: false,
    showContext: false,
    showNewBadge: false,
  });
  expect(sessionRowView("idle", 0, "calm")).toEqual({
    doneUnseen: false,
    showContext: false,
    showNewBadge: false,
  });
});

// --- orderMatched (keyed, memoized) ---

function inputs(sessions: UiSession[]): OrderInputs {
  return {
    appendSeq: {},
    statusOrigin: {},
    sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
    viewed: {},
  };
}

const p1 = project("p1", "One");
const p2 = project("p2", "Two");

test("orderMatched filters to the project's open, matching sessions", () => {
  const state = inputs([
    session("a", "idle", 3, "p1"),
    session("b", "idle", 2, "p2"),
    { ...session("c", "idle", 1, "p1"), archivedAt: 5 },
  ]);

  const { rows } = orderMatched(
    state,
    p1,
    "",
    false,
    "calm",
    "date",
    EMPTY_ORDER,
    OFF_HIDE
  );
  expect(rows).toEqual(["a"]); // b is another project, c is archived
});

test("orderMatched returns the same reference for identical inputs (memoized)", () => {
  const state = inputs([session("a", "idle", 1, "p1")]);
  expect(
    orderMatched(state, p1, "", false, "calm", "date", EMPTY_ORDER, OFF_HIDE)
  ).toBe(
    orderMatched(state, p1, "", false, "calm", "date", EMPTY_ORDER, OFF_HIDE)
  );
});

test("orderMatched does not thrash across projects: A, B, then A again all hit", () => {
  const state = inputs([
    session("a", "idle", 1, "p1"),
    session("b", "idle", 1, "p2"),
  ]);

  const firstA = orderMatched(
    state,
    p1,
    "",
    false,
    "calm",
    "date",
    EMPTY_ORDER,
    OFF_HIDE
  );
  orderMatched(state, p2, "", false, "calm", "date", EMPTY_ORDER, OFF_HIDE); // a different project in between
  // With a single shared slot this second p1 call would miss; keyed, it hits.
  expect(
    orderMatched(state, p1, "", false, "calm", "date", EMPTY_ORDER, OFF_HIDE)
  ).toBe(firstA);
});

test("orderMatched recomputes when appendSeq identity changes", () => {
  // Same `sessions` (and `viewed`) reference, only a new `appendSeq` — so the
  // cache entry exists but its appendSeq guard misses. This is what happens on
  // every appended transcript line.
  const state = inputs([session("a", "done", 1, "p1")]);
  const before = orderMatched(
    state,
    p1,
    "",
    false,
    "calm",
    "date",
    EMPTY_ORDER,
    OFF_HIDE
  );
  const after = orderMatched(
    { ...state, appendSeq: { a: 1 } },
    p1,
    "",
    false,
    "calm",
    "date",
    EMPTY_ORDER,
    OFF_HIDE
  );
  expect(after).not.toBe(before);
});

test("name sort orders alphabetically by title in calm mode", () => {
  const sessions = [
    { ...session("a", "idle", 1), title: "zeta" },
    { ...session("b", "running", 2), title: "alpha" },
    { ...session("c", "done", 3), title: "mid" },
  ];
  const { rows } = orderSessions(
    sessions,
    noneUnseen,
    "calm",
    "name",
    EMPTY_ORDER
  );
  expect(rows).toEqual(["b", "c", "a"]);
});

test("name sort fully wins in triage — no status floating, done still folds", () => {
  const sessions = [
    { ...session("w", "waiting", 1), title: "zzz waiting" },
    { ...session("r", "running", 2), title: "aaa running" },
    { ...session("d", "done", 3), title: "mmm done" }, // read → folds
  ];
  const { rows, collapsedDone } = orderSessions(
    sessions,
    noneUnseen,
    "triage",
    "name",
    EMPTY_ORDER
  );
  expect(rows).toEqual(["r", "w"]);
  expect(collapsedDone).toEqual(["d"]);
});

test("date sort in triage keeps status floating (today's behavior)", () => {
  const sessions = [session("i", "idle", 9), session("w", "waiting", 1)];
  const { rows } = orderSessions(
    sessions,
    noneUnseen,
    "triage",
    "date",
    EMPTY_ORDER
  );
  expect(rows).toEqual(["w", "i"]);
});

test("manual sort follows the saved order and ignores stale ids", () => {
  const sessions = [
    session("a", "idle", 1),
    session("b", "idle", 2),
    session("c", "idle", 3),
  ];
  const { rows } = orderSessions(sessions, noneUnseen, "calm", "manual", [
    "gone",
    "b",
    "c",
    "a",
  ]);
  expect(rows).toEqual(["b", "c", "a"]);
});

test("manual sort puts unlisted (new) sessions on top, newest first", () => {
  const sessions = [
    session("old", "idle", 1),
    session("new1", "idle", 5),
    session("new2", "idle", 7),
  ];
  const { rows } = orderSessions(sessions, noneUnseen, "calm", "manual", [
    "old",
  ]);
  expect(rows).toEqual(["new2", "new1", "old"]);
});

test("manual sort fully wins in triage but read done still folds", () => {
  const sessions = [
    session("w", "waiting", 1),
    session("r", "running", 2),
    session("d", "done", 3),
  ];
  const { rows, collapsedDone } = orderSessions(
    sessions,
    noneUnseen,
    "triage",
    "manual",
    ["r", "w", "d"]
  );
  expect(rows).toEqual(["r", "w"]);
  expect(collapsedDone).toEqual(["d"]);
});

// --- dropOrder ---

test("dropOrder moves the dragged id before/after its target and appends folded done", () => {
  expect(dropOrder([], ["a", "b", "c"], ["d1"], "a", "c")).toEqual([
    "b",
    "c",
    "a",
    "d1",
  ]);
  expect(dropOrder([], ["a", "b", "c"], [], "c", "a")).toEqual(["c", "a", "b"]);
});

test("dropOrder returns null when the drop changes nothing", () => {
  expect(dropOrder([], ["a", "b"], [], "a", "a")).toBeNull();
  expect(dropOrder([], ["a", "b"], [], "a", null)).toBeNull();
  expect(dropOrder([], ["a", "b"], [], "missing", "b")).toBeNull();
});

test("dropOrder keeps a hidden session's saved slot next to its old neighbor", () => {
  // "x" is in the saved order but not visible (archived / folded elsewhere).
  // Dragging c before a must not shove x to the end — it stays after "a",
  // its surviving predecessor from the saved order.
  expect(
    dropOrder(["a", "x", "b", "c"], ["a", "b", "c"], [], "c", "a")
  ).toEqual(["c", "a", "x", "b"]);
});

test("dropOrder keeps a previously top-placed hidden id at the top", () => {
  expect(dropOrder(["x", "a", "b"], ["a", "b"], [], "b", "a")).toEqual([
    "x",
    "b",
    "a",
  ]);
});

test("dropOrder preserves a calm-placed done row's slot on a triage drag", () => {
  // In triage "d1" folds out of the visible rows, but the user placed it
  // mid-list in calm mode — a drag of another row must not move it to the end.
  expect(dropOrder(["d1", "a", "b"], ["a", "b"], ["d1"], "b", "a")).toEqual([
    "d1",
    "b",
    "a",
  ]);
});

test("dropOrder appends never-placed done rows at the end", () => {
  expect(dropOrder(["a", "b"], ["a", "b"], ["d1"], "b", "a")).toEqual([
    "b",
    "a",
    "d1",
  ]);
});

test("orderMatched recomputes when the manual order identity changes", () => {
  const state = inputs([
    session("a", "idle", 1, "p1"),
    session("b", "idle", 2, "p1"),
  ]);
  const before = orderMatched(
    state,
    p1,
    "",
    false,
    "calm",
    "manual",
    ["a", "b"],
    OFF_HIDE
  );
  const after = orderMatched(
    state,
    p1,
    "",
    false,
    "calm",
    "manual",
    ["b", "a"],
    OFF_HIDE
  );
  expect(after).not.toBe(before);
  expect(after.rows).toEqual(["b", "a"]);
});

// --- partitionOld (staleness fold) ---

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 100 * DAY;

function sessionsMap(list: UiSession[]): Record<string, UiSession> {
  return Object.fromEntries(list.map((s) => [s.id, s]));
}

test("partitionOld with off is identity", () => {
  const s = sessionsMap([session("a", "idle", 0)]);
  const out = partitionOld(["a"], s, {}, () => 0, null, "off", NOW);
  expect(out.rows).toEqual(["a"]);
  expect(out.collapsedOld).toEqual([]);
});

test("partitionOld folds an idle session past the cutoff", () => {
  const s = sessionsMap([session("a", "idle", NOW - 2 * DAY)]);
  const out = partitionOld(["a"], s, {}, () => 0, null, "1d", NOW);
  expect(out.collapsedOld).toEqual(["a"]);
  expect(out.rows).toEqual([]);
});

test("partitionOld keeps a recent idle session", () => {
  const s = sessionsMap([session("a", "idle", NOW - 2 * HOUR)]);
  const out = partitionOld(["a"], s, {}, () => 0, null, "6h", NOW);
  expect(out.rows).toEqual(["a"]);
  expect(out.collapsedOld).toEqual([]);
});

test("the 1h threshold folds on the hour, not the day", () => {
  // The tightest option, and the only one short enough to notice within a
  // working session — so its arithmetic is worth pinning separately.
  const s = sessionsMap([
    session("stale", "idle", NOW - 2 * HOUR),
    session("fresh", "idle", NOW - 30 * 60_000),
  ]);
  const out = partitionOld(["stale", "fresh"], s, {}, () => 0, null, "1h", NOW);
  expect(out.collapsedOld).toEqual(["stale"]);
  expect(out.rows).toEqual(["fresh"]);
});

test("partitionOld exempts active, running, waiting, error, and unread-done", () => {
  const old = NOW - 30 * DAY;
  const s = sessionsMap([
    session("active", "idle", old),
    session("run", "running", old),
    session("wait", "waiting", old),
    session("err", "error", old),
    session("unread", "done", old),
    session("seen", "done", old),
  ]);
  const rows = ["active", "run", "wait", "err", "unread", "seen"];
  const unseen = (id: string) => (id === "unread" ? 3 : 0);
  const out = partitionOld(rows, s, {}, unseen, "active", "1w", NOW);
  expect(out.collapsedOld).toEqual(["seen"]);
  expect(out.rows).toEqual(["active", "run", "wait", "err", "unread"]);
});

test("partitionOld prefers lastChangeMs over createdAt for age", () => {
  // Created long ago, but a status change 1h ago keeps it recent under a 1d cut.
  const s = sessionsMap([session("a", "idle", NOW - 30 * DAY)]);
  const out = partitionOld(
    ["a"],
    s,
    { a: NOW - HOUR },
    () => 0,
    null,
    "1d",
    NOW
  );
  expect(out.rows).toEqual(["a"]);
});

// --- orderMatched folding hide into the memoized order ---

test("orderMatched folds stale idle rows into collapsedOld", () => {
  const p = project("p", "Proj");
  const input: OrderInputs = {
    appendSeq: {},
    statusOrigin: {},
    sessions: {
      fresh: session("fresh", "idle", NOW - HOUR, "p"),
      stale: session("stale", "idle", NOW - 5 * DAY, "p"),
    },
    viewed: {},
  };
  const out = orderMatched(input, p, "", false, "calm", "date", EMPTY_ORDER, {
    activeSessionId: null,
    lastChangeMs: {},
    now: NOW,
    threshold: "1d",
  });
  expect(out.collapsedOld).toEqual(["stale"]);
  expect(out.rows).toEqual(["fresh"]);
});

test("a finished session replayed at launch can still fold away", () => {
  // The second half of the launch-replay problem. A Done row folds only when
  // it has no unseen output, and `appendSeq` climbs on every replayed event
  // while `viewed` is empty after a restart — so every old finished session
  // looked unread and refused to fold, even though the same replay is exactly
  // what marks it as already-seen elsewhere.
  const p = project("p", "Proj");
  const base: OrderInputs = {
    appendSeq: { done: 412 },
    sessions: { done: session("done", "done", NOW - 5 * DAY, "p") },
    statusOrigin: { done: "seeded" },
    viewed: {},
  };
  const hide = {
    activeSessionId: null,
    lastChangeMs: {},
    now: NOW,
    threshold: "1d" as const,
  };

  expect(
    orderMatched(base, p, "", false, "calm", "date", EMPTY_ORDER, hide)
      .collapsedOld
  ).toEqual(["done"]);

  // A finish observed live this run is genuinely unread, so it stays visible.
  const live: OrderInputs = { ...base, statusOrigin: { done: "live" } };
  expect(
    orderMatched(live, p, "", false, "calm", "date", EMPTY_ORDER, hide)
      .collapsedOld
  ).toEqual([]);
});

test("orderMatched with off leaves collapsedOld empty", () => {
  const p = project("p", "Proj");
  const input: OrderInputs = {
    appendSeq: {},
    statusOrigin: {},
    sessions: { a: session("a", "idle", 0, "p") },
    viewed: {},
  };
  const out = orderMatched(input, p, "", false, "calm", "date", EMPTY_ORDER, {
    ...OFF_HIDE,
    now: NOW,
  });
  expect(out.collapsedOld).toEqual([]);
  expect(out.rows).toEqual(["a"]);
});

// --- inactiveProjectIds (whole-group staleness) ---

test("inactiveProjectIds with off hides nothing", () => {
  const input: OrderInputs = {
    appendSeq: {},
    sessions: sessionsMap([session("a", "idle", 0, "p")]),
    statusOrigin: {},
    viewed: {},
  };
  expect(inactiveProjectIds(input, { ...OFF_HIDE, now: NOW })).toEqual([]);
});

test("inactiveProjectIds hides a project whose every session is stale", () => {
  const input: OrderInputs = {
    appendSeq: {},
    sessions: sessionsMap([
      session("a", "idle", NOW - 5 * DAY, "stale"),
      session("b", "done", NOW - 5 * DAY, "stale"),
      session("c", "idle", NOW - HOUR, "fresh"),
    ]),
    statusOrigin: {},
    viewed: {},
  };
  expect(
    inactiveProjectIds(input, {
      activeSessionId: null,
      lastChangeMs: {},
      now: NOW,
      threshold: "1d",
    })
  ).toEqual(["stale"]);
});

test("one live session keeps its whole project visible", () => {
  const input: OrderInputs = {
    appendSeq: {},
    sessions: sessionsMap([
      session("old", "idle", NOW - 30 * DAY, "p"),
      session("busy", "running", NOW - 30 * DAY, "p"),
    ]),
    statusOrigin: {},
    viewed: {},
  };
  expect(
    inactiveProjectIds(input, {
      activeSessionId: null,
      lastChangeMs: {},
      now: NOW,
      threshold: "1h",
    })
  ).toEqual([]);
});

test("the active session's project is never hidden", () => {
  const input: OrderInputs = {
    appendSeq: {},
    sessions: sessionsMap([session("a", "idle", NOW - 30 * DAY, "p")]),
    statusOrigin: {},
    viewed: {},
  };
  expect(
    inactiveProjectIds(input, {
      activeSessionId: "a",
      lastChangeMs: {},
      now: NOW,
      threshold: "1h",
    })
  ).toEqual([]);
});

test("unread output keeps a finished project visible", () => {
  const input: OrderInputs = {
    appendSeq: { a: 4 },
    sessions: sessionsMap([session("a", "done", NOW - 30 * DAY, "p")]),
    statusOrigin: { a: "live" },
    viewed: {},
  };
  const hide: HideInputs = {
    activeSessionId: null,
    lastChangeMs: {},
    now: NOW,
    threshold: "1h",
  };
  expect(inactiveProjectIds(input, hide)).toEqual([]);

  // Once read, the same project falls away.
  const read: OrderInputs = {
    ...input,
    viewed: { a: { appendSeq: 4, ms: NOW, tasksDone: 0 } },
  };
  expect(inactiveProjectIds(read, hide)).toEqual(["p"]);
});

test("a project with only archived sessions is not listed as inactive", () => {
  // It has already left the rail on its own; listing it would inflate the
  // "N inactive projects" count with groups nobody can see.
  const input: OrderInputs = {
    appendSeq: {},
    sessions: sessionsMap([
      { ...session("a", "idle", NOW - 30 * DAY, "p"), archivedAt: NOW },
    ]),
    statusOrigin: {},
    viewed: {},
  };
  expect(
    inactiveProjectIds(input, {
      activeSessionId: null,
      lastChangeMs: {},
      now: NOW,
      threshold: "1h",
    })
  ).toEqual([]);
});

test("inactiveProjectIds prefers lastChangeMs over createdAt", () => {
  const input: OrderInputs = {
    appendSeq: {},
    sessions: sessionsMap([session("a", "idle", NOW - 30 * DAY, "p")]),
    statusOrigin: {},
    viewed: {},
  };
  expect(
    inactiveProjectIds(input, {
      activeSessionId: null,
      lastChangeMs: { a: NOW - HOUR },
      now: NOW,
      threshold: "1d",
    })
  ).toEqual([]);
});

test("pickFocusSession prefers a session waiting on the user over everything", () => {
  const sessions = [
    session("idle-1", "idle", 1),
    session("done-1", "done", 3),
    session("waiting-1", "waiting", 2),
    session("running-1", "running", 4),
  ];
  expect(pickFocusSession(sessions, {})?.id).toBe("waiting-1");
});

test("pickFocusSession picks running when nothing is waiting", () => {
  const sessions = [
    session("idle-1", "idle", 1),
    session("done-1", "done", 3),
    session("running-1", "running", 2),
  ];
  expect(pickFocusSession(sessions, {})?.id).toBe("running-1");
});

test("pickFocusSession falls back to the most recently active session by lastChangeMs", () => {
  const sessions = [session("idle-1", "idle", 1), session("idle-2", "idle", 2)];
  expect(pickFocusSession(sessions, { "idle-1": 500, "idle-2": 100 })?.id).toBe(
    "idle-1"
  );
});

test("pickFocusSession falls back to newest createdAt with no lastChangeMs", () => {
  const sessions = [session("older", "done", 1), session("newer", "done", 2)];
  expect(pickFocusSession(sessions, {})?.id).toBe("newer");
});

test("pickFocusSession returns undefined for an empty list", () => {
  expect(pickFocusSession([], {})).toBeUndefined();
});

describe("nestRows", () => {
  const nested = (id: string, under: string | null) =>
    ({ id, nestedUnder: under }) as UiSession;

  it("lists each nested session right under the one it was started from", () => {
    const sessions = {
      a: nested("a", null),
      b: nested("b", null),
      c: nested("c", "a"),
      d: nested("d", "c"),
    };
    expect(nestRows(["c", "b", "a", "d"], sessions)).toEqual({
      depth: { c: 1, d: 2 },
      rows: ["b", "a", "c", "d"],
    });
  });

  it("keeps a nested session in place when its parent isn't listed", () => {
    const sessions = { a: nested("a", "gone"), b: nested("b", null) };
    // Its lead is folded, filtered out or closed: not nested, not indented.
    expect(nestRows(["a", "b"], sessions)).toEqual({
      depth: {},
      rows: ["a", "b"],
    });
  });

  it("returns the same array when nothing is nested", () => {
    const rows = ["a", "b"];
    expect(
      nestRows(rows, { a: nested("a", null), b: nested("b", null) }).rows
    ).toBe(rows);
  });
});
