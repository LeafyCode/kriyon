import { describe, expect, it } from "vitest";
import { matchRange } from "./fileSearch.ts";

describe("matchRange", () => {
  it("finds the query inside the name, ignoring case", () => {
    expect(matchRange("IconButton.tsx", "button")).toEqual([4, 10]);
  });

  it("returns nothing when only the folder matched", () => {
    expect(matchRange("readme.md", "button")).toBeUndefined();
  });
});
