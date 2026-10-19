import { afterEach, expect, test } from "vitest";
import { homeRelative, setHomeFolder } from "./homeRelative.ts";

afterEach(() => setHomeFolder(""));

test("the home folder reads as ~, at the start or inside a command", () => {
  setHomeFolder("/Users/dev");
  expect(homeRelative("/Users/dev/Projects/kriyon")).toBe("~/Projects/kriyon");
  expect(homeRelative('cat "/Users/dev/.zshrc" /Users/dev/a')).toBe(
    'cat "~/.zshrc" ~/a'
  );
  expect(homeRelative("cd /Users/dev")).toBe("cd ~");
});

test("someone else's folder, or a home path inside another, stays", () => {
  setHomeFolder("/Users/dev");
  expect(homeRelative("cat /Users/alice/x")).toBe("cat /Users/alice/x");
  expect(homeRelative("/Volumes/Backup/Users/dev/x")).toBe(
    "/Volumes/Backup/Users/dev/x"
  );
  expect(homeRelative("/Users/developer/x")).toBe("/Users/developer/x");
});

test("before the home folder is known, nothing changes", () => {
  expect(homeRelative("/Users/dev/x")).toBe("/Users/dev/x");
});
