# PTY daemon + worktree diff/merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 5 (final) of the Kriyon perf + command-center plan: a net-new git diff/merge review loop for worktree sessions, and an out-of-process per-session PTY daemon so a session survives an app crash.

**Architecture:** Two separable commits. (1) Git diff/merge: pure parsers in `kriyon-core::git` + thin `git_cmd` shell-outs + Tauri commands + a review UI inside the existing worktree surface. (2) PTY daemon: a new `kriyon-ptyd` binary owns the PTY (byte-proxy over a per-session Unix socket); the app talks to it through a `DaemonClient` that implements the existing `SessionEngine` trait, so the hot path and Phase-1 backpressure are unchanged.

**Tech Stack:** Rust (kriyon-core, src-tauri, new kriyon-ptyd bin), `portable-pty` 0.9, std Unix domain sockets (`std::os::unix::net`), Tauri v2 IPC, React + TypeScript + Vitest, `theme/tokens.ts`.

## Global Constraints

- Branch: `feat/session-activity` — **do not branch**, commit here. Conventional commits, no `--no-verify`.
- `pnpm check` (biome/ultracite lint + tsc + Vitest + `rust:fmt` + `rust:clippy -D warnings` pedantic + `rust:test`) must be green before every commit.
- TDD: write the failing test first, watch it fail, then implement.
- clippy `-D warnings`: no `as` casts (use `u32::try_from(..).unwrap_or(..)`, `f64::from`), no `assert_eq!` on floats, no `push_str(&format!())`.
- Biome vs tsc: avoid `.at()` (use `arr.slice(-1)` / indexing).
- No `.unwrap()`/`.expect()` in command handlers; parsers/watchers/daemon stay tolerant — never panic on malformed input.
- IPC is a trust boundary — validate every frontend-supplied path/id (`reject_flag_like`, `--` positional guard, session-id validation, path containment).
- Design values only from `src/theme/tokens.ts`; all IPC via `src/ipc/bridge.ts`; frontend does no IO/parsing/business logic.
- A term must appear in `CONTEXT.md` before it becomes a module/type/command name.
- Leave pre-existing uncommitted files out: `Cargo.lock` (unless a new dep legitimately changes it), `PRODUCT.md`, `docs/superpowers/specs/2026-06-17-session-persistence-restore-design.md`. Stage only files you change.

---

# COMMIT 1 — Git diff/merge + review

### Task 1: CONTEXT.md git terms + `kriyon-core::git` diff types & `parse_diff`

**Files:**
- Modify: `CONTEXT.md` (add git-review terms)
- Modify: `crates/kriyon-core/src/git.rs` (types + `parse_diff` + tests)

**Interfaces:**
- Consumes: existing `kriyon_core::transcript::{DiffLine, DiffKind}` (added/removed/context).
- Produces:
  - `pub enum FileChange { Added, Modified, Deleted, Renamed }` (serde `rename_all = "lowercase"`)
  - `pub struct DiffHunk { pub header: String, pub lines: Vec<DiffLine> }`
  - `pub struct FileDiff { pub path: String, pub old_path: Option<String>, pub status: FileChange, pub hunks: Vec<DiffHunk> }` (serde `rename_all = "camelCase"`)
  - `pub struct SessionDiff { pub base: String, pub files: Vec<FileDiff> }`
  - `pub fn parse_diff(diff: &str) -> Vec<FileDiff>`

- [ ] **Step 1: Add CONTEXT.md terms.** Under the git/worktree area add:
  - **Session diff** (`SessionDiff`) — the committed changes a [Session] made on its branch since it forked from the base branch, with the base ref it was diffed against. Built by the [Drift guard]-style tolerant `parse_diff`. _Avoid_: changeset.
  - **File diff** (`FileDiff`) — one file's entry in a [Session diff]: its path, optional `oldPath` (renames only), a [File change], and its [Diff hunk]s.
  - **File change** (`FileChange`) — how a file changed in a [File diff]: `added | modified | deleted | renamed`.
  - **Diff hunk** (`DiffHunk`) — one `@@ … @@` region of a [File diff]: the hunk header plus its `DiffLine`s.
  - **Merge outcome** (`MergeOutcome`) — the result of merging a [Session]'s branch into the base: `clean`, or `conflicted` with the conflicted file paths. Conflicts are surfaced read-only; the user resolves in the [Raw view].

- [ ] **Step 2: Write the failing tests** in `crates/kriyon-core/src/git.rs` (`#[cfg(test)] mod tests`):

```rust
#[test]
fn parse_diff_modified_file_with_hunk() {
    let input = "\
diff --git a/src/main.rs b/src/main.rs
index 1111111..2222222 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,3 +1,3 @@
 fn main() {
-    println!(\"old\");
+    println!(\"new\");
 }
";
    let files = parse_diff(input);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "src/main.rs");
    assert_eq!(files[0].status, FileChange::Modified);
    assert_eq!(files[0].old_path, None);
    assert_eq!(files[0].hunks.len(), 1);
    assert_eq!(files[0].hunks[0].header, "@@ -1,3 +1,3 @@");
    let kinds: Vec<DiffKind> = files[0].hunks[0].lines.iter().map(|l| l.kind).collect();
    assert_eq!(
        kinds,
        vec![DiffKind::Context, DiffKind::Removed, DiffKind::Added, DiffKind::Context]
    );
}

#[test]
fn parse_diff_added_and_deleted_files() {
    let input = "\
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,1 @@
+hello
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 4444444..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
";
    let files = parse_diff(input);
    assert_eq!(files.len(), 2);
    assert_eq!(files[0].status, FileChange::Added);
    assert_eq!(files[0].path, "new.txt");
    assert_eq!(files[1].status, FileChange::Deleted);
    assert_eq!(files[1].path, "gone.txt");
}

#[test]
fn parse_diff_rename_sets_old_path() {
    let input = "\
diff --git a/old/name.rs b/new/name.rs
similarity index 90%
rename from old/name.rs
rename to new/name.rs
index 5555555..6666666 100644
--- a/old/name.rs
+++ b/new/name.rs
@@ -1,1 +1,1 @@
-a
+b
";
    let files = parse_diff(input);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].status, FileChange::Renamed);
    assert_eq!(files[0].old_path.as_deref(), Some("old/name.rs"));
    assert_eq!(files[0].path, "new/name.rs");
}

#[test]
fn parse_diff_binary_file_has_no_hunks() {
    let input = "\
diff --git a/img.png b/img.png
new file mode 100644
index 0000000..7777777
Binary files /dev/null and b/img.png differ
";
    let files = parse_diff(input);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "img.png");
    assert_eq!(files[0].status, FileChange::Added);
    assert!(files[0].hunks.is_empty());
}

#[test]
fn parse_diff_empty_is_empty() {
    assert!(parse_diff("").is_empty());
}
```

- [ ] **Step 3: Run, verify they fail.** Run: `cargo test -p kriyon-core parse_diff`. Expected: FAIL (`parse_diff` / types not found).

- [ ] **Step 4: Implement** in `crates/kriyon-core/src/git.rs`. Add `use crate::transcript::{DiffKind, DiffLine};` at the top, then:

```rust
/// How a file changed in a [`FileDiff`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileChange {
    Added,
    Modified,
    Deleted,
    Renamed,
}

/// One `@@ … @@` region of a [`FileDiff`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffHunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

/// One file's change within a [`SessionDiff`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileChange,
    pub hunks: Vec<DiffHunk>,
}

/// The committed changes a session made on its branch versus `base`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionDiff {
    pub base: String,
    pub files: Vec<FileDiff>,
}

/// Parse `git diff` output into [`FileDiff`]s. Tolerant: unexpected lines are
/// skipped, binary files yield a `FileDiff` with no hunks, and it never panics.
#[must_use]
pub fn parse_diff(diff: &str) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    let mut cur: Option<FileDiff> = None;
    let mut hunk: Option<DiffHunk> = None;

    // Close the open hunk into the current file.
    fn close_hunk(cur: &mut Option<FileDiff>, hunk: &mut Option<DiffHunk>) {
        if let (Some(file), Some(h)) = (cur.as_mut(), hunk.take()) {
            file.hunks.push(h);
        }
    }

    for raw in diff.lines() {
        let line = raw.trim_end_matches('\r');
        if let Some(rest) = line.strip_prefix("diff --git ") {
            close_hunk(&mut cur, &mut hunk);
            if let Some(file) = cur.take() {
                files.push(file);
            }
            // "a/<path> b/<path>" — take the b/ side as the path.
            let path = rest
                .split(" b/")
                .nth(1)
                .map_or_else(|| rest.to_string(), str::to_string);
            cur = Some(FileDiff {
                path,
                old_path: None,
                status: FileChange::Modified,
                hunks: Vec::new(),
            });
        } else if let Some(file) = cur.as_mut() {
            if line.starts_with("new file") {
                file.status = FileChange::Added;
            } else if line.starts_with("deleted file") {
                file.status = FileChange::Deleted;
            } else if let Some(from) = line.strip_prefix("rename from ") {
                file.status = FileChange::Renamed;
                file.old_path = Some(from.to_string());
            } else if let Some(to) = line.strip_prefix("rename to ") {
                file.status = FileChange::Renamed;
                file.path = to.to_string();
            } else if line.starts_with("@@") {
                close_hunk(&mut cur, &mut hunk);
                // Header is everything up to and including the second "@@".
                let header = line
                    .match_indices("@@")
                    .nth(1)
                    .map_or(line, |(i, _)| &line[..i + 2])
                    .to_string();
                hunk = Some(DiffHunk { header, lines: Vec::new() });
            } else if let Some(h) = hunk.as_mut() {
                let (kind, text) = match line.as_bytes().first() {
                    Some(b'+') => (DiffKind::Added, &line[1..]),
                    Some(b'-') => (DiffKind::Removed, &line[1..]),
                    Some(b' ') => (DiffKind::Context, &line[1..]),
                    // "\ No newline at end of file" and blanks: skip.
                    _ => continue,
                };
                h.lines.push(DiffLine { kind, text: text.to_string() });
            }
        }
    }
    close_hunk(&mut cur, &mut hunk);
    if let Some(file) = cur.take() {
        files.push(file);
    }
    files
}
```

