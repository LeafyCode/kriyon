import { expect, test } from "vitest";
import type { SessionActivity, ToolActivity } from "../types.ts";
import { contextLine } from "./sessionContext.ts";

function activity(
  currentTool: ToolActivity | null,
  runningAgents = 0
): SessionActivity {
  return {
    main: { currentTool },
    pendingAsk: null,
    shells: [],
    subagents: Array.from({ length: runningAgents }, (_, i) => ({
      agentId: null,
      currentTool: null,
      description: null,
      durationMs: null,
      endedAt: null,
      kind: "Explore",
      result: null,
      startedAt: null,
      state: "running" as const,
      toolUseId: `a${i}`,
    })),
    tasks: [],
  };
}

test("waiting reads needs-input, preferring the summary", () => {
  expect(contextLine("waiting", "Pick an option", undefined)).toEqual({
    text: "Pick an option",
    tone: "waiting",
  });
  expect(contextLine("waiting", "", undefined)).toEqual({
    text: "Needs your input",
    tone: "waiting",
  });
});

test("a waiting session shows the structured ask, not a polluted summary", () => {
  // A generic permission gate can set the flat summary to "Needs permission"
  // even when the real ask is a question; the structured pendingAsk is the
  // source of truth (the Needs-you section reads the same field).
  const withAsk: SessionActivity = {
    ...activity(null),
    pendingAsk: { askedAt: null, kind: "question", text: "Which db?" },
  };
  expect(contextLine("waiting", "Needs permission", withAsk)).toEqual({
    text: "Which db?",
    tone: "waiting",
  });
});

test("a waiting session with a blank ask falls back to the summary", () => {
  const blankAsk: SessionActivity = {
    ...activity(null),
    pendingAsk: { askedAt: null, kind: "permission", text: "" },
  };
  expect(contextLine("waiting", "$ still building", blankAsk)).toEqual({
    text: "$ still building",
    tone: "waiting",
  });
});

test("error reads the summary in the error tone", () => {
  expect(contextLine("error", "claude exited", undefined)).toEqual({
    text: "claude exited",
    tone: "error",
  });
  expect(contextLine("error", "", undefined)).toEqual({
    text: "Error",
    tone: "error",
  });
});

test("a live tool wins over the stale summary", () => {
  const tool = { startedAt: null, target: "/x/pty.rs", toolName: "Edit" };
  expect(contextLine("running", "$ old", activity(tool))).toEqual({
    text: "Editing pty.rs",
    tone: "live",
  });
});

test("running subagents are counted after the tool label", () => {
  const tool = { startedAt: null, target: null, toolName: "Bash" };
  expect(contextLine("running", "", activity(tool, 2))).toEqual({
    text: "Running · 2 agents",
    tone: "live",
  });
  expect(contextLine("running", "", activity(null, 1))).toEqual({
    text: "1 agent running",
    tone: "live",
  });
});

test("with nothing live the summary shows muted, else nothing", () => {
  expect(contextLine("running", "$ cargo build", undefined)).toEqual({
    text: "$ cargo build",
    tone: "muted",
  });
  expect(contextLine("idle", "", undefined)).toBeNull();
});

test("a session whose hooks are off says its status is unavailable", () => {
  // No hook ever fires, so "idle" would be a guess; name the file instead.
  expect(contextLine("idle", "", undefined, "user")).toEqual({
    text: "Status unavailable · hooks off in ~/.claude/settings.json",
    tone: "muted",
  });
  expect(contextLine("running", "stale", undefined, "project")).toEqual({
    text: "Status unavailable · hooks off in .claude/settings.json",
    tone: "muted",
  });
  expect(contextLine("idle", "", undefined, "local")?.text).toBe(
    "Status unavailable · hooks off in .claude/settings.local.json"
  );
  expect(contextLine("idle", "", undefined, "managed")?.text).toBe(
    "Status unavailable · hooks off by managed settings"
  );
  expect(contextLine("idle", "", undefined, "kriyon")?.text).toBe(
    "Status unavailable · hooks off in Kriyon settings"
  );
});
