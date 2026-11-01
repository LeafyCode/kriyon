import { expect, test } from "vitest";
import { matchingSections, SETTINGS_SECTIONS } from "./settingsSections.ts";

const ALL = SETTINGS_SECTIONS.map((section) => section.id);

test("an empty search keeps every section", () => {
  expect(matchingSections("")).toEqual(ALL);
  expect(matchingSections("   ")).toEqual(ALL);
});

test("a search matches a section by a setting inside it", () => {
  expect(matchingSections("budget")).toEqual(["sessions"]);
  expect(matchingSections("mascot")).toEqual(["appearance"]);
  expect(matchingSections("Live USAGE")).toEqual(["claude"]);
});

test("a search matches a section by its own name", () => {
  expect(matchingSections("updates")).toEqual(["updates"]);
});

test("every word must match, in any order", () => {
  expect(matchingSections("idle sleep")).toEqual(["sessions"]);
  expect(matchingSections("sleep theme")).toEqual([]);
});

test("a search with no match finds nothing", () => {
  expect(matchingSections("zzzz")).toEqual([]);
});
