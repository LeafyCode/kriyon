# Session Lifecycle Ergonomics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn session lifecycle chores into first-class Kriyon verbs — spawn a follow-up session seeded with a handoff prompt, create a worktree that bootstraps its own env/deps, warn on same-checkout collisions, and archive a session after a clean merge.

**Architecture:** Reuse-first. The worktree/diff/merge Rust stack, the session store, the command palette, persistence, and the CatchUpBrief digest already exist. This plan (a) wires the never-called worktree path into session creation, (b) adds one new backend piece — `bootstrap.rs` (pure) + `bootstrap_worktree` (shell-out), (c) seeds a follow-up's first `claude` prompt via a path-contained prompt file and `claude "$(cat …)"`, (d) adds a soft `archivedAt` flag + per-project `setupCommand` column, and (e) adds the `SpawnDialog`, a session-row overflow menu, and a merge-triggered archive offer.

**Tech Stack:** Rust (kriyon-core pure logic + src-tauri thin commands, serde, rusqlite), React + Zustand, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-02-session-lifecycle-design.md`

## Global Constraints

- **Branch:** work on `feat/session-lifecycle` (already created off `feat/session-activity`). Never commit to `main`/`master`.
- **SHARED CHECKOUT — CRITICAL:** multiple live Claude sessions share this ONE working tree. **Only ever `git add <explicit named files>`. NEVER `git add -u`, `git add .`, or `git add -A`.** Expect unrelated modified files (PTY/font WIP) and unrelated failing tests from other sessions' WIP — do not touch, fix, or stage them.
- **TDD:** write the failing test, run it, watch it fail, then implement. Every task is ordered that way.
- **Totality:** all new kriyon-core logic returns a value for every input — no panics, unknown/malformed input degrades (drift-guard discipline).
- **Trust boundary:** every value crossing Rust↔JS is validated. Session ids are validated (via `session_socket_path`) before being interpolated into a filesystem path. Branch/path args go through `reject_flag_like` (already in `git_cmd.rs`).
- **Never inject keystrokes** into a running session. Seeding a *new* session's first prompt is a launch argument (`claude "$(cat <file>)"`), not injection.
- **Design values** come from `src/theme/tokens.ts` — no hardcoded colors/spacing. Voice stays calm/native (PRODUCT.md).
- **Serde conventions:** structs `rename_all = "camelCase"`, enums `rename_all = "snake_case"` (or `"lowercase"` where the neighbouring enum uses it — match the file).
- **Type mirrors:** every Rust type crossing IPC has a TS mirror in `src/types.ts` with a `(mirrors Rust …)` doc comment.
- **Formatting/lint** is owned by Ultracite/Biome: run `pnpm fix` before committing frontend changes; never hand-format. Rust: `cargo fmt` + `cargo clippy --all-targets -- -D warnings`.
- **`pnpm check`** must pass before the final commit.

---

### Task 1: `bootstrap.rs` — pure worktree-setup decisions

The only genuinely new backend logic. Pure functions: no fs, no process. Mirrors the pure/shell split of `git.rs` vs `git_cmd.rs`.

**Files:**
- Create: `crates/kriyon-core/src/bootstrap.rs`
- Modify: `crates/kriyon-core/src/lib.rs` (add `pub mod bootstrap;` — alphabetically, between `backpressure` and `daemon`)

**Interfaces:**
- Produces (Tasks 2 & 9 rely on these exact names):

```rust
pub fn worktree_path_for(repo_root: &str, branch: &str) -> String;
pub fn sanitize_branch_dir(branch: &str) -> String;
pub fn detect_install(present_files: &[&str]) -> Option<&'static [&'static str]>;
pub fn env_files_to_copy(entries: &[String]) -> Vec<String>;
```

- [ ] **Step 1: Write the failing tests.** Create `crates/kriyon-core/src/bootstrap.rs` with ONLY the test module (plus a `use super::*;`) so the failure is a clean missing-symbol compile error:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_branch_into_a_dir_segment() {
        assert_eq!(sanitize_branch_dir("feat/foo"), "feat-foo");
        assert_eq!(sanitize_branch_dir("fix/a b"), "fix-a-b");
        assert_eq!(sanitize_branch_dir("plain"), "plain");
        // Collapses runs and trims separators so no empty or ".."-ish segment.
        assert_eq!(sanitize_branch_dir("a//b"), "a-b");
        assert_eq!(sanitize_branch_dir("/lead/"), "lead");
        assert_eq!(sanitize_branch_dir(".."), "wt");
        assert_eq!(sanitize_branch_dir(""), "wt");
    }

    #[test]
    fn worktree_path_is_a_sibling_of_the_repo() {
        assert_eq!(
            worktree_path_for("/Users/x/Projects/kriyon", "feat/foo"),
            "/Users/x/Projects/kriyon-worktrees/feat-foo"
        );
        // A trailing slash on the repo root is tolerated.
        assert_eq!(
            worktree_path_for("/Users/x/Projects/kriyon/", "wt"),
            "/Users/x/Projects/kriyon-worktrees/wt"
        );
    }

    #[test]
    fn detects_install_from_lockfile_priority() {
        assert_eq!(detect_install(&["pnpm-lock.yaml"]), Some(&["pnpm", "install"][..]));
        assert_eq!(detect_install(&["package-lock.json"]), Some(&["npm", "install"][..]));
        assert_eq!(detect_install(&["yarn.lock"]), Some(&["yarn"][..]));
        assert_eq!(detect_install(&["bun.lockb"]), Some(&["bun", "install"][..]));
        // pnpm wins when several are present (deterministic priority).
        assert_eq!(
            detect_install(&["package-lock.json", "pnpm-lock.yaml"]),
            Some(&["pnpm", "install"][..])
        );
        // No JS lockfile → nothing to run (Cargo builds lazily).
        assert_eq!(detect_install(&["Cargo.toml"]), None);
        assert_eq!(detect_install(&[]), None);
    }

    #[test]
    fn env_files_are_dotenv_only() {
        let entries = vec![
            ".env".to_string(),
            ".env.local".to_string(),
            ".env.production".to_string(),
            ".envrc".to_string(), // direnv, not a dotenv file
            "env".to_string(),
            "README.md".to_string(),
        ];
        assert_eq!(
            env_files_to_copy(&entries),
            vec![".env".to_string(), ".env.local".to_string(), ".env.production".to_string()]
        );
    }
}
```

- [ ] **Step 2: Add the module and run the tests to verify they fail**

Add `pub mod bootstrap;` to `crates/kriyon-core/src/lib.rs` (alphabetical, after `pub mod backpressure;`).
Run: `cargo test -p kriyon-core bootstrap::`
Expected: FAIL — `cannot find function sanitize_branch_dir` (compile error).

- [ ] **Step 3: Implement.** Prepend to `crates/kriyon-core/src/bootstrap.rs` (above the test module):

```rust
//! Pure decisions for a [Worktree bootstrap]: where a worktree lives, how a
//! branch name becomes a directory segment, which install command a lockfile
//! implies, and which `.env*` files to copy. No fs or process work lives here —
//! the shell-out is `src-tauri/src/bootstrap_cmd.rs`. Total: every input yields
//! a value. See CONTEXT.md "Worktree bootstrap" and the 2026-07-02 spec.

/// A branch name as a filesystem-safe directory segment: non-alphanumeric runs
/// collapse to a single `-`, leading/trailing `-` are trimmed, and anything that
/// would reduce to empty or a dot-run falls back to `wt`.
#[must_use]
pub fn sanitize_branch_dir(branch: &str) -> String {
    let mut out = String::with_capacity(branch.len());
    let mut prev_dash = false;
    for ch in branch.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches(['-', '.'].as_ref());
    if trimmed.is_empty() {
        "wt".to_string()
    } else {
        trimmed.to_string()
    }
}

/// The sibling worktree path for `branch`: `<repo_root>-worktrees/<sanitized>`.
/// Keeping worktrees outside the repo keeps them out of its `git status`.
#[must_use]
pub fn worktree_path_for(repo_root: &str, branch: &str) -> String {
    let root = repo_root.trim_end_matches('/');
    format!("{root}-worktrees/{}", sanitize_branch_dir(branch))
}

/// The dependency-install argv implied by the lockfiles present at the repo
/// root, or `None` when there is nothing to install. Priority is deterministic:
/// pnpm, npm, yarn, bun.
#[must_use]
pub fn detect_install(present_files: &[&str]) -> Option<&'static [&'static str]> {
    const PNPM: &[&str] = &["pnpm", "install"];
    const NPM: &[&str] = &["npm", "install"];
    const YARN: &[&str] = &["yarn"];
    const BUN: &[&str] = &["bun", "install"];
    if present_files.contains(&"pnpm-lock.yaml") {
        Some(PNPM)
    } else if present_files.contains(&"package-lock.json") {
        Some(NPM)
    } else if present_files.contains(&"yarn.lock") {
        Some(YARN)
    } else if present_files.contains(&"bun.lockb") {
        Some(BUN)
    } else {
        None
    }
}

/// From a directory listing, the top-level dotenv files to copy into a fresh
/// worktree: exactly `.env` and `.env.*` (so `.env.local`, `.env.production`),
/// never `.envrc` (direnv) or unrelated files. Order is preserved.
#[must_use]
pub fn env_files_to_copy(entries: &[String]) -> Vec<String> {
    entries
        .iter()
        .filter(|name| *name == ".env" || name.starts_with(".env."))
        .cloned()
        .collect()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p kriyon-core bootstrap:: && cargo clippy -p kriyon-core --all-targets -- -D warnings`
Expected: PASS (4 tests), no clippy warnings.

- [ ] **Step 5: Commit**

```bash
git add crates/kriyon-core/src/bootstrap.rs crates/kriyon-core/src/lib.rs
git commit -m "feat(core): pure worktree-bootstrap decisions (path, install, env files)"
```

---

### Task 2: `bootstrap_worktree` + `worktree_path` commands

Shell-out that copies `.env*`, runs the detected install, then the optional setup command — all in the worktree. Plus a thin command exposing `worktree_path_for` so the frontend gets the canonical path.

**Files:**
- Create: `src-tauri/src/bootstrap_cmd.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod bootstrap_cmd;` after `pub mod commands;`; register two commands in `invoke_handler`)
- Modify: `src-tauri/src/commands.rs` (add the two `#[tauri::command]` wrappers)