NOTE on the `cur.as_mut()` borrow vs `close_hunk(&mut cur, ...)`: the `else if let Some(file) = cur.as_mut()` block ends before each `close_hunk(&mut cur, ..)` call inside it — but `close_hunk` also takes `&mut cur`, which conflicts with the live `file` borrow. To avoid the borrow-checker conflict, inline the hunk-close at the `@@` branch instead of calling `close_hunk` while `file` is borrowed:

```rust
            } else if line.starts_with("@@") {
                if let Some(h) = hunk.take() {
                    file.hunks.push(h);
                }
                let header = line
                    .match_indices("@@")
                    .nth(1)
                    .map_or(line, |(i, _)| &line[..i + 2])
                    .to_string();
                hunk = Some(DiffHunk { header, lines: Vec::new() });
            } else if let Some(h) = hunk.as_mut() {
```

and at the top-of-loop `diff --git` branch, close the hunk into the file *before* `cur.take()` (the `file` borrow is not held there): keep the `close_hunk(&mut cur, &mut hunk)` call there, and the final `close_hunk` after the loop. Remove the unused inner `close_hunk` calls from inside the `file` borrow.

- [ ] **Step 5: Run, verify pass.** Run: `cargo test -p kriyon-core parse_diff && cargo clippy -p kriyon-core -- -D warnings`. Expected: PASS, no clippy warnings.

- [ ] **Step 6: Commit.**

```bash
git add CONTEXT.md crates/kriyon-core/src/git.rs
git commit -m "feat(git): parse git diff into structured FileDiff in core"
```

---

### Task 2: `git_cmd` — `default_branch`, `diff_worktree`, `merge_worktree`

**Files:**
- Modify: `src-tauri/src/git_cmd.rs` (functions + integration tests)

**Interfaces:**
- Consumes: `kriyon_core::git::{parse_diff, SessionDiff, FileChange}`, existing `reject_flag_like`, `run_git`.
- Produces:
  - `pub fn default_branch(repo_path: &str) -> Result<String, String>`
  - `pub fn diff_worktree(worktree_path: &str, base: &str) -> Result<SessionDiff, String>`
  - `pub enum MergeReport` → use `kriyon_core::git::MergeOutcome` (add it in Task 1's file if not already; see below)
  - `pub fn merge_worktree(repo_path: &str, branch: &str) -> Result<MergeOutcome, String>`

First, add `MergeOutcome` to `crates/kriyon-core/src/git.rs` (it is pure data; keep it beside the other git types):

```rust
/// Result of merging a session's branch into the base checkout.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum MergeOutcome {
    Clean,
    Conflicted { files: Vec<String> },
}
```
(Add a quick serde round-trip test for `MergeOutcome` in Task 1's test module: `Clean` serializes to `{"kind":"clean"}`, `Conflicted` to `{"kind":"conflicted","files":[...]}`.)

- [ ] **Step 1: Write the failing tests** in `src-tauri/src/git_cmd.rs` tests module (reuse `git_available`, `git_setup`):

```rust
#[test]
fn default_branch_resolves_local_main() {
    if !git_available() { return; }
    let repo_dir = tempfile::tempdir().expect("repo");
    let repo = repo_dir.path().to_str().expect("utf8");
    git_setup(repo, &["init", "-b", "main"]);
    git_setup(repo, &["config", "user.email", "t@e.com"]);
    git_setup(repo, &["config", "user.name", "T"]);
    std::fs::write(repo_dir.path().join("f.txt"), "a").expect("write");
    git_setup(repo, &["add", "."]);
    git_setup(repo, &["commit", "-m", "init"]);
    assert_eq!(default_branch(repo).expect("default branch"), "main");
}

#[test]
fn diff_worktree_shows_committed_change_vs_base() {
    if !git_available() { return; }
    let repo_dir = tempfile::tempdir().expect("repo");
    let repo = repo_dir.path().to_str().expect("utf8");
    git_setup(repo, &["init", "-b", "main"]);
    git_setup(repo, &["config", "user.email", "t@e.com"]);
    git_setup(repo, &["config", "user.name", "T"]);
    std::fs::write(repo_dir.path().join("f.txt"), "one\n").expect("write");
    git_setup(repo, &["add", "."]);
    git_setup(repo, &["commit", "-m", "init"]);
    git_setup(repo, &["checkout", "-b", "feature"]);
    std::fs::write(repo_dir.path().join("f.txt"), "two\n").expect("write");
    git_setup(repo, &["commit", "-am", "change"]);

    let diff = diff_worktree(repo, "main").expect("diff");
    assert_eq!(diff.base, "main");
    assert_eq!(diff.files.len(), 1);
    assert_eq!(diff.files[0].path, "f.txt");
}

#[test]
fn merge_worktree_clean_then_conflict() {
    if !git_available() { return; }
    let repo_dir = tempfile::tempdir().expect("repo");
    let repo = repo_dir.path().to_str().expect("utf8");
    git_setup(repo, &["init", "-b", "main"]);
    git_setup(repo, &["config", "user.email", "t@e.com"]);
    git_setup(repo, &["config", "user.name", "T"]);
    std::fs::write(repo_dir.path().join("f.txt"), "base\n").expect("write");
    git_setup(repo, &["add", "."]);
    git_setup(repo, &["commit", "-m", "init"]);
    git_setup(repo, &["checkout", "-b", "feature"]);
    std::fs::write(repo_dir.path().join("g.txt"), "new\n").expect("write");
    git_setup(repo, &["add", "."]);
    git_setup(repo, &["commit", "-m", "add g"]);
    git_setup(repo, &["checkout", "main"]);

    let outcome = merge_worktree(repo, "feature").expect("merge");
    assert_eq!(outcome, kriyon_core::git::MergeOutcome::Clean);

    // Now create a conflict: diverge both branches on the same file.
    git_setup(repo, &["checkout", "-b", "conflict"]);
    std::fs::write(repo_dir.path().join("f.txt"), "theirs\n").expect("write");
    git_setup(repo, &["commit", "-am", "theirs"]);
    git_setup(repo, &["checkout", "main"]);
    std::fs::write(repo_dir.path().join("f.txt"), "ours\n").expect("write");
    git_setup(repo, &["commit", "-am", "ours"]);

    let outcome = merge_worktree(repo, "conflict").expect("merge");
    match outcome {
        kriyon_core::git::MergeOutcome::Conflicted { files } => {
            assert!(files.contains(&"f.txt".to_string()));
        }
        kriyon_core::git::MergeOutcome::Clean => panic!("expected conflict"),
    }
}
```

- [ ] **Step 2: Run, verify fail.** Run: `cargo test -p kriyon default_branch diff_worktree merge_worktree`. Expected: FAIL (functions not found). (Test binary name is the `kriyon` lib's; if filtering by name is awkward, run `cargo test -p kriyon git_cmd`.)

- [ ] **Step 3: Implement** in `src-tauri/src/git_cmd.rs`. Add `use kriyon_core::git::{parse_diff, MergeOutcome, SessionDiff};` and:

```rust
/// Resolve the repo's default branch: origin/HEAD, else local `main`/`master`.
///
/// # Errors
/// Returns an error string if none can be determined or git fails to run.
pub fn default_branch(repo_path: &str) -> Result<String, String> {
    reject_flag_like("repo_path", repo_path)?;
    if let Ok(head) = run_git(repo_path, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) {
        let name = head.trim();
        if let Some(stripped) = name.strip_prefix("origin/") {
            if !stripped.is_empty() {
                return Ok(stripped.to_string());
            }
        }
    }
    for candidate in ["main", "master"] {
        if run_git(repo_path, &["rev-parse", "--verify", "--quiet", candidate]).is_ok() {
            return Ok(candidate.to_string());
        }
    }
    Err("could not determine a base branch".to_string())
}

/// Diff a worktree's committed changes against `base` (`base...HEAD`).
///
/// # Errors
/// Returns an error string if the git invocation fails.
pub fn diff_worktree(worktree_path: &str, base: &str) -> Result<SessionDiff, String> {
    reject_flag_like("worktree_path", worktree_path)?;
    reject_flag_like("base", base)?;
    // `<base>...HEAD` (three-dot) = changes since the branch diverged.
    let range = format!("{base}...HEAD");
    let stdout = run_git(worktree_path, &["diff", "--", ])
        .or_else(|_| Ok::<String, String>(String::new()))
        .ok();
    // NB: use the explicit range form below; the line above is replaced.
    let _ = stdout;
    let stdout = run_git(worktree_path, &["diff", &range])?;
    Ok(SessionDiff { base: base.to_string(), files: parse_diff(&stdout) })
}

/// Merge `branch` into the repo's currently checked-out base. Surfaces
/// conflicts read-only; leaves the repo in the merging state for the user to
/// resolve in the terminal.
///
/// # Errors
/// Returns an error string only if git cannot be spawned.
pub fn merge_worktree(repo_path: &str, branch: &str) -> Result<MergeOutcome, String> {
    reject_flag_like("repo_path", repo_path)?;
    reject_flag_like("branch", branch)?;
    let output = std::process::Command::new("git")
        .arg("-C").arg(repo_path)
        .args(["merge", "--no-edit", "--"])
        .arg(branch)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if output.status.success() {
        return Ok(MergeOutcome::Clean);
    }
    // Non-zero: distinguish a conflict (unmerged paths exist) from a real error.
    let conflicted = run_git(repo_path, &["diff", "--name-only", "--diff-filter=U"])
        .unwrap_or_default();
    let files: Vec<String> = conflicted.lines().map(str::to_string).collect();
    if files.is_empty() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(MergeOutcome::Conflicted { files })
}
```

Clean up `diff_worktree` to the final form (the `stdout`/`_` scaffolding above is illustrative — the real body is just the range build + one `run_git` + `parse_diff`):

```rust
pub fn diff_worktree(worktree_path: &str, base: &str) -> Result<SessionDiff, String> {
    reject_flag_like("worktree_path", worktree_path)?;
    reject_flag_like("base", base)?;
    let range = format!("{base}...HEAD");
    let stdout = run_git(worktree_path, &["diff", &range])?;
    Ok(SessionDiff { base: base.to_string(), files: parse_diff(&stdout) })
}
```

- [ ] **Step 4: Run, verify pass.** Run: `cargo test -p kriyon git_cmd && cargo clippy -p kriyon -- -D warnings`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add crates/kriyon-core/src/git.rs src-tauri/src/git_cmd.rs
git commit -m "feat(git): diff_worktree, merge_worktree, default_branch shell-outs"
```

---

### Task 3: Tauri commands + bridge + TS types

**Files:**
- Modify: `src-tauri/src/commands.rs` (3 commands)
- Modify: `src-tauri/src/lib.rs` (register handlers)
- Modify: `src/ipc/bridge.ts` (3 wrappers)
- Modify: `src/types.ts` (mirror types)

**Interfaces:**
- Consumes: `git_cmd::{default_branch, diff_worktree, merge_worktree}`, `kriyon_core::git::{SessionDiff, MergeOutcome}`.
- Produces (bridge): `defaultBranch(repoPath): Promise<string>`, `diffWorktree(worktreePath, base): Promise<SessionDiff>`, `mergeWorktree(repoPath, branch): Promise<MergeOutcome>`.

- [ ] **Step 1: Add commands** in `src-tauri/src/commands.rs` (next to the existing worktree commands):

```rust
/// Resolve the repo's default branch (the diff base).
///
/// # Errors
/// Returns an error string if the git invocation fails.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn default_branch(repo_path: String) -> Result<String, String> {
    crate::git_cmd::default_branch(&repo_path)
}

/// Diff a worktree's committed changes against `base`.
///
/// # Errors
/// Returns an error string if the git invocation fails.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn diff_worktree(
    worktree_path: String,
    base: String,
) -> Result<kriyon_core::git::SessionDiff, String> {
    crate::git_cmd::diff_worktree(&worktree_path, &base)
}

/// Merge `branch` into the repo's base checkout, surfacing conflicts read-only.
///
/// # Errors
/// Returns an error string if git cannot be spawned.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn merge_worktree(
    repo_path: String,
    branch: String,
) -> Result<kriyon_core::git::MergeOutcome, String> {
    crate::git_cmd::merge_worktree(&repo_path, &branch)
}
```

- [ ] **Step 2: Register** the three commands in `src-tauri/src/lib.rs` `generate_handler!` list (after `commands::remove_worktree,`).

- [ ] **Step 3: Add TS types** in `src/types.ts` (after `RepoStatus`; `DiffLine` already exists):

```ts
/** How a file changed (mirrors Rust `FileChange`). */
export type FileChange = "added" | "modified" | "deleted" | "renamed";

