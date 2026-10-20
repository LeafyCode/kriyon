---
name: pr-fix
disable-model-invocation: true
description: Review a pull request, fix what it finds, and keep going until it comes back clean. Runs the checks, commits, and pushes. Use for your own pull requests — "review and fix PR 97", "fix what the review found". For someone else's pull request use pr-review instead.
---

# PR fix

Same review as `pr-review`, then it fixes what it finds and checks its own work, up to three
passes.

Use this on **your own** pull requests. On someone else's, use `pr-review` — fixing another
person's branch takes the learning away from them. **Never on a fork** (`pr.isFork` in the
context file): that is someone else's code, and running its checks runs their code on your
machine. Stop and offer `pr-review` instead.

**Only run when the user asks for it.** This skill edits, commits and pushes, so never start
it on your own initiative — not after opening a pull request, not because a review seems due.
Offering once is fine ("want me to review and fix it?"); then wait for an answer.

The rulebook is shared. Read all of it before starting:

- `../pr-review/engine.md` — how a finding becomes real
- `../pr-review/repo-rules.md` — what to check
- `../pr-review/precedents.md` — false alarms already rejected
- `../pr-review/writing.md` — how to word things

## Step 1 — Check the ground first

This skill edits files, so the working folder has to be clean and on the right branch.

```bash
CTX=$(node .claude/skills/pr-review/scripts/pr-context.mjs <number> --write)
```

From `local` in that file:

**Uncommitted changes** → stop and ask. Offer three options:

- Commit them now (ask for a message, or write one following Conventional Commits)
- Stash them and restore afterwards
- Cancel

Never edit a file on top of someone's uncommitted work.

**Wrong branch** → stop and ask. Offer to check out the pull request's branch:

```bash
gh pr checkout <number>
```

Cancel if they say no. There is nothing safe to do from the wrong branch.

**Not at the pull request's head** → `local.atPrHead` is false. The context file says why:

- `local.behind` > 0 → pull first. Fixing on a stale branch causes conflicts.
- `local.ahead` > 0 → you have local commits GitHub has not seen. The review reads GitHub, so
  it would review code that is not on your disk. Push them first (ask), then reload the
  context.

This session may run inside a Kriyon terminal. Push with
`env -u KRIYON_TTY -u CLAUDE_PID git push`, or the pre-push tests see a hosted session.

## Step 2 — Review

Follow `pr-review` steps 4 to 7: work out the scope, settle what earlier passes left open,
find, score, rank.

`HEAD_DIR` (`pr-review` step 6) is the repo root here, always: step 1 put you on the pull
request's branch at its head, and your fixes land there, so every agent in every pass reads
the code as it now stands. Never make a separate checkout for `pr-fix`.

Three changes for this skill:

- **Fix the pull request checks too.** Each `prChecks` entry is yours to fix: a title that
  is not a conventional commit (`gh pr edit <n> --title`), the wrong base
  (`gh pr edit <n> --base dev`), a description missing the AI-use checkbox (add the
  template's checklist with `gh pr edit <n> --body-file`, and answer it truthfully: tick it
  if AI wrote most of the change).
- **Do not cap the findings.** The cap in `engine.md` exists so a human isn't buried. You are
  fixing them yourself, so fix everything at 75 and above, nits included.
- **Run the architecture review** — its own `pr-finder` agent, as `pr-review` step 6 says, built on
  `mattpocock-skills:codebase-design` and scoped to this pull request. Fix what it finds like any
  other finding.
- **Keep the list.** Write down every finding you are about to fix — path, line, title,
  severity. Step 7 needs it. Without it nobody can tell afterwards what was found or fixed.

## Step 3 — Fix

Work through the findings, worst first. For each one:

- Fix the cause, not the symptom. A guard that hides the problem is not a fix.
- Keep the change inside the scope of this pull request. A finding that needs a change
  somewhere else goes on the leftover list — do not widen the pull request.
- Follow the repo rules while fixing (`engineering-workflow` skill): logic goes in
  `kriyon-core`, IPC goes through `src/ipc/bridge.ts`, design values come from
  `src/theme/tokens.ts`, paths go through `SandboxRoot`.
- **Test first when the fix changes behaviour.** Write the test, watch it fail on the current
  code, then fix. Take the fix out and watch it go red again if you are not sure.
- A boundary finding (an unvalidated command input, a widened capability) is fixed at the
  boundary, in Rust. Never by trusting the frontend to send good values.
- A public-text finding is fixed by removing or neutralising the detail (`acme`,
  `/Users/you`), not by rewording around it. If the detail already reached git history on
  this branch, say so in the report: a later commit does not remove it from history.

## Step 4 — Check your own work

```bash
pnpm fix
pnpm check > "$TMPDIR/pr-fix-check.log" 2>&1; echo "exit $?"
grep -E "Tests |test result|FAILED|error" "$TMPDIR/pr-fix-check.log" | head -40
```

Run `pnpm fix`, never `pnpm -s fix` (the silent flag skipped the fixes). If Rust changed, also
`cargo fmt --all`. Add these when the pull request touches them:

- `website/` → `cd website && pnpm check`
- `.claude/`, `scripts/` or `crates/kriyon-core/companion/` → `pnpm test:node` (also part of
  `pnpm check`)
- public text → `gitleaks dir . --config .gitleaks.toml` on the tracked files, and a `grep`
  for home paths and client names

Any of them red → fix and run again. Never move on with a red check. Never silence a rule to
make it pass.

## Step 5 — Re-review, up to three passes

