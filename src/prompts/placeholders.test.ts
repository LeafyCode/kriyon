import { describe, expect, it } from "vitest";
import { parsePlaceholders, resolvePlaceholders } from "./placeholders.ts";

describe("parsePlaceholders", () => {
  it("finds unique names in order, excluding clipboard", () => {
    const body = "Review {focus} in {file} — again {focus}. Use {clipboard}.";
    expect(parsePlaceholders(body)).toEqual(["focus", "file"]);
  });

  it("returns empty for a body without placeholders", () => {
    expect(parsePlaceholders("plain text { not a placeholder ")).toEqual([]);
  });

  it("ignores multi-line and empty braces", () => {
    expect(parsePlaceholders("a {} b {\nx} c {ok-name_2}")).toEqual([
      "ok-name_2",
    ]);
  });
});

describe("resolvePlaceholders", () => {
  it("fills named values and clipboard", () => {
    const body = "Fix {bug} using {clipboard}";
    expect(resolvePlaceholders(body, { bug: "the race" }, "pasted")).toBe(
      "Fix the race using pasted"
    );
  });

  it("repeated names share one value; unknown names become empty", () => {
    expect(resolvePlaceholders("{a}+{a}+{b}", { a: "x" }, "")).toBe("x+x+");
  });

  it("leaves brace-less text untouched", () => {
    expect(resolvePlaceholders("no slots", {}, "clip")).toBe("no slots");
  });

  it("treats prototype member names as unknown", () => {
    expect(resolvePlaceholders("{constructor}+{toString}", {}, "")).toBe("+");
  });
});
