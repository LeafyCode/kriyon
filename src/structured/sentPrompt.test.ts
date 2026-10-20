import { expect, test } from "vitest";
import type { StructuredTurn } from "../ipc/bridge.ts";
import {
  clearCliInputKeys,
  isProcessed,
  matchingTurn,
  recordedEnd,
  SENT_PROMPT_TTL_MS,
  sentSettled,
  shownPrompt,
  wasTakenBack,
} from "./sentPrompt.ts";

function turn(over: Partial<StructuredTurn>): StructuredTurn {
  return {
    did: [],
    ended: false,
    endedMs: null,
    images: [],
    reports: [],
    interrupted: false,
    prompt: "go",
    reply: null,
    source: "live",
    startedMs: null,
    ...over,
  };
}

test("a sent prompt is found by its text, with mentions and images after it", () => {
  const turns = [
    turn({ prompt: "fix it" }),
    turn({ prompt: 'fix it @"/a b.txt" [Image #1]' }),
  ];
  expect(matchingTurn(turns, "fix it")).toBe(turns[1]);
  expect(matchingTurn(turns, "something else")).toBeNull();
  // An image-only message reaches Claude as just its placeholder.
  const imageOnly = [turn({ prompt: "[Image #3]" })];
  expect(matchingTurn(imageOnly, "")).toBe(imageOnly[0]);
});

test("a sent prompt the CLI rewrote is found by when it began", () => {
  const turns = [
    turn({ prompt: "old", startedMs: 1000 }),
    turn({ prompt: "[Image #1]", startedMs: 50_000 }),
  ];
  expect(matchingTurn(turns, "what is this pdf", 52_000)).toBe(turns[1]);
  expect(matchingTurn(turns, "what is this pdf", 90_000)).toBeNull();
  expect(matchingTurn(turns, "what is this pdf")).toBeNull();
});

test("the newest turn's recorded end is evidence once it is a while old", () => {
  const over = [turn({ ended: true, endedMs: 10_000 })];
  expect(recordedEnd(over, 15_000)).toEqual({
    endedMs: 10_000,
    interrupted: false,
  });
  expect(recordedEnd(over, 12_000)).toBeNull();
  expect(recordedEnd([turn({ endedMs: 10_000 })], 60_000)).toBeNull();
  expect(recordedEnd([], 60_000)).toBeNull();
});

test("a turn stopped by an interrupt row is a recorded end too", () => {
  // An interrupted turn gets no turn_duration row, so without this a status
  // whose Esc the view never saw (Ctrl+C, a slow row) stays Running.
  const stopped = [turn({ endedMs: 10_000, interrupted: true })];
  expect(recordedEnd(stopped, 15_000)).toEqual({
    endedMs: 10_000,
    interrupted: true,
  });
});

test("a turn is processed once Claude did, replied or was stopped", () => {
  expect(isProcessed(turn({}))).toBe(false);
  expect(isProcessed(turn({ reply: "ok" }))).toBe(true);
  expect(isProcessed(turn({ interrupted: true }))).toBe(true);
  // A slash command the CLI ran itself, that printed nothing (`/mcp`).
  expect(isProcessed(turn({ ended: true }))).toBe(true);
  expect(
    isProcessed(turn({ did: [{ durationMs: null, kind: "thought" }] }))
  ).toBe(true);
});

test("Esc took a prompt back only if Claude never started on it", () => {
  expect(wasTakenBack([turn({ prompt: "go" })], "go", 0)).toBe(true);
  expect(
    wasTakenBack([turn({ interrupted: true, prompt: "go" })], "go", 0)
  ).toBe(false);
  expect(wasTakenBack([turn({ prompt: "go", reply: "Once" })], "go", 0)).toBe(
    false
  );
  // Not read yet: so early that the CLI had it back before anything was kept.
  expect(wasTakenBack([], "go", 0)).toBe(true);
});

test("a prompt the CLI rewrote and ran is not taken back", () => {
  // A slash command is kept as its expansion, not the text that was sent.
  const ran = [
    turn({
      prompt: "<command-name>/review</command-name>",
      reply: "Looks fine",
      startedMs: 50_000,
    }),
  ];
  expect(wasTakenBack(ran, "/review src", 49_000)).toBe(false);
  const unstarted = [
    turn({ prompt: "<command-name>/review</command-name>", startedMs: 50_000 }),
  ];
  expect(wasTakenBack(unstarted, "/review src", 49_000)).toBe(true);
});

test("the CLI's copy is cleared one Ctrl+U per line, plus one", () => {
  expect(clearCliInputKeys("one")).toBe("\u0015\u0015");
  expect(clearCliInputKeys("one\ntwo\nthree")).toBe("\u0015".repeat(4));
});

test("a prompt is shown without the image placeholders its thumbnails replace", () => {
  expect(shownPrompt("what is this? [Image #1] [Image #2]", 2)).toBe(
    "what is this?"
  );
  expect(shownPrompt("see [Image #1]", 0)).toBe("see [Image #1]");
});

test("a sent prompt settles once Claude starts on its turn, or it grows too old", () => {
  const sent = { at: 10_000, text: "fix it" };
  expect(sentSettled(sent, [], 11_000)).toBe(false);
  expect(sentSettled(sent, null, 11_000)).toBe(false);
  // Its row is in, but Claude hasn't started on it: Esc may still take it back.
  expect(sentSettled(sent, [turn({ prompt: "fix it" })], 11_000)).toBe(false);
  expect(
    sentSettled(sent, [turn({ prompt: "fix it", reply: "Done." })], 11_000)
  ).toBe(true);
  // Never matched (Claude was given something else, or it never ran).
  expect(sentSettled(sent, null, 10_000 + SENT_PROMPT_TTL_MS)).toBe(true);
});
