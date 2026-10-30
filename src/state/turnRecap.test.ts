import { expect, test } from "vitest";
import type {
  SessionActivity,
  StructuredEvent,
  StudioEvent,
} from "../types.ts";
import { recapHeadline, turnRecap } from "./turnRecap.ts";

let n = 0;
function ev(event: StructuredEvent): StudioEvent {
  n += 1;
  return { ...event, id: `e${n}` };
}

const diff = (file: string) =>
  ev({ additions: 1, deletions: 0, file, hunk: "", kind: "diff", lines: [] });
const bash = (exit: number | null) =>
  ev({ cmd: "pnpm test", exit, kind: "bash", output: [] });

function activity(over: Partial<SessionActivity> = {}): SessionActivity {
  return {
    main: { currentTool: null },
    pendingAsk: null,
    shells: [],
    subagents: [],
    tasks: [],
    ...over,
  };
}

test("sums up only the last turn: files, commands, failures and the reply", () => {
  const events = [
    ev({ kind: "prompt", text: "first" }),
    diff("old.ts"),
    ev({ kind: "prompt", text: "fix the tests" }),
    diff("src/a.ts"),
    diff("src/b.ts"),
    diff("src/a.ts"),
    bash(1),
    bash(0),
    ev({ kind: "assistant", text: "Working on it" }),
    ev({ kind: "assistant", text: "All tests pass now.\nDetails follow." }),
  ];
  const recap = turnRecap(events, activity(), "done");
  expect(recap).toEqual({
    commands: 2,
    failedCommands: 1,
    files: ["src/a.ts", "src/b.ts"],
    key: events[2]?.id,
    needs: null,
    reply: "All tests pass now.",
    tasks: null,
  });
});

test("a waiting session says what it needs", () => {
  const recap = turnRecap(
    [ev({ kind: "prompt", text: "go" }), diff("x.ts")],
    activity({
      pendingAsk: {
        askedAt: null,
        kind: "permission",
        text: "Run npm install?",
      },
    }),
    "waiting"
  );
  expect(recap?.needs).toBe("Run npm install?");
});

test("counts the task list as it stands", () => {
  const recap = turnRecap(
    [ev({ kind: "prompt", text: "go" }), diff("x.ts")],
    activity({
      tasks: [
        { activeForm: null, status: "completed", text: "a" },
        { activeForm: null, status: "pending", text: "b" },
      ],
    }),
    "done"
  );
  expect(recap?.tasks).toEqual({ done: 1, total: 2 });
});

test("no recap while Claude works, before any prompt, or for a turn that did nothing", () => {
  const events = [ev({ kind: "prompt", text: "hi" }), diff("x.ts")];
  expect(turnRecap(events, activity(), "running")).toBeNull();
  expect(turnRecap([diff("x.ts")], activity(), "done")).toBeNull();
  expect(
    turnRecap(
      [
        ev({ kind: "prompt", text: "hi" }),
        ev({ kind: "assistant", text: "Hello!" }),
      ],
      activity(),
      "done"
    )
  ).toBeNull();
});

test("the headline reads as one plain line", () => {
  expect(
    recapHeadline({
      commands: 4,
      failedCommands: 1,
      files: ["a", "b", "c"],
      key: "k",
      needs: null,
      reply: null,
      tasks: { done: 2, total: 5 },
    })
  ).toBe("Changed 3 files · ran 4 commands, 1 failed · 2 of 5 tasks done");
  expect(
    recapHeadline({
      commands: 1,
      failedCommands: 0,
      files: [],
      key: "k",
      needs: null,
      reply: null,
      tasks: null,
    })
  ).toBe("Ran 1 command");
});
