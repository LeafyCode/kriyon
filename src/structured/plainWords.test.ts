import { expect, test } from "vitest";
import type { StepKind, StructuredTurn, TurnItem } from "../ipc/bridge.ts";
import {
  didSummary,
  durationLabel,
  stepActivity,
  stepInProgress,
  stepVerb,
  thoughtLabel,
  turnSections,
} from "./plainWords.ts";

type Step = Extract<TurnItem, { kind: "step" }>;

const step = (
  stepKind: StepKind,
  input: string,
  name = "Tool",
  said: Partial<Pick<Step, "description" | "target">> = {}
): Step => ({
  description: null,
  id: input,
  input,
  isError: false,
  kind: "step",
  name,
  result: null,
  stepKind,
  target: null,
  ...said,
});

test("thinking reads as how long, never its text", () => {
  expect(thoughtLabel(12_400)).toBe("Thought for 12s");
  expect(thoughtLabel(400)).toBe("Thought for 1s");
  expect(thoughtLabel(null)).toBe("Thought");
});

test("the folded summary counts what Claude did", () => {
  const did: TurnItem[] = [
    { durationMs: 2000, kind: "thought" },
    {
      id: "1",
      input: "{}",
      isError: false,
      kind: "step",
      description: null,
      target: null,
      name: "Read",
      result: null,
      stepKind: "read",
    },
    {
      id: "2",
      input: "{}",
      isError: false,
      kind: "step",
      description: null,
      target: null,
      name: "Read",
      result: null,
      stepKind: "read",
    },
    {
      id: "3",
      input: "{}",
      isError: false,
      kind: "step",
      description: null,
      target: null,
      name: "Bash",
      result: null,
      stepKind: "command",
    },
    {
      id: "4",
      input: "{}",
      isError: false,
      kind: "step",
      description: null,
      target: null,
      name: "Edit",
      result: null,
      stepKind: "edit",
    },
    { kind: "text", text: "hm" },
  ];
  expect(didSummary(did)).toBe("read 2 files · ran 1 command · changed 1 file");
  expect(didSummary([])).toBe("nothing but the reply");
});

test("step verbs follow the kind Rust gave the tool", () => {
  expect(stepVerb("search")).toBe("Searched");
  expect(stepVerb("web")).toBe("Web");
  expect(stepVerb("mcp")).toBe("MCP");
  expect(stepVerb("other")).toBe("Used");
});

test("a turn's length reads in plain units, and not at all when unknown", () => {
  expect(durationLabel(1000, 13_400)).toBe("12s");
  expect(durationLabel(0, 184_000)).toBe("3m 4s");
  expect(durationLabel(0, 3_600_000 + 120_000)).toBe("1h 2m");
  expect(durationLabel(0, 400)).toBeNull();
  expect(durationLabel(null, 5000)).toBeNull();
});

test("Claude's messages between steps stand on their own; the steps fold around them", () => {
  const read = step("read", "{}");
  const ran = step("command", "{}");
  const thought: TurnItem = { durationMs: 1000, kind: "thought" };
  expect(
    turnSections([
      thought,
      { kind: "text", text: "Let me look." },
      read,
      ran,
      { kind: "text", text: "Found it." },
      read,
    ])
  ).toEqual([
    { items: [thought], kind: "steps" },
    { kind: "text", text: "Let me look." },
    { items: [read, ran], kind: "steps" },
    { kind: "text", text: "Found it." },
    { items: [read], kind: "steps" },
  ]);
  expect(turnSections([])).toEqual([]);
});

test("a running step reads as what Claude is doing, in plain words", () => {
  // The input may be cut short; what it acts on comes from Rust.
  const doing = (
    kind: StepKind,
    said: Partial<Pick<Step, "description" | "target">>,
    name = "Tool"
  ) => stepActivity(step(kind, '{"cut sho', name, said));
  expect(
    doing("command", { description: "Run the tests", target: "pnpm test" })
  ).toBe("Run the tests");
  expect(doing("command", { target: "ls -la" })).toBe("Running ls -la");
  expect(doing("read", { target: "app.ts" })).toBe("Reading app.ts");
  expect(doing("write", { target: "app.ts" })).toBe("Writing app.ts");
  expect(doing("search", { target: "TODO" })).toBe("Searching for TODO");
  expect(doing("web", { target: "https://x.dev" })).toBe(
    "Fetching https://x.dev"
  );
  expect(doing("agent", { description: "Find the bug" })).toBe("Find the bug");
  // Nothing known it acts on: the verb and a noun, or the tool's name.
  expect(doing("read", {})).toBe("Reading a file");
  expect(doing("other", {}, "TodoWrite")).toBe("Using TodoWrite");
});

test("the step in progress is the newest turn's unfinished one, while that turn runs", () => {
  const turn = (over: Partial<StructuredTurn>): StructuredTurn => ({
    did: [step("command", "", "Bash", { target: "npm run build" })],
    ended: false,
    endedMs: null,
    images: [],
    reports: [],
    interrupted: false,
    prompt: "build it",
    reply: null,
    source: "live",
    startedMs: null,
    ...over,
  });
  expect(stepInProgress(turn({}))).toBe("Running npm run build");
  // Stopped mid-step, or over: its last step never finished, but isn't running.
  expect(stepInProgress(turn({ interrupted: true }))).toBeNull();
  expect(stepInProgress(turn({ ended: true }))).toBeNull();
  expect(
    stepInProgress(
      turn({ did: [{ ...step("read", "{}"), result: "contents" }] })
    )
  ).toBeNull();
  expect(stepInProgress(undefined)).toBeNull();
});
