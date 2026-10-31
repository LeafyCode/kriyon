import { expect, test } from "vitest";
import type { UiSession } from "../state/sessions.ts";
import type { ProjectRow, SessionActivity, SessionStatus } from "../types.ts";
import { needsYouSectionItems } from "./needsYouItems.ts";

function session(
  id: string,
  status: SessionStatus,
  createdAt: number,
  archivedAt: number | null = null
): UiSession {
  return {
    archivedAt,
    baselineOid: null,
    claudeSessionId: null,
    createdAt,
    cwd: "/x",
    id,
    projectId: "p1",
    status,
    summary: "",
    title: id,
    titleLocked: false,
    worktreePath: null,
  };
}

function asking(text: string): SessionActivity {
  return {
    main: { currentTool: null },
    pendingAsk: { askedAt: null, kind: "question", text },
    shells: [],
    subagents: [],
    tasks: [],
  };
}

const EMPTY = {
  activeSessionId: null,
  activity: {},
  appendSeq: {},
  projects: [] as ProjectRow[],
  statusOrigin: {} as Record<string, "seeded" | "live">,
  sessions: {},
  viewed: {},
};

test("a waiting session with an exact ask reads as a question, with its text", () => {
  const items = needsYouSectionItems({
    ...EMPTY,
    activity: { s1: asking("Merge or rebase?") },
    sessions: { s1: session("s1", "waiting", 1) },
  });

  expect(items).toEqual([
    {
      askKind: "question",
      askText: "Merge or rebase?",
      kind: "question",
      sessionId: "s1",
    },
  ]);
});

test("permission and plan-approval asks read as questions but keep their kind", () => {
  const items = needsYouSectionItems({
    ...EMPTY,
    activity: {
      s1: {
        main: { currentTool: null },
        pendingAsk: { askedAt: null, kind: "permission", text: "Allow Bash?" },
        shells: [],
        subagents: [],
        tasks: [],
      },
    },
    sessions: { s1: session("s1", "waiting", 1) },
  });

  // Same priority and wash as a question, but the kind survives so the row
  // can show a permission-specific icon (a permission is approved in the
  // terminal, not answered in the composer).
  expect(items).toEqual([
    {
      askKind: "permission",
      askText: "Allow Bash?",
      kind: "question",
      sessionId: "s1",
    },
  ]);
});

test("a waiting session without an ask is plain waiting", () => {
  const items = needsYouSectionItems({
    ...EMPTY,
    sessions: { s1: session("s1", "waiting", 1) },
  });

  expect(items).toEqual([
    { askKind: null, askText: null, kind: "waiting", sessionId: "s1" },
  ]);
});

test("errored sessions are listed", () => {
  const items = needsYouSectionItems({
    ...EMPTY,
    sessions: { s1: session("s1", "error", 1) },
  });

  expect(items).toEqual([
    { askKind: null, askText: null, kind: "error", sessionId: "s1" },
  ]);
});

test("a done session appears only while it has unseen output and is not active", () => {
  const base = {
    ...EMPTY,
    appendSeq: { s1: 1 },
    sessions: { s1: session("s1", "done", 1) },
  };

  expect(needsYouSectionItems(base)).toEqual([
    { askKind: null, askText: null, kind: "done", sessionId: "s1" },
  ]);
  // Already caught up → nothing new to review.
  expect(
    needsYouSectionItems({
      ...base,
      viewed: { s1: { appendSeq: 1, ms: 0, tasksDone: 0 } },
    })
  ).toEqual([]);
  // The user is looking at it right now.
  expect(needsYouSectionItems({ ...base, activeSessionId: "s1" })).toEqual([]);
});

test("a finish replayed at launch never counts as unseen output", () => {
  // The launch seed is the whole reason this guard exists: the backend
  // re-tails each transcript from offset 0, so appendSeq climbs to hundreds
  // while `viewed` (in-memory only) is empty — an unguarded unseen count then
  // reports every old finished session as needing review on every launch.
  const base = {
    ...EMPTY,
    appendSeq: { s1: 412 },
    sessions: { s1: session("s1", "done", 1) },
  };

  expect(
    needsYouSectionItems({ ...base, statusOrigin: { s1: "seeded" as const } })
  ).toEqual([]);
  // The same session finishing again *live* this run is real news.
  expect(
    needsYouSectionItems({ ...base, statusOrigin: { s1: "live" as const } })
  ).toEqual([{ askKind: null, askText: null, kind: "done", sessionId: "s1" }]);
});

test("unseen output is still detected past the event ring's cap", () => {
  // The event buffer caps at 1000 and evicts from the front, so its LENGTH
  // stops growing — only the monotonic append counter can tell "new output
  // since last viewed" on a long session.
  const items = needsYouSectionItems({
    ...EMPTY,
    appendSeq: { s1: 1500 },
    sessions: { s1: session("s1", "done", 1) },
    viewed: { s1: { appendSeq: 1000, ms: 0, tasksDone: 0 } },
  });

  expect(items).toEqual([
    { askKind: null, askText: null, kind: "done", sessionId: "s1" },
  ]);
});

test("running, idle, and archived sessions never qualify", () => {
  const items = needsYouSectionItems({
    ...EMPTY,
    appendSeq: { s3: 1 },
    sessions: {
      s1: session("s1", "running", 1),
      s2: session("s2", "idle", 2),
      s3: session("s3", "waiting", 3, 99), // archived
    },
  });

  expect(items).toEqual([]);
});

test("sessions of a parked project never qualify", () => {
  const items = needsYouSectionItems({
    ...EMPTY,
    projects: [
      {
        color: null,
        id: "p1",
        name: "p1",
        parkedAt: 10,
        path: "/x",
        setupCommand: null,
      },
    ],
    sessions: { s1: session("s1", "waiting", 1) },
  });

  expect(items).toEqual([]);
});

test("orders questions first, then errors, waiting, done — oldest first within a kind", () => {
  const items = needsYouSectionItems({
    ...EMPTY,
    activity: { q2: asking("?") },
    appendSeq: { d1: 1 },
    sessions: {
      d1: session("d1", "done", 1),
      w1: session("w1", "waiting", 2),
      e1: session("e1", "error", 3),
      q2: session("q2", "waiting", 4),
      w0: session("w0", "waiting", 1),
    },
  });

  expect(items.map((i) => i.sessionId)).toEqual(["q2", "e1", "w0", "w1", "d1"]);
});
