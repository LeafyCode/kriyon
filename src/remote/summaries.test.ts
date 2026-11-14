/**
 * The JSON Rust makes for both apps (`src/remote/fixtures/summaries.json`,
 * written and checked by `kriyon_remote::device_view`'s tests) is what the
 * TypeScript types say: each expected value below is typed, so a field the
 * types lack or misname fails to compile, and the fixture must equal it, so
 * a field Rust renamed or added fails here.
 */
import { expect, test } from "vitest";
import fixture from "./fixtures/summaries.json" with { type: "json" };
import type { HostSummary } from "./hostSummary.ts";
import type { ReadableSummary } from "./readableSummary.ts";

const HOST: Required<HostSummary> = {
  hostId: "ab".repeat(32),
  hostName: "Mac",
  lastSeenMs: null,
  link: "connected",
  mayStart: true,
  path: "direct",
  projects: [{ id: "p1", name: "app", parked: false }],
  refused: null,
  role: "controller",
  sessions: [
    {
      activity: null,
      dialogOpen: true,
      diff: { added: 10, files: 2, removed: 3 },
      id: "s1",
      lastChangeMs: 5,
      mayType: true,
      needsYou: true,
      projectId: "p1",
      question: { options: ["Postgres", "SQLite"], text: "Which db?" },
      runningSinceMs: null,
      standing: "awaiting_input",
      status: "waiting",
      title: "Fix the build",
      turnSummary: "Fixed it.",
      typing: "you",
    },
    {
      activity: "Bash · pnpm test",
      dialogOpen: false,
      diff: null,
      id: "s2",
      lastChangeMs: 5,
      mayType: false,
      needsYou: false,
      projectId: "p1",
      question: null,
      runningSinceMs: 4,
      standing: "running",
      status: "running",
      title: "Fix the build",
      turnSummary: null,
      typing: null,
    },
  ],
  usage: { resetsAtMs: 9000, usedPercent: 40, window: "5-hour limit" },
};

const READABLE: ReadableSummary = {
  entries: [
    { kind: "you", seq: 1, text: "Fix the login bug" },
    { done: false, kind: "claude", seq: 2, text: "The form sends too early" },
    {
      kind: "step",
      name: "Read",
      seq: 3,
      state: "done",
      target: "src/login.ts",
    },
    {
      kind: "report",
      outcome: "Finished",
      seq: 4,
      summary: "Waited for the token",
    },
    {
      header: "Tests",
      kind: "asking",
      options: ["Yes", "No"],
      question: "Fix the failing test too?",
      seq: 5,
    },
    { kind: "note", seq: 6, text: "Context compacted" },
  ],
  unavailable: null,
};

test("a host's summary from Rust is what HostSummary says, field for field", () => {
  expect(fixture.hostSummary).toEqual(HOST);
  // Every session field too: none Rust sends is missing from the type.
  for (const [at, session] of fixture.hostSummary.sessions.entries()) {
    expect(new Set(Object.keys(session))).toEqual(
      new Set(Object.keys(HOST.sessions[at] ?? {}))
    );
  }
});

test("a readable view from Rust is what ReadableSummary says", () => {
  expect(fixture.readableSummary).toEqual(READABLE);
});
