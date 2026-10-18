# Changes View Round-Two Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship six UX/correctness improvements to the Kriyon Code Changes View (PR #10): collapsible Inspector stats, session-scoped changes via a git baseline, return-to-prior-view on session click, a zero-change bug fix, in-app file editing, and a couple of cheap extras.

**Architecture:** Rust core owns all git/fs; a new hook-free `snapshot_tree` (temp-index `write-tree`) captures a per-session baseline oid, and `diff_session_changes` diffs baseline-tree vs a current snapshot tree. `touchedFiles` becomes an attribution badge, not a filter. A new sandboxed `write_file` command enables editing behind a lazy-loaded CodeMirror 6 editor. Frontend stays a thin UI over `src/ipc/bridge.ts`.

**Tech Stack:** Rust (Tauri v2, rusqlite, std::process git), React 19 + Zustand stores, Vitest, CodeMirror 6 (lazy), shiki (existing, read-only view).

## Global Constraints

- `pnpm check` must pass before every commit. Rust commits need `PATH="$HOME/.cargo/bin:$PATH" git commit`.
- Rust tests: `CARGO_BUILD_JOBS=1 cargo test ... -- --test-threads=1` (parallel OOMs on this machine). Push with `RUST_TEST_THREADS=1 CARGO_BUILD_JOBS=1`.
- Stage NAMED files only — never `git add -u`/`-A`/`.` (multiple live sessions share this checkout).
- Any Rust that spawns git MUST route through `git_cmd::output_with_retry` / `run_git` (clears `GIT_DIR`/`GIT_WORK_TREE`).
- Styling from `src/theme/tokens.ts` only — never hardcode colors/spacing.
- The Rust↔JS IPC boundary is a trust boundary: every command validates inputs (`validate_cwd` + `resolve_within`); never trust frontend paths/ids.
- Panes/feeds are display-toggled, never unmounted — tests assert `display:none`, not just mounted.
- Conventional commits, small and frequent. Never commit to `main`.
- `grep -a` when auditing `dist` chunks (shiki must stay out of the entry chunk).
- Avoid `Array.prototype.at()` (tsc lib rejects it).
- Namespace SDD brief/report files `r2-task-N-*` to avoid colliding with existing `fb-task-*`.

---

## File structure

**Rust (`src-tauri` / `crates/kriyon-core`):**
- `crates/kriyon-core/src/git.rs` — add `binary: bool` to `FileDiff` + parse the `Binary files … differ` line (Task 7).
- `src-tauri/src/git_cmd.rs` — `snapshot_tree`, `capture_baseline`, `diff_session_changes`, `repo_toplevel` commands (Tasks 1–3, 5).
- `src-tauri/src/store.rs` — `baseline_oid` column + `SessionRow` field + `upsert_session` (Task 4).
- `src-tauri/src/file_cmd.rs` — `mtime` on `FileContent`; new `write_file` command (Tasks 12–13).
- `src-tauri/src/lib.rs` — register new commands (Tasks 1, 3, 5, 13).

**Frontend (`src`):**
- `src/types.ts` — `SessionRow.baselineOid`, `FileDiff.binary`, `FileContent.mtime`, `FileWriteResult` (Tasks 4, 7, 12, 13).
- `src/ipc/bridge.ts` — `captureBaseline`, `diffSessionChanges`, `repoToplevel`, `writeFile` wrappers (Tasks 1, 3, 5, 13).
- `src/state/sessions.ts` — `baselineOid` plumbing, capture-on-create, `repoToplevel` cache (Tasks 4, 6).
- `src/state/actions.ts` — capture baseline after `createSession` (Task 4).
- `src/state/changes.ts` — source selection (baseline vs fallback), touched-file relativization, zero-change filtering, `computeTotals` fix (Tasks 6, 8, 9).
- `src/state/layout.ts` + `src/state/persistence.ts` — `inspectorChangesOpen`, `preChangesView`/`leaveChangesView` (Tasks 10, 14).
- `src/ui/CollapsibleSection.tsx` — new vertical collapsible (Task 10).
- `src/inspector/Inspector.tsx` — stats-on-top + collapsible list (Task 11).
- `src/sidebar/Sidebar.tsx` (or `ProjectGroup.tsx` seam) — `leaveChangesView()` on select (Task 14).
- `src/changes/DiffFileCard.tsx` / `ChangedFilesList` — badge, binary/rename/empty rendering, copy-path (Tasks 8, 9, 15).
- `src/changes/FileViewer.tsx` — CodeMirror 6 editor + save/dirty/conflict (Tasks 12, 16, 17).
- `src/changes/CodeEditor.tsx` — new lazy CM6 wrapper (Task 16).

**Docs:** `docs/adr/` — baseline model ADR (Task 3), CM6 ADR (Task 16).

Sequencing: item 4 bug fix (Task 7–9) and item 2 baseline (Tasks 1–6) are independent of item 5 editor (Tasks 12–17) and items 1/3 (Tasks 10–11, 14–15). Rust foundations first so frontend tasks consume real signatures.

---

## Task 1: `snapshot_tree` + `capture_baseline` (hook-free working-tree snapshot)

**Files:**
- Modify: `src-tauri/src/git_cmd.rs`
- Modify: `src-tauri/src/lib.rs` (register `capture_baseline`)
- Test: `src-tauri/src/git_cmd.rs` (inline `#[cfg(test)]`)

**Interfaces:**
- Produces: `fn snapshot_tree(repo_path: &str) -> Result<String, String>` (returns a tree oid); `#[tauri::command(async)] fn capture_baseline(store: State<StoreState>, cwd: String) -> Result<String, String>`.
- Consumes: `output_with_retry`, `run_git`, `reject_flag_like` (existing in `git_cmd.rs`); `completion_cmd::validate_cwd`.

- [ ] **Step 1: Write the failing test** — captures tracked + untracked, respects gitignore, moves no refs/HEAD/index, ignores an inherited `GIT_DIR`.

```rust
#[test]
fn snapshot_tree_captures_tracked_and_untracked_without_moving_refs() {
    let repo = TempRepo::new(); // helper already used by other git_cmd tests; else init+commit
    repo.write("committed.txt", "a\n");
    repo.git(&["add", "committed.txt"]);
    repo.git(&["commit", "-m", "init"]);
    repo.write("committed.txt", "a\nb\n"); // modify tracked
    repo.write("untracked.txt", "new\n");  // untracked
    repo.write(".gitignore", "ignored.txt\n");
    repo.write("ignored.txt", "no\n");     // ignored

    let head_before = repo.git(&["rev-parse", "HEAD"]);
    let index_before = repo.git(&["rev-parse", "--verify", "-q", ":committed.txt"]).ok();

    let oid = snapshot_tree(repo.path_str()).expect("snapshot");

    // tree contains modified + untracked, NOT the ignored file
    let ls = repo.git(&["ls-tree", "-r", "--name-only", &oid]);
    assert!(ls.contains("committed.txt"));
    assert!(ls.contains("untracked.txt"));
    assert!(!ls.contains("ignored.txt"));
    // committed.txt in the tree has the MODIFIED content
    let blob = repo.git(&["show", &format!("{oid}:committed.txt")]);
    assert_eq!(blob, "a\nb\n");
    // nothing moved
    assert_eq!(repo.git(&["rev-parse", "HEAD"]), head_before);
    assert_eq!(repo.git(&["rev-parse", "--verify", "-q", ":committed.txt"]).ok(), index_before);
}
```

