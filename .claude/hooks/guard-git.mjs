/**
 * The git rules for the AI assistant's Bash calls, run by guard-bash.mjs.
 *
 * Blocks what an assistant should never do on its own:
 *   1. Bypass git hooks with `--no-verify`.
 *   2. Rewrite shared history with a plain `git push --force` (`--force-with-lease`
 *      is allowed — it refuses to clobber work it hasn't seen).
 *   3. Throw away uncommitted work with `git reset --hard`.
 *   4. Delete a branch, local or remote. Unmerged commits on it are gone.
 *
 * Each rule reads the words of one git command, as shell-words.mjs splits them:
 * the subcommand and its arguments, quotes removed. So `rm -f` in another
 * command is never a force push, a branch called `push-fix` is not a push, and
 * `--hard` inside a commit message is not a flag.
 *
 * Team-wide git policy lives in lefthook.yml; this guards the assistant itself,
 * because a git hook cannot guard against its own bypass.
 */
import { commands, programName } from "./shell-words.mjs";

// git's own options that take the next word as their value: `git -C dir reset`.
const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
]);

const NO_VERIFY_MESSAGE =
  "Blocked: --no-verify bypasses the git hooks (lint, commit format, tests). Fix what the hook reports instead of skipping it.";
const FORCE_PUSH_MESSAGE =
  "Blocked: `git push --force` can erase teammates' commits. Use `--force-with-lease`, or push a new commit.";
const HARD_RESET_MESSAGE =
  "Blocked: `git reset --hard` destroys uncommitted work. Use `git stash`, `git reset --soft`, or a new branch.";
const BRANCH_DELETE_MESSAGE =
  "Blocked: deleting a branch can lose unmerged commits. Leave branch deletion to the person.";

/** `{ subcommand, args }` of the git call in `words`, or null if it has none. */
function gitCall(words) {
  const start = words.findIndex((word) => programName(word) === "git");
  if (start === -1) {
    return null;
  }
  let i = start + 1;
  while (i < words.length && words[i].startsWith("-")) {
    i += GLOBAL_OPTIONS_WITH_VALUE.has(words[i]) ? 2 : 1;
  }
  return { subcommand: words[i] ?? "", args: words.slice(i + 1) };
}

function pushReason(args) {
  const forced = args.some(
    (arg) => arg === "--force" || arg === "-f" || arg.startsWith("--force=")
  );
  const leased = args.some((arg) => arg.startsWith("--force-with-lease"));
  if (forced && !leased) {
    return FORCE_PUSH_MESSAGE;
  }
  const deletes = args.some(
    (arg) =>
      arg === "--delete" ||
      arg === "-d" ||
      (arg.startsWith(":") && arg.length > 1)
  );
  return deletes ? BRANCH_DELETE_MESSAGE : null;
}

function callReason({ subcommand, args }) {
  // `git commit -n` is the short form of `--no-verify`.
  if (
    args.includes("--no-verify") ||
    (subcommand === "commit" && args.includes("-n"))
  ) {
    return NO_VERIFY_MESSAGE;
  }
  if (subcommand === "push") {
    return pushReason(args);
  }
  if (subcommand === "reset" && args.includes("--hard")) {
    return HARD_RESET_MESSAGE;
  }
  if (
    subcommand === "branch" &&
    args.some((arg) => arg === "-d" || arg === "-D" || arg === "--delete")
  ) {
    return BRANCH_DELETE_MESSAGE;
  }
  return null;
}

export function denialReason(command) {
  for (const words of commands(command)) {
    const call = gitCall(words);
    const reason = call && callReason(call);
    if (reason) {
      return reason;
    }
  }
  return null;
}