**Interfaces:**
- Consumes: `kriyon_core::bootstrap::{worktree_path_for, detect_install, env_files_to_copy}` (Task 1).
- Produces (Task 9 relies on the bridge names; the command names are registered here):

```rust
// bootstrap_cmd.rs
pub struct BootstrapStep { pub label: String, pub ok: bool }   // serde camelCase
pub struct BootstrapReport { pub ok: bool, pub steps: Vec<BootstrapStep>, pub output: String } // camelCase
pub fn bootstrap_worktree(repo_root: &str, worktree_path: &str, setup_cmd: Option<&str>) -> BootstrapReport;

// commands.rs
#[tauri::command] pub fn worktree_path(repo_path: String, branch: String) -> Result<String, String>;
#[tauri::command] pub async fn bootstrap_worktree(repo_path: String, worktree_path: String, setup_cmd: Option<String>) -> Result<BootstrapReport, String>;
```

- [ ] **Step 1: Write the failing test.** Create `src-tauri/src/bootstrap_cmd.rs` with the implementation stubbed as `unimplemented!()` is NOT allowed (it would panic); instead write the test module first against the real signatures, then implement in Step 3. Put this test module at the bottom of the file:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_env_and_runs_setup_command() {
        let repo = tempfile::tempdir().expect("repo dir");
        let wt = tempfile::tempdir().expect("worktree dir");
        std::fs::write(repo.path().join(".env"), "SECRET=1\n").expect("write .env");
        std::fs::write(repo.path().join("README.md"), "hi").expect("write readme");

        let report = bootstrap_worktree(
            repo.path().to_str().unwrap(),
            wt.path().to_str().unwrap(),
            Some("printf ok > setup-ran.txt"),
        );

        assert!(report.ok, "report: {report:?}");
        // .env copied, README not.
        assert!(wt.path().join(".env").exists(), "env copied");
        assert!(!wt.path().join("README.md").exists(), "only dotenv copied");
        // Setup command ran IN the worktree.
        assert!(wt.path().join("setup-ran.txt").exists(), "setup ran in worktree");
    }

    #[test]
    fn a_failing_setup_command_is_reported_not_panicked() {
        let repo = tempfile::tempdir().expect("repo dir");
        let wt = tempfile::tempdir().expect("worktree dir");
        let report = bootstrap_worktree(
            repo.path().to_str().unwrap(),
            wt.path().to_str().unwrap(),
            Some("exit 3"),
        );
        assert!(!report.ok, "a non-zero setup command fails the report");
        assert!(
            report.steps.iter().any(|s| s.label.contains("setup") && !s.ok),
            "the setup step is marked failed: {report:?}"
        );
    }

    #[test]
    fn no_lockfile_skips_install_and_still_succeeds() {
        let repo = tempfile::tempdir().expect("repo dir");
        let wt = tempfile::tempdir().expect("worktree dir");
        let report = bootstrap_worktree(repo.path().to_str().unwrap(), wt.path().to_str().unwrap(), None);
        assert!(report.ok, "no env, no lockfile, no setup → clean no-op");
        assert!(report.steps.iter().all(|s| s.ok));
    }
}
```

- [ ] **Step 2: Wire the module and run the test to verify it fails**

Add `pub mod bootstrap_cmd;` to `src-tauri/src/lib.rs` (after `pub mod commands;`).
Run: `cargo test -p kriyon bootstrap_cmd::`
Expected: FAIL — `cannot find function bootstrap_worktree` (compile error).

- [ ] **Step 3: Implement.** Prepend to `src-tauri/src/bootstrap_cmd.rs` (above the test module):

```rust
//! Thin shell-out for a [Worktree bootstrap]: copy the repo's untracked
//! top-level `.env*` files into a fresh worktree, run the lockfile-detected
//! install, then the project's optional setup command — all inside the
//! worktree. Best-effort: each step is recorded and the next still runs; a
//! failing step sets `ok = false` but never panics. Kept Tauri-free so it is
//! unit-testable. Pairs with the pure decisions in `kriyon_core::bootstrap`.

use std::process::Command;

use kriyon_core::bootstrap::{detect_install, env_files_to_copy, worktree_path_for};
use serde::Serialize;

pub use worktree_path_for as compute_worktree_path;

/// One step of a [`BootstrapReport`].
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapStep {
    pub label: String,
    pub ok: bool,
}

/// The outcome of a [Worktree bootstrap]: whether every step succeeded, the
/// per-step results, and the combined captured output (surfaced on failure).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapReport {
    pub ok: bool,
    pub steps: Vec<BootstrapStep>,
    pub output: String,
}

/// Copy `.env*`, run the detected install, then the optional setup command,
/// inside `worktree_path`. Best-effort and total.
#[must_use]
pub fn bootstrap_worktree(
    repo_root: &str,
    worktree_path: &str,
    setup_cmd: Option<&str>,
) -> BootstrapReport {
    let mut steps: Vec<BootstrapStep> = Vec::new();
    let mut output = String::new();

    // 1. Copy top-level dotenv files (they are gitignored, so the worktree lacks them).
    let listing: Vec<String> = std::fs::read_dir(repo_root)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    let mut copy_ok = true;
    for name in env_files_to_copy(&listing) {
        let from = std::path::Path::new(repo_root).join(&name);
        let to = std::path::Path::new(worktree_path).join(&name);
        if let Err(e) = std::fs::copy(&from, &to) {
            copy_ok = false;
            output.push_str(&format!("copy {name}: {e}\n"));
        }
    }
    if !listing.is_empty() {
        steps.push(BootstrapStep { label: "copy .env files".to_string(), ok: copy_ok });
    }

    // 2. Install dependencies, if a lockfile says how.
    let present: Vec<&str> = listing.iter().map(String::as_str).collect();
    if let Some(argv) = detect_install(&present) {
        let (ok, out) = run_in(worktree_path, argv);
        output.push_str(&out);
        steps.push(BootstrapStep { label: format!("install ({})", argv.join(" ")), ok });
    }

    // 3. The project's optional setup command, via `sh -c` in the worktree.
    if let Some(cmd) = setup_cmd.filter(|c| !c.trim().is_empty()) {
        let (ok, out) = run_in(worktree_path, &["sh", "-c", cmd]);
        output.push_str(&out);
        steps.push(BootstrapStep { label: format!("setup ({cmd})"), ok });
    }

    BootstrapReport { ok: steps.iter().all(|s| s.ok), steps, output }
}

/// Run `argv` in `dir`, returning (success, combined stdout+stderr). A spawn
/// failure (e.g. the tool is not installed) is a failed step, not a panic.
fn run_in(dir: &str, argv: &[&str]) -> (bool, String) {
    let Some((program, rest)) = argv.split_first() else {
        return (true, String::new());
    };
    match Command::new(program).args(rest).current_dir(dir).output() {
        Ok(out) => {
            let mut combined = String::from_utf8_lossy(&out.stdout).into_owned();
            combined.push_str(&String::from_utf8_lossy(&out.stderr));
            (out.status.success(), combined)
        }
        Err(e) => (false, format!("{}: {e}\n", argv.join(" "))),
    }
}
```

- [ ] **Step 4: Add the Tauri command wrappers.** Append to `src-tauri/src/commands.rs` (near the other git command wrappers). Add the import at the top of the file's use-block: `use crate::bootstrap_cmd::{bootstrap_worktree as run_bootstrap, BootstrapReport};` (place with the existing `use crate::…` lines).

```rust
/// Compute the canonical sibling worktree path for `branch` under `repo_path`.
///
/// # Errors
/// Infallible today; returns `Result` for command-signature uniformity.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn worktree_path(repo_path: String, branch: String) -> Result<String, String> {
    Ok(kriyon_core::bootstrap::worktree_path_for(&repo_path, &branch))
}

/// Bootstrap a freshly-created worktree: copy `.env*`, install deps, run the
/// project's optional setup command. Best-effort — a non-`ok` report is returned
/// (not an `Err`) so the caller can offer "Open anyway".
///
/// # Errors
/// Never returns `Err` today; the `Result` shape matches the other commands.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn bootstrap_worktree(
    repo_path: String,
    worktree_path: String,
    setup_cmd: Option<String>,
) -> Result<BootstrapReport, String> {
    Ok(run_bootstrap(&repo_path, &worktree_path, setup_cmd.as_deref()))
}
```

Register both in `src-tauri/src/lib.rs` `invoke_handler` (after `commands::merge_worktree,`):

```rust
            commands::worktree_path,
            commands::bootstrap_worktree,
```

- [ ] **Step 5: Add the bridge functions.** In `src/ipc/bridge.ts`, in the `// --- Git / worktrees ---` section (after `mergeWorktree`), add:

```ts
/** The canonical sibling worktree path for `branch` (mirrors Rust `worktree_path_for`). */
export function worktreePathFor(repoPath: string, branch: string): Promise<string> {
  return invoke("worktree_path", { repoPath, branch });
}

/** One step of a {@link BootstrapReport} (mirrors Rust `BootstrapStep`). */
export interface BootstrapStep {
  label: string;
  ok: boolean;
}

/** Outcome of a worktree bootstrap (mirrors Rust `BootstrapReport`). */
export interface BootstrapReport {
  ok: boolean;
  output: string;
  steps: BootstrapStep[];
}

/** Copy `.env*`, install deps, and run the project's setup command in a fresh worktree. */
export function bootstrapWorktree(
  repoPath: string,
  worktreePath: string,
  setupCmd: string | null
): Promise<BootstrapReport> {
  return invoke("bootstrap_worktree", { repoPath, worktreePath, setupCmd });
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cargo test -p kriyon bootstrap_cmd:: && cargo clippy -p kriyon --all-targets -- -D warnings && pnpm typecheck`
Expected: PASS (3 tests), no clippy warnings, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/bootstrap_cmd.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src/ipc/bridge.ts
git commit -m "feat(worktree): bootstrap command (copy env, install, setup) + worktree path"
```

---

### Task 3: `seed_prompt` command — path-contained handoff file

Writes the edited handoff prompt to `~/.claude/kriyon/run/<id>.prompt`, reusing `session_socket_path`'s id validation for path containment, and returns the absolute path.

**Files:**
- Modify: `src-tauri/src/commands.rs` (add the command; reuse `run_dir`, `session_socket_path`)
- Modify: `src-tauri/src/lib.rs` (register `commands::seed_prompt`)

**Interfaces:**
- Produces: `#[tauri::command] pub fn seed_prompt(app, id: String, text: String) -> Result<String, String>` returning the prompt file path. Task 4's bridge relies on the `seed_prompt` command name.

