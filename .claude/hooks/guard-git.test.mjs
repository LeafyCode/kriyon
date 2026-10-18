import assert from "node:assert/strict";
import { test } from "node:test";
import { denialReason } from "./guard-git.mjs";

const FORCE_MESSAGE = /force/;
const NO_VERIFY_MESSAGE = /no-verify/;

test("allows a plain push", () => {
  assert.equal(denialReason("git push"), null);
  assert.equal(denialReason("git push origin main"), null);
});

test("allows --force-with-lease", () => {
  assert.equal(denialReason("git push --force-with-lease"), null);
  assert.equal(denialReason("git push --force-with-lease origin feat/x"), null);
});

test("blocks git push --force", () => {
  assert.match(denialReason("git push --force") ?? "", FORCE_MESSAGE);
  assert.match(
    denialReason("git push origin main --force") ?? "",
    FORCE_MESSAGE
  );
});

test("blocks git push -f", () => {
  assert.match(denialReason("git push -f") ?? "", FORCE_MESSAGE);
});

test("blocks --no-verify on git commands", () => {
  assert.match(
    denialReason("git commit --no-verify -m x") ?? "",
    NO_VERIFY_MESSAGE
  );
  assert.match(denialReason("git push --no-verify") ?? "", NO_VERIFY_MESSAGE);
});

test("does not read -f from another command as a force push", () => {
  // Regression: `rm -f` in a different segment must not look like `git push --force`.
  assert.equal(denialReason("git push 2>&1 | tail -8 && rm -f /tmp/x"), null);
  assert.equal(denialReason("git commit -m x && rm -f file"), null);
  assert.equal(denialReason("grep -f patterns.txt && git push"), null);
});

test("keeps redirections like 2>&1 intact", () => {
  assert.equal(denialReason("git push 2>&1"), null);
});

test("ignores non-git commands", () => {
  assert.equal(denialReason("rm -f /tmp/x"), null);
  assert.equal(denialReason("npm run build -- --force"), null);
});

const RESET_MESSAGE = /reset --hard/;
const BRANCH_MESSAGE = /branch/;

test("blocks git reset --hard", () => {
  assert.match(denialReason("git reset --hard") ?? "", RESET_MESSAGE);
  assert.match(
    denialReason("git reset --hard origin/dev") ?? "",
    RESET_MESSAGE
  );
  assert.match(
    denialReason("git -C ../other reset --hard HEAD~1") ?? "",
    RESET_MESSAGE
  );
});

test("allows the gentler resets", () => {
  assert.equal(denialReason("git reset --soft HEAD~1"), null);
  assert.equal(denialReason("git reset HEAD file.ts"), null);
});

test("blocks deleting a local branch", () => {
  assert.match(denialReason("git branch -d feat/x") ?? "", BRANCH_MESSAGE);
  assert.match(denialReason("git branch -D feat/x") ?? "", BRANCH_MESSAGE);
  assert.match(
    denialReason("git branch --delete feat/x") ?? "",
    BRANCH_MESSAGE
  );
});

test("blocks deleting a remote branch", () => {
  assert.match(
    denialReason("git push origin --delete feat/x") ?? "",
    BRANCH_MESSAGE
  );
  assert.match(denialReason("git push origin -d feat/x") ?? "", BRANCH_MESSAGE);
  assert.match(denialReason("git push origin :feat/x") ?? "", BRANCH_MESSAGE);
});

test("allows listing, creating and switching branches", () => {
  assert.equal(denialReason("git branch"), null);
  assert.equal(denialReason("git branch --show-current"), null);
  assert.equal(denialReason("git branch feat/new"), null);
  assert.equal(denialReason("git switch -c feat/new origin/dev"), null);
  assert.equal(denialReason("git push -u origin feat/new"), null);
});

test("ignores blocked words inside a heredoc body", () => {
  // Writing a doc that mentions a rule is not running the command.
  const command = [
    "cat > notes.md <<'EOF'",
    "Never run git reset --hard or git push --force.",
    "EOF",
    "git add notes.md",
  ].join("\n");
  assert.equal(denialReason(command), null);
});

test("judges reset and branch deletion when a name contains push", () => {
  // Regression: the word `push` in a ref name skipped every other rule.
  assert.match(
    denialReason("git reset --hard origin/push-fix") ?? "",
    RESET_MESSAGE
  );
  assert.match(
    denialReason("git branch -D feat/push-notifications") ?? "",
    BRANCH_MESSAGE
  );
});

test("allows blocked words inside a quoted argument", () => {
  assert.equal(
    denialReason('git commit -m "docs: explain reset --hard"'),
    null
  );
  assert.equal(denialReason("git commit -m 'note: push -f is blocked'"), null);
  assert.equal(denialReason('git log --grep "branch -D"'), null);
});

test("still blocks a quoted flag that git reads as a flag", () => {
  assert.match(denialReason('git reset "--hard"') ?? "", RESET_MESSAGE);
});

test("joins backslash line continuations", () => {
  assert.match(denialReason("git reset \\\n  --hard") ?? "", RESET_MESSAGE);
  assert.match(denialReason("git push \\\n  --force") ?? "", FORCE_MESSAGE);
});

test("does not read a here-string as a heredoc", () => {
  // Regression: `<<<` swallowed every later line, rules included.
  assert.match(
    denialReason("grep x <<< foo\ngit reset --hard") ?? "",
    RESET_MESSAGE
  );
  assert.match(
    denialReason('git commit -m "see <<EOF"\ngit reset --hard') ?? "",
    RESET_MESSAGE
  );
});

test("skips a comment, apostrophes and all", () => {
  // Regression: the apostrophe in "don't" opened a quote to the end of the text.
  assert.match(
    denialReason("# don't do this\ngit reset --hard") ?? "",
    RESET_MESSAGE
  );
  assert.equal(denialReason("ls # then git reset --hard"), null);
});

test("judges git run inside another command", () => {
  for (const command of [
    "echo $(git reset --hard)",
    'echo "$(git reset --hard)"',
    "echo `git reset --hard`",
    "(git reset --hard)",
    "(cd sub && git reset --hard)",
    'bash -c "git reset --hard"',
    "sh -c 'cd .. && git reset --hard'",
    'eval "git reset --hard"',
  ]) {
    assert.match(denialReason(command) ?? "", RESET_MESSAGE, command);
  }
});

test("reads ANSI-C quoting and git's short no-verify", () => {
  assert.match(denialReason("git reset $'--hard'") ?? "", RESET_MESSAGE);
  assert.match(denialReason("git commit -n -m x") ?? "", NO_VERIFY_MESSAGE);
});

test("still judges the commands after a heredoc", () => {
  const command = ["cat > f <<EOF", "text", "EOF", "git reset --hard"].join(
    "\n"
  );
  assert.match(denialReason(command) ?? "", RESET_MESSAGE);
});
