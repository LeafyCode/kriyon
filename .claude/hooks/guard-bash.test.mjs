import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decide } from "./guard-bash-rules.mjs";

const HOOK = fileURLToPath(new URL("./guard-bash.mjs", import.meta.url));
const TAURI_MESSAGE = /tauri dev/;
const FAIL_CLOSED_MESSAGE = /blocking to stay safe/;

function runHook(stdin, hook = HOOK) {
  return spawnSync(process.execPath, [hook], {
    input: stdin,
    encoding: "utf8",
  });
}

test("blocks starting the app with tauri dev", () => {
  for (const command of [
    "pnpm tauri dev",
    "pnpm run tauri dev",
    "npx tauri dev",
    "cargo tauri dev",
    "cd src-tauri && tauri dev",
    "pnpm tauri -- dev",
    "./node_modules/.bin/tauri dev --verbose",
    'bash -c "pnpm tauri dev"',
    "(cd src-tauri && cargo tauri dev)",
  ]) {
    const decision = decide(command);
    assert.equal(decision.kind, "block", command);
    assert.match(decision.reason, TAURI_MESSAGE);
  }
});

test("allows other tauri commands", () => {
  assert.equal(decide("pnpm tauri build").kind, "allow");
  assert.equal(decide("pnpm tauri icon app-icon.svg").kind, "allow");
  assert.equal(decide("pnpm dev").kind, "allow");
});

test("allows tauri dev as quoted text", () => {
  assert.equal(decide('grep -rn "tauri dev" docs').kind, "allow");
  assert.equal(
    decide("git commit -m 'docs: never run tauri dev'").kind,
    "allow"
  );
});

test("passes git blocks through", () => {
  assert.equal(decide("git reset --hard").kind, "block");
});

test("pipes a full test run through the output filter", () => {
  for (const command of [
    "pnpm test",
    "pnpm check",
    "pnpm rust:test",
    "cargo test",
  ]) {
    const decision = decide(command);
    assert.equal(decision.kind, "rewrite", command);
    assert.ok(decision.command.startsWith("set -o pipefail; "));
    assert.ok(decision.command.includes(`${command} 2>&1 | node `));
    assert.ok(decision.command.includes("filter-test-output.mjs"));
  }
});

test("leaves anything more than a bare test run alone", () => {
  // A rewrite auto-approves the command, so only exact shapes qualify.
  for (const command of [
    "pnpm test src/foo.test.ts",
    "pnpm check > log.txt",
    "pnpm test && rm -rf dist",
    "NODE_OPTIONS=--require=x pnpm test",
    "cargo test -p kriyon-core",
    "pnpm test; echo $HOME",
  ]) {
    assert.equal(decide(command).kind, "allow", command);
  }
});

test("hook exits 2 with the reason on a blocked command", () => {
  const result = runHook(
    JSON.stringify({ tool_input: { command: "pnpm tauri dev" } })
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, TAURI_MESSAGE);
});

test("hook prints the rewritten command for a test run", () => {
  const result = runHook(
    JSON.stringify({ tool_input: { command: "pnpm check", timeout: 600_000 } })
  );
  assert.equal(result.status, 0);
  const out = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, "PreToolUse");
  assert.equal(out.permissionDecision, "allow");
  // updatedInput replaces the whole input, so other fields are kept.
  assert.equal(out.updatedInput.timeout, 600_000);
  assert.ok(out.updatedInput.command.includes("filter-test-output.mjs"));
});

test("hook allows an ordinary command silently", () => {
  const result = runHook(JSON.stringify({ tool_input: { command: "ls" } }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("hook blocks when its rules fail to load", () => {
  // Fail closed: a broken guard must not wave commands through.
  // The entry point alone, without the rules module beside it.
  const dir = mkdtempSync(path.join(tmpdir(), "guard-bash-"));
  try {
    const lonely = path.join(dir, "guard-bash.mjs");
    copyFileSync(HOOK, lonely);
    const result = runHook(
      JSON.stringify({ tool_input: { command: "ls" } }),
      lonely
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, FAIL_CLOSED_MESSAGE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook blocks on input it cannot read", () => {
  const result = runHook("not json");
  assert.equal(result.status, 2);
});
