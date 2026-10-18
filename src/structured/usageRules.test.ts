import { expect, test } from "vitest";
import type { StructuredTurn } from "../ipc/bridge.ts";
import { isUsageCommand, usageCardSlot } from "./usageRules.ts";

function turn(startedMs: number | null): StructuredTurn {
  return {
    did: [],
    ended: true,
    endedMs: null,
    images: [],
    reports: [],
    interrupted: false,
    prompt: "go",
    reply: null,
    source: "live",
    startedMs,
  };
}

test("only /usage and /cost on their own open the card", () => {
  expect(isUsageCommand("/usage")).toBe(true);
  expect(isUsageCommand("  /cost \n")).toBe(true);
  expect(isUsageCommand("/usage please")).toBe(false);
  expect(isUsageCommand("/stats")).toBe(false);
  expect(isUsageCommand("what does /usage show?")).toBe(false);
  expect(isUsageCommand("/Usage")).toBe(false);
});

test("the card sits after the turns begun before it was asked for", () => {
  const turns = [turn(1000), turn(null), turn(5000), turn(9000)];
  expect(usageCardSlot(turns, { at: 6000 })).toBe(3);
  expect(usageCardSlot(turns, { at: 500 })).toBe(0);
  expect(usageCardSlot(turns, { at: 10_000 })).toBe(4);
  expect(usageCardSlot([], { at: 10_000 })).toBe(0);
  expect(usageCardSlot(turns, undefined)).toBeNull();
});
