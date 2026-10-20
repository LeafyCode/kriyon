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