- [ ] **Step 1: Write the failing test.** Append to `mod tests` in `src-tauri/src/commands.rs` (if the file has no test module, create one at the end: `#[cfg(test)] mod tests { use super::*; … }`). This tests the id→path derivation and containment directly, without a Tauri `AppHandle`, by factoring the pure path step:

```rust
#[test]
fn seed_prompt_path_is_contained_and_typed() {
    let run = tempfile::tempdir().expect("run dir");
    // A valid id yields <run>/<id>.prompt.
    let path = seed_prompt_path(run.path(), "abc-123").expect("valid id");
    assert_eq!(path.file_name().unwrap().to_str().unwrap(), "abc-123.prompt");
    assert!(path.starts_with(run.path()), "stays inside the run dir");
    // A traversal id is rejected (same guard as the session socket).
    assert!(seed_prompt_path(run.path(), "../evil").is_none());
    assert!(seed_prompt_path(run.path(), "a/b").is_none());
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p kriyon seed_prompt_path`
Expected: FAIL — `cannot find function seed_prompt_path` (compile error).

- [ ] **Step 3: Implement.** In `src-tauri/src/commands.rs`, add the pure helper (near `run_dir`) and the command (near `create_session`):

```rust
/// The path of a session's seed-prompt file, `<run>/<id>.prompt`, or `None` if
/// `id` is not a valid session id. Reuses `session_socket_path`'s validation
/// (which enforces path containment) and swaps the extension, so the prompt file
/// is guaranteed to sit beside the socket inside the run dir.
fn seed_prompt_path(run: &std::path::Path, id: &str) -> Option<PathBuf> {
    kriyon_core::daemon::session_socket_path(run, id).map(|s| s.with_extension("prompt"))
}

/// Write a [Handoff prompt] to the session's path-contained prompt file and
/// return its absolute path, so the launcher can seed it via
/// `claude "$(cat <path>)"`. The id is validated before it touches the path.
///
/// # Errors
/// Returns an error string if HOME cannot be resolved, the id is invalid, or the
/// write fails.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn seed_prompt(app: tauri::AppHandle, id: String, text: String) -> Result<String, String> {
    let home = {
        use tauri::Manager as _;
        app.path()
            .home_dir()
            .ok()
            .or_else(|| std::env::var("HOME").ok().map(PathBuf::from))
            .ok_or_else(|| "cannot resolve HOME".to_string())?
    };
    let run = run_dir(&home);
    std::fs::create_dir_all(&run).map_err(|e| e.to_string())?;
    let path = seed_prompt_path(&run, &id).ok_or_else(|| "invalid session id".to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
```

Register in `src-tauri/src/lib.rs` `invoke_handler` (after `commands::bootstrap_worktree,`):

```rust
            commands::seed_prompt,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p kriyon seed_prompt_path && cargo clippy -p kriyon --all-targets -- -D warnings`
Expected: PASS, no clippy warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(session): seed_prompt writes a path-contained handoff prompt file"
```

---

### Task 4: Seed the launch + thread the prompt through the store

`launchClaudeOnce` gains an optional seed; a new non-persisted `pendingSeedPrompt` map carries it from spawn to activation; `App.tsx` passes and clears it.

**Files:**
- Modify: `src/ipc/bridge.ts` (add `seedPrompt`)
- Modify: `src/state/sessions.ts` (`pendingSeedPrompt` map + setter/consumer)
- Modify: `src/terminal/sessionHost.ts` (`launchClaudeOnce` seeding)
- Modify: `src/App.tsx` (pass + clear the seed)
- Test: `src/terminal/sessionHost.test.ts` (create if absent)

**Interfaces:**
- Consumes: `seed_prompt` command (Task 3).
- Produces (Task 9 relies on these): `useSessions` gains `pendingSeedPrompt: Record<string, string>`, `setPendingSeedPrompt(id, text)`, `consumePendingSeedPrompt(id): string | undefined`. `launchClaudeOnce(sessionId, claudeSessionId, seedPrompt?)`.

- [ ] **Step 1: Write the failing test.** Create/append `src/terminal/sessionHost.test.ts`. Because `launchClaudeOnce` writes to the real IPC, mock the bridge and assert the seeded command shape:

```ts
import { beforeEach, expect, test, vi } from "vitest";

const writes: string[] = [];
vi.mock("../ipc/bridge.ts", () => ({
  createSession: vi.fn(() => Promise.resolve(false)),
  closeSession: vi.fn(() => Promise.resolve()),
  reportDrained: vi.fn(() => Promise.resolve()),
  writeStdin: vi.fn((_id: string, data: Uint8Array) => {
    writes.push(new TextDecoder().decode(data));
    return Promise.resolve();
  }),
  seedPrompt: vi.fn(() => Promise.resolve("/run/s1.prompt")),
}));

import { ensureSession, launchClaudeOnce } from "./sessionHost.ts";

beforeEach(() => {
  writes.length = 0;
});

test("a seeded launch reads the prompt file and self-cleans", async () => {
  await ensureSession("s1", "/repo", () => {});
  const launched = await launchClaudeOnce("s1", null, "Continue the work");
  expect(launched).toBe(true);
  // Reads the file into a var, removes it, launches claude with it — quoted.
  expect(writes.at(-1)).toBe(
    'p="$(cat "/run/s1.prompt")"; rm -f "/run/s1.prompt"; claude "$p"\r'
  );
});

