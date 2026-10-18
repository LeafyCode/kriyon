import { expect, test } from "vitest";
import type { PartialReply, StructuredTurn } from "../ipc/bridge.ts";
import { liveText } from "./liveReply.ts";

const partial = (text: string, receivedMs = 2000): PartialReply => ({
  block: 0,
  done: false,
  receivedMs,
  step: 0,
  text,
  turnId: "t",
});

const turn = (over: Partial<StructuredTurn>): StructuredTurn => ({
  did: [],
  ended: false,
  endedMs: null,
  images: [],
  reports: [],
  interrupted: false,
  prompt: "go",
  reply: null,
  source: "live",
  startedMs: 1000,
  ...over,
});

test("a streaming reply shows until the turn keeps it", () => {
  expect(liveText(partial("Once upon"), [turn({})])).toBe("Once upon");
  expect(
    liveText(partial("Once upon"), [turn({ reply: "Once upon" })])
  ).toBeNull();
  expect(
    liveText(partial("Looking."), [
      turn({ did: [{ kind: "text", text: "Looking." }] }),
    ])
  ).toBeNull();
});

test("a stream from before the newest prompt, or nothing, isn't shown", () => {
  expect(liveText(partial("old", 500), [turn({})])).toBeNull();
  expect(liveText(null, [turn({})])).toBeNull();
  expect(liveText(partial("  "), [turn({})])).toBeNull();
});

test("a long reply, cut short while it streamed, is still known once kept", () => {
  // The companion caps what it streams; the turn keeps the reply whole.
  const whole = "a".repeat(25_000);
  const streamed = `${whole.slice(0, 20_000)}…`;
  expect(liveText(partial(streamed), [turn({ reply: whole })])).toBeNull();
  // A short reply ending in "…" is matched whole, as before.
  expect(liveText(partial("Wait…"), [turn({ reply: "Wait… no" })])).toBe(
    "Wait…"
  );
});
