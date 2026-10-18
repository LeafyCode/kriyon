# Session lifecycle ergonomics — spawn, worktree bootstrap, collision, archive

- **Status:** Accepted
- **Date:** 2026-07-02
- **Register:** design spec

## 1. Problem

Kriyon watches many Sessions but makes the user do their *lifecycle* by hand. The
things a multi-session developer does dozens of times a day are all manual:

1. **Starting the next session.** Continuing work means typing "/handoff, then start a
   fresh session and paste the summary" by hand. Claude Code has `/handoff`; Kriyon has
   no verb for "spawn the successor."
2. **Isolating parallel work.** Kriyon has a fully built worktree stack
   (`createWorktree` → `git worktree add -b`, diff, merge) that **nothing in the UI ever
   calls** — every session is created with `worktreePath: null`. So users run parallel
   agents in one shared checkout, and the `ReviewPanel` (diff/merge) is unreachable.
   Worktree setup friction (copying `.env`, running installs) came up often in the tools
   we looked at; some users keep several full checkouts instead.
3. **Colliding on a checkout.** Two live sessions in one working directory clobber each
   other's files. The market has no fix for the semantic case; a *warning* is the
   realistic bar.
4. **Cleaning up.** A session whose branch merged sticks around forever; there's no tidy.

Market research (2026-07-02) placed these as Arc B, the natural successor to the shipped
"Actionable Needs-you" arc: the same attention layer, now with the verbs. Kriyon's
differentiation is doing this while hosting the **real** CLI, not reimplementing chat.

## 2. Decisions locked during brainstorming

| Decision | Choice |
|---|---|
| Scope | All four items as one continuous arc (spawn → worktree → collision → archive) |
| Where the verbs live | ⌘K command palette (primary) + a per-session-row overflow action; no always-visible buttons |
| Bootstrap recipe | Zero-config heuristics (copy untracked `.env*`, run lockfile-detected install) **plus** one optional per-Project setup command. No checked-in recipe file, no DSL |
| Handoff seeding | Kriyon's own composer pre-filled from a deterministic digest (reuses CatchUpBrief machinery), passed as the new session's **initial `claude` argument**. Not auto-detecting Claude Code's `/handoff` doc |
| Seeding mechanism | `claude "$(cat <prompt-file>)"` — a launch argument, never keystroke injection into a running TUI. Verified: a bare positional prompt starts an interactive session (only `-p` is headless); `$(…)` strips the trailing newline |
| Collision detection | Two live sessions sharing a resolved working directory (same `worktreePath ?? cwd` ⇒ same branch). Spawn-time warning only, never a persistent badge |
| Archive | Soft flag (`archivedAt`); the Claude transcript and the worktree are preserved. Offered after a **clean merge through Kriyon's ReviewPanel**; external-merge auto-detection deferred |

## 3. Vocabulary (to be added to CONTEXT.md before implementation)

- **Follow-up session** — a new [Session] spawned from an existing one, seeded with a
  [Handoff prompt] and optionally created in a fresh [Worktree]. The natural successor to
  Claude Code's `/handoff`. No parent pointer is stored — the handoff prompt carries the
  continuity, so a follow-up is an ordinary [Session] once launched. _Avoid_: child
  session (that's a [Subagent]), spawned session.
- **Handoff prompt** — the editable initial prompt seeded into a [Follow-up session],
  pre-filled from a deterministic digest of the predecessor's recent work (the same
  zero-token digest the [Catch-up brief] builds) and passed as the new session's first
  `claude` argument via a Kriyon-written, path-contained prompt file. Never
  keystroke-injected into a running Session. _Avoid_: seed prompt, handoff doc.
- **Worktree bootstrap** — the one-time setup that makes a freshly created [Worktree]
  ready to work in: copying the project root's untracked top-level `.env*` files into it,
  running the [Install command] detected from the lockfile, then running the project's
  optional [Setup command]. Best-effort — a failed step warns but never blocks the
  Session from opening. _Avoid_: provisioning, worktree init.
- **Install command** — the dependency-install command a [Worktree bootstrap] infers from
  which lockfile is present (`pnpm-lock.yaml`→`pnpm install`, `package-lock.json`→`npm
  install`, `yarn.lock`→`yarn`, `bun.lockb`→`bun install`), or none. Purely a function of
  the present filenames. _Avoid_: package install.
