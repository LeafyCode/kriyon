import { expect, test } from "vitest";
import { PROJECT_PALETTE, projectColor } from "./projectColor.ts";

test("an explicit project color always wins", () => {
  expect(projectColor({ color: "#123456", id: "/x" })).toBe("#123456");
});

test("assignment is deterministic per project id", () => {
  const first = projectColor({ color: null, id: "/Users/x/kriyon" });
  const again = projectColor({ color: null, id: "/Users/x/kriyon" });
  expect(first).toBe(again);
  expect(PROJECT_PALETTE).toContain(first);
});

test("different ids spread across the palette", () => {
  const assigned = new Set(
    ["/a", "/b", "/c", "/d", "/e", "/f", "/g", "/h"].map((id) =>
      projectColor({ color: null, id })
    )
  );
  // A degenerate hash would map everything to one hue.
  expect(assigned.size).toBeGreaterThan(2);
});