test("an unseeded launch is a plain claude", async () => {
  await ensureSession("s2", "/repo", () => {});
  await launchClaudeOnce("s2", null);
  expect(writes.at(-1)).toBe("claude\r");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/terminal/sessionHost.test.ts`
Expected: FAIL — `launchClaudeOnce` ignores the third arg (still writes `claude\r`).

- [ ] **Step 3: Implement.**

(a) `src/ipc/bridge.ts` — add near `createSession`:

```ts
/**
 * Write a session's seed [Handoff prompt] to a path-contained file and resolve
 * to its absolute path, so the launcher can start `claude "$(cat <path>)"`.
 */
export function seedPrompt(id: string, text: string): Promise<string> {
  return invoke("seed_prompt", { id, text });
}
```

(b) `src/state/sessions.ts` — add to `SessionsState` (interface, alphabetical among fields/actions):

```ts
  /** In-memory seed prompts for follow-up sessions, consumed at first launch. Never persisted. */
  pendingSeedPrompt: Record<string, string>;
  setPendingSeedPrompt: (id: string, text: string) => void;
  consumePendingSeedPrompt: (id: string) => string | undefined;
```

Initialize in the store object (next to `pendingPrompts: {}`): `pendingSeedPrompt: {},` and add the actions:

```ts
  setPendingSeedPrompt: (id, text) =>
    set((state) => ({
      pendingSeedPrompt: { ...state.pendingSeedPrompt, [id]: text },
    })),

  consumePendingSeedPrompt: (id) => {
    const text = useSessions.getState().pendingSeedPrompt[id];
    if (text !== undefined) {
      set((state) => {
        const next = { ...state.pendingSeedPrompt };
        delete next[id];
        return { pendingSeedPrompt: next };
      });
    }
    return text;
  },
```

(c) `src/terminal/sessionHost.ts` — import `seedPrompt` and change the launch. Update the import block:

```ts
import {
  closeSession as closeSessionIpc,
  createSession,
  reportDrained,
  seedPrompt,
  writeStdin,
} from "../ipc/bridge.ts";
```

Change the signature and command build (replace lines ~146–171):

```ts
export async function launchClaudeOnce(
  sessionId: string,
  claudeSessionId: string | null,
  seed?: string
): Promise<boolean> {
  const host = hosts.get(sessionId);
  if (!host || host.launched) {
    return false;
  }
  host.launched = true;

  try {
    await host.ready;
  } catch {
    return false;
  }

  if (host.reattached) {
    return false;
  }

  const resumable = claudeSessionId && SAFE_CLAUDE_ID.test(claudeSessionId);
  let command: string;
  if (resumable) {
    command = `claude --resume ${claudeSessionId}\r`;
  } else if (seed && seed.trim() !== "") {
    // Seed the first prompt as a launch ARGUMENT (not keystroke injection): the
    // prompt lives in a Kriyon-written, path-contained file, so no user text is
    // ever shell-escaped. Read it into a var, remove the file, launch claude.
    // `$(…)` strips the trailing newline; both the path and the value are quoted.
    const path = await seedPrompt(sessionId, seed).catch(() => null);
    command = path
      ? `p="$(cat "${path}")"; rm -f "${path}"; claude "$p"\r`
      : "claude\r";
  } else {
    command = "claude\r";
  }

  await writeStdin(sessionId, new TextEncoder().encode(command)).catch(() => {
    // ignored
  });

  return true;
}
```

(d) `src/App.tsx` — pass the seed at activation (replace the `launchClaudeOnce(id, session.claudeSessionId)` call at ~line 148):

```tsx
      launchClaudeOnce(
        id,
        session.claudeSessionId,
        useSessions.getState().consumePendingSeedPrompt(id)
      ).then((launched) => {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/terminal/sessionHost.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/ipc/bridge.ts src/state/sessions.ts src/terminal/sessionHost.ts src/App.tsx src/terminal/sessionHost.test.ts
git commit -m "feat(session): seed a follow-up's first prompt via launch argument"
```

---

### Task 5: Persist `archivedAt` + `setupCommand`

`sessions.archived_at` (soft archive) and `projects.setup_command` (the optional per-project [Setup command]), both nullable with idempotent migrations mirroring `migrate_claude_session_id`.

**Files:**
- Modify: `crates/kriyon-core` is NOT touched — the store lives in `src-tauri/src/store.rs`.
- Modify: `src-tauri/src/store.rs` (both structs, schema, migrations, upsert/list, tests)

**Interfaces:**
- Produces: `SessionRow` gains `pub archived_at: Option<i64>` (serde `archivedAt`); `ProjectRow` gains `pub setup_command: Option<String>` (serde `setupCommand`). Task 6's TS mirrors rely on these field names.

- [ ] **Step 1: Write the failing tests.** In `src-tauri/src/store.rs` `mod tests`, add:

```rust
#[test]
fn session_round_trips_archived_at() {
    let store = Store::open_in_memory().expect("open");
    store.upsert_project(&sample_project()).expect("project");
    let session = SessionRow { archived_at: Some(1_720_000_000), ..sample_session() };
    store.upsert_session(&session).expect("upsert");
    assert_eq!(store.list_sessions().expect("list"), vec![session]);
}

#[test]
fn project_round_trips_setup_command() {
    let store = Store::open_in_memory().expect("open");
    let project = ProjectRow {
        setup_command: Some("docker compose up -d".to_string()),
        ..sample_project()
    };
    store.upsert_project(&project).expect("upsert");
    assert_eq!(store.list_projects().expect("list"), vec![project]);
}

#[test]
fn migrates_tables_missing_the_new_columns() {
    let conn = Connection::open_in_memory().expect("open");
    conn.execute_batch(
        "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, color TEXT);
         CREATE TABLE sessions (
             id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
             cwd TEXT NOT NULL, worktree_path TEXT, created_at INTEGER NOT NULL, claude_session_id TEXT
         );
         INSERT INTO projects (id,name,path) VALUES ('p1','Old','/tmp');
         INSERT INTO sessions (id,project_id,title,cwd,created_at) VALUES ('s1','p1','Old','/tmp',1000);",
    )
    .expect("seed legacy schema");
    let store = Store::from_connection(conn).expect("migrate on open");
    assert_eq!(store.list_sessions().expect("list")[0].archived_at, None);
    assert_eq!(store.list_projects().expect("list")[0].setup_command, None);
}
```

Also update the two sample builders so existing tests still compile — add `archived_at: None,` to `sample_session()` and `setup_command: None,` to `sample_project()`, and add the fields to the literal in `upsert_session_updates_in_place` (`archived_at: None,`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p kriyon store::`
Expected: FAIL — `missing field archived_at` / `no field setup_command` (compile error).

- [ ] **Step 3: Implement.** In `src-tauri/src/store.rs`:

(a) Add the fields:

```rust
// in ProjectRow, after `pub color: Option<String>,`
    /// The project's optional per-worktree [Setup command], run at the end of a
    /// [Worktree bootstrap]. `None` = no custom step.
    pub setup_command: Option<String>,
```

```rust
// in SessionRow, after `pub claude_session_id: Option<String>,`
    /// When the session was archived (ms since epoch), or `None` while active.
    /// A soft flag: the transcript and worktree are untouched.
    pub archived_at: Option<i64>,
```

(b) Extend the schema in `init_schema` (`projects` gets `setup_command TEXT`, `sessions` gets `archived_at INTEGER`) and add both migrations after `self.migrate_claude_session_id()?;`:

```rust
        self.migrate_column("projects", "setup_command", "TEXT")?;
        self.migrate_column("sessions", "archived_at", "INTEGER")?;
```

Replace the bespoke `migrate_claude_session_id` with a reusable helper (keep `migrate_claude_session_id` calling it, or inline — simplest is to add the generic one and call it for all three):

```rust
    /// Add `column <ty>` to `table` if it is missing. A "duplicate column" error
    /// means the migration already ran, which is not a failure.
    fn migrate_column(&self, table: &str, column: &str, ty: &str) -> Result<(), StoreError> {
        match self
            .conn
            .execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {ty}"), [])
        {
            Ok(_) => Ok(()),
            Err(rusqlite::Error::SqliteFailure(_, Some(msg))) if msg.contains("duplicate column") => {
                Ok(())
            }
            Err(e) => Err(StoreError::Sqlite(e)),
        }
    }
```

Keep the existing `migrate_claude_session_id` too (called before these), or replace its body with `self.migrate_column("sessions", "claude_session_id", "TEXT")` — either is fine; do NOT remove its call site.

(c) Update `upsert_project` (add `setup_command` to columns, values `?5`, and the conflict SET), `list_projects` (SELECT it, `setup_command: row.get(4)?`), `upsert_session` (add `archived_at` as `?8`, conflict SET), and `list_sessions` (SELECT it, `archived_at: row.get(7)?`). The full new statements:

```rust
// upsert_project
    "INSERT INTO projects (id, name, path, color, setup_command)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, path = excluded.path,
         color = excluded.color, setup_command = excluded.setup_command",
    rusqlite::params![p.id, p.name, p.path, p.color, p.setup_command],
```

```rust
// list_projects SELECT + mapping
    "SELECT id, name, path, color, setup_command FROM projects ORDER BY name"
    // …
        setup_command: row.get(4)?,
```

```rust
// upsert_session
    "INSERT INTO sessions
         (id, project_id, title, cwd, worktree_path, created_at, claude_session_id, archived_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(id) DO UPDATE SET
         project_id = excluded.project_id, title = excluded.title,
         cwd = excluded.cwd, worktree_path = excluded.worktree_path,
         created_at = excluded.created_at, claude_session_id = excluded.claude_session_id,
         archived_at = excluded.archived_at",
    rusqlite::params![
        s.id, s.project_id, s.title, s.cwd, s.worktree_path,
        s.created_at, s.claude_session_id, s.archived_at
    ],
```

```rust
// list_sessions SELECT + mapping
    "SELECT id, project_id, title, cwd, worktree_path, created_at, claude_session_id, archived_at
     FROM sessions ORDER BY created_at"
    // …
        archived_at: row.get(7)?,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p kriyon store:: && cargo clippy -p kriyon --all-targets -- -D warnings`
Expected: PASS (all, old + 3 new), no clippy warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/store.rs
git commit -m "feat(store): persist session archivedAt and project setupCommand"
```

---

### Task 6: Frontend mirrors + archive store actions

TS mirrors for the two new columns, persistence, and `UiSession.archivedAt` with `archiveSession`/`unarchiveSession`.

**Files:**
- Modify: `src/types.ts` (`ProjectRow.setupCommand`, `SessionRow.archivedAt`)
- Modify: `src/state/sessions.ts` (`UiSession.archivedAt` + `idleSession` + actions)
- Modify: `src/state/persistence.ts` (`persistKey` + `persist` carry the new fields)
- Test: `src/state/sessions.test.ts`

**Interfaces:**
- Produces (Tasks 9–13 rely on these): `UiSession.archivedAt: number | null`; `useSessions` gains `archiveSession(id)`, `unarchiveSession(id)`; `ProjectRow.setupCommand: string | null`; `SessionRow.archivedAt: number | null`.

- [ ] **Step 1: Write the failing tests.** Append to `src/state/sessions.test.ts` (reuse its existing helpers if present; otherwise a minimal session builder):

```ts
test("archiveSession stamps archivedAt and unarchive clears it", () => {
  const now = 1_720_000_000_000;
  useSessions.setState({
    sessions: {
      s1: {
        archivedAt: null,
        booting: false,
        claudeSessionId: null,
        createdAt: 1,
        cwd: "/repo",
        id: "s1",
        projectId: "p1",
        status: "idle",
        summary: "",
        title: "One",
        worktreePath: null,
      },
    },
  });
  useSessions.getState().archiveSession("s1");
  expect(useSessions.getState().sessions.s1?.archivedAt).toBeGreaterThan(0);
  useSessions.getState().unarchiveSession("s1");
  expect(useSessions.getState().sessions.s1?.archivedAt).toBeNull();
  expect(now).toBeGreaterThan(0); // anchor the clock reference
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/state/sessions.test.ts`
Expected: FAIL — `archiveSession is not a function`.

- [ ] **Step 3: Implement.**

(a) `src/types.ts` — add to `ProjectRow` (`setupCommand: string | null;`) and `SessionRow`:

```ts
export interface ProjectRow {
  color: string | null;
  id: string;
  name: string;
  path: string;
  /** Optional per-worktree setup command (mirrors Rust `setup_command`). */
  setupCommand: string | null;
}
```

```ts
// in SessionRow, add:
  /** When the session was archived (ms since epoch), or null while active. */
  archivedAt: number | null;
```

(b) `src/state/sessions.ts` — `UiSession` gains `archivedAt: number | null;` (alphabetical, first field). `idleSession` already spreads the row, so `archivedAt` flows through — no change there. Add the actions to `SessionsState` and the store:

```ts
// interface SessionsState:
  archiveSession: (id: string) => void;
  unarchiveSession: (id: string) => void;
```

```ts
// store body:
  archiveSession: (id) =>
    set((state) => {
      const session = state.sessions[id];
      if (!session || session.archivedAt !== null) {
        return state;
      }
      return {
        sessions: { ...state.sessions, [id]: { ...session, archivedAt: Date.now() } },
      };
    }),

  unarchiveSession: (id) =>
    set((state) => {
      const session = state.sessions[id];
      if (!session || session.archivedAt === null) {
        return state;
      }
      return {
        sessions: { ...state.sessions, [id]: { ...session, archivedAt: null } },
      };
    }),
```

Fix any `UiSession` / `SessionRow` / `ProjectRow` literal in QA fixtures and tests the compiler flags (`pnpm typecheck`), adding `archivedAt: null` / `setupCommand: null`.

(c) `src/state/persistence.ts` — carry the new fields. In `persistKey`, add to the project field join and the session field join:

```ts
  const projects = state.projects
    .map((p) => [p.id, p.name, p.path, p.color ?? "", p.setupCommand ?? ""].join(SEP))
    .join("\n");
  const sessions = Object.values(state.sessions)
    .map((s) =>
      [
        s.id, s.projectId, s.cwd, s.title,
        s.claudeSessionId ?? "", s.worktreePath ?? "",
        String(s.archivedAt ?? ""), s.createdAt,
      ].join(SEP)
    )
    .sort()
    .join("\n");
```

In `persist`, include the fields in the upserted rows:

```ts
  for (const project of state.projects) {
    ignore(upsertProject(project)); // already whole-row; setupCommand rides along
  }
  for (const session of Object.values(state.sessions)) {
    ignore(
      upsertSession({
        archivedAt: session.archivedAt,
        claudeSessionId: session.claudeSessionId,
        createdAt: session.createdAt,
        cwd: session.cwd,
        id: session.id,
        projectId: session.projectId,
        title: session.title,
        worktreePath: session.worktreePath,
      })
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/state/sessions.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/types.ts src/state/sessions.ts src/state/persistence.ts src/state/sessions.test.ts
git commit -m "feat(session): archivedAt flag + setupCommand mirror, persisted"
```

---

### Task 7: `buildHandoffPrompt` — the seed composer text

A pure function turning the predecessor's events + activity into an editable handoff prompt (reusing the CatchUpBrief digest shape).

**Files:**
- Create: `src/studio/handoffPrompt.ts`
- Test: `src/studio/handoffPrompt.test.ts`

**Interfaces:**
- Consumes: `buildCatchUpBrief`-style digest — reuse the counting by importing nothing new; compute inline from `StudioEvent[]` + `SessionActivity`.
- Produces (Task 9 relies on this): `buildHandoffPrompt(args: { title: string; events: StudioEvent[]; activity: SessionActivity | undefined }): string`.

- [ ] **Step 1: Write the failing tests.** Create `src/studio/handoffPrompt.test.ts`:

```ts
import { expect, test } from "vitest";
import type { SessionActivity, StudioEvent } from "../types.ts";
import { buildHandoffPrompt } from "./handoffPrompt.ts";

const activity: SessionActivity = {
  main: { currentTool: null },
  pendingAsk: null,
  shells: [],
  subagents: [],
  tasks: [],
};

test("summarizes recent work and leaves a steer line", () => {
  const events: StudioEvent[] = [
    { file: "Foo.tsx", id: "1:0", kind: "diff", hunks: [] },
    { cmd: "pnpm test", exit: 0, id: "2:0", kind: "bash", output: [] },
    { id: "3:0", kind: "assistant", text: "Landed the parser.\nNext: wire the UI." },
  ];
  const prompt = buildHandoffPrompt({ activity, events, title: "Parser work" });
  expect(prompt).toContain("Continuing from a previous session: Parser work");
  expect(prompt).toContain("Foo.tsx");
  expect(prompt).toContain("Ran 1 command");
  expect(prompt).toContain("Landed the parser.");
  // Ends with an empty steer line for the user to type into.
  expect(prompt.endsWith("\n")).toBe(true);
});

test("with no digestible events still yields a usable header", () => {
  const prompt = buildHandoffPrompt({ activity, events: [], title: "Fresh" });
  expect(prompt).toContain("Continuing from a previous session: Fresh");
  expect(prompt).toContain("Pick up where it left off");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/studio/handoffPrompt.test.ts`
Expected: FAIL — cannot resolve `./handoffPrompt.ts`.

- [ ] **Step 3: Implement.** Create `src/studio/handoffPrompt.ts`:

```ts
import type { SessionActivity, StudioEvent } from "../types.ts";
import { completedTasks } from "./catchUpBrief.ts";

/** Names shown before collapsing into a total. */
const MAX_FILE_NAMES = 5;

/** First non-empty line of a text, trimmed. */
function firstLine(text: string): string | null {
  const line = text.split("\n", 1)[0]?.trim() ?? "";
  return line || null;
}

/**
 * Compose an editable [Handoff prompt] seeding a [Follow-up session] from what
 * the predecessor did — files edited, commands run, subagents, completed tasks,
 * and its last line. Deterministic and zero-token (same digest as the
 * [Catch-up brief]); the user edits it before spawning. See CONTEXT.md.
 */
export function buildHandoffPrompt(args: {
  activity: SessionActivity | undefined;
  events: StudioEvent[];
  title: string;
}): string {
  const files: string[] = [];
  let commandsRun = 0;
  let subagentsRan = 0;
  let lastAssistant: string | null = null;
  for (const event of args.events) {
    if (event.kind === "diff" && !files.includes(event.file)) {
      files.push(event.file);
    } else if (event.kind === "bash") {
      commandsRun += 1;
    } else if (
      event.kind === "tool" &&
      (event.name === "Agent" || event.name === "Task")
    ) {
      subagentsRan += 1;
    } else if (event.kind === "assistant") {
      lastAssistant = firstLine(event.text) ?? lastAssistant;
    }
  }

  const lines: string[] = [`Continuing from a previous session: ${args.title}`, ""];
  const bullets: string[] = [];
  if (files.length > 0) {
    const shown = files.slice(0, MAX_FILE_NAMES).join(", ");
    const extra = files.length > MAX_FILE_NAMES ? ` (+${files.length - MAX_FILE_NAMES} more)` : "";
    bullets.push(`- Edited: ${shown}${extra}`);
  }
  if (commandsRun > 0) {
    bullets.push(`- Ran ${commandsRun} command${commandsRun === 1 ? "" : "s"}`);
  }
  if (subagentsRan > 0) {
    bullets.push(`- Ran ${subagentsRan} subagent${subagentsRan === 1 ? "" : "s"}`);
  }
  const done = completedTasks(args.activity);
  if (done > 0) {
    bullets.push(`- Completed ${done} task${done === 1 ? "" : "s"}`);
  }
  if (lastAssistant) {
    bullets.push(`- Last note: ${lastAssistant}`);
  }
  if (bullets.length > 0) {
    lines.push("Recent work:", ...bullets, "");
  }
  lines.push("Pick up where it left off:", "");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/studio/handoffPrompt.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/studio/handoffPrompt.ts src/studio/handoffPrompt.test.ts
git commit -m "feat(session): deterministic handoff-prompt composer"
```

---

### Task 8: `collision.ts` — same-checkout detection

Pure detection of a live session already occupying a candidate working directory.

**Files:**
- Create: `src/state/collision.ts`
- Test: `src/state/collision.test.ts`

**Interfaces:**
- Produces (Tasks 9 & 11 rely on these): `sessionWorkingDir(session): string`; `detectCollision(candidateDir, sessions, ignoreSessionId?): UiSession | null`.

- [ ] **Step 1: Write the failing tests.** Create `src/state/collision.test.ts`:

```ts
import { expect, test } from "vitest";
import type { UiSession } from "./sessions.ts";
import { detectCollision, sessionWorkingDir } from "./collision.ts";

function session(over: Partial<UiSession> & { id: string }): UiSession {
  return {
    archivedAt: null,
    booting: false,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "/repo",
    id: over.id,
    projectId: "p1",
    status: "running",
    summary: "",
    title: `T ${over.id}`,
    worktreePath: null,
    ...over,
  };
}

test("working dir prefers the worktree over the cwd", () => {
  expect(sessionWorkingDir(session({ id: "s", cwd: "/repo", worktreePath: "/wt" }))).toBe("/wt");
  expect(sessionWorkingDir(session({ id: "s", cwd: "/repo" }))).toBe("/repo");
});

test("a live session in the same dir collides", () => {
  const sessions = { a: session({ id: "a", cwd: "/repo" }) };
  expect(detectCollision("/repo", sessions)?.id).toBe("a");
});

test("a fresh worktree path never collides", () => {
  const sessions = { a: session({ id: "a", cwd: "/repo" }) };
  expect(detectCollision("/repo-worktrees/feat-x", sessions)).toBeNull();
});

test("archived sessions and the ignored session are skipped", () => {
  const sessions = {
    a: session({ archivedAt: 1, id: "a", cwd: "/repo" }),
    b: session({ id: "b", cwd: "/repo" }),
  };
  // Only 'b' would collide; ignoring it clears the collision.
  expect(detectCollision("/repo", sessions, "b")).toBeNull();
  // 'a' is archived, so with 'b' ignored nothing remains.
  expect(detectCollision("/repo", { a: sessions.a }, undefined)).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/state/collision.test.ts`
Expected: FAIL — cannot resolve `./collision.ts`.

- [ ] **Step 3: Implement.** Create `src/state/collision.ts`:

```ts
import type { UiSession } from "./sessions.ts";

/** The working directory a session occupies: its worktree if set, else its cwd. */
export function sessionWorkingDir(session: UiSession): string {
  if (session.worktreePath !== null && session.worktreePath !== "") {
    return session.worktreePath;
  }
  return session.cwd;
}

/**
 * A live, non-[Archived session] already working in `candidateDir`, or null.
 * The real file-collision hazard is two sessions in one checkout; a fresh
 * worktree has a unique path and so never collides. `ignoreSessionId` excludes
 * the session being spawned from (or the one whose dir is being re-checked).
 */
export function detectCollision(
  candidateDir: string,
  sessions: Record<string, UiSession>,
  ignoreSessionId?: string
): UiSession | null {
  for (const session of Object.values(sessions)) {
    if (session.id === ignoreSessionId || session.archivedAt !== null) {
      continue;
    }
    if (sessionWorkingDir(session) === candidateDir) {
      return session;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/state/collision.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/state/collision.ts src/state/collision.test.ts
git commit -m "feat(session): same-checkout collision detection"
```

---

### Task 9: `spawnFollowUpSession` orchestration

The single action tying it together: optional worktree create + bootstrap, session row with the right cwd/worktreePath, and the stashed seed prompt.

**Files:**
- Modify: `src/state/actions.ts` (add `spawnFollowUpSession`; generalize the internal `createSession`)
- Test: `src/state/actions.test.ts` (create if absent)

**Interfaces:**
- Consumes: `worktreePathFor`, `createWorktree`, `bootstrapWorktree` (bridge, Task 2); `setPendingSeedPrompt` (Task 4); `detectCollision`/`sessionWorkingDir` (Task 8).
- Produces (Tasks 11–12 rely on this): 

```ts
export async function spawnFollowUpSession(args: {
  predecessor: UiSession;
  project: ProjectRow;
  promptText: string;
  worktree: { branch: string } | null;
}): Promise<{ ok: boolean; bootstrap: BootstrapReport | null; error: string | null }>;
```

- [ ] **Step 1: Write the failing test.** Create `src/state/actions.test.ts`, mocking the bridge so no real git/IPC runs:

```ts
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({
  isTauriRuntime: () => true,
  pickDirectory: vi.fn(),
  worktreePathFor: vi.fn((_r: string, b: string) => Promise.resolve(`/repo-worktrees/${b}`)),
  createWorktree: vi.fn(() => Promise.resolve()),
  bootstrapWorktree: vi.fn(() => Promise.resolve({ ok: true, output: "", steps: [] })),
}));

import type { ProjectRow } from "../types.ts";
import { spawnFollowUpSession } from "./actions.ts";
import { type UiSession, useSessions } from "./sessions.ts";

const project: ProjectRow = { color: null, id: "p1", name: "Repo", path: "/repo", setupCommand: null };
const predecessor: UiSession = {
  archivedAt: null, booting: false, claudeSessionId: null, createdAt: 1,
  cwd: "/repo", id: "pre", projectId: "p1", status: "done", summary: "",
  title: "Predecessor", worktreePath: null,
};

beforeEach(() => {
  useSessions.setState({ activeSessionId: null, sessions: {}, projects: [], pendingSeedPrompt: {} });
});

test("a worktree follow-up creates the worktree, seeds the prompt, and activates", async () => {
  const result = await spawnFollowUpSession({
    predecessor, project, promptText: "Continue", worktree: { branch: "feat/x" },
  });
  expect(result.ok).toBe(true);
  const state = useSessions.getState();
  const created = Object.values(state.sessions).find((s) => s.id !== "pre");
  expect(created?.worktreePath).toBe("/repo-worktrees/feat/x");
  expect(created?.cwd).toBe("/repo-worktrees/feat/x");
  expect(state.activeSessionId).toBe(created?.id);
  // Seed stashed for the launch effect to consume.
  expect(state.pendingSeedPrompt[created?.id ?? ""]).toBe("Continue");
});

test("a same-checkout follow-up reuses the predecessor cwd, no worktree", async () => {
  const result = await spawnFollowUpSession({
    predecessor, project, promptText: "Continue", worktree: null,
  });
  expect(result.ok).toBe(true);
  const created = Object.values(useSessions.getState().sessions).find((s) => s.id !== "pre");
  expect(created?.worktreePath).toBeNull();
  expect(created?.cwd).toBe("/repo");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/state/actions.test.ts`
Expected: FAIL — `spawnFollowUpSession is not exported`.

- [ ] **Step 3: Implement.** In `src/state/actions.ts`:

(a) Extend imports:

```ts
import {
  bootstrapWorktree,
  createWorktree,
  isTauriRuntime,
  pickDirectory,
  worktreePathFor,
  type BootstrapReport,
} from "../ipc/bridge.ts";
import type { PastSession, ProjectRow } from "../types.ts";
import { idleSession, type UiSession, useSessions } from "./sessions.ts";
```

(b) Generalize the internal `createSession` to accept optional worktree/seed (default preserves every existing caller):

```ts
function createSession(
  project: ProjectRow,
  cwd: string,
  title: string,
  opts?: { worktreePath?: string | null; seedPrompt?: string }
): string {
  const state = useSessions.getState();
  state.addProject(project);
  const id = crypto.randomUUID();
  state.addSession(
    idleSession({
      archivedAt: null,
      claudeSessionId: null,
      createdAt: Date.now(),
      cwd,
      id,
      projectId: project.id,
      title,
      worktreePath: opts?.worktreePath ?? null,
    })
  );
  if (opts?.seedPrompt) {
    state.setPendingSeedPrompt(id, opts.seedPrompt);
  }
  state.setActiveSession(id);
  return id;
}
```

(The existing callers keep passing three args; add `return id;` changes nothing for them. Also add `archivedAt: null` to the `idleSession({…})` literal in `resumePastSession`.)

(c) Add the orchestration:

```ts
/**
 * Spawn a [Follow-up session] from `predecessor`, seeded with `promptText`.
 * When `worktree` is given, create and bootstrap a fresh [Worktree] first and
 * run the session there; otherwise run in the predecessor's working directory.
 * Returns the bootstrap report (if any) so the UI can surface a failed setup.
 */
export async function spawnFollowUpSession(args: {
  predecessor: UiSession;
  project: ProjectRow;
  promptText: string;
  worktree: { branch: string } | null;
}): Promise<{ bootstrap: BootstrapReport | null; error: string | null; ok: boolean }> {
  const { predecessor, project, promptText, worktree } = args;
  const repoRoot = project.path;
  const title = worktree ? worktree.branch : `${predecessor.title} (follow-up)`;

  if (!worktree) {
    createSession(project, predecessor.cwd, title, { seedPrompt: promptText });
    return { bootstrap: null, error: null, ok: true };
  }

  try {
    const path = await worktreePathFor(repoRoot, worktree.branch);
    await createWorktree(repoRoot, worktree.branch, path);
    const bootstrap = await bootstrapWorktree(repoRoot, path, project.setupCommand);
    createSession(project, path, title, { seedPrompt: promptText, worktreePath: path });
    return { bootstrap, error: null, ok: bootstrap.ok };
  } catch (e) {
    return { bootstrap: null, error: e instanceof Error ? e.message : String(e), ok: false };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/state/actions.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/state/actions.ts src/state/actions.test.ts
git commit -m "feat(session): spawnFollowUpSession orchestration (worktree + bootstrap + seed)"
```

---

### Task 10: Exclude archived sessions from the active surfaces

Archived sessions leave the Command center standings and the active sidebar groups, and gain a collapsed "Archived" group.

**Files:**
- Modify: `src/state/commandCenter.ts` (`buildStandings` skips archived)
- Modify: `src/sidebar/Sidebar.tsx` (active groups exclude archived; new Archived group)
- Test: `src/state/commandCenter.test.ts` (add a case)

**Interfaces:**
- Consumes: `UiSession.archivedAt` (Task 6), `unarchiveSession` (Task 6).
- Produces: `buildStandings` output no longer contains archived sessions.

- [ ] **Step 1: Write the failing test.** Append to `src/state/commandCenter.test.ts` (a test file exists for this module; match its imports/helpers):

```ts
test("buildStandings omits archived sessions", () => {
  const now = Date.now();
  const base = {
    booting: false, claudeSessionId: null, createdAt: 1, cwd: "/r",
    projectId: "p1", status: "running" as const, summary: "", title: "T", worktreePath: null,
  };
  const sessions = {
    live: { ...base, archivedAt: null, id: "live" },
    gone: { ...base, archivedAt: now - 1000, id: "gone" },
  };
  const standings = buildStandings(sessions, { live: now, gone: now }, {}, now);
  expect(standings.map((s) => s.sessionId)).toEqual(["live"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/state/commandCenter.test.ts`
Expected: FAIL — the archived session still appears.

- [ ] **Step 3: Implement.**

(a) `src/state/commandCenter.ts` — filter in `buildStandings`:

```ts
export function buildStandings(
  sessions: Record<string, UiSession>,
  lastSeen: Record<string, number>,
  lastChange: Record<string, number>,
  nowMs: number
): SessionStanding[] {
  return Object.values(sessions)
    .filter((s) => s.archivedAt === null)
    .map((s) => ({
      sessionId: s.id,
      projectId: s.projectId,
      worktree: s.worktreePath,
      state: standingState(s.status, lastSeen[s.id], nowMs),
      lastChangeMs: lastChange[s.id] ?? s.createdAt,
      lastSeenMs: lastSeen[s.id] ?? 0,
    }));
}
```

(b) `src/sidebar/Sidebar.tsx` — the `ProjectGroup` selects its sessions' ids; exclude archived there, and add an "Archived" group modeled on the existing "Earlier sessions"/project-group pattern. Read the file's current `ProjectGroup` id selector (~lines 488–590) and its group-header + list markup; apply the same shape:

- In `ProjectGroup`, where it derives the ordered session ids for the project, add `.filter((s) => s.archivedAt === null)` before mapping to ids (match the existing selector; it currently reads all sessions for the project id).
- Add an `ArchivedGroup` component after `ProjectGroup` that lists sessions with `archivedAt !== null` across all projects, collapsed by default, each row showing the title and an un-archive button calling `useSessions.getState().unarchiveSession(id)`. Render it once at the bottom of the sidebar body in `Sidebar(...)`, only when at least one archived session exists.

Concretely, add near the other memoized components:

```tsx
const ArchivedGroup = memo(function ArchivedGroup() {
  const archived = useSessions((state) =>
    Object.values(state.sessions).filter((s) => s.archivedAt !== null)
  );
  const [open, setOpen] = useState(false);
  if (archived.length === 0) {
    return null;
  }
  return (
    <div data-testid="archived-group" style={{ marginTop: tokens.space.md }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={archivedHeaderStyle}
        type="button"
      >
        {open ? "▾" : "▸"} Archived ({archived.length})
      </button>
      {open
        ? archived.map((s) => (
            <div key={s.id} style={archivedRowStyle}>
              <span style={archivedTitleStyle}>{s.title}</span>
              <button
                aria-label={`Unarchive ${s.title}`}
                data-testid={`unarchive-${s.id}`}
                onClick={() => useSessions.getState().unarchiveSession(s.id)}
                style={unarchiveButtonStyle}
                type="button"
              >
                Restore
              </button>
            </div>
          ))
        : null}
    </div>
  );
});
```

Define `archivedHeaderStyle`, `archivedRowStyle`, `archivedTitleStyle`, `unarchiveButtonStyle` as `CSSProperties` using `tokens` only (mirror the muted, hairline styling of the existing group header and the close button). Mount `<ArchivedGroup />` at the end of the sidebar's scrollable body in `Sidebar(...)`. Import `useState`/`memo` if not already imported (they are, for the other memoized rows).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/state/commandCenter.test.ts && pnpm typecheck`
Expected: PASS. (Sidebar has no unit test for this; verify visually in Task 11's QA pass.)

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/state/commandCenter.ts src/sidebar/Sidebar.tsx src/state/commandCenter.test.ts
git commit -m "feat(session): archived sessions leave active surfaces, gain a sidebar group"
```

---

### Task 11: `SpawnDialog` + palette verbs

The modal composer (pre-filled prompt, worktree toggle + branch + setup command, collision warning, bootstrap progress) and the two ⌘K entries.

**Files:**
- Modify: `src/state/ui.ts` (spawn-dialog open state)
- Create: `src/spawn/SpawnDialog.tsx`
- Modify: `src/palette/CommandPalette.tsx` (`commandItems`)
- Modify: `src/layout/Shell.tsx` (mount `<SpawnDialog />` beside `<CommandPalette />`)
- Test: `src/spawn/SpawnDialog.test.tsx`

**Interfaces:**
- Consumes: `spawnFollowUpSession` (Task 9); `buildHandoffPrompt` (Task 7); `detectCollision`/`sessionWorkingDir` (Task 8); `worktreePathFor` (bridge); `useSessions`, `useUi`, `tokens`, `CommandPalette` styles as a visual reference.
- Produces: `useUi` gains `spawnOpen: boolean`, `spawnPredecessorId: string | null`, `openSpawn(predecessorId: string | null)`, `closeSpawn()`. `<SpawnDialog />` mounted globally.

- [ ] **Step 1: Write the failing tests.** Create `src/spawn/SpawnDialog.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({
  worktreePathFor: vi.fn((_r: string, b: string) => Promise.resolve(`/repo-worktrees/${b}`)),
  createWorktree: vi.fn(() => Promise.resolve()),
  bootstrapWorktree: vi.fn(() => Promise.resolve({ ok: true, output: "", steps: [] })),
  isTauriRuntime: () => true,
  pickDirectory: vi.fn(),
}));

import { type UiSession, useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import type { ProjectRow } from "../types.ts";
import { SpawnDialog } from "./SpawnDialog.tsx";

const project: ProjectRow = { color: null, id: "p1", name: "Repo", path: "/repo", setupCommand: null };
function session(over: Partial<UiSession> & { id: string }): UiSession {
  return {
    archivedAt: null, booting: false, claudeSessionId: null, createdAt: 1, cwd: "/repo",
    id: over.id, projectId: "p1", status: "done", summary: "", title: `T ${over.id}`,
    worktreePath: null, ...over,
  };
}

beforeEach(() => {
  useSessions.setState({
    activeSessionId: "pre", events: {}, activity: {},
    projects: [project], sessions: { pre: session({ id: "pre" }) },
    pendingSeedPrompt: {},
  });
  useUi.setState({ spawnOpen: true, spawnPredecessorId: "pre" });
});

test("opens with a pre-filled, editable prompt", () => {
  render(<SpawnDialog />);
  const box = screen.getByTestId("spawn-prompt") as HTMLTextAreaElement;
  expect(box.value).toContain("Continuing from a previous session");
});

test("toggling worktree reveals the branch field and warns of no collision", () => {
  render(<SpawnDialog />);
  fireEvent.click(screen.getByTestId("spawn-worktree-toggle"));
  expect(screen.getByTestId("spawn-branch")).toBeTruthy();
  // A fresh worktree never collides.
  expect(screen.queryByTestId("spawn-collision")).toBeNull();
});

test("a same-checkout spawn warns about the occupying session", () => {
  useSessions.setState((s) => ({ sessions: { ...s.sessions, other: session({ id: "other", cwd: "/repo" }) } }));
  render(<SpawnDialog />);
  // worktree off by default → runs in /repo, where 'other' is live.
  expect(screen.getByTestId("spawn-collision").textContent).toContain("already working");
});

test("escape closes the dialog", () => {
  render(<SpawnDialog />);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(useUi.getState().spawnOpen).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/spawn/SpawnDialog.test.tsx`
Expected: FAIL — cannot resolve `./SpawnDialog.tsx`.

- [ ] **Step 3: Implement.**

(a) `src/state/ui.ts` — extend the store (keep the mutual-exclusion pattern with palette/needsYou):

```ts
interface UiState {
  closeNeedsYou: () => void;
  closePalette: () => void;
  closeSpawn: () => void;
  needsYouOpen: boolean;
  openNeedsYou: () => void;
  openPalette: () => void;
  openSpawn: (predecessorId: string | null) => void;
  paletteOpen: boolean;
  spawnOpen: boolean;
  spawnPredecessorId: string | null;
  togglePalette: () => void;
}
```

Store additions:

```ts
  spawnOpen: false,
  spawnPredecessorId: null,
  openSpawn: (predecessorId) =>
    set({ needsYouOpen: false, paletteOpen: false, spawnOpen: true, spawnPredecessorId: predecessorId }),
  closeSpawn: () => set({ spawnOpen: false }),
```

Also, in `openPalette`/`openNeedsYou`, add `spawnOpen: false` so the three surfaces never stack.

(b) Create `src/spawn/SpawnDialog.tsx`. Model the overlay/backdrop/panel styling on `CommandPalette.tsx` (reuse its `tokens`-based look; do not import its private styles — redeclare equivalents). The component:

```tsx
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { spawnFollowUpSession } from "../state/actions.ts";
import { detectCollision, sessionWorkingDir } from "../state/collision.ts";
import { useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import { buildHandoffPrompt } from "../studio/handoffPrompt.ts";
import { tokens } from "../theme/tokens.ts";

// overlayStyle / backdropStyle / panelStyle: copy the shape from CommandPalette,
// (fixed inset overlay, blurred backdrop button, tokens.color.glass.overlay panel).

export function SpawnDialog() {
  const open = useUi((s) => s.spawnOpen);
  const predecessorId = useUi((s) => s.spawnPredecessorId);
  const closeSpawn = useUi((s) => s.closeSpawn);

  const predecessor = useSessions((s) => (predecessorId ? s.sessions[predecessorId] : undefined));
  const project = useSessions((s) =>
    predecessor ? s.projects.find((p) => p.id === predecessor.projectId) : undefined
  );
  const events = useSessions((s) => (predecessorId ? s.events[predecessorId] : undefined));
  const activity = useSessions((s) => (predecessorId ? s.activity[predecessorId] : undefined));
  const sessions = useSessions((s) => s.sessions);

  const seed = useMemo(
    () =>
      predecessor
        ? buildHandoffPrompt({ activity, events: events ?? [], title: predecessor.title })
        : "",
    [predecessor, events, activity]
  );

  const [prompt, setPrompt] = useState(seed);
  const [useWorktree, setUseWorktree] = useState(false);
  const [branch, setBranch] = useState("");
  const [setupCmd, setSetupCmd] = useState(project?.setupCommand ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset local state each time the dialog (re)opens for a predecessor.
  useEffect(() => {
    if (open) {
      setPrompt(seed);
      setUseWorktree(false);
      setBranch(predecessor ? `wt/${predecessor.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "followup"}` : "");
      setSetupCmd(project?.setupCommand ?? "");
      setError(null);
    }
  }, [open, seed, predecessor, project]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!open) {
        return;
      }
      if (e.key === "Escape") {
        closeSpawn();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void confirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!(open && predecessor && project)) {
    return null;
  }

  // Collision only for a same-checkout spawn (worktree off). A fresh worktree
  // path is unique, so it can never collide.
  const collision = useWorktree
    ? null
    : detectCollision(sessionWorkingDir(predecessor), sessions, predecessor.id);

  async function confirm() {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    // Persist the (possibly edited) setup command onto the project for reuse.
    if (useWorktree && setupCmd !== (project.setupCommand ?? "")) {
      useSessions.getState().addProject({ ...project, setupCommand: setupCmd || null });
      // addProject is add-only; also update in place:
      useSessions.setState((s) => ({
        projects: s.projects.map((p) => (p.id === project.id ? { ...p, setupCommand: setupCmd || null } : p)),
      }));
    }
    const result = await spawnFollowUpSession({
      predecessor,
      project: { ...project, setupCommand: setupCmd || null },
      promptText: prompt,
      worktree: useWorktree ? { branch } : null,
    });
    setBusy(false);
    if (result.ok || result.bootstrap) {
      // Success, or bootstrap ran with warnings — the session exists; close.
      if (result.error) {
        setError(result.error);
        return;
      }
      closeSpawn();
    } else if (result.error) {
      setError(result.error);
    } else {
      closeSpawn();
    }
  }

  return (
    <div data-testid="spawn-dialog" style={overlayStyle}>
      <button aria-label="Close" onClick={closeSpawn} style={backdropStyle} type="button" />
      <div style={panelStyle}>
        <textarea
          data-testid="spawn-prompt"
          onChange={(e) => setPrompt(e.target.value)}
          style={promptStyle}
          value={prompt}
        />
        <label style={toggleRowStyle}>
          <input
            checked={useWorktree}
            data-testid="spawn-worktree-toggle"
            onChange={(e) => setUseWorktree(e.target.checked)}
            type="checkbox"
          />
          Run in a fresh worktree
        </label>
        {useWorktree ? (
          <>
            <input
              data-testid="spawn-branch"
              onChange={(e) => setBranch(e.target.value)}
              placeholder="branch name"
              style={fieldStyle}
              value={branch}
            />
            <input
              data-testid="spawn-setup"
              onChange={(e) => setSetupCmd(e.target.value)}
              placeholder="Setup command (optional)"
              style={fieldStyle}
              value={setupCmd}
            />
          </>
        ) : null}
        {collision ? (
          <span data-testid="spawn-collision" style={warnStyle}>
            {collision.title} is already working in {sessionWorkingDir(collision)}
          </span>
        ) : null}
        {error ? <span style={warnStyle}>{error}</span> : null}
        <div style={actionsStyle}>
          <button onClick={closeSpawn} style={secondaryStyle} type="button">
            Cancel
          </button>
          <button data-testid="spawn-confirm" disabled={busy} onClick={() => void confirm()} style={primaryStyle} type="button">
            {busy ? "Setting up…" : collision ? "Open anyway" : "Spawn"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

Declare the referenced `CSSProperties` consts (`overlayStyle`, `backdropStyle`, `panelStyle`, `promptStyle`, `toggleRowStyle`, `fieldStyle`, `warnStyle`, `actionsStyle`, `primaryStyle`, `secondaryStyle`) using `tokens` only, mirroring `CommandPalette`'s visual language (blurred backdrop, glass panel, accent primary button). Fix the deliberate lint note: the two `useEffect` hooks must sit above the early `return null` — React hooks run unconditionally. Move the `collision`/`confirm`/JSX below the guard; keep both `useEffect`s and all `useState`/`useMemo` above it. (Rewrite so every hook precedes `if (!(open && predecessor && project)) return null;`.)

(c) `src/palette/CommandPalette.tsx` — add two `commandItems` (after "New session in folder…"):

```tsx
    {
      icon: "⤳",
      id: "cmd:spawn-followup",
      kind: "Action",
      label: "Spawn follow-up session…",
      run: () => {
        const { activeSessionId } = useSessions.getState();
        useUi.getState().openSpawn(activeSessionId);
      },
    },
```

`useUi` is already imported in this file. When there is no active session, `openSpawn(null)` → `SpawnDialog` renders null (its guard), which is acceptable.

(d) `src/layout/Shell.tsx` — mount `<SpawnDialog />` next to `<CommandPalette />` (find the `<CommandPalette />` mount, ~line 405, and add `<SpawnDialog />` beside it; import it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/spawn/SpawnDialog.test.tsx && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/state/ui.ts src/spawn/SpawnDialog.tsx src/palette/CommandPalette.tsx src/layout/Shell.tsx src/spawn/SpawnDialog.test.tsx
git commit -m "feat(session): spawn dialog + palette verbs for follow-up sessions"
```

---

### Task 12: Session-row overflow menu (Spawn follow-up + Archive)

A hover-revealed "⋯" on each session row opening a tiny menu, reusing the existing `kr-reveal` hover pattern.

**Files:**
- Modify: `src/sidebar/Sidebar.tsx` (`SessionRow`: add the overflow button + menu)
- Test: `src/sidebar/Sidebar.test.tsx` (add a case if the file exists; else assert via the QA seam in Step 4)

**Interfaces:**
- Consumes: `useUi.openSpawn` (Task 11), `useSessions.archiveSession` (Task 6).
- Produces: per-row `data-testid={`session-menu-${id}`}` button; menu with `spawn-followup-${id}` and `archive-${id}` items.

- [ ] **Step 1: Write the failing test.** If `src/sidebar/Sidebar.test.tsx` exists, append (matching its render/store setup); otherwise create it rendering a single `SessionRow` via the exported component:

```tsx
test("the row overflow menu spawns a follow-up and archives", () => {
  // seed one session 's1' active in the store (match existing helpers)…
  render(<SessionRow onCloseSession={() => {}} onSelect={() => {}} sessionId="s1" />);
  fireEvent.click(screen.getByTestId("session-menu-s1"));
  fireEvent.click(screen.getByTestId("archive-s1"));
  expect(useSessions.getState().sessions.s1?.archivedAt).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/sidebar/Sidebar.test.tsx`
Expected: FAIL — `session-menu-s1` not found.

- [ ] **Step 3: Implement.** In `SessionRow` (`src/sidebar/Sidebar.tsx`), add local `const [menuOpen, setMenuOpen] = useState(false);` and, beside the existing close button, an overflow button + a small absolutely-positioned menu:

```tsx
      <button
        aria-label={`Actions for ${session.title}`}
        className="kr-reveal"
        data-testid={`session-menu-${sessionId}`}
        onClick={(event) => {
          event.stopPropagation();
          setMenuOpen((v) => !v);
        }}
        style={menuButtonStyle}
        type="button"
      >
        ⋯
      </button>
      {menuOpen ? (
        <div style={menuStyle}>
          <button
            data-testid={`spawn-followup-${sessionId}`}
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(false);
              useUi.getState().openSpawn(sessionId);
            }}
            style={menuItemStyle}
            type="button"
          >
            Spawn follow-up
          </button>
          <button
            data-testid={`archive-${sessionId}`}
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(false);
              useSessions.getState().archiveSession(sessionId);
            }}
            style={menuItemStyle}
            type="button"
          >
            Archive
          </button>
        </div>
      ) : null}
```

Add `menuButtonStyle` (mirror `closeButtonStyle`), `menuStyle` (absolute, `tokens.color.glass.overlay`, hairline border, `tokens.shadow.pop`, small z above the row), and `menuItemStyle` (full-width, left-aligned, hover surface) using `tokens` only. Import `useUi` at the top of `Sidebar.tsx` if not present. Ensure `SessionRow`'s container has `position: "relative"` so the menu anchors to the row (the row style likely already sets it; if not, add it to `sessionRowStyle`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/sidebar/Sidebar.test.tsx && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/sidebar/Sidebar.tsx src/sidebar/Sidebar.test.tsx
git commit -m "feat(session): session-row overflow menu (spawn follow-up, archive)"
```

---

### Task 13: Merge-triggered archive offer

After a clean merge in `ReviewPanel`, offer to archive (and optionally remove the worktree).

**Files:**
- Modify: `src/inspector/ReviewPanel.tsx` (offer banner after `MergeOutcome::Clean`)
- Test: `src/inspector/ReviewPanel.test.tsx` (add a case; the file exists)

**Interfaces:**
- Consumes: `useSessions.archiveSession` (Task 6); `removeWorktree` (bridge, existing); the active session id.
- Produces: after a clean merge, `merge-archive-offer` with `merge-archive` and `merge-archive-remove` buttons.

- [ ] **Step 1: Write the failing test.** Append to `src/inspector/ReviewPanel.test.tsx` (mirror its existing bridge mocks; it already mocks `defaultBranch`/`diffWorktree`/`mergeWorktree`). Add `removeWorktree` to the mock and:

```tsx
test("a clean merge offers to archive the session", async () => {
  // arrange: mocks return a one-file diff and a clean merge (match existing patterns)…
  // seed an active session 's1' with a worktreePath in the store…
  render(<ReviewPanel branch="feat/x" repoRoot="/repo" worktreePath="/repo-worktrees/feat-x" />);
  fireEvent.click(screen.getByText("Review changes"));
  await screen.findByText(/Merge feat\/x/);
  fireEvent.click(screen.getByText(/Merge feat\/x/));
  const archive = await screen.findByTestId("merge-archive");
  fireEvent.click(archive);
  expect(useSessions.getState().sessions.s1?.archivedAt).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/inspector/ReviewPanel.test.tsx`
Expected: FAIL — `merge-archive` not found.

- [ ] **Step 3: Implement.** In `src/inspector/ReviewPanel.tsx`:

- Import `removeWorktree` from the bridge and `useSessions`.
- After the `{merge ? <MergeResult … /> : null}` line, add the offer (only for a clean merge):

```tsx
          {merge?.kind === "clean" ? (
            <div data-testid="merge-archive-offer" style={{ marginTop: "8px" }}>
              <span style={mutedStyle}>Branch merged cleanly — tidy this session?</span>
              <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
                <button
                  data-testid="merge-archive"
                  onClick={() => {
                    const id = useSessions.getState().activeSessionId;
                    if (id) {
                      useSessions.getState().archiveSession(id);
                    }
                  }}
                  style={buttonStyle}
                  type="button"
                >
                  Archive
                </button>
                <button
                  data-testid="merge-archive-remove"
                  onClick={() => {
                    const id = useSessions.getState().activeSessionId;
                    if (id) {
                      useSessions.getState().archiveSession(id);
                    }
                    // Best-effort worktree removal; git refuses on a dirty tree.
                    void removeWorktree(repoRoot, worktreePath).catch(() => {
                      // surfaced by the user's own terminal if it matters
                    });
                  }}
                  style={buttonStyle}
                  type="button"
                >
                  Archive & remove worktree
                </button>
              </div>
            </div>
          ) : null}
```

(`buttonStyle`/`mutedStyle` already exist in this file.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/inspector/ReviewPanel.test.tsx && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/inspector/ReviewPanel.tsx src/inspector/ReviewPanel.test.tsx
git commit -m "feat(session): offer archive (and worktree cleanup) after a clean merge"
```

---

### Task 14: Full green + browser QA

- [ ] **Step 1: Whole-suite green**

Run: `pnpm check` (typecheck + lint + frontend tests) and `cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings`.
Expected: PASS. Ignore pre-existing failures from other sessions' unrelated WIP (PTY/font) — confirm any failure is not in files this plan touched before dismissing it.

- [ ] **Step 2: Browser QA via the `window.__kriyon` seam** (see `src/dev/`)

`pnpm dev` (reuse port 1420 if the other session already serves it; reload to clear seeded state). With Playwright + the QA seam:
- Seed a session, open ⌘K → "Spawn follow-up session…" → the dialog shows a pre-filled prompt; toggle worktree reveals branch + setup fields.
- Seed a second session in the same folder → the dialog (worktree off) shows the collision warning; confirm button reads "Open anyway".
- Row "⋯" → Archive → the row leaves its project group and appears under "Archived (1)"; Restore returns it.
- Gotchas: standings go `unknown` after 6s without heartbeats (install a keepalive interval); a pane mount clears seeded `events` (re-seed via `appendEvent` after mount); settle ~400ms between a hotkey and the next key.

- [ ] **Step 3: Final commit (only if QA required doc/tweak changes)**

```bash
git add <only files this plan changed>
git commit -m "test(session): QA pass for session lifecycle verbs"
```

---

## Self-Review

**Spec coverage:**
- §4.1 spawn follow-up → Tasks 3, 4, 7, 9, 11, 12. ✓
- §4.2 worktree bootstrap → Tasks 1, 2; setup command persisted (5, 6) + edited in the dialog (11). ✓
- §4.3 collision → Tasks 8, 11. ✓
- §4.4 archive → Tasks 5, 6, 10, 12, 13. ✓
- §4.5 surfaces (palette, dialog, row menu, archived group, merge banner) → Tasks 10–13. ✓
- §5 error handling → bootstrap best-effort (2), seed fallback (4), collision/absence-tolerant (8), "Open anyway" (11). ✓
- §6 testing → each task is TDD; QA in Task 14. ✓

**Placeholder scan:** No `TODO`/`TBD` remain. Task 11 carries one real implementation instruction (React hooks must precede the `if (!(open && …)) return null;` guard — all `useState`/`useMemo`/`useEffect` above it), which is a correctness note, not a placeholder. The style consts each task references (`overlayStyle`, `menuStyle`, etc.) are specified by shape + which existing component to mirror, per the tokens-only rule.

**Type consistency:** `archivedAt`/`archived_at`, `setupCommand`/`setup_command`, `BootstrapReport`, `spawnFollowUpSession`, `worktreePathFor`, `seedPrompt`, `openSpawn` are used identically across tasks. Store actions `archiveSession`/`unarchiveSession`/`setPendingSeedPrompt`/`consumePendingSeedPrompt` match their definitions.

**Note on CONTEXT.md:** the spec's §3 vocabulary must be added to `CONTEXT.md` before/with Task 1 (repo rule: a term precedes its module/type name). Fold the `Follow-up session`, `Handoff prompt`, `Worktree bootstrap`, `Install command`, `Setup command`, `Branch collision`, and `Archived session` entries into `CONTEXT.md` as the first step of implementation (stage `CONTEXT.md` with Task 1's commit).