- **Setup command** — an optional per-[Project (Workspace)] shell command, persisted on
  the project row, run once at the end of a [Worktree bootstrap] (e.g. `docker compose
  up -d`, a codegen step). The single escape hatch above the zero-config heuristics.
  _Avoid_: bootstrap script, hook.
- **Branch collision** — the condition where a new [Session] would start in a working
  directory a live (non-[Archived session]) [Session] already occupies — the same
  resolved repo path, hence the same branch. Surfaced as a spawn-time warning the user
  can override, never a persistent badge (the [Needs-you rail] restraint rule). _Avoid_:
  conflict (reserved for [Merge outcome]), clash.
- **Archived session** — a [Session] tidied out of the active sidebar and [Command
  center] with an `archivedAt` timestamp, typically after its branch merged cleanly. The
  Claude [Transcript] is preserved (so it remains discoverable as a [Past session]) and
  its [Worktree] is **not** removed unless the user explicitly asks. Reversible
  (un-archive). Shown in a collapsed "Archived" sidebar group. _Avoid_: deleted session,
  closed session.

## 4. Architecture

Reuse-first. The worktree/diff/merge stack, session store, palette, persistence, and the
CatchUpBrief digest all exist; Arc B is mostly wiring, plus one genuinely new backend
piece (bootstrap) and the spawn dialog.

### 4.1 Spawn a follow-up session

**Flow (frontend `src/state/actions.ts` + a new `SpawnDialog`):**

1. Trigger: ⌘K "Spawn follow-up session…" (predecessor = active session) or the
   session-row overflow action on a specific predecessor.
2. The **spawn dialog** opens with:
   - a **prompt composer**, pre-filled with `buildHandoffPrompt(events, session)` — a
     deterministic prose seed derived from the predecessor's parsed [Studio event]s
     (files edited, commands run, tasks completed, subagents run, last assistant line —
     the CatchUpBrief digest fields), ending with an empty line for the user to steer.
     Fully editable.
   - a **"fresh worktree" toggle**. Off → the follow-up runs in the predecessor's working
     directory (a [Branch collision] warning may show, §4.3). On → a **branch-name field**
     (default a slug of the title, editable) and the computed target worktree path.
3. Confirm:
   - If worktree: `createWorktree(repoRoot, branch, worktreePathFor(repoRoot, branch))`,
     then run the [Worktree bootstrap] (§4.2), showing "Setting up worktree…" progress.
   - Create the session: `id = crypto.randomUUID()`, `projectId` = predecessor's,
     `cwd` = predecessor's `cwd`, `worktreePath` = the new worktree or `null`.
   - Stash the edited prompt text in a transient, **non-persisted** `pendingSeedPrompt`
     map keyed by the new session id.
   - Activate the session → activation-launch seeds it (below).

**Seeding at launch (`src/terminal/sessionHost.ts` + a `seed_prompt` command):**

- `App.tsx`'s activation-launch passes the transient seed to
  `launchClaudeOnce(id, claudeSessionId, seedPrompt?)`.
- When `seedPrompt` is present (and there is no `claudeSessionId` — a follow-up is a fresh
  conversation): the frontend calls a new Tauri command `seed_prompt(id, text)` which
  **validates `id` against the safe-id pattern and path-containment rule** (same guard as
  the session socket), writes `text` to `~/.claude/kriyon/run/<id>.prompt`, and returns
  the path. `launchClaudeOnce` then writes `claude "$(cat <path>)"\r` to the PTY instead
  of `claude\r`.
- The prompt file's path is entirely Kriyon-controlled (run dir + validated id +
  `.prompt`); the arbitrary user text lives *inside* the file, so no shell-escaping of
  user content ever occurs. `$(…)` strips the trailing newline for free.
- `close_session` best-effort removes the session's `.prompt` file so the run dir doesn't
  accumulate.

### 4.2 Worktree bootstrap

Rust owns fs/process (repo rule). Split pure decisions (kriyon-core, unit-tested) from the
thin shell-out (src-tauri), mirroring `git.rs` / `git_cmd.rs`.

**Pure — `crates/kriyon-core/src/bootstrap.rs`:**

```rust
/// Sibling worktree path: `<repoRoot>-worktrees/<sanitized-branch>`.
pub fn worktree_path_for(repo_root: &str, branch: &str) -> String;
/// Branch → filesystem-safe dir segment (`feat/foo` → `feat-foo`).
pub fn sanitize_branch_dir(branch: &str) -> String;
/// The install argv inferred from which lockfiles are present, or none.
pub fn detect_install(present_files: &[&str]) -> Option<&'static [&'static str]>;
/// The top-level `.env*` names to copy (filters a dir listing).
pub fn env_files_to_copy(entries: &[String]) -> Vec<String>;
```

