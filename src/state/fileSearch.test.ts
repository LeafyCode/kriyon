import { describe, expect, it } from "vitest";
import type { FileEntry } from "../ipc/bridge.ts";
import { matchRange, rankFileMatches } from "./fileSearch.ts";

function f(path: string, isDir = false): FileEntry {
  return { isDir, path };
}

describe("rankFileMatches", () => {
  it("puts an exact name first, then names that start with the query, then names that contain it, then path-only hits", () => {
    const ranked = rankFileMatches(
      [
        f("docs/button/readme.md"),
        f("src/ui/IconButton.tsx"),
        f("src/ui/Button.tsx"),
        f("src/ui/button"),
        f("src/ui/ButtonGroup.tsx"),
      ],
      "button"
    );
    expect(ranked.map((e) => e.path)).toEqual([
      "src/ui/button",
      "src/ui/Button.tsx",
      "src/ui/ButtonGroup.tsx",
      "src/ui/IconButton.tsx",
      "docs/button/readme.md",
    ]);
  });

  it("breaks ties with the shorter path, so the shallower file wins", () => {
    const ranked = rankFileMatches(
      [f("a/b/c/index.ts"), f("index.ts"), f("a/index.ts")],
      "index"
    );
    expect(ranked.map((e) => e.path)).toEqual([
      "index.ts",
      "a/index.ts",
      "a/b/c/index.ts",
    ]);
  });

  it("ignores case and surrounding spaces", () => {
    expect(rankFileMatches([f("src/App.tsx")], "  app ")).toHaveLength(1);
  });
});

describe("matchRange", () => {
  it("finds the query inside the name, ignoring case", () => {
    expect(matchRange("IconButton.tsx", "button")).toEqual([4, 10]);
  });

  it("returns nothing when only the folder matched", () => {
    expect(matchRange("readme.md", "button")).toBeUndefined();
  });
});
