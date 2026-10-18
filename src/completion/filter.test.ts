import { describe, expect, it } from "vitest";
import { fuzzyFilter } from "./filter.ts";

const names = ["commit", "compact", "context", "clear", "security-review"];
const id = (s: string) => s;

describe("fuzzyFilter", () => {
  it("returns all items for an empty query", () => {
    expect(fuzzyFilter(names, "", id)).toEqual(names);
  });

  it("keeps only subsequence matches", () => {
    const out = fuzzyFilter(names, "con", id);
    expect(out).toContain("context");
    expect(out).not.toContain("clear");
  });

  it("ranks prefix matches above scattered matches", () => {
    const out = fuzzyFilter(["security-review", "compact"], "c", id);
    expect(out[0]).toBe("compact"); // prefix 'c' beats mid-word 'c'
  });

  it("matches scattered subsequences", () => {
    expect(fuzzyFilter(["security-review"], "srv", id)).toEqual([
      "security-review",
    ]);
  });

  it("returns [] when nothing matches the query", () => {
    expect(fuzzyFilter(names, "zzz", id)).toEqual([]);
  });

  it("breaks a score tie by shorter key", () => {
    // Both are prefix matches for "com" (score 0), so the shorter key wins.
    expect(fuzzyFilter(["commit", "com"], "com", id)[0]).toBe("com");
  });
});
