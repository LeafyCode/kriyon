import { expect, test } from "vitest";
import type { StructuredEvent, StudioEvent } from "../types.ts";
import { digestEvents } from "./eventDigest.ts";

let n = 0;
const ev = (event: StructuredEvent): StudioEvent => {
  n += 1;
  return { ...event, id: `e${n}` };
};

test("counts files once, commands and failures, subagents, and keeps the last reply's first line", () => {
  const digest = digestEvents([
    ev({
      additions: 1,
      deletions: 0,
      file: "a.ts",
      hunk: "",
      kind: "diff",
      lines: [],
    }),
    ev({
      additions: 1,
      deletions: 0,
      file: "a.ts",
      hunk: "",
      kind: "diff",
      lines: [],
    }),
    ev({ cmd: "pnpm test", exit: 1, kind: "bash", output: [] }),
    ev({ cmd: "pnpm test", exit: null, kind: "bash", output: [] }),
    ev({ kind: "tool", meta: null, name: "Agent", target: null }),
    ev({ kind: "assistant", text: "\n" }),
    ev({ kind: "assistant", text: "Done.\nMore" }),
  ]);
  expect(digest).toEqual({
    commands: 2,
    failedCommands: 1,
    files: ["a.ts"],
    lastLine: "Done.",
    subagents: 1,
  });
});
