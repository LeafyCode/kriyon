import { expect, test } from "vitest";
import type {
  ProjectRow,
  SessionActivity,
  SessionStanding,
  StudioEvent,
} from "../types.ts";
import {
  buildNeedsYouEntries,
  formatDuration,
  snippetFromEvents,
} from "./needsYou.ts";
import type { UiSession } from "./sessions.ts";

const NOW = Date.parse("2026-07-02T10:12:00Z");

function standing(sessionId: string, lastChangeMs: number): SessionStanding {
  return {
    lastChangeMs,
    lastSeenMs: NOW,
    projectId: "p1",
    sessionId,
    state: "awaiting_input",
    worktree: null,
  };
}

function session(id: string): UiSession {
  return {
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "/repo",
    id,
    projectId: "p1",
    status: "waiting",
    summary: "Waiting for you",
    title: `Title ${id}`,
    titleLocked: false,
    worktreePath: null,
  };
}

function activityWith(ask: SessionActivity["pendingAsk"]): SessionActivity {
  return {
    main: { currentTool: null },
    pendingAsk: ask,
    shells: [],
    subagents: [],
    tasks: [],
  };
}

const project: ProjectRow = {
  color: null,
  id: "p1",
  name: "Kriyon",
  path: "/repo",
  parkedAt: null,
  setupCommand: null,
};

test("an exact ask is surfaced with its kind and text", () => {
  const entries = buildNeedsYouEntries({
    activity: {
      s1: activityWith({
        askedAt: "2026-07-02T10:00:00Z",
        kind: "question",
        text: "Which db?",
      }),
    },
    blocked: [standing("s1", NOW - 1000)],
    events: {},
    nowMs: NOW,
    projects: [project],
    sessions: { s1: session("s1") },
  });
  expect(entries).toHaveLength(1);
  expect(entries[0]?.ask).toEqual({
    kind: "question",
    text: "Which db?",
    tier: "exact",
  });
  expect(entries[0]?.projectName).toBe("Kriyon");
  // blockedFor comes from askedAt when present: 12 minutes.
  expect(entries[0]?.blockedForMs).toBe(12 * 60_000);
});

test("without an exact ask the last assistant text becomes a best-effort snippet", () => {
  const events: StudioEvent[] = [
    { id: "1:0", kind: "assistant", text: "First answer" },
    { id: "2:0", kind: "tool", meta: null, name: "Bash", target: "ls" },
    {
      id: "3:0",
      kind: "assistant",
      text: "Should I use worktrees?\nMore detail…",
    },
  ];
  const entries = buildNeedsYouEntries({
    activity: {},
    blocked: [standing("s1", NOW - 5000)],
    events: { s1: events },
    nowMs: NOW,
    projects: [project],
    sessions: { s1: session("s1") },
  });
  expect(entries[0]?.ask).toEqual({
    kind: "snippet",
    text: "Should I use worktrees?",
    tier: "best_effort",
  });
  // Falls back to lastChangeMs for the blocked duration.
  expect(entries[0]?.blockedForMs).toBe(5000);
});

test("entries order longest-blocked first", () => {
  const entries = buildNeedsYouEntries({
    activity: {},
    blocked: [standing("recent", NOW - 1000), standing("old", NOW - 60_000)],
    events: {},
    nowMs: NOW,
    projects: [project],
    sessions: { old: session("old"), recent: session("recent") },
  });
  expect(entries.map((e) => e.sessionId)).toEqual(["old", "recent"]);
});

test("an unparseable askedAt falls back to lastChangeMs", () => {
  const entries = buildNeedsYouEntries({
    activity: {
      s1: activityWith({
        askedAt: "not-a-date",
        kind: "permission",
        text: "Bash",
      }),
    },
    blocked: [standing("s1", NOW - 2000)],
    events: {},
    nowMs: NOW,
    projects: [project],
    sessions: { s1: session("s1") },
  });
  expect(entries[0]?.blockedForMs).toBe(2000);
});

test("snippet skips a leading blank line to find the first non-empty one", () => {
  const snippet = snippetFromEvents([
    { id: "1:0", kind: "assistant", text: "\nShould I proceed?" },
  ]);
  expect(snippet).toBe("Should I proceed?");
});

test("snippet is null with no assistant events", () => {
  expect(snippetFromEvents(undefined)).toBeNull();
  expect(
    snippetFromEvents([
      { id: "1:0", kind: "bash", cmd: "ls", exit: 0, output: [] },
    ])
  ).toBeNull();
});

test("snippet truncates to 120 chars on the first line", () => {
  const long = "x".repeat(200);
  const snippet = snippetFromEvents([
    { id: "1:0", kind: "assistant", text: long },
  ]);
  expect(snippet).toHaveLength(121); // 120 + ellipsis
  expect(snippet?.endsWith("…")).toBe(true);
});

test("formatDuration buckets", () => {
  expect(formatDuration(30_000)).toBe("<1m");
  expect(formatDuration(12 * 60_000)).toBe("12m");
  expect(formatDuration(65 * 60_000)).toBe("1h 05m");
});
