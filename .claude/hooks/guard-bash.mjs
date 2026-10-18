#!/usr/bin/env node
/**
 * The one PreToolUse(Bash) hook for the AI assistant. The rules are in
 * guard-bash-rules.mjs; this file only reads the call and reports the decision.
 *
 * Fails CLOSED. PreToolUse treats any exit but 2 as "carry on", so a bug here
 * would silently switch every guard off. Instead, anything unexpected (a rules
 * module that won't load, input that isn't JSON, a throw) exits 2 and blocks.
 * The rules load with a dynamic import inside the `try` for exactly this reason:
 * a static import that failed would crash before any handler ran. The hook entry
 * in .claude/settings.json also sets `onFailure: "block"` for crashes this file
 * can't catch.
 *
 * Exit 2 sends stderr back to the assistant. A rewrite prints JSON on stdout.
 * Written in Node (always present in this repo) so it needs no `jq`.
 */
import process from "node:process";

const EXIT_BLOCK = 2;
const EXIT_ALLOW = 0;

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

function block(message) {
  process.stderr.write(`${message}\n`);
  process.exit(EXIT_BLOCK);
}

async function main() {
  let input;
  let decision;
  try {
    const { decide } = await import("./guard-bash-rules.mjs");
    input = JSON.parse(await readStdin());
    const command = input?.tool_input?.command;
    decision = decide(typeof command === "string" ? command : "");
  } catch (error) {
    block(
      `guard-bash internal error, blocking to stay safe: ${error?.message ?? error}`
    );
    return;
  }
  if (decision.kind === "block") {
    block(decision.reason);
    return;
  }
  if (decision.kind === "rewrite") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason:
            "Full test run piped through filter-test-output.mjs, so only failures and the summary reach the model.",
          // updatedInput replaces the whole input, so keep the other fields.
          updatedInput: { ...input.tool_input, command: decision.command },
        },
      })
    );
  }
  process.exit(EXIT_ALLOW);
}

await main();