**Shell-out — `src-tauri/src/bootstrap_cmd.rs` + Tauri command:**

```rust
pub struct BootstrapReport { pub ok: bool, pub steps: Vec<BootstrapStep>, pub output: String }
pub struct BootstrapStep { pub label: String, pub ok: bool }
/// Copy untracked `.env*`, run the detected install, then the optional setup command,
/// all inside `worktree_path`. Best-effort: captures combined output; a failing step is
/// recorded but the next still runs. Never panics.
pub fn bootstrap_worktree(repo_root: &str, worktree_path: &str, setup_cmd: Option<&str>)
    -> BootstrapReport;
```

- Tauri command `bootstrap_worktree(repoPath, worktreePath, setupCmd: Option<String>) ->
  Result<BootstrapReport, String>`. Async (install can take minutes); the frontend shows
  progress and only launches `claude` after it returns.
- On `ok: false` the spawn dialog surfaces the captured output and offers "Open anyway"
  (the tree may still be workable) — the Session is never trapped.
- `setup_cmd` runs via `sh -c` in the worktree; it is the user's own persisted command
  (their trust boundary, like the shell Kriyon already spawns), not frontend-supplied
  per-spawn input.

**Per-project setup command:** `ProjectRow`/`projects` gains `setup_command TEXT`
(nullable). Edited from the project's context (a small field; exact placement in §4.5).
Idempotent `ALTER TABLE` migration, matching `migrate_claude_session_id`.

### 4.3 Branch collision warning

**Pure — `src/state/collision.ts`:**

```ts
/** The resolved working directory a session occupies (worktree wins over cwd). */
export function sessionWorkingDir(session: UiSession): string;
/** A live, non-archived session already in `candidateDir`, or null. */
export function detectCollision(
  candidateDir: string,
  sessions: Record<string, UiSession>,
  ignoreSessionId?: string,
): UiSession | null;
```

- A fresh worktree never collides (new path), so the warning only appears for
  same-checkout spawns — which nudges users toward worktrees, the desired behaviour.
- Surface: in the spawn dialog, a warning line — "**<title>** is already working in
  <folder>" (branch appended when a cached `RepoStatus` is available) — and the confirm
  button reads "Open anyway". Also consulted by "New session in folder…" so the nudge is
  consistent, not just for follow-ups.

### 4.4 Archive

**State:** `UiSession` and `SessionRow` gain `archivedAt: number | null`
(`archived_at INTEGER`, idempotent migration). `persistKey` already fingerprints the
session fields it needs; add `archivedAt`. Store actions `archiveSession(id)` /
`unarchiveSession(id)` set/clear it and persist.

**Filtering:** archived sessions leave the active surfaces —
- sidebar active project groups exclude them; a collapsed **"Archived"** group (same
  pattern as "Earlier sessions") lists them with an un-archive affordance.
- `buildStandings` (Command center / [Needs-you rail]) skips archived sessions, so they
  never count toward badges or notifications.

**Merge-triggered offer:** when `mergeWorktree` returns `Clean` in the `ReviewPanel`
(now reachable because §4.1 sets `worktreePath`), show a calm banner: "Branch merged
cleanly — archive this session?" with **Archive**, **Archive & remove worktree**, and
**Dismiss**.
- "Remove worktree" calls `removeWorktree(repoRoot, worktreePath)`, which uses
  `git worktree remove` (no `--force`) — it refuses on a dirty tree, so it is safe by
  construction. Explicit and confirm-gated; never automatic.
- Archive is a soft flag: `delete_session` is **not** called, the transcript is
  untouched, and the session can be un-archived or resumed later.

### 4.5 Surfaces

- **⌘K palette** (`CommandPalette.tsx` `commandItems`): add "Spawn follow-up session…"
  (predecessor = active session; disabled with a hint when none is active) and "New
  worktree session…". Both open the `SpawnDialog`.
- **`SpawnDialog`** — a new modal, a keyboard-first sibling of `CommandPalette` /
  `NeedsYouOverlay` (Esc cancels, ⌘↵ confirms): the prompt composer, the worktree toggle
  + branch field, the collision warning, and the bootstrap-progress state.
