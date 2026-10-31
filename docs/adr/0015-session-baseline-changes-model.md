# ADR 0015 — Per-session git baseline, not touched-file intersection, anchors the Code Changes View

**Date:** 2026-07-22
**Status:** Accepted. Its default-off "My edits only" is superseded by [ADR 0050](0050-ai-changes-keeps-to-claudes-files.md).

## Context

The Code Changes View's Inspector/sidebar list was anchored on
`diff_working_tree` (`git diff merge-base(base, HEAD)` plus untracked files) —
the whole working tree's diff, not a diff scoped to one session. Two
non-worktree sessions open on the same branch/checkout at once were observed
seeing **identical** file lists: neither diff carries any notion of "since
this session started," so each showed every uncommitted change in the
checkout, including the other session's.

The only per-session signal that existed, `touchedFiles` (from replaying each
session's tool-call transcript), is **cumulative**, holds **absolute** paths,
and is derived from tracked tool edits only — it has no record of edits made
via `Bash` (`sed`, a formatter, a generated file), and it cannot self-correct:
a file a session edited and then reverted stays marked touched forever, and a
file another actor reverted on the session's behalf never clears.

## Decision

Anchor the view on a **per-session git baseline**, diffed **tree-vs-tree**,
not on `touchedFiles`:

- `capture_baseline(cwd)` snapshots the working tree (tracked + untracked,
  honoring `.gitignore`) into a dangling tree object via `git add -A` +
  `git write-tree` against a throwaway `GIT_INDEX_FILE` — no commit, no ref,
  no HEAD move, no hooks fired (`snapshot_tree`, `git_cmd.rs`). Captured once,
  shortly after `createSession`, and persisted on the session row
  (`baseline_oid`). **Carve-out as shipped:** `createSession` skips
  `capture_baseline` entirely when `cwd === defaultCwd` (`src/state/
  actions.ts`), so a Home-project session never gets a baseline. `git add -A`
  over a `$HOME` that is itself a git repo (a dotfiles checkout — common)
  would walk and content-hash every non-ignored file under the user's home
  directory and permanently grow `~/.git/objects`, once per Home session.
  Those sessions take the `baseline_oid = null` fallback below.
- `diff_session_changes(cwd, baselineOid)` snapshots the **current** working
  tree the same way, then `git diff -M <baselineOid> <currentOid>`. Because
  both sides of the diff are full tree snapshots, tracked and untracked files
  are covered uniformly by one `git diff` — no separate untracked-porcelain
  pass is needed, and rename detection (`-M`) works across both.
- `touchedFiles` is demoted from *the* file-set gate to an **attribution
  badge**: a changed file (from the baseline diff) gets a "✎ this session"
  badge when its path — relativized against the repo toplevel
  (`repo_toplevel`, this ADR's companion command) — falls in that session's
  `touchedFiles`. That relativization has a known blind spot
  (`relativizeTouchedPath`): `repo_toplevel` canonicalizes its `cwd`, so the
  toplevel is always a realpath, while `touchedFiles` holds whatever
  (possibly symlinked) path the edit tool used. Under a symlinked project
  path — macOS's `/tmp` → `/private/tmp`, a symlinked home — every prefix
  test fails and every badge for that session silently vanishes. It fails
  safe (no file is ever mis-attributed to the wrong session), which is why
  it's left as-is; the same relativization backs the My-edits-only filter,
  so that filter goes empty under the same condition. It labels *who* plausibly made a change the baseline diff
  already found; it never decides *whether* a change exists. It does gate
  *display* in exactly one place, opt-in: the **My edits only** toggle
  (`myEditsOnly` in `src/state/changes.ts`) narrows `ChangesView`'s rendered
  file set to the touched subset, with `SummaryBar` recomputing its totals
  over that filtered list. Default-off per session, so the honest full diff is
  what a user sees first, and no persisted state ever leaves it on.
- Pre-feature, resumed-old, and Home-cwd sessions have no `baseline_oid`; the frontend
  falls back to `diff_working_tree` (today's merge-base behavior) rather than
  failing.

## Considered and rejected

- **Touched-file intersection** — gate the file list to
  `tools-touched ∩ working-tree-diff` instead of adding a baseline. Rejected:
  it inherits every gap above (misses Bash-style edits, can't self-correct a
  revert) and cannot be fixed without exactly the transcript-completeness
  guarantees Kriyon's loose-coupling stance (terminal is the source of truth,
  the structured view is best-effort) explicitly declines to promise.
- **Convergent precedent.** Survey of six mature agentic-coding tools shows a
  consistent pattern: each anchors its authoritative "what changed" view on a
  git baseline rather than a tool-touch filter. Observed approaches across
  public docs:
  - **Cline / Roo Code** maintain a separate shadow git repository and commit
    a task-start baseline, diffing against it for the changes view
    (docs.cline.bot/core-workflows/checkpoints).
  - **Aider** commits a clean baseline (`dirty_commits`) then auto-commits each
    LLM edit as its own commit (`auto_commits`), anchoring changes on that log
    (aider.chat/docs/git.html).
  - **Warp** surfaces a plain git working-tree diff of uncommitted changes vs
    the branch, not a per-run snapshot (docs.warp.dev/code/code-review).
  - **Cursor** tracks per-edit snapshots ("checkpoints") stored outside git,
    explicitly excluding manual edits from the tracked set
    (cursor.com/docs).
  - **Claude Code** publishes `/diff` as authoritative `git diff HEAD`, while
    keeping its per-turn tool-record view explicitly non-authoritative.
  - **Zed** applies agent edits to real files; its git panel reflects the
    working-tree status normally.
  
  None of the surveyed tools uses touched-file intersection to gate which
  files appear in the changes view.

## Consequences

- One extra git spawn pair per **new** session (`capture_baseline`'s
  `add -A` + `write-tree`) and one `repo_toplevel` spawn, cached per session
  rather than re-run per render. Per view open/refresh: one current-tree
  snapshot + one diff, gated to the on-screen session — no continuous
  polling. **But not only on view open, as shipped:** `sessions.ts` also fires
  a 500 ms-debounced live refresh (`scheduleChangesRefresh`) on every
  tool-touch for the *active* session, regardless of which transcript tab is
  showing — the Inspector reads the diff even from Raw. (Amended 2026-08-05,
  [ADR-0019](0019-remove-the-structured-pane.md): the tabs are now Changes and
  Raw only; "Studio or Raw" here was the removed structured pane, not the
  Studio *shell layout*, which is unchanged.) Not polling
  (nothing fires while nothing is edited, and a burst of `MultiEdit`/`Edit`
  calls coalesces into one), but a busy turn still costs a `snapshot_tree` +
  diff every ~500 ms, which compounds with the `.git/objects` growth and the
  LFS-clean-filter cost noted in the two M9 bullets below.
- The changes list is now honestly scoped to "since this session started,"
  self-corrects on revert, and catches edits made by any means (Bash, a
  formatter, a generated file) — not just tracked tool calls.
- `touchedFiles` keeps exactly one job (attribution), matching Claude Code's
  own authoritative-git + per-turn-lens split; it no longer needs to be
  complete to keep the changes list correct.
- Sessions with `baseline_oid = null` (pre-feature, resumed from before this
  shipped, or in the default "Home" cwd per the carve-out above) degrade to
  the prior whole-working-tree `diff_working_tree`
  view rather than erroring — multiple such sessions on one branch still see
  each other's changes, same as before this ADR.
- (M9, round-two review) Every `snapshot_tree` call writes real objects into
  the user's `.git/objects` — a new tree object, plus a blob per changed
  file since the previous snapshot (roughly 3 objects + the changed bytes
  per call, on a session-start `capture_baseline` and on every subsequent
  `diff_session_changes` refresh). None of this moves a ref, HEAD, or the
  index (the "no git side effects" claim above still holds for those), but
  the objects themselves are real and **unreachable by construction** — no
  ref, branch, or reflog entry ever points at a baseline tree — so they are
  exactly what `git gc --prune=now`, `git repack -ad`, or the default
  two-week `gc.pruneExpire` collect on their normal schedule. A session's
  `baseline_oid` can therefore go stale (the object it names gets pruned)
  purely from background git housekeeping the user runs for unrelated
  reasons; `diff_session_changes` detects that specific failure and the
  frontend degrades to `diff_working_tree` for that refresh and clears the
  dead oid, rather than erroring on every subsequent refresh forever.
- (M9, round-two review) `snapshot_tree`'s `git add -A` runs any clean
  filters configured for the repo (notably git-lfs's) on every file it
  stages — the same as an ordinary `git add -A` would — on every snapshot,
  not just once at session start. For a repo with LFS-tracked files this
  means every Changes-view refresh re-runs those filters, not only the
  initial `capture_baseline`.
