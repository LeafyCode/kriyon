import { expect, test } from "vitest";
import { DEFAULT_LAYOUT } from "../state/layout.ts";
import { formatCpu, formatMb, memoryChipView } from "./memoryChip.ts";

const BUDGET = DEFAULT_LAYOUT.memoryBudgetMb;

test("no chip before the first sample or for a dead tree", () => {
  expect(memoryChipView(undefined, BUDGET)).toBeNull();
  expect(memoryChipView(0, BUDGET)).toBeNull();
});

test("labels read as MB below a GB and one-decimal GB above", () => {
  expect(formatMb(431)).toBe("431 MB");
  expect(formatMb(1024)).toBe("1.0 GB");
  expect(formatMb(2560)).toBe("2.5 GB");
});

test("tone escalates as a share of the user's own budget", () => {
  // Well under a sixth of the budget is unremarkable; a sixth is worth
  // noticing; a third of the whole app's ceiling in one session is the thing
  // to look at.
  expect(memoryChipView(512, BUDGET)?.tone).toBe("quiet");
  expect(memoryChipView(BUDGET / 6, BUDGET)?.tone).toBe("elevated");
  expect(memoryChipView(BUDGET / 3, BUDGET)?.tone).toBe("high");
  // Just under each boundary stays in the calmer tone.
  expect(memoryChipView(BUDGET / 6 - 1, BUDGET)?.tone).toBe("quiet");
  expect(memoryChipView(BUDGET / 3 - 1, BUDGET)?.tone).toBe("elevated");
});

test("a smaller budget makes the same session read as heavier", () => {
  // The whole point of tying the chip to the budget: a user who sets a 2 GB
  // ceiling should see a 700 MB session flagged, not styled as quiet against
  // a constant that ignores their setting.
  const mb = 700;
  expect(memoryChipView(mb, BUDGET)?.tone).toBe("quiet");
  expect(memoryChipView(mb, 3072)?.tone).toBe("elevated");
  expect(memoryChipView(mb, 1024)?.tone).toBe("high");
});

test("a nonsensical budget never divides by zero", () => {
  // The setting is validated at both ends, but the view must not produce NaN
  // if it ever sees a zero.
  expect(memoryChipView(500, 0)?.tone).toBe("high");
  expect(memoryChipView(500, 0)?.label).toBe("500 MB");
});

test("CPU reads a dash until the second sample, then a percent of one core", () => {
  expect(formatCpu(undefined)).toBe("—");
  expect(formatCpu(null)).toBe("—");
  expect(formatCpu(0)).toBe("0%");
  expect(formatCpu(3.24)).toBe("3.2%");
  expect(formatCpu(9.96)).toBe("10%");
  // Several busy cores read above 100, like Activity Monitor.
  expect(formatCpu(142.4)).toBe("142%");
});