- **Session-row overflow** (`Sidebar.tsx` `SessionRow`): a hover-revealed "⋯" opening a
  tiny menu with "Spawn follow-up" and "Archive" (reusing the existing hover-reveal
  pattern that shows the close affordance; no heavyweight context-menu framework).
- **Archived group** in the sidebar; **merge-offer banner** in the `ReviewPanel`.
- **Setup command** field: on the project (edited from the project group header's existing
  affordance area — a single optional text input, empty by default).

Design values from `src/theme/tokens.ts` only; voice stays calm and native (PRODUCT.md).

## 5. Error handling

- All new kriyon-core logic is total: `bootstrap.rs` helpers return values for every input
  (unknown lockfiles → no install; odd branch names → sanitized), never panic.
- `bootstrap_worktree` captures failures per step and returns a report; the UI degrades to
  "Open anyway", never a dead session.
- `createWorktree` errors (e.g. branch already exists) surface inline in the dialog; the
  user picks another name. Nothing is created half-way that the user can't see.
- `seed_prompt` rejects an id that fails the path-containment guard (returns `Err`);
  `launchClaudeOnce` then falls back to a plain `claude` launch rather than seeding.
- Collision detection and archive filtering are pure and absence-tolerant.

## 6. Testing (TDD, per repo rules)

**kriyon-core `bootstrap.rs`** — failing tests first:
- `detect_install`: each lockfile → its argv; multiple present → deterministic priority;
  none → `None`.
- `env_files_to_copy`: matches exactly `.env` and `.env.*` — keeps `.env`, `.env.local`,
  `.env.production`; drops `.envrc` (direnv, not a dotenv file) and unrelated files.
- `worktree_path_for` / `sanitize_branch_dir`: slashes and unsafe chars sanitized;
  sibling path shape.

**src-tauri** — `bootstrap_worktree` against a temp git repo: copies a seeded `.env`,
records an install step (with a stub PM or a repo with no lockfile → skipped), runs a
setup command; a failing setup command yields `ok:false` but a populated report.
`seed_prompt` writes the file for a valid id and rejects a traversal id.

**Frontend:**
- `buildHandoffPrompt`: digest composition, name caps, empty-delta still yields a usable
  header, no crash on zero events.
- `collision.ts`: same-dir live session detected; archived/own session ignored; worktree
  path vs cwd resolution.
- Store: `archiveSession`/`unarchiveSession` round-trip; archived sessions excluded from
  `buildStandings` and active sidebar groups.
- `SpawnDialog` via the `window.__kriyon` QA seam + Playwright: pre-filled composer,
  worktree toggle reveals the branch field, collision warning appears for an occupied
  folder and not for a fresh worktree, ⌘↵ confirms, Esc cancels.

**Integration:** one test that a spawned follow-up ends up as a session with the right
`worktreePath` and a seed prompt written; one that a clean `mergeWorktree` surfaces the
archive offer and archiving sets `archivedAt` without deleting the transcript.

## 7. Out of scope (explicitly)

- **Persisting a predecessor→follow-up link / a session tree.** The handoff prompt carries
  continuity; a stored parent pointer is YAGNI for v1.
- **External-merge auto-detection** (archiving a session whose branch was merged via `gh`
  or the terminal). v1 offers archive only on a clean merge performed through Kriyon;
  manual archive is always available.
- **A bootstrap recipe DSL / multiple setup steps / `.worktreeinclude`-style include
  globs.** One optional setup command is the whole escape hatch.
- **Semantic merge-conflict prevention** between parallel agents — unsolved everywhere;
  Arc B warns, it does not prevent.
- **Cross-project "ready to land" review queue** (Arc C) and mobile/remote surfaces.

## 8. Open risks

- **Install duration in the spawn flow.** A cold `pnpm install` can take minutes; the
  dialog must show honest progress and stay cancellable. If it stings, a follow-up could
  run bootstrap in the background and launch `claude` optimistically — deferred.
- **`claude --resume <id> "prompt"`** (resume *and* seed) is undocumented. Not needed for
  Arc B (follow-ups are fresh conversations), but if a future flow wants it, test first.
- **Setup command is arbitrary code** the user persisted. It runs in their own shell in
  their own repo — the same trust level as the interactive shell Kriyon already spawns —
  but it must never take frontend-supplied per-spawn input, only the stored project value.
- **`worktree_path_for` collisions** if two branches sanitize to the same dir
  (`feat/foo` vs `feat-foo`). Acceptable: `git worktree add` fails on an existing path and
  the error surfaces; the user renames.
