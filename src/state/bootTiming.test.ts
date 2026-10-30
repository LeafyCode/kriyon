import { expect, test } from "vitest";
import { formatBootTime } from "./bootTiming.ts";

test("boot times read in ms under a second, then in tenths of a second", () => {
  expect(formatBootTime(undefined)).toBe("—");
  expect(formatBootTime(420)).toBe("420ms");
  expect(formatBootTime(1330)).toBe("1.3s");
});
