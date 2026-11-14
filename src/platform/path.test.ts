import { describe, expect, it } from "vitest";
import { pathBasename, pathDirname, pathSegments } from "./path.ts";

describe("path helpers", () => {
  it("read POSIX paths as before", () => {
    expect(pathBasename("/Users/me/acme")).toBe("acme");
    expect(pathBasename("/Users/me/acme/")).toBe("acme");
    expect(pathDirname("/Users/me/acme/a.ts")).toBe("/Users/me/acme");
    expect(pathSegments("/Users/me/acme")).toEqual(["Users", "me", "acme"]);
  });

  it("read Windows paths by either separator", () => {
    expect(pathBasename("C:\\dev\\playground")).toBe("playground");
    expect(pathBasename("C:\\dev\\playground\\")).toBe("playground");
    expect(pathBasename("C:/dev/playground/src\\a.ts")).toBe("a.ts");
    expect(pathDirname("C:\\dev\\playground\\a.ts")).toBe(
      "C:\\dev\\playground"
    );
    expect(pathSegments("C:\\dev\\playground")).toEqual([
      "C:",
      "dev",
      "playground",
    ]);
    expect(pathBasename("\\\\server\\share\\repo")).toBe("repo");
  });

  it("keep a backslash inside a POSIX file name", () => {
    expect(pathBasename("/tmp/odd\\name")).toBe("odd\\name");
  });

  it("leave a bare name alone", () => {
    expect(pathBasename("README.md")).toBe("README.md");
    expect(pathDirname("README.md")).toBe("");
  });
});