If `TempRepo` doesn't exist, reuse the existing test scaffold in `git_cmd.rs`/`git.rs` tests (they already `git init` in tempdirs); mirror that pattern with `tempfile::tempdir()` + `run_git`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && CARGO_BUILD_JOBS=1 cargo test snapshot_tree_captures -- --test-threads=1`
Expected: FAIL (`snapshot_tree` not found).

- [ ] **Step 3: Implement `snapshot_tree` + `capture_baseline`**

```rust
/// Snapshot the current working tree (tracked + untracked, honoring .gitignore)
/// into a dangling tree object WITHOUT touching the real index, HEAD, refs, or
/// firing any commit hooks. Uses a throwaway GIT_INDEX_FILE.
fn snapshot_tree(repo_path: &str) -> Result<String, String> {
    let tmp = tempfile::Builder::new()
        .prefix("kriyon-idx-")
        .tempfile()
        .map_err(|e| format!("temp index: {e}"))?;
    let idx = tmp.path().to_owned();
    // A fresh (empty) index + `add -A` stages the whole working tree as new.
    let mut add = std::process::Command::new("git");
    add.arg("-C").arg(repo_path).arg("add").arg("-A");
    add.env("GIT_INDEX_FILE", &idx);
    let out = output_with_retry(&mut add).map_err(|e| format!("git add: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let mut wt = std::process::Command::new("git");
    wt.arg("-C").arg(repo_path).arg("write-tree");
    wt.env("GIT_INDEX_FILE", &idx);
    let out = output_with_retry(&mut wt).map_err(|e| format!("git write-tree: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[tauri::command(async)]
#[allow(clippy::needless_pass_by_value)]
pub fn capture_baseline(
    store: tauri::State<'_, crate::StoreState>,
    cwd: String,
) -> Result<String, String> {
    reject_flag_like("cwd", &cwd)?;
    let canonical = crate::completion_cmd::validate_cwd(store.inner(), std::path::Path::new(&cwd))?;
    snapshot_tree(&canonical.to_string_lossy())
}
```

Note: `output_with_retry` already `env_remove`s `GIT_DIR`/`GIT_WORK_TREE`; we set `GIT_INDEX_FILE` on top. Confirm `tempfile` is already a dependency (it is, used by tests) — if not in non-test deps, add it to `[dependencies]`.

- [ ] **Step 4: Register the command** in `src-tauri/src/lib.rs` `generate_handler![…]` beside the other `git_cmd::` commands:

```rust
git_cmd::capture_baseline,
```

- [ ] **Step 5: Run tests + clippy + fmt**

Run: `cd src-tauri && CARGO_BUILD_JOBS=1 cargo test snapshot_tree_captures -- --test-threads=1 && cargo clippy --all-targets -- -D warnings && cargo fmt --check`
Expected: PASS, clippy clean, fmt clean.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/git_cmd.rs src-tauri/src/lib.rs
PATH="$HOME/.cargo/bin:$PATH" git commit -m "feat(changes): hook-free working-tree snapshot + capture_baseline command"
```

---

## Task 2: `diff_session_changes` (baseline-tree vs current-tree diff)

**Files:**
- Modify: `src-tauri/src/git_cmd.rs`
- Test: `src-tauri/src/git_cmd.rs`

**Interfaces:**
- Produces: `#[tauri::command(async)] fn diff_session_changes(store, cwd: String, baseline_oid: String) -> Result<SessionDiff, String>`.
- Consumes: `snapshot_tree` (Task 1), `run_git`, `parse_diff` (`kriyon_core::git`), `resolve_short_sha`, `SessionDiff`.

- [ ] **Step 1: Write the failing tests** — three behaviors that distinguish baseline-diff from the working-tree diff.

```rust
#[test]
fn diff_session_changes_catches_non_tool_edits_and_self_corrects_reverts() {
    let repo = TempRepo::new();
    repo.write("a.txt", "1\n"); repo.git(&["add", "."]); repo.git(&["commit", "-m", "init"]);
    let baseline = snapshot_tree(repo.path_str()).unwrap();

    // edit made by ANY means (simulating a Bash/sed edit)
    repo.write("a.txt", "1\n2\n");
    repo.write("b.txt", "new\n"); // untracked new file after baseline

    let diff = diff_session_changes_sync(repo.path_str(), &baseline).unwrap();
    let paths: Vec<_> = diff.files.iter().map(|f| f.path.as_str()).collect();
    assert!(paths.contains(&"a.txt")); // caught even though no tool "touched" it
    assert!(paths.contains(&"b.txt")); // untracked-after-baseline shows as added

    // revert a.txt to baseline content -> disappears
    repo.write("a.txt", "1\n");
    let diff2 = diff_session_changes_sync(repo.path_str(), &baseline).unwrap();
    let paths2: Vec<_> = diff2.files.iter().map(|f| f.path.as_str()).collect();
    assert!(!paths2.contains(&"a.txt"));
}

#[test]
fn diff_session_changes_excludes_pre_session_dirt() {
    let repo = TempRepo::new();
    repo.write("a.txt", "1\n"); repo.git(&["add", "."]); repo.git(&["commit", "-m", "init"]);
    repo.write("dirty.txt", "predates\n"); // uncommitted BEFORE baseline
    let baseline = snapshot_tree(repo.path_str()).unwrap();
    // no further edits
    let diff = diff_session_changes_sync(repo.path_str(), &baseline).unwrap();
    assert!(diff.files.is_empty()); // pre-session dirt is baked into the baseline
}
```

Factor the logic into a testable `diff_session_changes_sync(repo_path, baseline_oid)` and have the `#[tauri::command]` wrapper call it after `validate_cwd` (mirrors `diff_working_tree` / `diff_working_tree_sync`).

- [ ] **Step 2: Run to verify fail**

Run: `cd src-tauri && CARGO_BUILD_JOBS=1 cargo test diff_session_changes -- --test-threads=1`
Expected: FAIL (not found).

- [ ] **Step 3: Implement**

```rust
fn diff_session_changes_sync(repo_path: &str, baseline_oid: &str) -> Result<SessionDiff, String> {
    let current = snapshot_tree(repo_path)?;
    // -M detects renames; tree-vs-tree covers tracked AND untracked uniformly.
    let raw = run_git(repo_path, &["diff", "-M", baseline_oid, &current])?;
    let files = kriyon_core::git::parse_diff(&raw);
    Ok(SessionDiff {
        base: baseline_oid.to_string(),
        base_sha: resolve_short_sha(repo_path, baseline_oid),
        files,
    })
}

#[tauri::command(async)]
#[allow(clippy::needless_pass_by_value)]
pub fn diff_session_changes(
    store: tauri::State<'_, crate::StoreState>,
    cwd: String,
    baseline_oid: String,
) -> Result<SessionDiff, String> {
    reject_flag_like("cwd", &cwd)?;
    reject_flag_like("baseline_oid", &baseline_oid)?;
    let canonical = crate::completion_cmd::validate_cwd(store.inner(), std::path::Path::new(&cwd))?;
    diff_session_changes_sync(&canonical.to_string_lossy(), &baseline_oid)
}
```

