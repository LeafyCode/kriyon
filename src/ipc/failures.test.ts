import { describe, expect, it } from "vitest";
import { commandFailure, failureMessage } from "./failures.ts";

describe("commandFailure", () => {
  it("classifies each Rust leader string by its kind", () => {
    // Copied verbatim: the leader format `tagged_failure` (src-tauri's
    // `crates/kriyon-core/src/failure.rs`) produces, one per slug it's
    // adopted at (git_cmd.rs's baseline-pruned/over-budget, file_cmd.rs's
    // save-conflict/file-missing).
    expect(
      commandFailure(
        new Error(
          "kind:baseline-pruned: baseline object missing: fatal: bad object deadbeef"
        )
      )
    ).toBe("baselinePruned");
    expect(
      commandFailure(
        new Error(
          "kind:over-budget: working tree too large: over 10000 untracked files"
        )
      )
    ).toBe("overBudget");
    expect(
      commandFailure(
        new Error(
          "kind:save-conflict: file changed on disk since it was opened"
        )
      )
    ).toBe("saveConflict");
    expect(
      commandFailure(new Error("kind:file-missing: path does not exist"))
    ).toBe("fileMissing");
  });

  it("classifies a plain string carrying the same leader identically to an Error", () => {
    // A rejected `invoke()` always throws an `Error`, but the classifier
    // must not assume that — a bare string is what a test (or a non-Tauri
    // caller) is most likely to hand it.
    expect(
      commandFailure(
        "kind:save-conflict: file changed on disk since it was opened"
      )
    ).toBe("saveConflict");
  });

  it("classifies an unleadered string as unknown", () => {
    expect(commandFailure(new Error("git exited with status 128"))).toBe(
      "unknown"
    );
    expect(commandFailure("plain string failure")).toBe("unknown");
  });

  it("classifies non-Error, non-string values as unknown rather than throwing", () => {
    expect(commandFailure(undefined)).toBe("unknown");
    expect(commandFailure(null)).toBe("unknown");
    expect(commandFailure({ oops: true })).toBe("unknown");
  });

  it("does not recognize an unknown slug", () => {
    // Forward-compat: a future Rust slug this TS side hasn't learned yet
    // must degrade to unknown, not crash the classifier.
    expect(commandFailure(new Error("kind:some-future-kind: whatever"))).toBe(
      "unknown"
    );
  });

  it("does not resolve a slug that shadows an Object.prototype property", () => {
    // Regression guard: a naive `Record<string, FailureKind>` object-literal
    // lookup (`table[slug] ?? "unknown"`) walks the prototype chain, so
    // `table["constructor"]` resolves to the `Object` constructor function —
    // not `undefined` — and `?? "unknown"` never catches it, since a
    // function is not nullish. That would return a non-`FailureKind` value
    // for this exact input. `commandFailure` must classify it as `"unknown"`
    // like any other slug it doesn't recognize.
    expect(commandFailure(new Error("kind:constructor: x"))).toBe("unknown");
  });
});

describe("failureMessage", () => {
  it("strips exactly one leader", () => {
    expect(
      failureMessage(
        new Error(
          "kind:save-conflict: file changed on disk since it was opened"
        )
      )
    ).toBe("file changed on disk since it was opened");
    expect(
      failureMessage(new Error("kind:file-missing: path does not exist"))
    ).toBe("path does not exist");
  });

  it("passes an unleadered message through unchanged", () => {
    expect(failureMessage(new Error("git exited with status 128"))).toBe(
      "git exited with status 128"
    );
    expect(failureMessage("plain string failure")).toBe("plain string failure");
  });

  it("only strips a leader at the very start of the message", () => {
    // A message that merely mentions "kind:" further in must keep that text —
    // the leader is anchored, not a general substring strip.
    expect(
      failureMessage(
        new Error("path does not exist (kind:save-conflict: unrelated aside)")
      )
    ).toBe("path does not exist (kind:save-conflict: unrelated aside)");
  });

  it("degrades non-Error, non-string values the same way commandFailure does", () => {
    expect(failureMessage(undefined)).toBe("undefined");
  });
});

describe("cross-boundary round trip", () => {
  // Task 2 brief: "Cross-boundary round-trip test per kind (TS test
  // contains the verbatim Rust output)." Each string below is exactly what
  // `tagged_failure` produces at that Rust error site (see git_cmd.rs's
  // `session_diff`/`snapshot_tree`, sandbox.rs's `SandboxRoot::resolve`, and
  // file_cmd.rs's `write_file_sync`), copied verbatim rather than reconstructed, so a
  // change to either side's wording breaks this test instead of silently
  // drifting.
  it("baseline-pruned: git_cmd.rs's session_diff Baseline-anchor tag", () => {
    const raw =
      "kind:baseline-pruned: baseline object missing: fatal: bad object ffffffffffffffffffffffffffffffffffffffff";
    expect(commandFailure(new Error(raw))).toBe("baselinePruned");
    expect(failureMessage(new Error(raw))).toBe(
      "baseline object missing: fatal: bad object ffffffffffffffffffffffffffffffffffffffff"
    );
  });

  it("over-budget: git_cmd.rs's snapshot_tree file-ceiling tag", () => {
    // `snapshot_tree` tags `WORKING_TREE_TOO_LARGE_PREFIX` + the detail, not
    // the detail alone — the human-readable half retains that prefix (see
    // the constant's doc comment in git_cmd.rs), so the leadered message
    // must too.
    const raw =
      "kind:over-budget: working tree too large: over 10000 untracked files (including opt/, vendor/)";
    expect(commandFailure(new Error(raw))).toBe("overBudget");
    expect(failureMessage(new Error(raw))).toBe(
      "working tree too large: over 10000 untracked files (including opt/, vendor/)"
    );
  });

  it("save-conflict: file_cmd.rs's write_file_sync conflict-guard tag", () => {
    const raw = "kind:save-conflict: file changed on disk since it was opened";
    expect(commandFailure(new Error(raw))).toBe("saveConflict");
    expect(failureMessage(new Error(raw))).toBe(
      "file changed on disk since it was opened"
    );
  });

  it("file-missing: sandbox.rs's SandboxRoot::resolve canonicalize-failure tag", () => {
    const raw = "kind:file-missing: path does not exist";
    expect(commandFailure(new Error(raw))).toBe("fileMissing");
    expect(failureMessage(new Error(raw))).toBe("path does not exist");
  });
});
