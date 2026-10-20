import { expect, test } from "vitest";
import { summaryParts } from "./workReport.ts";

test("the quoted name in a summary is pulled out to stand out", () => {
  expect(
    summaryParts('Agent "Review the PR" failed: API error (ENOTFOUND)')
  ).toEqual({
    after: " failed: API error (ENOTFOUND)",
    before: "Agent ",
    name: "Review the PR",
  });
});

test("a summary with no quoted name is kept whole", () => {
  expect(summaryParts("Background shell stopped")).toEqual({
    after: "",
    before: "Background shell stopped",
    name: null,
  });
  expect(summaryParts('Odd "unclosed quote')).toEqual({
    after: "",
    before: 'Odd "unclosed quote',
    name: null,
  });
});
