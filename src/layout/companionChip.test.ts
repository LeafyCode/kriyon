import { expect, test } from "vitest";
import { companionChip } from "./companionChip.ts";

test("each companion state reads plainly, and off shows nothing", () => {
  expect(companionChip({ claudeVersion: null, state: "off" })).toBeNull();
  expect(companionChip({ claudeVersion: "2.1.288", state: "on" })).toEqual({
    label: "Companion",
    on: true,
    title: "Kriyon Companion is on (Claude Code 2.1.288).",
  });
  expect(
    companionChip({ claudeVersion: null, state: "starting" })?.title
  ).toContain("trust this folder");
  expect(
    companionChip({ claudeVersion: null, state: "silent" })?.title
  ).toContain("2.1.287");
  expect(companionChip({ claudeVersion: null, state: "blocked" })?.label).toBe(
    "Companion blocked"
  );
  expect(
    companionChip({ claudeVersion: null, state: "needsRestart" })?.label
  ).toBe("Restart for Companion");
});