/** One `@@ … @@` region of a file diff (mirrors Rust `DiffHunk`). */
export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

/** One file's change within a session diff (mirrors Rust `FileDiff`). */
export interface FileDiff {
  path: string;
  oldPath: string | null;
  status: FileChange;
  hunks: DiffHunk[];
}

/** Committed changes a session made vs its base (mirrors Rust `SessionDiff`). */
export interface SessionDiff {
  base: string;
  files: FileDiff[];
}

/** Result of merging a branch into base (mirrors Rust `MergeOutcome`). */
export type MergeOutcome =
  | { kind: "clean" }
  | { kind: "conflicted"; files: string[] };
```

- [ ] **Step 4: Add bridge wrappers** in `src/ipc/bridge.ts` (in the Git/worktrees section; import the new types):

```ts
export function defaultBranch(repoPath: string): Promise<string> {
  return invoke("default_branch", { repoPath });
}

export function diffWorktree(
  worktreePath: string,
  base: string
): Promise<SessionDiff> {
  return invoke("diff_worktree", { worktreePath, base });
}

export function mergeWorktree(
  repoPath: string,
  branch: string
): Promise<MergeOutcome> {
  return invoke("merge_worktree", { repoPath, branch });
}
```

- [ ] **Step 5: Verify it compiles + lints.** Run: `pnpm typecheck && cargo clippy -p kriyon -- -D warnings`. Expected: clean.

- [ ] **Step 6: Commit.**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/ipc/bridge.ts src/types.ts
git commit -m "feat(git): expose diff/merge/default-branch over the IPC bridge"
```

---

### Task 4: Review UI in the worktree surface

**Files:**
- Create: `src/inspector/ReviewPanel.tsx` (the diff + merge view)
- Create: `src/inspector/ReviewPanel.test.tsx` (Vitest)
- Modify: `src/inspector/Inspector.tsx` (mount the Review affordance)

**Interfaces:**
- Consumes: `diffWorktree`, `mergeWorktree`, `defaultBranch` from bridge; `SessionDiff`, `FileDiff`, `MergeOutcome`, `DiffLine` from types; `tokens` from theme.
- Produces: `export function ReviewPanel({ session }: { session: UiSession })`.

Design notes: The panel only renders for a session whose `worktreePath` is set and on a branch (the loose-worktree case). It has a **Review** button → loads `defaultBranch(repoPath)` then `diffWorktree(worktreePath, base)`, renders per-file hunks (added=green, removed=red, context=muted, all from `tokens.color`), and a **Merge** button → `mergeWorktree(repoPath, branch)` → on `clean` shows "Merged"; on `conflicted` lists the files with a "resolve in terminal" hint. All states handle the no-Tauri browser case (the bridge already no-ops; the panel shows an empty/idle state).

