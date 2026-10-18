# Worktree sessions + sidebar refresh

Design source: design mockups (not in this repo), sidebar variants 5a and 5b.
Research: worktree pain points across Conductor/Crystal/Vibe-Kanban/Claude Code (2026-07-11).

## Goal

Worktrees stay **opt-in per session** — never on by default. The sidebar is the command
center: a session running in a [Worktree] is visibly different (`⎇ branch` + uncommitted-changes
dot), each project header shows how many worktree sessions it has (`⎇N`), and cleanup is one
explicit, guarded action. Alongside, the sidebar adopts the calmer 5a/5b look (color only where
action is needed; counts move right; quieter done rows).

## Decision (ADR-worthy): Kriyon-owned worktrees, not `claude --worktree`

`claude --worktree` creates the worktree *after* launch, inside the PTY — Kriyon would not know
the path when it spawns the daemon, so the session's cwd, repo-status polling, diff/merge panel,
and cleanup would all be blind. Kriyon already owns a tested pipeline
(`worktree_path_for` → `create_worktree` → `bootstrap_worktree`) that solves the top researched
pain points (env files copied, deps installed via detected package manager, setup command), and
launching `claude` with cwd *inside* the worktree keys transcripts to that path, so resume works
natively. Same user-visible result as `claude worktree`, but the GUI stays in control.
Worktrees live at the existing sibling convention `<repo>-worktrees/<branch>`.

## Research pain points → what v1 answers

| Pain point | Answer |
| --- | --- |
| env files / deps missing in fresh worktree | existing bootstrap (env copy + install + setup command), surfaced in the dialog |
| "which copy am I in?" | `⎇ branch` chip on the row, `⎇N` on the project header, branch in session header |
| orphaned worktrees never cleaned | explicit **Remove worktree** on worktree rows (archive + remove), dirty-guarded |
| dirty worktree removed silently | plain `git worktree remove` first; force only after an explicit confirm listing the risk |
| branch-already-exists / checked-out errors | git's error surfaced verbatim in the create dialog; no silent fallback |
| deleted branch still locked by worktree | v1 keeps the branch on removal (commits stay reachable); message says so |

Out of scope (YAGNI for v1): orphan scan on boot, disk-usage display, port allocation,
`.worktreeinclude` interop, a global worktrees panel, a settings toggle (opt-in is per creation).

## Implementation

### 1. Rust: force-remove variant (only backend gap)
- `git_cmd::remove_worktree(repo_path, path, force: bool)` — appends `--force` when set;
  same `reject_flag_like` guards. TDD: dirty worktree → plain remove errs, force succeeds.
- Thread through `commands::remove_worktree` + `bridge.removeWorktree(repo, path, force)`.
  (ReviewPanel's existing call passes `false`.)

### 2. Frontend action: `createWorktreeSession`
`src/state/actions.ts`: mirror `spawnFollowUpSession`'s worktree branch minus the seed prompt —
`worktreePathFor` → `createWorktree` → `bootstrapWorktree` → `createSession(project, path, branch,
{worktreePath: path})`. Returns the same `{ok, error, bootstrap}` shape for the dialog.

### 3. Opt-in entry point: WorktreeDialog
- Project header gains a third hover-revealed action (GitBranch icon,
  "New worktree session in <project>") next to palette/+. The plain `+` is untouched —
  default behavior identical to today.
- `src/spawn/WorktreeDialog.tsx` (opened via `useUi`): branch field (pre-filled `wt/<slug>`),
  setup-command field (persisted back to the project, as SpawnDialog does), the target path
  shown so nothing is mysterious, error/bootstrap-report surface, spawn-once latch
  (SpawnDialog's `spawned` rule: never re-run `createWorktree` on an existing path).

### 4. Sidebar worktree indicators (design 5a/5b)
- **Row chip**: existing `⎇ name` chip restyled (mono 10.5px, ink.faint) + a 5px
  `#C97B4A`-toned dirty dot when the worktree has uncommitted changes.
  Data: reuse the existing `repoStatusResource` SWR (`useRepoStatus`) keyed by
  `worktreePath`, revalidated when the session's status changes — no polling loop,
  no per-tick re-renders (dirty_count already comes back in `RepoStatus`).
- **Project header**: right-side cluster per design — `⎇N` (count of open sessions with
  `worktreePath`), attention dot, session count. Pure derivation in the existing selector.
- **Remove worktree**: menu item on any worktree row's ⋯ menu + the quiet inline text action
  on done worktree rows (design). Flow: plain `removeWorktree` → on success archive the
  session; on git refusal show a confirm ("uncommitted changes will be lost; branch <b> is
  kept") → `removeWorktree(force)` → archive. Never force without the confirm.

### 5. Sidebar visual refresh (tokens + inline styles only)
Per design: header count moves to the right cluster (drop the left gutter number); tighter
row padding; no structural regrouping. Done rows stay single-line and drop to the faint ramp
(mostly already true); triage "N done" summary + History row restyled to the design's quiet
`✓ N done · History ›` line; row title 12.5–13px, context line 11.5px. All values through
`tokens.ts` / theme files — no hardcoded colors in components (dirty-dot + chip tones become
tokens).

### 6. Docs
- ADR: "Worktree sessions ride Kriyon's own git machinery, not `claude --worktree`".
- CONTEXT.md: terms already exist (Worktree, Worktree bootstrap); extend [Worktree] with the
  uncommitted-changes indicator sentence. No new module-name terms needed.

## Test plan (TDD per step)
- Rust: `git_cmd` force-remove on a dirty worktree (tempdir repo, existing test idioms).
- `actions.test.ts`: `createWorktreeSession` happy path + createWorktree failure → no session.
- `WorktreeDialog.test.tsx`: renders path preview, disables re-spawn after create, shows errors.
- `Sidebar.test.tsx` additions: `⎇N` header count, dirty dot shown when repo status dirty,
  Remove-worktree flow (plain → confirm → force) with archived session.
- `sessionOrder`/row view: unchanged logic, existing tests keep passing.
- `pnpm check` green; real-app smoke: create worktree session in kriyon repo, watch chip,
  dirty dot after an edit, merge via ReviewPanel, Remove worktree.

## Commit sequence (small, conventional; shared checkout — stage named files only)
1. `feat(git): allow forced worktree removal behind an explicit flag`
2. `feat(session): create an opt-in worktree session from a project`
3. `feat(sidebar): show worktree branch, dirty state, and per-project counts`
4. `feat(sidebar): guarded remove-worktree action on worktree rows`
5. `style(sidebar): adopt the calm 5a/5b hierarchy`
6. `docs(adr): record the kriyon-owned worktree decision`
