import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { filterOutput } from "./filter-test-output.mjs";

const FILTER = fileURLToPath(
  new URL("./filter-test-output.mjs", import.meta.url)
);

const lines = (n, make) => Array.from({ length: n }, (_, i) => make(i));

test("keeps what it saw when the run is killed", async () => {
  // A test run past the Bash tool's timeout is killed mid-way. The failures
  // and the last lines so far must still reach the assistant.
  const child = spawn(process.execPath, [FILTER]);
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const input = [
    ...lines(300, (i) => `test mod_${i}::works ... ok`),
    "test diff::parses_rename ... FAILED",
    ...lines(50, (i) => `test late_${i}::works ... ok`),
    "",
  ].join("\n");
  child.stdin.write(input);
  // Give the filter a moment to read, then kill it with stdin still open.
  await new Promise((resolve) => setTimeout(resolve, 300));
  child.kill("SIGTERM");
  await once(child, "close");
  assert.ok(stdout.includes("parses_rename ... FAILED"));
  assert.ok(stdout.includes("late_49::works"));
});

test("passes short output through untouched", () => {
  const text = "running 3 tests\ntest result: ok. 3 passed\n";
  assert.equal(filterOutput(text), text);
});

test("keeps failures and the summary of a long run", () => {
  const text = [
    ...lines(300, (i) => ` ✓ src/a${i}.test.ts (2 tests)`),
    " FAIL  src/broken.test.ts > adds",
    "AssertionError: expected 1 to be 2",
    ...lines(300, (i) => ` ✓ src/b${i}.test.ts (2 tests)`),
    " Test Files  1 failed | 600 passed (601)",
  ].join("\n");
  const out = filterOutput(text);
  assert.ok(out.includes("FAIL  src/broken.test.ts"));
  assert.ok(out.includes("AssertionError"));
  assert.ok(out.includes("1 failed | 600 passed"));
  assert.ok(out.includes("lines hidden"));
  assert.ok(out.split("\n").length < 100);
});

test("keeps cargo and clippy failures", () => {
  const text = [
    ...lines(300, (i) => `test mod_${i}::works ... ok`),
    "test diff::parses_rename ... FAILED",
    "thread 'diff::parses_rename' panicked at src/diff.rs:10:5:",
    "error[E0308]: mismatched types",
    ...lines(300, (i) => `test other_${i}::works ... ok`),
    "test result: FAILED. 600 passed; 1 failed",
  ].join("\n");
  const out = filterOutput(text);
  assert.ok(out.includes("parses_rename ... FAILED"));
  assert.ok(out.includes("panicked at"));
  assert.ok(out.includes("error[E0308]"));
  assert.ok(out.includes("test result: FAILED"));
});

test("keeps the summary when the last line is a failure", () => {
  // Regression: a late `test result: FAILED` threw away the held tail, and
  // with it the list of failing tests.
  const text = [
    ...lines(300, (i) => `test mod_${i}::works ... ok`),
    "failures:",
    "    tests::bad",
    "    tests::bad2",
    "test result: FAILED. 300 passed; 2 failed",
    "error: test failed, to rerun pass `--lib`",
  ].join("\n");
  const out = filterOutput(text);
  assert.ok(out.includes("tests::bad2"));
  assert.ok(out.includes("test result: FAILED"));
});

test("does not keep passing tests whose names say error", () => {
  const text = [
    ...lines(300, (i) => ` ✓ shows the error message ${i}`),
    " Tests  300 passed (300)",
  ].join("\n");
  const out = filterOutput(text);
  assert.ok(out.split("\n").length < 60);
});

test("clips a single huge line", () => {
  const text = [...lines(200, () => "ok"), `FAIL ${"x".repeat(10_000)}`].join(
    "\n"
  );
  assert.ok(filterOutput(text).includes("chars clipped"));
});