- [ ] **Step 1: Write the failing test** `src/inspector/ReviewPanel.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewPanel } from "./ReviewPanel.tsx";

vi.mock("../ipc/bridge.ts", () => ({
  defaultBranch: vi.fn().mockResolvedValue("main"),
  diffWorktree: vi.fn().mockResolvedValue({
    base: "main",
    files: [
      {
        path: "src/main.rs",
        oldPath: null,
        status: "modified",
        hunks: [
          {
            header: "@@ -1 +1 @@",
            lines: [
              { kind: "removed", text: "old" },
              { kind: "added", text: "new" },
            ],
          },
        ],
      },
    ],
  }),
  mergeWorktree: vi.fn().mockResolvedValue({ kind: "clean" }),
}));

const session = {
  id: "s1",
  projectId: "p1",
  cwd: "/repo",
  worktreePath: "/repo-wt",
  title: "t",
  createdAt: 0,
} as const;

describe("ReviewPanel", () => {
  it("loads and renders the session diff on review", async () => {
    render(<ReviewPanel session={session} />);
    screen.getByRole("button", { name: /review/i }).click();
    expect(await screen.findByText("src/main.rs")).toBeInTheDocument();
    expect(await screen.findByText("new")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, verify fail.** Run: `pnpm vitest run src/inspector/ReviewPanel.test.tsx`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `src/inspector/ReviewPanel.tsx`. Use React `useState` for `{ diff, outcome, loading, error }`; colors from `tokens`. Render: a Review button; once `diff` is loaded, the file list with hunks (each `DiffLine` colored by `kind`), and a Merge button that calls `mergeWorktree` and stores `outcome`. Conflicted outcome renders the file list + a muted "Resolve in the terminal, then merge again." line. Follow the styling idiom of `Inspector.tsx` (CSSProperties consts, `tokens.color.*`, `tokens.font.mono` for code). Mono diff lines; no color literals.

- [ ] **Step 4: Mount in `Inspector.tsx`.** Import `ReviewPanel`; render `{session.worktreePath ? <ReviewPanel session={session} /> : null}` inside the "Changes" section (or directly after it). Keep the existing "Changes" KV summary.

- [ ] **Step 5: Run, verify pass + full check.** Run: `pnpm vitest run src/inspector/ReviewPanel.test.tsx && pnpm typecheck && pnpm lint`. Expected: PASS, clean. Fix any biome `.at()`/formatting via `pnpm fix`.

- [ ] **Step 6: Commit.**

```bash
git add src/inspector/ReviewPanel.tsx src/inspector/ReviewPanel.test.tsx src/inspector/Inspector.tsx
git commit -m "feat(review): per-worktree diff + merge review panel"
```

---

### Task 5: Green gate for commit 1

- [ ] **Step 1: Full check.** Run: `pnpm check`. Expected: all green (JS + Rust). Fix anything; if biome reformats, re-stage.
- [ ] **Step 2:** If `pnpm check` made formatting-only changes, `git add -u && git commit --amend --no-edit` (only if the amend stays on `feat/session-activity`; otherwise a follow-up `style:` commit). Commit 1 (git diff/merge) is done.

---

# COMMIT 2 — Out-of-process PTY daemon

### Task 6: CONTEXT.md daemon terms + `kriyon-core::wire` frame protocol

**Files:**
- Modify: `CONTEXT.md` (daemon terms)
- Create: `crates/kriyon-core/src/wire.rs` (`Frame`, encode, `FrameDecoder`)
- Modify: `crates/kriyon-core/src/lib.rs` (`pub mod wire;`)

**Interfaces:**
- Produces:
  - `pub enum Frame { Output(Vec<u8>), Stdin(Vec<u8>), Resize { cols: u16, rows: u16 }, Attach { cols: u16, rows: u16 }, Shutdown }`
  - `impl Frame { pub fn encode(&self) -> Vec<u8> }`
  - `pub struct FrameDecoder { … }` with `pub fn new() -> Self`, `pub fn push(&mut self, bytes: &[u8])`, `pub fn next(&mut self) -> Option<Frame>`

- [ ] **Step 1: CONTEXT.md terms.** Add:
  - **PTY daemon** (`kriyon-ptyd`) — the long-lived per-[Session] process that owns the [Session]'s PTY and child, outliving the app so the [Session] survives an app crash. One process per [Session], listening on its [Session socket]. Byte-proxies output/stdin/resize over [Daemon frame]s. _Avoid_: pty server, broker.
  - **Session socket** — the per-[Session] Unix domain socket at `~/.claude/kriyon/run/<session-id>.sock` the [PTY daemon] listens on and the [Daemon client] connects to. Keyed by Kriyon's [Session] id (validated before use). _Avoid_: ipc socket.
  - **Daemon frame** (`Frame`) — one message on the [Session socket]: `Output`/`Stdin`/`Resize`/`Attach`/`Shutdown`, length-prefixed (`[tag][u32 len][payload]`). Encoded/decoded by the pure `wire` module. _Avoid_: packet, message.
  - **Daemon client** (`DaemonClient`) — the app-side [Engine] that connects to a [Session socket], runs the framed reader thread feeding [Backpressure], and sends stdin/resize/shutdown frames. Implements `SessionEngine`, so the app's hot path is unchanged. _Avoid_: pty client.
  - **Scrollback ring** — the [PTY daemon]'s bounded (~256 KB) buffer of recent output held while no [Daemon client] is attached, replayed on attach so the terminal repaints. _Avoid_: replay buffer (ambiguous with the frontend one).

- [ ] **Step 2: Write the failing tests** `crates/kriyon-core/src/wire.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_each_frame() {
        let frames = vec![
            Frame::Output(vec![1, 2, 3, 0, 255]),
            Frame::Stdin(b"ls -la\n".to_vec()),
            Frame::Resize { cols: 120, rows: 40 },
            Frame::Attach { cols: 80, rows: 24 },
            Frame::Shutdown,
        ];
        let mut dec = FrameDecoder::new();
        for f in &frames {
            dec.push(&f.encode());
        }
        let mut got = Vec::new();
        while let Some(f) = dec.next() {
            got.push(f);
        }
        assert_eq!(got, frames);
    }

    #[test]
    fn decodes_across_split_buffers() {
        let f = Frame::Output(b"hello world".to_vec());
        let bytes = f.encode();
        let mut dec = FrameDecoder::new();
        // Feed one byte at a time: no frame until the last byte lands.
        for (i, b) in bytes.iter().enumerate() {
            dec.push(&[*b]);
            if i + 1 < bytes.len() {
                assert!(dec.next().is_none(), "no full frame yet at byte {i}");
            }
        }
        assert_eq!(dec.next(), Some(f));
        assert_eq!(dec.next(), None);
    }

    #[test]
    fn unknown_tag_is_skipped_not_panic() {
        let mut dec = FrameDecoder::new();
        // tag 99 (unknown), len 1, one payload byte — must be consumed, no panic.
        dec.push(&[99, 1, 0, 0, 0, 7]);
        assert_eq!(dec.next(), None);
        // A valid frame after the bad one still decodes.
        dec.push(&Frame::Shutdown.encode());
        assert_eq!(dec.next(), Some(Frame::Shutdown));
    }
}
```

- [ ] **Step 3: Run, verify fail.** Run: `cargo test -p kriyon-core wire`. Expected: FAIL (module not found).

- [ ] **Step 4: Implement** `crates/kriyon-core/src/wire.rs`:

```rust
//! Length-prefixed frame protocol for the per-session PTY daemon socket.
//!
//! Wire layout per frame: `[u8 tag][u32 len (LE)][payload len bytes]`. Pure
//! encode/decode — no IO. The decoder tolerates partial reads (stream
//! boundaries are arbitrary) and skips unknown tags without panicking.

const TAG_OUTPUT: u8 = 0;
const TAG_STDIN: u8 = 1;
const TAG_RESIZE: u8 = 2;
const TAG_ATTACH: u8 = 3;
const TAG_SHUTDOWN: u8 = 4;

/// One message on the session socket.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Frame {
    Output(Vec<u8>),
    Stdin(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Attach { cols: u16, rows: u16 },
    Shutdown,
}

impl Frame {
    /// Serialize the frame to its wire bytes.
    #[must_use]
    pub fn encode(&self) -> Vec<u8> {
        let (tag, payload): (u8, Vec<u8>) = match self {
            Frame::Output(b) => (TAG_OUTPUT, b.clone()),
            Frame::Stdin(b) => (TAG_STDIN, b.clone()),
            Frame::Resize { cols, rows } => {
                (TAG_RESIZE, dims(*cols, *rows))
            }
            Frame::Attach { cols, rows } => {
                (TAG_ATTACH, dims(*cols, *rows))
            }
            Frame::Shutdown => (TAG_SHUTDOWN, Vec::new()),
        };
        let len = u32::try_from(payload.len()).unwrap_or(u32::MAX);
        let mut out = Vec::with_capacity(5 + payload.len());
        out.push(tag);
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&payload);
        out
    }
}

fn dims(cols: u16, rows: u16) -> Vec<u8> {
    let mut v = Vec::with_capacity(4);
    v.extend_from_slice(&cols.to_le_bytes());
    v.extend_from_slice(&rows.to_le_bytes());
    v
}

/// Accumulates bytes off the socket and yields complete [`Frame`]s.
#[derive(Default)]
pub struct FrameDecoder {
    buf: Vec<u8>,
}

