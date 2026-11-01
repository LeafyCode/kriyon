import { describe, expect, it } from "vitest";
import { canonicalDir } from "./paths.ts";
import { relativizeTouchedPath } from "./sessions.ts";

describe("canonicalDir", () => {
  it("sees through the macOS /private firmlinks", () => {
    expect(canonicalDir("/private/tmp/x/")).toBe("/tmp/x");
  });

  it("gives a Windows path one spelling", () => {
    expect(canonicalDir("c:\\dev\\my app\\")).toBe("C:/dev/my app");
    expect(canonicalDir("C:/dev/my app")).toBe("C:/dev/my app");
  });

  it("gives a network share one spelling too", () => {
    expect(canonicalDir("\\\\server\\share\\app")).toBe("//server/share/app");
    expect(canonicalDir("//server/share/app/")).toBe("//server/share/app");
  });

  it("leaves a backslash in a macOS name alone", () => {
    expect(canonicalDir("/Users/me/odd\\name")).toBe("/Users/me/odd\\name");
  });
});

describe("relativizeTouchedPath on Windows", () => {
  it("matches Claude's backslash path to git's forward-slash root", () => {
    expect(
      relativizeTouchedPath("C:\\dev\\my app\\src\\index.js", "C:/dev/my app")
    ).toBe("src/index.js");
  });
});
