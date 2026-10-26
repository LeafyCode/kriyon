import { describe, expect, test } from "vitest";
import { validateBranchName } from "./branchName.ts";

describe("validateBranchName", () => {
  test("accepts ordinary branch names", () => {
    for (const name of [
      "fix/scroll-jump",
      "feature/file-uploads",
      "wt/audio-buffer-fix",
      "release-0.3.0",
      "user.name/topic_1",
    ]) {
      expect(validateBranchName(name)).toBeNull();
    }
  });

  test("rejects an empty name", () => {
    expect(validateBranchName("")).toContain("Enter");
    expect(validateBranchName("   ")).toContain("Enter");
  });

  test("rejects spaces and characters git forbids", () => {
    for (const name of [
      "has space",
      "tilde~1",
      "caret^",
      "colon:x",
      "star*",
      "question?",
      "bracket[1]",
      "back\\slash",
    ]) {
      expect(validateBranchName(name)).not.toBeNull();
    }
  });

  test("rejects leading dash (git reads it as a flag)", () => {
    expect(validateBranchName("-flag")).not.toBeNull();
  });

  test("rejects slash edges, doubled slashes, and empty components", () => {
    for (const name of ["/leading", "trailing/", "a//b"]) {
      expect(validateBranchName(name)).not.toBeNull();
    }
  });

  test("rejects the dot and lock rules git enforces", () => {
    for (const name of [
      "ends.",
      "feature.lock",
      "feat/x.lock/y",
      "feat/X.LOCK",
      "a..b",
      ".hidden",
      "dir/.hidden",
    ]) {
      expect(validateBranchName(name)).not.toBeNull();
    }
  });

  test("rejects @{ and a lone @", () => {
    expect(validateBranchName("ref@{0}")).not.toBeNull();
    expect(validateBranchName("@")).not.toBeNull();
  });
});
