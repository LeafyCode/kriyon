/**
 * What guard-bash.mjs decides for one Bash call, in a fixed order:
 *
 *   - block:   the git rules (guard-git.mjs), and starting the app with
 *              `tauri dev`. The reason goes back to the assistant.
 *   - rewrite: a bare full test run (`pnpm check`, `pnpm test`, `cargo test`…)
 *              is piped through filter-test-output.mjs, so hundreds of passing
 *              lines never reach the model. A rewrite auto-approves the
 *              command, so only exact, known shapes qualify: no shell
 *              metacharacters, no env prefix, no extra arguments.
 *   - allow:   everything else, untouched.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { denialReason as gitDenialReason } from "./guard-git.mjs";
import { commands, programName } from "./shell-words.mjs";

const FILTER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "filter-test-output.mjs"
);

const TAURI_DEV_MESSAGE =
  "Blocked: `tauri dev` opens the app on the person's screen and fights the running Kriyon for its sockets. Ask them to start it, and verify with `pnpm check` meanwhile.";

// The exact full-suite runs whose passing output is noise. A new one must be
// added here to be filtered; until then it simply runs unfiltered.
const FULL_TEST_RUNS = new Set([
  "pnpm test",
  "pnpm run test",
  "pnpm check",
  "pnpm run check",
  "pnpm rust:test",
  "cargo test",
]);

/** Whether `words` runs the tauri CLI's `dev`, e.g. `pnpm tauri -- dev`. */
function startsTauriDev(words) {
  const start = words.findIndex((word) => programName(word) === "tauri");
  if (start === -1) {
    return false;
  }
  const next = words.slice(start + 1).find((word) => word !== "--");
  return next === "dev";
}

function tauriDevReason(command) {
  return commands(command).some(startsTauriDev) ? TAURI_DEV_MESSAGE : null;
}

export function decide(command) {
  const reason = gitDenialReason(command) ?? tauriDevReason(command);
  if (reason) {
    return { kind: "block", reason };
  }
  if (typeof command === "string" && FULL_TEST_RUNS.has(command.trim())) {
    return {
      kind: "rewrite",
      command: `set -o pipefail; ${command.trim()} 2>&1 | node "${FILTER_PATH}"`,
    };
  }
  return { kind: "allow" };
}
