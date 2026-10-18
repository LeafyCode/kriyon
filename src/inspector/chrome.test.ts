import { expect, test } from "vitest";
import { agoFromIso, agoLabel } from "./chrome.tsx";

test("agoLabel renders coarse relative buckets", () => {
  const now = Date.now();
  expect(agoLabel(now - 5000)).toBe("just now");
  expect(agoLabel(now - 120_000)).toBe("2m ago");
  expect(agoLabel(now - 3 * 3_600_000)).toBe("3h ago");
  expect(agoLabel(now - 2 * 86_400_000)).toBe("2d ago");
});

test("agoFromIso parses a timestamp; null/invalid renders an em dash", () => {
  const twoMinAgo = new Date(Date.now() - 120_000).toISOString();
  expect(agoFromIso(twoMinAgo)).toBe("2m ago");
  expect(agoFromIso(null)).toBe("—");
  expect(agoFromIso("not a date")).toBe("—");
});