impl FrameDecoder {
    #[must_use]
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// Append freshly-read bytes.
    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// Pop the next complete frame, if one is fully buffered.
    pub fn next(&mut self) -> Option<Frame> {
        loop {
            if self.buf.len() < 5 {
                return None;
            }
            let tag = self.buf[0];
            let len = u32::from_le_bytes([self.buf[1], self.buf[2], self.buf[3], self.buf[4]]);
            let len = usize::try_from(len).unwrap_or(usize::MAX);
            if self.buf.len() < 5 + len {
                return None;
            }
            let payload = self.buf[5..5 + len].to_vec();
            self.buf.drain(..5 + len);
            match tag {
                TAG_OUTPUT => return Some(Frame::Output(payload)),
                TAG_STDIN => return Some(Frame::Stdin(payload)),
                TAG_RESIZE if payload.len() == 4 => {
                    return Some(Frame::Resize {
                        cols: u16::from_le_bytes([payload[0], payload[1]]),
                        rows: u16::from_le_bytes([payload[2], payload[3]]),
                    })
                }
                TAG_ATTACH if payload.len() == 4 => {
                    return Some(Frame::Attach {
                        cols: u16::from_le_bytes([payload[0], payload[1]]),
                        rows: u16::from_le_bytes([payload[2], payload[3]]),
                    })
                }
                TAG_SHUTDOWN => return Some(Frame::Shutdown),
                // Unknown/malformed tag or bad dims: skip this frame, keep going.
                _ => continue,
            }
        }
    }
}
```

Add `pub mod wire;` to `crates/kriyon-core/src/lib.rs`.

- [ ] **Step 5: Run, verify pass.** Run: `cargo test -p kriyon-core wire && cargo clippy -p kriyon-core -- -D warnings`. Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add CONTEXT.md crates/kriyon-core/src/wire.rs crates/kriyon-core/src/lib.rs
git commit -m "feat(daemon): pure frame protocol for the PTY daemon socket"
```

---

### Task 7: `kriyon-core::daemon` socket-path + session-id validation

**Files:**
- Create: `crates/kriyon-core/src/daemon.rs` (path + id validation)
- Modify: `crates/kriyon-core/src/lib.rs` (`pub mod daemon;`)

**Interfaces:**
- Produces:
  - `pub fn is_valid_session_id(id: &str) -> bool` — non-empty, only `[A-Za-z0-9-]`.
  - `pub fn session_socket_path(run_dir: &Path, id: &str) -> Option<PathBuf>` — `Some(run_dir/<id>.sock)` iff id valid.

- [ ] **Step 1: Write failing tests** `crates/kriyon-core/src/daemon.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn valid_ids_accepted_traversal_rejected() {
        assert!(is_valid_session_id("a1b2-c3d4"));
        assert!(!is_valid_session_id(""));
        assert!(!is_valid_session_id("../etc/passwd"));
        assert!(!is_valid_session_id("a/b"));
        assert!(!is_valid_session_id("a.b"));
        assert!(!is_valid_session_id("a b"));
    }

    #[test]
    fn socket_path_built_only_for_valid_id() {
        let run = Path::new("/run/kriyon");
        assert_eq!(
            session_socket_path(run, "abc-123"),
            Some(run.join("abc-123.sock"))
        );
        assert_eq!(session_socket_path(run, "../x"), None);
    }
}
```

- [ ] **Step 2: Run, verify fail.** Run: `cargo test -p kriyon-core daemon`. Expected: FAIL.

- [ ] **Step 3: Implement** `crates/kriyon-core/src/daemon.rs`:

```rust
//! Per-session daemon discovery helpers: socket-path derivation and the
//! session-id validation that gates it (the path-containment trust boundary).

use std::path::{Path, PathBuf};

/// A session id is safe to interpolate into a socket path: non-empty and only
/// ASCII alphanumerics or `-` (Kriyon ids are UUIDs). Rejects anything that
/// could traverse or escape the run directory.
#[must_use]
pub fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// The session's socket path inside `run_dir`, or `None` if `id` is invalid.
#[must_use]
pub fn session_socket_path(run_dir: &Path, id: &str) -> Option<PathBuf> {
    if is_valid_session_id(id) {
        Some(run_dir.join(format!("{id}.sock")))
    } else {
        None
    }
}
```

Add `pub mod daemon;` to `crates/kriyon-core/src/lib.rs`.