- [ ] **Step 4: Run tests** — Run: `cd src-tauri && CARGO_BUILD_JOBS=1 cargo test diff_session_changes -- --test-threads=1` → PASS.

- [ ] **Step 5: Register + commit** — add `git_cmd::diff_session_changes,` to `lib.rs` handler.

```bash
git add src-tauri/src/git_cmd.rs src-tauri/src/lib.rs
PATH="$HOME/.cargo/bin:$PATH" git commit -m "feat(changes): diff_session_changes (baseline-tree vs current-tree)"
```

---

## Task 3: `repo_toplevel` command + baseline ADR

**Files:**
- Modify: `src-tauri/src/git_cmd.rs`, `src-tauri/src/lib.rs`
- Create: `docs/adr/NNNN-session-baseline-changes-model.md`
- Test: `src-tauri/src/git_cmd.rs`

**Interfaces:**
- Produces: `#[tauri::command(async)] fn repo_toplevel(store, cwd: String) -> Result<String, String>` (absolute repo root, for relativizing absolute `touchedFiles`).

- [ ] **Step 1: Failing test**

```rust
#[test]
fn repo_toplevel_returns_worktree_root() {
    let repo = TempRepo::new();
    repo.write("a.txt", "1\n"); repo.git(&["add","."]); repo.git(&["commit","-m","i"]);
    let top = repo_toplevel_sync(repo.path_str()).unwrap();
    assert_eq!(std::fs::canonicalize(&top).unwrap(),
               std::fs::canonicalize(repo.path_str()).unwrap());
}
```

- [ ] **Step 2: Verify fail** — `cargo test repo_toplevel -- --test-threads=1` → FAIL.

- [ ] **Step 3: Implement**

```rust
fn repo_toplevel_sync(repo_path: &str) -> Result<String, String> {
    Ok(run_git(repo_path, &["rev-parse", "--show-toplevel"])?.trim().to_string())
}

#[tauri::command(async)]
#[allow(clippy::needless_pass_by_value)]
pub fn repo_toplevel(
    store: tauri::State<'_, crate::StoreState>,
    cwd: String,
) -> Result<String, String> {
    reject_flag_like("cwd", &cwd)?;
    let canonical = crate::completion_cmd::validate_cwd(store.inner(), std::path::Path::new(&cwd))?;
    repo_toplevel_sync(&canonical.to_string_lossy())
}
```

- [ ] **Step 4: Verify pass** — `cargo test repo_toplevel -- --test-threads=1` → PASS.

