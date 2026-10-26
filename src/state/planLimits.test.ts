import { expect, test } from "vitest";
import { usePlanLimits } from "./planLimits.ts";

test("an unchanged re-send keeps the same object, a change replaces it", () => {
  const limits = {
    fiveHour: { resetsAt: 100, usedPercentage: 5 },
    sevenDay: null,
  };
  usePlanLimits.getState().apply(limits);
  const first = usePlanLimits.getState().limits;

  usePlanLimits.getState().apply({
    fiveHour: { resetsAt: 100, usedPercentage: 5 },
    sevenDay: null,
  });
  expect(usePlanLimits.getState().limits).toBe(first);

  usePlanLimits.getState().apply({
    fiveHour: { resetsAt: 100, usedPercentage: 6 },
    sevenDay: null,
  });
  expect(usePlanLimits.getState().limits.fiveHour?.usedPercentage).toBe(6);
});

test("keeps each window's readings until it resets", () => {
  usePlanLimits.setState({
    limits: { fiveHour: null, sevenDay: null },
    samples: { fiveHour: [], sevenDay: [] },
  });
  const { apply } = usePlanLimits.getState();
  apply({ fiveHour: null, sevenDay: { resetsAt: 100, usedPercentage: 10 } }, 1);
  apply({ fiveHour: null, sevenDay: { resetsAt: 100, usedPercentage: 12 } }, 2);
  expect(usePlanLimits.getState().samples.sevenDay).toEqual([
    { atMs: 1, usedPercentage: 10 },
    { atMs: 2, usedPercentage: 12 },
  ]);
  // A new reset time is a new window: its readings start over.
  apply({ fiveHour: null, sevenDay: { resetsAt: 200, usedPercentage: 1 } }, 3);
  expect(usePlanLimits.getState().samples.sevenDay).toEqual([
    { atMs: 3, usedPercentage: 1 },
  ]);
});