- [ ] **Step 4: Run, verify pass.** Run: `cargo test -p kriyon-core daemon && cargo clippy -p kriyon-core -- -D warnings`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add crates/kriyon-core/src/daemon.rs crates/kriyon-core/src/lib.rs
git commit -m "feat(daemon): session socket-path derivation + id validation"
```

---

### Task 8: `kriyon-ptyd` crate — daemon server (owns the PTY, byte-proxy)

**Files:**
- Create: `crates/kriyon-ptyd/Cargo.toml`
- Create: `crates/kriyon-ptyd/src/main.rs` (arg parse + run)
- Create: `crates/kriyon-ptyd/src/pty.rs` (moved from `src-tauri/src/pty.rs`)
- Create: `crates/kriyon-ptyd/src/server.rs` (accept loop, attach, ring, proxy)
- Modify: `Cargo.toml` workspace members already globs `crates/*` (no change needed).

**Interfaces:**
- Consumes: `kriyon_core::wire::{Frame, FrameDecoder}`, `kriyon_core::session::{SpawnSpec, SessionId}`, `portable_pty`.
- Produces: a binary `kriyon-ptyd` invoked as `kriyon-ptyd --socket <path> --cwd <dir> --shell <path>` reading the env/spec; it daemonizes its own listener.

Design: `main.rs` parses args (socket path, cwd, shell; env inherited), removes any stale socket file, binds a `UnixListener`, opens the PTY via the moved `PtyEngine` with an `on_output` closure that routes bytes to the shared session state, and runs the accept loop. Shared state (`Mutex`): `Option<UnixStream>` (current client writer) + a `VecDeque<u8>` scrollback ring capped at 256 KB. On client connect: lock, replay the ring to the new stream, store it as the current client; spawn a per-connection reader thread decoding `Frame`s → `Stdin`/`Resize`/`Shutdown` → drive the `PtyEngine`. On PTY EOF (child exit) the `on_output` reader ends → signal shutdown → remove socket → exit. `Shutdown` frame: close the engine, remove socket, exit.

This task has no unit test of its own (it is wiring around tested pure modules); Task 9 is its integration test. Build it to compile + clippy-clean first.

- [ ] **Step 1: Create `crates/kriyon-ptyd/Cargo.toml`:**

```toml
[package]
name = "kriyon-ptyd"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "kriyon-ptyd"
path = "src/main.rs"

[dependencies]
kriyon-core = { path = "../kriyon-core" }
portable-pty = "0.9"
parking_lot = "0.12"

[lints.clippy]
all = "warn"
pedantic = "warn"
correctness = "deny"
```

- [ ] **Step 2: Move `PtyEngine`** from `src-tauri/src/pty.rs` into `crates/kriyon-ptyd/src/pty.rs` verbatim (keep its existing tests). Then in Task 10 the app stops using it; for now `src-tauri` still references it — to keep the workspace compiling between commits, **leave `src-tauri/src/pty.rs` in place for now** and add the copy in the new crate. (The two coexist until Task 10 deletes the src-tauri copy. They are identical; this is a deliberate transient.) Update `crates/kriyon-ptyd/src/pty.rs`'s `use` paths if needed (it already uses `kriyon_core::*`).

- [ ] **Step 3: Implement `crates/kriyon-ptyd/src/server.rs`** — the accept loop + shared session state:

```rust
//! Per-session daemon server: owns one PTY+child, byte-proxies to one client
//! at a time over a Unix socket, buffering a bounded scrollback while detached.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::Arc;

use kriyon_core::session::{SessionId, SpawnSpec};
use kriyon_core::wire::{Frame, FrameDecoder};
use parking_lot::Mutex;

use crate::pty::PtyEngine;

const RING_CAP: usize = 256 * 1024;

struct Shared {
    client: Mutex<Option<UnixStream>>,
    ring: Mutex<VecDeque<u8>>,
}

impl Shared {
    fn on_output(&self, bytes: &[u8]) {
        // Prefer the live client; fall back to the scrollback ring.
        let mut client = self.client.lock();
        if let Some(stream) = client.as_mut() {
            if stream.write_all(&Frame::Output(bytes.to_vec()).encode()).is_ok() {
                let _ = stream.flush();
                return;
            }
            // Write failed: client gone. Drop it and buffer instead.
            *client = None;
        }
        drop(client);
        let mut ring = self.ring.lock();
        ring.extend(bytes.iter().copied());
        while ring.len() > RING_CAP {
            ring.pop_front();
        }
    }
}

/// Run the daemon: bind the socket, spawn the PTY, serve clients until the
/// child exits or a Shutdown frame arrives. Best-effort cleanup of the socket.
pub fn run(socket_path: PathBuf, id: SessionId, spec: SpawnSpec) -> std::io::Result<()> {
    // Remove a stale socket file before binding.
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path)?;

    let shared = Arc::new(Shared {
        client: Mutex::new(None),
        ring: Mutex::new(VecDeque::new()),
    });

    let out_shared = Arc::clone(&shared);
    let engine = PtyEngine::spawn(id, &spec, move |bytes| out_shared.on_output(&bytes))
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let engine = Arc::new(engine);

    for conn in listener.incoming() {
        let Ok(mut stream) = conn else { continue };
        // New client: replay the ring, then become the live client.
        {
            let ring = shared.ring.lock();
            if !ring.is_empty() {
                let snapshot: Vec<u8> = ring.iter().copied().collect();
                let _ = stream.write_all(&Frame::Output(snapshot).encode());
                let _ = stream.flush();
            }
        }
        if let Ok(clone) = stream.try_clone() {
            *shared.client.lock() = Some(clone);
        }

        // Serve this client until it disconnects or asks to shut down.
        if serve_client(&mut stream, &engine) {
            break; // Shutdown requested.
        }
        // Client disconnected (app crash/close): keep the child alive, detach.
        *shared.client.lock() = None;
        // If the child has exited, stop; the next read of the engine reflects it
        // via the output thread ending. We detect child-death below.
        if engine.child_has_exited() {
            break;
        }
    }

    let _ = engine.close();
    let _ = std::fs::remove_file(&socket_path);
    Ok(())
}

/// Read frames from one client; returns `true` if Shutdown was requested.
fn serve_client(stream: &mut UnixStream, engine: &Arc<PtyEngine>) -> bool {
    let mut dec = FrameDecoder::new();
    let mut buf = [0u8; 8192];
    loop {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => return false, // disconnect
            Ok(n) => {
                dec.push(&buf[..n]);
                while let Some(frame) = dec.next() {
                    match frame {
                        Frame::Stdin(bytes) => {
                            let _ = engine.write_stdin(&bytes);
                        }
                        Frame::Resize { cols, rows } => {
                            let _ = engine.resize(cols, rows);
                        }
                        Frame::Shutdown => return true,
                        // Attach handled implicitly (we already replayed); ignore.
                        Frame::Attach { cols, rows } => {
                            let _ = engine.resize(cols, rows);
                        }
                        Frame::Output(_) => {}
                    }
                }
            }
        }
    }
}
```

This requires a small addition to `PtyEngine`: a `child_has_exited(&self) -> bool` using `Child::try_wait`. Add to `crates/kriyon-ptyd/src/pty.rs`:

```rust
    /// `true` if the child process has already exited.
    #[must_use]
    pub fn child_has_exited(&self) -> bool {
        matches!(self.child.lock().try_wait(), Ok(Some(_)))
    }
```

NOTE: the detached-but-child-still-running case parks here in `listener.incoming()` waiting for the next client — correct (the daemon idles, PTY output fills the ring). But child-death while detached must also end the daemon. Handle it by spawning a tiny reaper thread after `engine` is created that polls `engine.child_has_exited()` every 500ms and, on exit, connects to its own socket once to unblock `incoming()` then breaks — OR simpler: set the listener non-blocking with a short accept timeout and check `child_has_exited()` between accepts. Implement the **reaper-poke** approach: a thread that, when the child exits, removes the socket and `std::process::exit(0)` after `engine.close()`. Replace the post-loop cleanup reliance with this reaper so detached child-death always terminates the daemon:

```rust
    let reaper = Arc::clone(&engine);
    let reap_socket = socket_path.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if reaper.child_has_exited() {
            let _ = reaper.close();
            let _ = std::fs::remove_file(&reap_socket);
            std::process::exit(0);
        }
    });
```

- [ ] **Step 4: Implement `crates/kriyon-ptyd/src/main.rs`:**

```rust
//! `kriyon-ptyd` — the per-session out-of-process PTY daemon. One instance owns
//! one PTY+child and serves one app client at a time over a Unix socket.

mod pty;
mod server;

use std::collections::HashMap;
use std::path::PathBuf;

use kriyon_core::session::{SessionId, SpawnSpec};

fn arg(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(socket) = arg(&args, "--socket") else {
        eprintln!("kriyon-ptyd: --socket required");
        std::process::exit(2);
    };
    let Some(id) = arg(&args, "--id") else {
        eprintln!("kriyon-ptyd: --id required");
        std::process::exit(2);
    };
    let cwd = arg(&args, "--cwd").unwrap_or_default();
    let shell = arg(&args, "--shell")
        .unwrap_or_else(|| std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()));

    // The daemon inherits the env the app set for it (ZDOTDIR etc. are passed
    // through the spawning env), so the spec carries no extra env here.
    let spec = SpawnSpec { cwd, shell, env: HashMap::new() };

    if let Err(e) = server::run(PathBuf::from(socket), SessionId(id), spec) {
        eprintln!("kriyon-ptyd: {e}");
        std::process::exit(1);
    }
}
```

- [ ] **Step 5: Build + clippy.** Run: `cargo build -p kriyon-ptyd && cargo clippy -p kriyon-ptyd -- -D warnings`. Expected: compiles, no warnings. Fix borrow/clippy issues (e.g. `std::io::Error::other` needs Rust ≥1.74 — available).

- [ ] **Step 6: Commit.**

```bash
git add crates/kriyon-ptyd Cargo.lock
git commit -m "feat(daemon): kriyon-ptyd per-session PTY daemon (byte-proxy)"
```

---

### Task 9: Daemon crash-survival integration test (automated v-crash proxy)

**Files:**
- Create: `crates/kriyon-ptyd/tests/survives_client_disconnect.rs`

**Interfaces:**
- Consumes: the built `kriyon-ptyd` binary via `env!("CARGO_BIN_EXE_kriyon-ptyd")`; `kriyon_core::wire::{Frame, FrameDecoder}`.

- [ ] **Step 1: Write the failing test** `crates/kriyon-ptyd/tests/survives_client_disconnect.rs`:

```rust
//! The daemon keeps the child alive across a client disconnect (app crash) and
//! a fresh client can reattach and drive the same child — the automated proxy
//! for the plan's `v-crash`.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

use kriyon_core::wire::{Frame, FrameDecoder};

fn read_until(stream: &mut UnixStream, needle: &str, timeout: Duration) -> String {
    let mut dec = FrameDecoder::new();
    let mut acc = String::new();
    let mut buf = [0u8; 4096];
    let start = Instant::now();
    stream
        .set_read_timeout(Some(Duration::from_millis(200)))
        .expect("set timeout");
    while start.elapsed() < timeout {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                dec.push(&buf[..n]);
                while let Some(Frame::Output(bytes)) = dec.next() {
                    acc.push_str(&String::from_utf8_lossy(&bytes));
                }
                if acc.contains(needle) {
                    return acc;
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => break,
        }
    }
    acc
}

fn connect(path: &str) -> UnixStream {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(s) = UnixStream::connect(path) {
            return s;
        }
        assert!(Instant::now() < deadline, "daemon socket never appeared");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn child_survives_client_disconnect_and_reattach() {
    let dir = tempfile::tempdir().expect("tmp");
    let socket = dir.path().join("s.sock");
    let socket_str = socket.to_str().expect("utf8").to_string();

    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_kriyon-ptyd"))
        .args(["--socket", &socket_str, "--id", "test", "--cwd", "/", "--shell", "/bin/sh"])
        .env("PS1", "")
        .spawn()
        .expect("spawn daemon");

    // First client: attach, run a marker, confirm we see it.
    let mut c1 = connect(&socket_str);
    c1.write_all(&Frame::Attach { cols: 80, rows: 24 }.encode()).unwrap();
    c1.write_all(&Frame::Stdin(b"printf MARK_ONE\n".to_vec()).encode()).unwrap();
    let seen = read_until(&mut c1, "MARK_ONE", Duration::from_secs(5));
    assert!(seen.contains("MARK_ONE"), "first client should see output, got: {seen:?}");

    // Simulate app crash: drop the client connection entirely.
    drop(c1);
    std::thread::sleep(Duration::from_millis(300));

    // Reattach with a fresh client: the SAME shell is still alive.
    let mut c2 = connect(&socket_str);
    c2.write_all(&Frame::Attach { cols: 80, rows: 24 }.encode()).unwrap();
    c2.write_all(&Frame::Stdin(b"printf MARK_TWO\n".to_vec()).encode()).unwrap();
    let seen = read_until(&mut c2, "MARK_TWO", Duration::from_secs(5));
    assert!(seen.contains("MARK_TWO"), "reattached client should drive same child, got: {seen:?}");

    // Shutdown cleanly.
    c2.write_all(&Frame::Shutdown.encode()).unwrap();
    let _ = child.wait();
    assert!(!socket.exists(), "socket should be removed on shutdown");
}
```

Add `tempfile` as a dev-dependency of `kriyon-ptyd` (`[dev-dependencies] tempfile = "3"`).

- [ ] **Step 2: Run, verify it passes** (the daemon from Task 8 should already satisfy it). Run: `cargo test -p kriyon-ptyd --test survives_client_disconnect -- --nocapture`. Expected: PASS. If reattach output is flaky, ensure `serve_client` returns on disconnect and the accept loop re-enters `incoming()` to take the next client (it does).

- [ ] **Step 3: Commit.**

```bash
git add crates/kriyon-ptyd/Cargo.toml crates/kriyon-ptyd/tests/survives_client_disconnect.rs Cargo.lock
git commit -m "test(daemon): child survives client disconnect + reattach (v-crash)"
```

---

### Task 10: `DaemonClient` in src-tauri (implements `SessionEngine`)

**Files:**
- Create: `src-tauri/src/daemon_client.rs`
- Modify: `src-tauri/src/lib.rs` (`pub mod daemon_client;`, `Session.engine` type)
- Delete: `src-tauri/src/pty.rs` (now owned by `kriyon-ptyd`); remove `pub mod pty;`

**Interfaces:**
- Consumes: `kriyon_core::session::{SessionEngine, SessionId, SpawnSpec, EngineError}`, `kriyon_core::wire::{Frame, FrameDecoder}`, `kriyon_core::backpressure::Backpressure`, `kriyon_core::daemon::session_socket_path`.
- Produces: `pub struct DaemonClient` with `pub fn connect(socket: &Path, on_output: F) -> Result<Self, EngineError>` and `impl SessionEngine`, plus `pub fn report_drained(&self, bytes: usize)`.

Design: `connect` opens a `UnixStream`, sends nothing yet (the caller sends `Attach`), spawns a reader thread that decodes `Frame::Output` → `on_output(bytes)` then `backpressure.after_send(n)` (identical to the old PtyEngine reader). `write_stdin`/`resize` send frames over a cloned writer (behind a `Mutex`). `close` sends `Shutdown`, then drops. `report_drained` → `backpressure.report_drained`. Reuse `HIGH_WATER`/`LOW_WATER` constants (128 KB / 16 KB) from the old pty.rs.

- [ ] **Step 1: Write the failing test** `src-tauri/src/daemon_client.rs` (an integration test against the built daemon binary, mirroring Task 9 but exercising `DaemonClient`). Since `src-tauri` can spawn `kriyon-ptyd` via `env!`, put it in `#[cfg(test)] mod tests`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    #[test]
    fn daemon_client_drives_a_real_daemon() {
        let dir = tempfile::tempdir().expect("tmp");
        let socket = dir.path().join("s.sock");
        let socket_str = socket.to_str().expect("utf8").to_string();

        let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_kriyon-ptyd"))
            .args(["--socket", &socket_str, "--id", "test", "--cwd", "/", "--shell", "/bin/sh"])
            .env("PS1", "")
            .spawn()
            .expect("spawn daemon");

        // Wait for the socket.
        let deadline = Instant::now() + Duration::from_secs(5);
        while !socket.exists() {
            assert!(Instant::now() < deadline, "socket never appeared");
            std::thread::sleep(Duration::from_millis(50));
        }

        let collected = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sink = Arc::clone(&collected);
        let client = DaemonClient::connect(&socket, move |bytes| {
            sink.lock().expect("lock").extend_from_slice(&bytes);
        })
        .expect("connect");
        client.attach(80, 24).expect("attach");
        client.write_stdin(b"printf HELLO_DC\n").expect("stdin");

        let mut found = false;
        for _ in 0..100 {
            if String::from_utf8_lossy(&collected.lock().expect("lock")).contains("HELLO_DC") {
                found = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(found, "client should receive daemon output");

        client.close().expect("close");
        let _ = child.wait();
    }
}
```

Requires a `pub fn attach(&self, cols: u16, rows: u16) -> Result<(), EngineError>` on `DaemonClient`.

- [ ] **Step 2: Run, verify fail.** Run: `cargo test -p kriyon daemon_client`. Expected: FAIL (type not found). (This will also fail to compile until `pty.rs` removal is reconciled — do Step 3–4 together.)

- [ ] **Step 3: Implement `src-tauri/src/daemon_client.rs`:**

```rust
//! App-side client for the out-of-process [`kriyon-ptyd`] daemon. Implements the
//! [`SessionEngine`] trait so the rest of the app is unchanged: the PTY now
//! lives in the daemon, but stdin/resize/close/backpressure look identical.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::Arc;
use std::thread::JoinHandle;

use kriyon_core::backpressure::Backpressure;
use kriyon_core::session::{EngineError, SessionEngine, SessionId};
use kriyon_core::wire::{Frame, FrameDecoder};
use parking_lot::Mutex;

const HIGH_WATER: usize = 128 * 1024;
const LOW_WATER: usize = 16 * 1024;

fn io_err<E: std::fmt::Display>(e: E) -> EngineError {
    EngineError::Pty(e.to_string())
}

pub struct DaemonClient {
    id: SessionId,
    writer: Mutex<UnixStream>,
    reader_thread: Mutex<Option<JoinHandle<()>>>,
    backpressure: Arc<Backpressure>,
}

impl DaemonClient {
    /// Connect to a daemon's socket and start streaming its output to
    /// `on_output`. The caller should call [`DaemonClient::attach`] next.
    ///
    /// # Errors
    /// Returns [`EngineError::Pty`] if the socket cannot be connected/cloned.
    pub fn connect<F>(socket: &Path, on_output: F) -> Result<Self, EngineError>
    where
        F: Fn(Vec<u8>) + Send + 'static,
    {
        let stream = UnixStream::connect(socket).map_err(io_err)?;
        let mut reader = stream.try_clone().map_err(io_err)?;
        let backpressure = Arc::new(Backpressure::new(HIGH_WATER, LOW_WATER));
        let reader_bp = Arc::clone(&backpressure);

        let reader_thread = std::thread::spawn(move || {
            let mut dec = FrameDecoder::new();
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        dec.push(&buf[..n]);
                        while let Some(frame) = dec.next() {
                            if let Frame::Output(bytes) = frame {
                                let len = bytes.len();
                                on_output(bytes);
                                reader_bp.after_send(len);
                            }
                        }
                    }
                }
            }
        });

        Ok(Self {
            id: SessionId(String::new()), // set by caller via with_id if needed
            writer: Mutex::new(stream),
            reader_thread: Mutex::new(Some(reader_thread)),
            backpressure,
        })
    }

    /// Set the session id (kept for the `SessionEngine::id` contract).
    #[must_use]
    pub fn with_id(mut self, id: SessionId) -> Self {
        self.id = id;
        self
    }

    fn send(&self, frame: &Frame) -> Result<(), EngineError> {
        let mut w = self.writer.lock();
        w.write_all(&frame.encode()).map_err(io_err)?;
        w.flush().map_err(io_err)
    }

    /// Send the initial Attach (also sets the daemon's pty size).
    ///
    /// # Errors
    /// Returns [`EngineError::Pty`] on write failure.
    pub fn attach(&self, cols: u16, rows: u16) -> Result<(), EngineError> {
        self.send(&Frame::Attach { cols, rows })
    }

    /// Acknowledge drained bytes, resuming a parked socket reader.
    pub fn report_drained(&self, bytes: usize) {
        self.backpressure.report_drained(bytes);
    }
}

impl SessionEngine for DaemonClient {
    fn id(&self) -> &SessionId {
        &self.id
    }

    fn write_stdin(&self, bytes: &[u8]) -> Result<(), EngineError> {
        self.send(&Frame::Stdin(bytes.to_vec()))
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), EngineError> {
        self.send(&Frame::Resize { cols, rows })
    }

    fn close(&self) -> Result<(), EngineError> {
        // Wake any parked reader so the join never hangs, then ask the daemon to
        // terminate. Best-effort: never panic on teardown.
        self.backpressure.close();
        let _ = self.send(&Frame::Shutdown);
        if let Some(handle) = self.reader_thread.lock().take() {
            let _ = handle.join();
        }
        Ok(())
    }
}
```

- [ ] **Step 4: Wire module + remove old pty.** In `src-tauri/src/lib.rs`: replace `pub mod pty;` with `pub mod daemon_client;`; change `use crate::pty::PtyEngine;` to `use crate::daemon_client::DaemonClient;`; change `pub struct Session { pub engine: PtyEngine, … }` to `pub engine: DaemonClient`. Delete `src-tauri/src/pty.rs`. (The `PtyEngine` now lives only in `kriyon-ptyd`.)

- [ ] **Step 5: Run, verify pass.** Run: `cargo test -p kriyon daemon_client -- --nocapture && cargo clippy -p kriyon -- -D warnings`. Expected: PASS. (Note: `id` defaulting to empty then `with_id` — Task 11 uses `with_id`. The test doesn't assert id.)

- [ ] **Step 6: Commit.**

```bash
git add src-tauri/src/daemon_client.rs src-tauri/src/lib.rs
git rm src-tauri/src/pty.rs
git commit -m "feat(daemon): DaemonClient SessionEngine over the daemon socket"
```

---

### Task 11: Rewire `create_session` / `close_session` to spawn-or-reattach

**Files:**
- Modify: `src-tauri/src/commands.rs` (`create_session`; helper to spawn/locate daemon)
- Modify: `src-tauri/src/lib.rs` (`AppState` unchanged; ensure run dir helper)

**Interfaces:**
- Consumes: `kriyon_core::daemon::session_socket_path`, `DaemonClient`, the daemon binary path.
- Produces: `create_session` now spawns/reattaches a daemon and builds a `DaemonClient`; `close_session` unchanged (calls `engine.close()` which sends Shutdown).

Design: add a private helper in `commands.rs`:

```rust
/// Resolve the daemon binary: $KRIYON_PTYD_BIN, else a sibling of the app exe.
fn ptyd_binary() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("KRIYON_PTYD_BIN") {
        return std::path::PathBuf::from(p);
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join("kriyon-ptyd")))
        .unwrap_or_else(|| std::path::PathBuf::from("kriyon-ptyd"))
}

/// The per-user daemon run dir: `~/.claude/kriyon/run`, created if missing.
fn run_dir(home: &std::path::Path) -> std::path::PathBuf {
    home.join(".claude").join("kriyon").join("run")
}

/// Spawn a detached daemon for `id` if no live one exists, then connect a client.
fn spawn_or_reattach(
    socket: &std::path::Path,
    id: &str,
    cwd: &str,
    shell: &str,
    env: &std::collections::HashMap<String, String>,
    on_output: impl Fn(Vec<u8>) + Send + 'static,
) -> Result<DaemonClient, String> {
    use std::os::unix::process::CommandExt as _;
    // Already live? Reattach.
    if UnixStream::connect(socket).is_ok() {
        return DaemonClient::connect(socket, on_output).map_err(|e| e.to_string());
    }
    // Stale socket file (not connectable): remove before spawning.
    let _ = std::fs::remove_file(socket);

    let mut cmd = std::process::Command::new(ptyd_binary());
    cmd.args(["--socket"]).arg(socket)
        .args(["--id", id, "--cwd", cwd, "--shell", shell]);
    for (k, v) in env {
        cmd.env(k, v);
    }
    // Detach into its own process group so the daemon outlives the app.
    cmd.process_group(0);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    cmd.spawn().map_err(|e| format!("spawn daemon: {e}"))?;

    // Wait for the socket, then connect + attach.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if let Ok(client) = DaemonClient::connect(socket, /* moved once */ ) { /* see note */ }
        if std::time::Instant::now() > deadline {
            return Err("daemon socket never appeared".to_string());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}