- [ ] **Step 5: Write the ADR** (`docs/adr/` — use the next number in sequence). Content: decision = per-session git baseline oid diffed tree-vs-tree; context = two sessions on one branch saw identical working-tree diffs; alternatives considered = touched-file intersection (rejected: misses Bash edits, can't self-correct reverts — cite Cline/Aider/Warp/Claude-Code convergence); consequences = one snapshot spawn per new session, `touchedFiles` demoted to attribution badge, pre-feature sessions fall back to merge-base `diff_working_tree`.

- [ ] **Step 6: Register + commit**

```bash
git add src-tauri/src/git_cmd.rs src-tauri/src/lib.rs docs/adr/NNNN-session-baseline-changes-model.md
PATH="$HOME/.cargo/bin:$PATH" git commit -m "feat(changes): repo_toplevel command + baseline model ADR"
```

---

## Task 4: Persist `baseline_oid` on the session (Rust + TS schema)

**Files:**
- Modify: `src-tauri/src/store.rs` (schema, `SessionRow`, `upsert_session`)
- Modify: `src/types.ts` (`SessionRow`)
- Modify: `src/ipc/bridge.ts` (`captureBaseline`, `diffSessionChanges`, `repoToplevel` wrappers)
- Test: `src-tauri/src/store.rs`

**Interfaces:**
- Produces: `SessionRow.baseline_oid: Option<String>` (Rust) / `SessionRow.baselineOid: string | null` (TS); bridge `captureBaseline(cwd): Promise<string>`, `diffSessionChanges(cwd, baselineOid): Promise<SessionDiff>`, `repoToplevel(cwd): Promise<string>`.
- Consumes: `migrate_column` (`store.rs:202`).

- [ ] **Step 1: Failing test** — persist + read back a baseline oid; existing rows migrate to NULL.

```rust
#[test]
fn upsert_session_roundtrips_baseline_oid() {
    let store = StoreState::in_memory(); // or the existing test constructor
    let mut row = sample_session_row(); // helper used by other store tests
    row.baseline_oid = Some("deadbeef".into());
    store.upsert_session(&row).unwrap();
    let got = store.session(&row.id).unwrap().unwrap();
    assert_eq!(got.baseline_oid.as_deref(), Some("deadbeef"));
}
```

- [ ] **Step 2: Verify fail** — `cargo test upsert_session_roundtrips_baseline_oid -- --test-threads=1` → FAIL (field/column absent).

- [ ] **Step 3: Implement**
  - Add `baseline_oid TEXT` via `migrate_column("sessions", "baseline_oid", "TEXT")` next to the `archived_at` migration (`store.rs:189`).
  - Add `pub baseline_oid: Option<String>` to the Rust `SessionRow` struct (`store.rs:35-49`).
  - Thread it through `upsert_session` (column list + bind params, `store.rs:258-279`) and the row-read `session`/list mappers.
  - TS: add `baselineOid: string | null;` to `SessionRow` (`types.ts:104-119`).
  - Bridge: add `captureBaseline`, `diffSessionChanges`, `repoToplevel` beside `readFile` (`bridge.ts`):

```ts
export function captureBaseline(cwd: string): Promise<string> {
  return invoke("capture_baseline", { cwd });
}
export function diffSessionChanges(cwd: string, baselineOid: string): Promise<SessionDiff> {
  return invoke("diff_session_changes", { cwd, baselineOid });
}
export function repoToplevel(cwd: string): Promise<string> {
  return invoke("repo_toplevel", { cwd });
}
```

- [ ] **Step 4: Verify pass** — Rust test PASS; `pnpm typecheck` clean (SessionRow consumers may need the new field — set `baselineOid: null` in every `SessionRow` literal, incl. tests and `createSession`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/store.rs src/types.ts src/ipc/bridge.ts
PATH="$HOME/.cargo/bin:$PATH" git commit -m "feat(changes): persist baseline_oid on the session record"
```

---

## Task 5: Capture baseline on session creation (frontend)

**Files:**
- Modify: `src/state/actions.ts` (`createSession`, and the seed path ~`:184`)
- Modify: `src/state/sessions.ts` (a `setBaseline(id, oid)` action + store field)
- Test: `src/state/actions.test.ts` (or the existing sessions/actions test file)

**Interfaces:**
- Produces: `sessions.setBaseline(id: string, oid: string): void`; sessions store carries `baselineOid` per session (via the persisted `SessionRow`).
- Consumes: `bridge.captureBaseline` (Task 4).

- [ ] **Step 1: Failing test** — creating a session captures a baseline and persists it; a capture failure leaves `baselineOid` null (fallback) without throwing.

```ts
it("captures and stores a baseline oid on session creation", async () => {
  vi.mocked(bridge.captureBaseline).mockResolvedValue("cafebabe");
  const id = await actions.createSession(project, "/repo", "t");
  await flushPromises();
  expect(bridge.captureBaseline).toHaveBeenCalledWith("/repo");
  expect(useSessions.getState().sessions[id].row.baselineOid).toBe("cafebabe");
  expect(bridge.upsertSession).toHaveBeenLastCalledWith(
    expect.objectContaining({ baselineOid: "cafebabe" }),
  );
});

it("falls back to null baseline when capture fails", async () => {
  vi.mocked(bridge.captureBaseline).mockRejectedValue(new Error("not a repo"));
  const id = await actions.createSession(project, "/repo", "t");
  await flushPromises();
  expect(useSessions.getState().sessions[id].row.baselineOid).toBeNull();
});
```

- [ ] **Step 2: Verify fail** — `pnpm vitest run actions` → FAIL.

- [ ] **Step 3: Implement** — after `persistThenWarm(project, row)` in `createSession`, fire-and-forget:

```ts
// row starts with baselineOid: null
void bridge
  .captureBaseline(cwd)
  .then((oid) => get().setBaseline(id, oid))
  .catch(() => {/* fallback: keep null -> diff_working_tree path */});
```

`setBaseline` updates the in-store `row.baselineOid` AND re-persists via `bridge.upsertSession(updatedRow)`. Add `baselineOid: null` to both row builders (`actions.ts:99-108` and `:184`).

- [ ] **Step 4: Verify pass** — `pnpm vitest run actions` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/actions.ts src/state/sessions.ts src/state/actions.test.ts
git commit -m "feat(changes): capture a git baseline when a session is created"
```

---

## Task 6: Changes store — source selection (baseline vs fallback)

**Files:**
- Modify: `src/state/changes.ts` (`refresh`/`doRefresh`)
- Modify: callers passing the session to `refresh` (`src/state/sessions.ts` `refreshSessionChanges` ~`:382-408`)
- Test: `src/state/changes.test.ts`

**Interfaces:**
- Produces: `refresh` chooses `diffSessionChanges(cwd, baselineOid)` when `baselineOid` is present, else `diffWorkingTree(cwd, base)`.
- Consumes: `bridge.diffSessionChanges` / `bridge.diffWorkingTree`.

- [ ] **Step 1: Failing test**

```ts
it("uses diff_session_changes when the session has a baseline oid", async () => {
  vi.mocked(bridge.diffSessionChanges).mockResolvedValue(sampleDiff);
  await useChanges.getState().refresh("s1", "/repo", { baselineOid: "cafebabe" });
  expect(bridge.diffSessionChanges).toHaveBeenCalledWith("/repo", "cafebabe");
  expect(bridge.diffWorkingTree).not.toHaveBeenCalled();
});

it("falls back to diff_working_tree when there is no baseline oid", async () => {
  vi.mocked(bridge.diffWorkingTree).mockResolvedValue(sampleDiff);
  await useChanges.getState().refresh("s1", "/repo", { baselineOid: null, base: "main" });
  expect(bridge.diffWorkingTree).toHaveBeenCalledWith("/repo", "main");
});
```

- [ ] **Step 2: Verify fail** — `pnpm vitest run changes` → FAIL.

- [ ] **Step 3: Implement** — widen `refresh`/`doRefresh` signature to accept `{ baselineOid?: string | null; base?: string }`; branch on `baselineOid`. Update `refreshSessionChanges` in `sessions.ts` to pass `session.row.baselineOid`. Keep the in-flight de-dupe and `fetchedAt`-only-on-success behavior intact.

- [ ] **Step 4: Verify pass** — `pnpm vitest run changes` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/changes.ts src/state/sessions.ts src/state/changes.test.ts
git commit -m "feat(changes): route session-scoped diffs through the baseline when present"
```

---

## Task 7: `FileDiff.binary` flag (parser)

**Files:**
- Modify: `crates/kriyon-core/src/git.rs` (`FileDiff`, `parse_diff`)
- Modify: `src/types.ts` (`FileDiff`)
- Test: `crates/kriyon-core/src/git.rs`

**Interfaces:**
- Produces: `FileDiff.binary: bool` (Rust) / `binary: boolean` (TS).

- [ ] **Step 1: Failing test**

```rust
#[test]
fn parse_diff_flags_binary_files() {
    let raw = "diff --git a/img.png b/img.png\nnew file mode 100644\nindex 0000000..abc1234\nBinary files /dev/null and b/img.png differ\n";
    let files = parse_diff(raw);
    assert_eq!(files.len(), 1);
    assert!(files[0].binary);
    assert!(files[0].hunks.is_empty());
}

#[test]
fn parse_diff_text_file_is_not_binary() {
    let raw = "diff --git a/a.rs b/a.rs\nindex 111..222 100644\n--- a/a.rs\n+++ b/a.rs\n@@ -1 +1,2 @@\n x\n+y\n";
    let files = parse_diff(raw);
    assert!(!files[0].binary);
}
```

- [ ] **Step 2: Verify fail** — `cd crates/kriyon-core && CARGO_BUILD_JOBS=1 cargo test parse_diff_flags_binary -- --test-threads=1` → FAIL (no `binary` field).

- [ ] **Step 3: Implement** — add `pub binary: bool` to `FileDiff` (default `false` at open); in `parse_diff` (`git.rs:188-265`), when a line starts with `Binary files ` set the current file's `binary = true`. Update every `FileDiff { … }` literal (incl. `untracked_as_diff`, tests) to include `binary: false`. Add `binary: boolean;` to TS `FileDiff` (`types.ts`).

- [ ] **Step 4: Verify pass** — `cargo test parse_diff -- --test-threads=1` → PASS; `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add crates/kriyon-core/src/git.rs src/types.ts
PATH="$HOME/.cargo/bin:$PATH" git commit -m "fix(changes): flag binary files in parse_diff"
```

---

## Task 8: Filter zero-change noise + `computeTotals` fix (store)

**Files:**
- Modify: `src/state/changes.ts` (`fileDiffCounts`, `computeTotals`, add `isNoise`/`fileKind` helpers)
- Test: `src/state/changes.test.ts`

**Interfaces:**
- Produces: `fileKind(file: FileDiff): "binary" | "rename" | "empty" | "content"`; `visibleFiles(diff): FileDiff[]` (drops true noise); `computeTotals` counts binary/rename/empty as 1 file / 0 lines and excludes noise.

- [ ] **Step 1: Failing test**

```ts
it("drops zero-change non-binary modified noise but keeps binary/rename/empty", () => {
  const diff = { base: "x", baseSha: null, files: [
    { path: "noise.ts", oldPath: undefined, status: "Modified", binary: false, hunks: [] },
    { path: "img.png",  oldPath: undefined, status: "Modified", binary: true,  hunks: [] },
    { path: "new.rs",   oldPath: "old.rs",  status: "Renamed",  binary: false, hunks: [] },
    { path: "empty.txt",oldPath: undefined, status: "Added",    binary: false, hunks: [] },
    { path: "real.ts",  oldPath: undefined, status: "Modified", binary: false,
      hunks: [{ header: "@@ -1 +1,2 @@", lines: [{kind:"added",text:"y"}] }] },
  ]};
  const vis = visibleFiles(diff).map((f) => f.path);
  expect(vis).toEqual(["img.png", "new.rs", "empty.txt", "real.ts"]); // noise.ts dropped
  const totals = computeTotals(diff);
  expect(totals.files).toBe(4);
});
```

- [ ] **Step 2: Verify fail** — `pnpm vitest run changes` → FAIL.

- [ ] **Step 3: Implement** — `fileKind`: binary→"binary"; `status==="Renamed" && hunks.length===0`→"rename"; `hunks.length===0 && (Added||Deleted)`→"empty"; `hunks.length===0 && Modified && !binary`→noise (excluded); else "content". `visibleFiles` filters out noise. `computeTotals` sums line counts over hunks and counts each visible file once. Route the Inspector list, `DiffFeed`, jump rail, and `SummaryBar` totals through `visibleFiles`/the fixed totals so counts match everywhere.

- [ ] **Step 4: Verify pass** — `pnpm vitest run changes` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/changes.ts src/state/changes.test.ts
git commit -m "fix(changes): drop 0-change noise, count binary/rename/empty by kind"
```

---

## Task 9: Render binary/rename/empty by kind + copy-path (file card/row)

**Files:**
- Modify: `src/changes/DiffFileCard.tsx`, `src/inspector/ChangedFilesList.tsx`
- Test: `src/changes/DiffFileCard.test.tsx`

**Interfaces:**
- Consumes: `fileKind` (Task 8).

- [ ] **Step 1: Failing test** — binary shows a `binary` chip and no `±` counts; rename shows `old → new`; empty shows an `empty` tag; copy-path button copies the repo-relative path.

```tsx
it("renders a binary file with a binary tag and no line counts", () => {
  render(<DiffFileCard file={binaryFile} .../>);
  expect(screen.getByText(/binary/i)).toBeInTheDocument();
  expect(screen.queryByText(/^[+]\d/)).not.toBeInTheDocument();
});
it("renders a rename as old → new", () => {
  render(<DiffFileCard file={renamedFile} .../>);
  expect(screen.getByText(/old\.rs/)).toBeInTheDocument();
  expect(screen.getByText(/new\.rs/)).toBeInTheDocument();
});
it("copies the repo-relative path", async () => {
  const writeText = vi.fn();
  Object.assign(navigator, { clipboard: { writeText } });
  render(<DiffFileCard file={realFile} .../>);
  await userEvent.click(screen.getByRole("button", { name: /copy path/i }));
  expect(writeText).toHaveBeenCalledWith(realFile.path);
});
```

- [ ] **Step 2: Verify fail** → FAIL.

- [ ] **Step 3: Implement** — branch the card/row header on `fileKind`: `binary`/`empty` tags (tokens colors), rename `oldPath → path`, `content` keeps existing `±` counts. Add a small copy-path icon button (tokens styling, `aria-label="Copy path"`).

- [ ] **Step 4: Verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/changes/DiffFileCard.tsx src/inspector/ChangedFilesList.tsx src/changes/DiffFileCard.test.tsx
git commit -m "feat(changes): kind-aware file rows (binary/rename/empty) + copy path"
```

---

## Task 10: `CollapsibleSection` component + layout `inspectorChangesOpen`

**Files:**
- Create: `src/ui/CollapsibleSection.tsx`
- Modify: `src/state/layout.ts` (field + setter), `src/state/persistence.ts` (persist/parse)
- Test: `src/ui/CollapsibleSection.test.tsx`, `src/state/layout.test.ts`

**Interfaces:**
- Produces: `CollapsibleSection({ title, open, onToggle, children, testId, headerRight? })`; layout `inspectorChangesOpen: boolean` (default `true`) + `setInspectorChangesOpen(open: boolean)`.

- [ ] **Step 1: Failing tests** — clicking the header toggles via `onToggle`; body hidden when `open=false` (assert `display:none`, kept mounted); layout persists the flag.

```tsx
it("hides the body when closed but keeps it mounted", () => {
  const { rerender } = render(
    <CollapsibleSection title="Changes" open onToggle={vi.fn()} testId="cs"><p>x</p></CollapsibleSection>);
  expect(screen.getByText("x")).toBeVisible();
  rerender(<CollapsibleSection title="Changes" open={false} onToggle={vi.fn()} testId="cs"><p>x</p></CollapsibleSection>);
  expect(screen.getByText("x")).not.toBeVisible(); // display:none, still in DOM
});
it("fires onToggle when the header is clicked", async () => {
  const onToggle = vi.fn();
  render(<CollapsibleSection title="Changes" open onToggle={onToggle} testId="cs"><p>x</p></CollapsibleSection>);
  await userEvent.click(screen.getByRole("button", { name: /changes/i }));
  expect(onToggle).toHaveBeenCalledWith(false);
});
```

```ts
it("persists inspectorChangesOpen", () => {
  useLayout.getState().setInspectorChangesOpen(false);
  const raw = serializeLayout(useLayout.getState().layout);
  expect(deserializeLayout(raw).inspectorChangesOpen).toBe(false);
});
```

- [ ] **Step 2: Verify fail** → FAIL.

- [ ] **Step 3: Implement** — `CollapsibleSection`: a header `<button>` (title + chevron rotated by `open`, optional `headerRight` slot) and a body wrapper with `style={{ display: open ? "block" : "none" }}` (mounted always). Tokens-only. Layout: add field to `Layout` + `DEFAULT_LAYOUT` (`true`), setter, and persistence parse (`persistence.ts` — mirror `transcriptView` boolean coercion; default `true` on garbage).

- [ ] **Step 4: Verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/CollapsibleSection.tsx src/ui/CollapsibleSection.test.tsx src/state/layout.ts src/state/layout.test.ts src/state/persistence.ts
git commit -m "feat(inspector): CollapsibleSection component + persisted open state"
```

---

## Task 11: Inspector — stats on top, list collapsible

**Files:**
- Modify: `src/inspector/Inspector.tsx`
- Test: `src/inspector/Inspector.test.tsx`

**Interfaces:**
- Consumes: `CollapsibleSection`, `inspectorChangesOpen`/`setInspectorChangesOpen` (Task 10); `computeTotals`/`visibleFiles` (Task 8).

- [ ] **Step 1: Failing test** — the aggregate summary (`N files`, `+adds −dels`) renders in the always-visible header; the file list hides when collapsed; toggling persists.

```tsx
it("keeps the stats summary visible when the list is collapsed", async () => {
  renderInspector({ changes: sampleChanges }); // totals: 3 files +10 -4
  expect(screen.getByText(/3 files/i)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: /changes/i }));
  expect(screen.getByText(/3 files/i)).toBeVisible();        // stats stay
  expect(screen.queryByTestId("changed-files-list")).not.toBeVisible(); // list hidden
});
```

- [ ] **Step 2: Verify fail** → FAIL.

- [ ] **Step 3: Implement** — wrap the `Changes` section body (the `Kv` rows + `ChangedFilesList`) in `CollapsibleSection`, driving `open` from `inspectorChangesOpen`. Put the aggregate summary (`totals.files`, `+totals.additions −totals.deletions`) in the header row (`headerRight`), always visible. Feed the list from `visibleFiles(diff)`.

- [ ] **Step 4: Verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/inspector/Inspector.tsx src/inspector/Inspector.test.tsx
git commit -m "feat(inspector): stats-on-top + collapsible changed-files list"
```

---

## Task 12: `read_file` returns mtime; `FileContent.mtime`

**Files:**
- Modify: `src-tauri/src/file_cmd.rs` (`FileContent`, `read_file_sync`)
- Modify: `src/types.ts` (`FileContent`)
- Test: `src-tauri/src/file_cmd.rs`

**Interfaces:**
- Produces: `FileContent.mtime: u64` (unix millis; `0` if unavailable) / `mtime: number` (TS). Used by `write_file`'s conflict guard.

- [ ] **Step 1: Failing test**

```rust
#[test]
fn read_file_reports_mtime() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("a.txt");
    std::fs::write(&p, "hi").unwrap();
    let fc = read_file_sync(dir.path(), "a.txt").unwrap();
    assert!(fc.mtime > 0);
}
```

- [ ] **Step 2: Verify fail** → FAIL (no `mtime`).

- [ ] **Step 3: Implement** — add `mtime: u64` to `FileContent`; in `read_file_sync` read `metadata.modified()` → millis since epoch (`0` on error). Update TS `FileContent`. Reuse/compare with `watcher::file_signature`'s `(SystemTime, u64)` convention.

- [ ] **Step 4: Verify pass** → PASS; `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/file_cmd.rs src/types.ts
PATH="$HOME/.cargo/bin:$PATH" git commit -m "feat(changes): read_file returns mtime for conflict detection"
```

---

## Task 13: `write_file` command (sandboxed, conflict-guarded, atomic)

**Files:**
- Modify: `src-tauri/src/file_cmd.rs`, `src-tauri/src/lib.rs`
- Modify: `src/types.ts` (`FileWriteResult`), `src/ipc/bridge.ts` (`writeFile`)
- Test: `src-tauri/src/file_cmd.rs`

**Interfaces:**
- Produces: `#[tauri::command(async)] fn write_file(store, cwd, path, content, expected_mtime: u64, expected_len: u64) -> Result<FileWriteResult, String>` where `FileWriteResult { mtime: u64, len: u64 }`; bridge `writeFile(cwd, path, content, expectedMtime, expectedLen): Promise<FileWriteResult>`.
- Consumes: `validate_cwd`, `resolve_within`, `file_signature` convention, `MAX_READ_BYTES`.

- [ ] **Step 1: Failing tests** — roundtrip; escape rejected; `.git` refused; binary refused; oversize refused; conflict refused; atomic (no temp left behind).

```rust
#[test]
fn write_file_roundtrips_and_returns_new_signature() {
    let (store, dir) = writable_root(); // helper: temp dir registered as a known root
    std::fs::write(dir.join("a.txt"), "old").unwrap();
    let sig = file_sig(dir.join("a.txt"));
    let res = write_file_sync(&store, dir.to_str().unwrap(), "a.txt", "new content", sig.0, sig.1).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "new content");
    assert_eq!(res.len, "new content".len() as u64);
}
#[test]
fn write_file_refuses_when_changed_on_disk() {
    let (store, dir) = writable_root();
    std::fs::write(dir.join("a.txt"), "old").unwrap();
    let err = write_file_sync(&store, dir.to_str().unwrap(), "a.txt", "x", 1, 1).unwrap_err();
    assert!(err.contains("changed on disk"));
}
#[test]
fn write_file_rejects_escape_and_dotgit_and_binary_and_oversize() {
    let (store, dir) = writable_root();
    std::fs::create_dir_all(dir.join(".git")).unwrap();
    std::fs::write(dir.join(".git/x"), "a").unwrap();
    assert!(write_file_sync(&store, dir.to_str().unwrap(), "../escape", "x", 0, 0).is_err());
    assert!(write_file_sync(&store, dir.to_str().unwrap(), ".git/x", "x", 0, 0).unwrap_err().to_lowercase().contains(".git"));
    std::fs::write(dir.join("b.bin"), [0u8,1,2]).unwrap(); // binary on disk
    let s = file_sig(dir.join("b.bin"));
    assert!(write_file_sync(&store, dir.to_str().unwrap(), "b.bin", "x", s.0, s.1).unwrap_err().to_lowercase().contains("binary"));
    std::fs::write(dir.join("c.txt"), "x").unwrap();
    let s = file_sig(dir.join("c.txt"));
    let big = "a".repeat((MAX_READ_BYTES + 1) as usize);
    assert!(write_file_sync(&store, dir.to_str().unwrap(), "c.txt", &big, s.0, s.1).unwrap_err().to_lowercase().contains("large"));
}
```

- [ ] **Step 2: Verify fail** → FAIL.

- [ ] **Step 3: Implement `write_file_sync` + command**

```rust
fn write_file_sync(
    store: &StoreState, cwd: &str, path: &str, content: &str,
    expected_mtime: u64, expected_len: u64,
) -> Result<FileWriteResult, String> {
    let cwd_canonical = crate::completion_cmd::validate_cwd(store, Path::new(cwd))?;
    let resolved = resolve_within(&cwd_canonical, path)?; // must exist, inside root
    if resolved.components().any(|c| c.as_os_str() == ".git") {
        return Err("refusing to write inside .git".into());
    }
    if content.len() as u64 > MAX_READ_BYTES {
        return Err("file too large to save".into());
    }
    // binary: sniff current on-disk bytes
    let existing = std::fs::read(&resolved).map_err(|e| e.to_string())?;
    if existing.iter().take(BINARY_SNIFF_BYTES).any(|&b| b == 0) {
        return Err("refusing to edit a binary file".into());
    }
    // conflict guard
    let meta = std::fs::metadata(&resolved).map_err(|e| e.to_string())?;
    let (mtime, len) = signature_of(&meta); // millis, byte len — same convention as read_file
    if mtime != expected_mtime || len != expected_len {
        return Err("file changed on disk since it was opened".into());
    }
    // atomic write: temp in same dir + rename
    let dir = resolved.parent().ok_or("no parent dir")?;
    let mut tmp = tempfile::Builder::new().prefix(".kriyon-write-").tempfile_in(dir).map_err(|e| e.to_string())?;
    use std::io::Write;
    tmp.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    tmp.flush().map_err(|e| e.to_string())?;
    tmp.persist(&resolved).map_err(|e| e.error.to_string())?;
    let meta = std::fs::metadata(&resolved).map_err(|e| e.to_string())?;
    let (m, l) = signature_of(&meta);
    Ok(FileWriteResult { mtime: m, len: l })
}
```

Command wrapper mirrors `read_file`: `#[tauri::command(async)]`, `reject_flag_like`, calls `write_file_sync(store.inner(), …)`. Register in `lib.rs`. Add `FileWriteResult` (Rust serde camelCase + TS) and the `bridge.writeFile` wrapper.

- [ ] **Step 4: Verify pass** — `cargo test write_file -- --test-threads=1` → PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/file_cmd.rs src-tauri/src/lib.rs src/types.ts src/ipc/bridge.ts
PATH="$HOME/.cargo/bin:$PATH" git commit -m "feat(changes): sandboxed write_file command (atomic, conflict-guarded)"
```

---

## Task 14: Remember + restore the pre-Changes view

**Files:**
- Modify: `src/state/layout.ts` (`preChangesView`, `setTranscriptView` capture, `leaveChangesView`)
- Modify: `src/sidebar/Sidebar.tsx` (or `ProjectGroup.tsx` seam) — call `leaveChangesView()` on select
- Test: `src/state/layout.test.ts`, `src/sidebar/Sidebar.test.tsx`

**Interfaces:**
- Produces: layout `preChangesView: "studio" | "raw"` (default `"studio"`, ephemeral) + `leaveChangesView(): void`.

- [ ] **Step 1: Failing tests**

```ts
it("records the prior view when switching into changes, restores it on leave", () => {
  const s = useLayout.getState();
  s.setTranscriptView("raw");
  s.setTranscriptView("changes");
  expect(useLayout.getState().layout.preChangesView).toBe("raw");
  s.leaveChangesView();
  expect(useLayout.getState().layout.transcriptView).toBe("raw");
});
it("leaveChangesView is a no-op when not in changes", () => {
  useLayout.getState().setTranscriptView("studio");
  useLayout.getState().leaveChangesView();
  expect(useLayout.getState().layout.transcriptView).toBe("studio");
});
```

```tsx
it("returns to the prior view when a session is selected from the sidebar", async () => {
  useLayout.getState().setTranscriptView("studio");
  useLayout.getState().setTranscriptView("changes");
  renderSidebar();
  await userEvent.click(screen.getByRole("button", { name: /session two/i }));
  expect(useLayout.getState().layout.transcriptView).toBe("studio");
});
```

- [ ] **Step 2: Verify fail** → FAIL.

- [ ] **Step 3: Implement** — in `setTranscriptView`, when the new view is `"changes"` and the current view isn't, set `preChangesView = currentView`. `leaveChangesView`: if `transcriptView === "changes"`, set it to `preChangesView`. `preChangesView` not persisted (ephemeral). Wire the sidebar select seam (`onSelect={(id) => { setActiveSession(id); leaveChangesView(); }}`).

- [ ] **Step 4: Verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/layout.ts src/state/layout.test.ts src/sidebar/Sidebar.tsx src/sidebar/Sidebar.test.tsx
git commit -m "feat(changes): return to the prior view when selecting a session"
```

---

## Task 15: `touchedFiles` attribution badge + "my edits only" toggle

**Files:**
- Modify: `src/state/sessions.ts` (relativized-touched selector + `repoToplevel` cache)
- Modify: `src/state/changes.ts` (toggle state) or `src/changes/ChangesView.tsx` (toggle UI + filter)
- Modify: `src/changes/DiffFileCard.tsx` / `ChangedFilesList` (badge)
- Test: `src/state/sessions.test.ts`, `src/changes/ChangesView.test.tsx`

**Interfaces:**
- Produces: `sessionTouchedRelative(sessionId): Set<string>` (repo-relative), computed from absolute `touchedFiles` minus the cached repo toplevel; `myEditsOnly: Record<sessionId, boolean>` + toggle; per-file `touchedBySession` boolean.

- [ ] **Step 1: Failing tests**

```ts
it("relativizes absolute touchedFiles against the repo toplevel", () => {
  // toplevel "/repo", touched ["/repo/src/a.ts", "/other/x.ts"]
  const rel = sessionTouchedRelative("s1"); // uses cached toplevel
  expect(rel.has("src/a.ts")).toBe(true);
  expect(rel.has("x.ts")).toBe(false); // outside the repo — excluded
});
```

```tsx
it("filters the list to this session's touched files when 'my edits only' is on", async () => {
  renderChanges({ diff: threeFiles, touchedRelative: new Set(["a.ts"]) });
  await userEvent.click(screen.getByRole("switch", { name: /my edits only/i }));
  expect(screen.getByText("a.ts")).toBeInTheDocument();
  expect(screen.queryByText("b.ts")).not.toBeInTheDocument();
});
it("badges files this session touched", () => {
  renderChanges({ diff: threeFiles, touchedRelative: new Set(["a.ts"]) });
  expect(within(screen.getByTestId("row-a.ts")).getByLabelText(/this session/i)).toBeInTheDocument();
  expect(within(screen.getByTestId("row-b.ts")).queryByLabelText(/this session/i)).toBeNull();
});
```

- [ ] **Step 2: Verify fail** → FAIL.

- [ ] **Step 3: Implement** — fetch `repoToplevel(cwd)` once per session (cache on the session or in a small store map; refetch only if cwd changes), strip each absolute `touchedFiles` entry against it (drop those outside). `sessionTouchedRelative` memoized. Badge: `✎ this session` (tokens, `aria-label`) when `file.path ∈ set`. Toggle (a `role="switch"`, default off) filters `visibleFiles` to the set; pure frontend, no spawn.

- [ ] **Step 4: Verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/sessions.ts src/state/sessions.test.ts src/state/changes.ts src/changes/ChangesView.tsx src/changes/ChangesView.test.tsx src/changes/DiffFileCard.tsx
git commit -m "feat(changes): touched-file attribution badge + my-edits-only toggle"
```

---

## Task 16: `CodeEditor` — lazy CodeMirror 6 wrapper

**Files:**
- Create: `src/changes/CodeEditor.tsx`
- Create: `docs/adr/NNNN-codemirror-editor.md`
- Test: `src/changes/CodeEditor.test.tsx`
- Modify: `package.json` (add `@codemirror/*` deps)

**Interfaces:**
- Produces: `CodeEditor({ value, language, onChange, readOnly? })` — dynamically `import()`s `@codemirror/*` + the per-language grammar; themed via `EditorView.theme()` bound to `var(--kr-*)`.

- [ ] **Step 1: Add deps** (do NOT let them into the entry chunk — they load only via dynamic import in this file):

```bash
pnpm add @codemirror/state @codemirror/view @codemirror/language @codemirror/commands \
  @codemirror/lang-javascript @codemirror/lang-python @codemirror/lang-rust \
  @codemirror/lang-json @codemirror/lang-css @codemirror/lang-html @codemirror/lang-markdown \
  @codemirror/legacy-modes
```

- [ ] **Step 2: Failing test** — renders the initial value, emits `onChange` on edit, maps a path/lang to a grammar (mock the dynamic imports so jsdom stays light).

```tsx
it("renders initial content and emits changes", async () => {
  const onChange = vi.fn();
  render(<CodeEditor value={"const x = 1\n"} language="typescript" onChange={onChange} />);
  await screen.findByText(/const/); // editor mounted
  await typeInto(screen.getByRole("textbox"), "\nconst y = 2");
  expect(onChange).toHaveBeenCalled();
});
it("falls back to plain text for an unknown language", async () => {
  render(<CodeEditor value={"x"} language="toml" onChange={vi.fn()} />);
  // toml uses StreamLanguage(legacy-modes) — assert no throw + mounted
  expect(await screen.findByRole("textbox")).toBeInTheDocument();
});
```

- [ ] **Step 3: Verify fail** → FAIL.

- [ ] **Step 4: Implement** — a `useEffect` that dynamically imports the core + a `languageExtension(language)` resolver (`lang-javascript` for ts/tsx/js/jsx, `-python`, `-rust`, `-json`, `-css`, `-html`, `-markdown`; `StreamLanguage.define(toml)` from `@codemirror/legacy-modes/mode/toml` for toml; plain for unknown). Build an `EditorView` with a theme reading `var(--kr-*)` and a `HighlightStyle` mapping tags to tokens; `updateListener` → `onChange`. Tear down on unmount. Write the ADR (CM6 over Monaco/shiki-bridge; TOML legacy-mode; lazy-load invariant).

- [ ] **Step 5: Verify pass + entry-chunk audit** — `pnpm vitest run CodeEditor` → PASS; `pnpm build` then `grep -a codemirror dist/assets/index-*.js` (entry) → **absent** (must be in an async chunk).

- [ ] **Step 6: Commit**

```bash
git add src/changes/CodeEditor.tsx src/changes/CodeEditor.test.tsx docs/adr/NNNN-codemirror-editor.md package.json pnpm-lock.yaml
git commit -m "feat(changes): lazy CodeMirror 6 editor wrapper"
```

---

## Task 17: FileViewer editing — save / dirty / conflict

**Files:**
- Modify: `src/changes/FileViewer.tsx`
- Test: `src/changes/FileViewer.test.tsx`

**Interfaces:**
- Consumes: `CodeEditor` (Task 16), `bridge.writeFile` (Task 13), `FileContent.mtime` (Task 12).

- [ ] **Step 1: Failing tests** — edit enables Save + dirty dot; Save calls `writeFile` with the read signature and clears dirty; a conflict error shows a Reload banner; binary/truncated stay read-only.

```tsx
it("saves edits and clears the dirty state", async () => {
  vi.mocked(bridge.readFile).mockResolvedValue({ content: "old", truncated: false, binary: false, size: 3, mtime: 111 });
  vi.mocked(bridge.writeFile).mockResolvedValue({ mtime: 222, len: 3 });
  renderViewer({ cwd: "/repo", path: "a.ts" });
  await screen.findByRole("textbox");
  await typeInto(screen.getByRole("textbox"), "new");
  expect(screen.getByTestId("dirty-indicator")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /save/i }));
  expect(bridge.writeFile).toHaveBeenCalledWith("/repo", "a.ts", expect.any(String), 111, 3);
  expect(screen.queryByTestId("dirty-indicator")).toBeNull();
});
it("shows a reload banner when the file changed on disk", async () => {
  vi.mocked(bridge.writeFile).mockRejectedValue(new Error("file changed on disk since it was opened"));
  renderViewer({ cwd: "/repo", path: "a.ts" });
  await screen.findByRole("textbox");
  await typeInto(screen.getByRole("textbox"), "x");
  await userEvent.click(screen.getByRole("button", { name: /save/i }));
  expect(await screen.findByText(/changed on disk/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
});
it("stays read-only for binary or truncated files", async () => {
  vi.mocked(bridge.readFile).mockResolvedValue({ content: "", truncated: false, binary: true, size: 10, mtime: 5 });
  renderViewer({ cwd: "/repo", path: "img.png" });
  expect(await screen.findByText(/binary/i)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
});
```

- [ ] **Step 2: Verify fail** → FAIL.

- [ ] **Step 3: Implement** — for text/non-truncated files, render `CodeEditor` with local `draft` state seeded from `content`; track `dirty = draft !== content`; Save calls `writeFile(cwd, path, draft, readSig.mtime, readSig.len)`, on success updates `content` + stored signature + clears dirty, on `"changed on disk"` error shows a Reload banner (Reload re-reads via `readFile`); Revert resets `draft`. Binary/truncated keep the existing read-only notice (no editor). Guard file/tab switch + close (via `selectFile`) when dirty (confirm-discard). Keep the pane display-toggled, never unmounted.

- [ ] **Step 4: Verify pass** → PASS.

- [ ] **Step 5: Full check + commit**

Run: `pnpm check` (all green) then:

```bash
git add src/changes/FileViewer.tsx src/changes/FileViewer.test.tsx
git commit -m "feat(changes): editable FileViewer with save, dirty state, conflict guard"
```

---

## Final: whole-branch review + smoke

- [ ] Run full `pnpm check` + Rust suite (`CARGO_BUILD_JOBS=1 … -- --test-threads=1`), `grep -a` entry chunk for `codemirror`/`shiki` absence.
- [ ] Whole-branch review (opus) + a security-focused pass on `write_file` and the new git commands (`agent-skills:security-auditor`).
- [ ] Rebuild the isolated smoke app; verify session-scoped diff (two sessions, one branch), baseline correctness, the badge/toggle, editing→save→conflict, and collapsible stats. Live hook-driven refresh needs the real Tauri run.
- [ ] Push with `RUST_TEST_THREADS=1 CARGO_BUILD_JOBS=1`; update PR #10 description.

## Self-review notes (coverage)

- Item 1 → Tasks 10, 11. Item 2 → Tasks 1–6 (baseline) + 15 (badge/toggle). Item 3 → Task 14. Item 4 → Tasks 7–9. Item 5 → Tasks 12, 13, 16, 17. Item 6 → rename+copy-path in Tasks 8–9 (rename) + 9 (copy-path); per-file Undo/keyboard-nav deferred as stretch (not in this plan's task list — add only if budget remains after Task 17).
- Types threaded consistently: `baselineOid`/`baseline_oid`, `FileDiff.binary`, `FileContent.mtime`, `FileWriteResult{mtime,len}`, `diffSessionChanges(cwd, baselineOid)`.
