import { expect, test } from "vitest";
import { ACTIVITY, FILTERS, rowsFor } from "./demo.ts";

test("--all shows every row of the record", () => {
  expect(rowsFor("all")).toHaveLength(ACTIVITY.length);
});

test("each flag keeps only the rows of its kind", () => {
  expect(rowsFor("changes").map((r) => r.title)).toEqual([
    "Changed UsageFooter.tsx",
    "Added UsageFooter.test.tsx",
    "Changed 3 files",
  ]);
  expect(rowsFor("look").every((r) => r.kinds.includes("look"))).toBe(true);
});

test("a row can match more than one flag", () => {
  // An install is both a command and something to look at.
  const install = ACTIVITY.find((r) => r.title === "Installed a package");
  expect(rowsFor("commands")).toContain(install);
  expect(rowsFor("look")).toContain(install);
});

test("every flag matches at least one row", () => {
  for (const f of FILTERS) {
    expect(rowsFor(f.id).length).toBeGreaterThan(0);
  }
});