```

NOTE: `on_output` is `FnOnce`-moved into `DaemonClient::connect`, so it can't be retried in a loop. Restructure: first poll for the socket file existence (`socket.exists()` + connectable) in the wait loop **without** `on_output`, then call `DaemonClient::connect(socket, on_output)` exactly once after the socket is ready. Final shape:

```rust
    // wait for connectable socket
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if UnixStream::connect(socket).is_ok() {
            break;
        }
        if std::time::Instant::now() > deadline {
            return Err("daemon socket never appeared".to_string());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    DaemonClient::connect(socket, on_output).map_err(|e| e.to_string())
```

(The pre-break `UnixStream::connect` test-connection drops immediately; the real client connects once after.)

Then in `create_session`, after building `spec` and the `callback`, replace the `PtyEngine::spawn(...)` block with:

```rust
    use tauri::Manager as _;
    let home = app
        .path()
        .home_dir()
        .ok()
        .or_else(|| std::env::var("HOME").ok().map(Into::into))
        .ok_or_else(|| "cannot resolve HOME".to_string())?;
    let run = run_dir(&home);
    std::fs::create_dir_all(&run).map_err(|e| e.to_string())?;
    let socket = kriyon_core::daemon::session_socket_path(&run, &id)
        .ok_or_else(|| "invalid session id".to_string())?;

    let client = spawn_or_reattach(&socket, &id, &spec.cwd, &spec.shell, &spec.env, callback)?
        .with_id(SessionId(id.clone()));
    client.attach(80, 24).map_err(|e| e.to_string())?;
    state.sessions.lock().insert(SessionId(id.clone()), Session { engine: client, zdotdir });
```

`create_session` needs `app: tauri::AppHandle` added to its signature (it currently takes only `state`). Add `app: tauri::AppHandle,` as the first param; Tauri injects it. Also add `use std::os::unix::net::UnixStream;` to `commands.rs`.

- [ ] **Step 1: Add the helpers + rewire `create_session`** as above. Keep `report_drained` (it calls `session.engine.report_drained(bytes)` — `DaemonClient` has it). `close_session` is unchanged (`engine.close()` now sends Shutdown).

- [ ] **Step 2: Build + clippy.** Run: `cargo build -p kriyon && cargo clippy -p kriyon -- -D warnings`. Expected: clean. Fix the `create_session` signature/`app` injection and any borrow issues.

- [ ] **Step 3: Set `KRIYON_PTYD_BIN` for dev runs.** In the dev tauri config / run script, ensure `kriyon-ptyd` is built and discoverable. For `cargo test`/dev, the env override is used; for the bundled app, Task 12 handles bundling. Add a note in the run path: `tauri.conf.json` `beforeDevCommand` already builds the frontend; the Rust workspace build produces `target/debug/kriyon-ptyd` next to the app binary, so the sibling lookup works in dev.

- [ ] **Step 4: Run the daemon-client + existing session tests.** Run: `cargo test -p kriyon`. Expected: PASS (the old `pty_engine_echoes_shell_output` test moved to `kriyon-ptyd`; confirm `cargo test -p kriyon-ptyd` still passes too).

- [ ] **Step 5: Commit.**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(daemon): create_session spawns or reattaches the PTY daemon"
```

---

### Task 12: Bundle the daemon binary + manual v-crash verification

**Files:**
- Modify: `src-tauri/tauri.conf.json` (bundle `kriyon-ptyd` as an external binary / resource)
- Modify: `src-tauri/Cargo.toml` only if a build-time copy is needed (likely not)

- [ ] **Step 1: Bundle the binary.** Add `kriyon-ptyd` to the app bundle so it ships next to the main binary. In `src-tauri/tauri.conf.json` `bundle`, add it under `externalBin` (Tauri sidecar) OR `resources`. Simplest that satisfies the sibling lookup: build `kriyon-ptyd` in the same `target/<profile>/` (the workspace already does) and add a bundling `resources`/`externalBin` entry so the packaged `.app` contains it adjacent to the main exe. Verify with `pnpm tauri build` later; for this session, dev (`pnpm tauri dev`) uses the workspace `target/debug/kriyon-ptyd` sibling, so no config change is strictly required to run — add the `externalBin` entry for release completeness.

- [ ] **Step 2: Manual v-crash smoke (the real acceptance test).** Run `pnpm tauri dev`. Open a session, start `claude`, let it run. Kill the **app** process (not the daemon): `pkill -f 'target/debug/kriyon'` (the main app binary), leaving `kriyon-ptyd` alive (`pgrep -fl kriyon-ptyd` shows it). Relaunch `pnpm tauri dev`; the persisted session reattaches and the live `claude` session resumes via the daemon. Confirm output streams and input works. Document the result in the commit/handoff.

- [ ] **Step 3: Commit.**

```bash
git add src-tauri/tauri.conf.json
git commit -m "build(daemon): bundle kriyon-ptyd alongside the app binary"
```

---

### Task 13: Green gate, code-reviewer pass, final commit

- [ ] **Step 1: Full check.** Run: `pnpm check`. Expected: all green (JS lint + tsc + Vitest + rustfmt + clippy `-D warnings` + cargo test across all three crates). Fix anything; `pnpm fix` for formatting.
- [ ] **Step 2: Code-reviewer subagent** over the whole Phase 5 diff (`git diff main...feat/session-activity` scoped to the new files). Address Critical/Important findings via TDD before finalizing.
- [ ] **Step 3:** Ensure no stray staged pre-existing files (`Cargo.lock` is legit here — the new crate added it; `PRODUCT.md` and the unrelated spec stay out).
- [ ] **Step 4:** Phase 5 complete. Proceed to `superpowers:finishing-a-development-branch` for the whole 5-phase effort, then `/handoff`.

---

## Self-Review

**Spec coverage:**
- Diff (committed, base...HEAD) → Tasks 1,2. Default branch → Task 2. Merge + conflict surfacing → Task 2. Wire format structured/parsed-in-core, reuse DiffLine → Task 1. Commands/bridge/types → Task 3. Review UI in worktree surface → Task 4. ✓
- Daemon byte-proxy, one-per-session → Tasks 6–11. Wire protocol pure in core → Task 6. Socket path + id validation (trust boundary) → Task 7. Daemon owns PTY + ring + proxy → Task 8. Crash-survival automated test → Task 9. DaemonClient (SessionEngine, unchanged backpressure) → Task 10. Spawn/discovery/reattach + orphan cleanup (child-exit reaper, stale-socket lazy clean) → Tasks 8,11. Bundle + manual v-crash → Task 12. ✓
- CONTEXT.md terms before identifiers → Tasks 1 (git) and 6/7 (daemon). ✓
- Green gate + code-reviewer → Tasks 5, 13. ✓

**Placeholder scan:** The two `NOTE:` blocks in Tasks 1, 2, 8, 11 are *corrections* that give the final code form, not deferrals — each ends with the concrete code. No TODO/TBD left.

**Type consistency:** `SessionDiff`, `FileDiff`, `DiffHunk`, `FileChange`, `MergeOutcome`, `Frame`, `FrameDecoder`, `DaemonClient`, `session_socket_path`, `is_valid_session_id`, `diff_worktree`, `merge_worktree`, `default_branch` used identically across Rust, bridge, and TS. `DiffLine`/`DiffKind` reused from `transcript.rs` (Rust) and the existing `DiffLine` TS type. ✓