Re-review what you just changed. Your own fix can introduce a new problem — that has happened
before, and it is what turns a two-round pull request into a five-round one.

**Find** in this session, against the same finder areas: you already hold the context, and a
new `pr-finder` agent would have to rebuild it. Launch finders again only if the fixes touched
more than you could read in one sitting.

**Run the architecture review again** as a `pr-finder` agent when your fixes add, remove or rename a
code file or change an export. A fix that moves a helper into a new file has changed the
shape of the code, and you are the last one to judge whether it is the right shape.

**Score** with a fresh agent, as `engine.md` step 2 requires: finder and scorer are never the
same agent, and you wrote these fixes, so you are the last one to judge them. Hand every
candidate finding to **one** `pr-scorer` agent in a single call. Found nothing to hand over →
no scorer needed.

Read past your own diff while you do it, the same as in `engine.md`: for anything you changed
that other code uses — an export, a hook's return value, a constant, an effect dependency —
open the callers and check them. A fix that makes a hook return a fresh object every render is
correct in the file you edited and wrong three files away.

- New findings at 75 or above → go back to step 3.
- Nothing new → done.
- Three passes and still finding things → stop. Something is wrong with the approach. Report
  what is left and ask.

## Step 6 — Commit and push

One commit per logical fix, not one big commit. Conventional Commits, as the hooks require:

```
fix(files): resolve the rename target through the sandbox
```

Write the message to a file and commit with `git commit -F <file>`; heredoc bodies get lost
in compound commands. End it with the attribution lines the session asks for.

Then push:

```bash
env -u KRIYON_TTY -u CLAUDE_PID git push
```

The pre-push hook runs the tests. If it fails, fix it — never use `--no-verify`.

Then wait for CI on the new head, so the verdict in step 7 is about a finished run:

```bash
gh pr checks <number> --watch --fail-fast
```

Run it in the background rather than a blocking sleep. A red run is a finding of this pass:
read the log (`gh run view <id> --log-failed`), fix it, and go back to step 4.

## Step 7 — Post the round

Reload the context first, so the sha you stamp is the one you just pushed:

```bash
CTX=$(node .claude/skills/pr-review/scripts/pr-context.mjs <number> --write)
```

Then post a round, using `.claude/skills/pr-review/scripts/post-review.mjs`.

**Everything you found goes in, whether or not you fixed it.** There are two lists and the
difference matters:

- `fixedFindings` — found and fixed in this pass. No comment is posted; the record is the
  point. Leave these out and the pull request keeps no memory of them.
- `findings` — found and **not** fixed: outside this pull request's scope, needs a decision,
  or you tried and it did not work. These get a comment like any other finding, and they hold
  the verdict open until somebody deals with them. Reporting a leftover only in chat loses it
  the moment the session ends.

```json
{
  "prNumber": 97,
  "reviewedSha": "<pr.headSha from the reloaded context>",
  "round": 2,
  "priorFindings": "<copy from the reloaded context>",
  "summary": "## Review and fix — pass 2\n\nFixed 4 issues in 2 passes. All checks green.\n\n- ...",
  "fixedFindings": [
    { "path": "src-tauri/src/file_cmd.rs", "line": 42,
      "title": "Resolve this path through the sandbox", "severity": "important" }
  ],
  "findings": [],
  "resolveThreadIds": ["PRRT_kw..."],
  "droppedFindings": [{ "fp": "<from priorFindings>", "reason": "no longer applies" }],
  "contextFile": "<$CTX>",
  "process": {
    "kind": "fix-recheck",
    "finders": [
      { "agent": "<step 2 finder description>", "areas": ["correctness", "tests"], "candidates": 5 },
      { "agent": "main session", "areas": ["step 5 re-check of the fixes"], "candidates": 0 }
    ],
    "architecture": { "ran": true, "agent": "<its description>", "candidates": 2 },
    "scorer": { "agent": "<step 2 scorer description>", "scored": 7, "kept": 4 }
  }
}
```

`process` is the same checked record as in `pr-review` step 8. `"kind": "fix-recheck"` is
what lets step 5's in-session finding count — the step 2 finder agents still have to be in the
list. `kept` covers every finding that scored 75 or above, fixed or not.

Set `"inlineCap": null` so nothing you could not fix gets held back — you are not protecting
yourself from your own list.

**Only stamp a commit you actually reviewed.** You may stamp what you just pushed *because*
step 5 re-reviewed it. If you skipped step 5, stamp the sha you started from instead — a
bookmark on unreviewed commits hides them from every later run, including someone else's.

If the script reports that commits landed while you were working, somebody else pushed. Those
were not reviewed; it says so in the summary and leaves them for the next run. Do not stamp
over them.

The summary follows `../pr-review/writing.md`: one line per item, under 300 words. If a point
needs a paragraph, it was a finding and should have been fixed, not written up.

## Step 8 — Report back

```
PR 97 · fixed 4 in 2 passes · checks green · CI green · pushed · not ready to merge (1 open)
- src-tauri/src/file_cmd.rs — rename target now goes through the sandbox
- crates/kriyon-ptyd/src/main.rs — retry now stops after 5 tries

Left alone: 1
- the same problem in entry_cmd.rs, outside this PR's scope
```

The verdict comes from the script, never from you. Fixing everything you found does not make
the pull request ready — a comment from an earlier pass that nobody resolved keeps it open,
and so does anything you left alone. Say "ready to merge" only when the script says so.

Say plainly what you did not fix and why. Never report done with something quietly skipped.
