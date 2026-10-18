import { expect, test } from "vitest";
import type { ToolActivity } from "../../types.ts";
import { durationLabel, elapsedLabel, toolLabel } from "./toolLabel.ts";

function tool(overrides: Partial<ToolActivity>): ToolActivity {
  return { startedAt: null, target: null, toolName: "Edit", ...overrides };
}

test("toolLabel maps a known verb and basenames the target", () => {
  expect(toolLabel(tool({ target: "src/foo.tsx", toolName: "Edit" }))).toBe(
    "Editing foo.tsx"
  );
  expect(toolLabel(tool({ target: "src/bar.ts", toolName: "Read" }))).toBe(
    "Reading bar.ts"
  );
});

test("toolLabel falls back to the tool name for an unmapped tool", () => {
  expect(toolLabel(tool({ target: null, toolName: "WebFetch" }))).toBe(
    "WebFetch"
  );
});

test("elapsedLabel formats seconds and minutes from a start time", () => {
  const start = "2026-06-21T00:00:00.000Z";
  const now = Date.parse(start);
  expect(elapsedLabel(start, now + 12_000)).toBe("12s");
  expect(elapsedLabel(start, now + 63_000)).toBe("1m 3s");
  expect(elapsedLabel(null, now)).toBe("—");
});

test("durationLabel formats sub-minute and minute spans", () => {
  expect(durationLabel(1300)).toBe("1.3s");
  expect(durationLabel(124_000)).toBe("2m 4s");
});
