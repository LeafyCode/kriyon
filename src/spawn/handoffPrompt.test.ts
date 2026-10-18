import { expect, test } from "vitest";
import type { SessionActivity, StudioEvent } from "../types.ts";
import { buildHandoffPrompt } from "./handoffPrompt.ts";

const activity: SessionActivity = {
  main: { currentTool: null },
  pendingAsk: null,
  shells: [],
  subagents: [],
  tasks: [],
};

test("summarizes recent work and leaves a steer line", () => {
  const events: StudioEvent[] = [
    {
      file: "Foo.tsx",
      id: "1:0",
      kind: "diff",
      additions: 0,
      deletions: 0,
      hunk: "",
      lines: [],
    },
    { cmd: "pnpm test", exit: 0, id: "2:0", kind: "bash", output: [] },
    {
      id: "3:0",
      kind: "assistant",
      text: "Landed the parser.\nNext: wire the UI.",
    },
  ];
  const prompt = buildHandoffPrompt({ activity, events, title: "Parser work" });
  expect(prompt).toContain("Continuing from a previous session: Parser work");
  expect(prompt).toContain("Foo.tsx");
  expect(prompt).toContain("Ran 1 command");
  expect(prompt).toContain("Landed the parser.");
  // Ends with an empty steer line for the user to type into.
  expect(prompt.endsWith("\n")).toBe(true);
});

test("with no digestible events still yields a usable header", () => {
  const prompt = buildHandoffPrompt({ activity, events: [], title: "Fresh" });
  expect(prompt).toContain("Continuing from a previous session: Fresh");
  expect(prompt).toContain("Pick up where it left off");
});
