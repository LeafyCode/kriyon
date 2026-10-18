# File-tree mutations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right-clicking Kriyon's file browser tree opens a context menu offering New File, New Folder, Rename and Delete, with VS Code's inline-naming row.

**Architecture:** Four new Rust commands cross the IPC trust boundary through one new containment rule (`SandboxRoot::resolve_new`) that resolves the *parent* canonically — the way the existing sandbox does — and validates only the final path segment as a name that cannot traverse. The frontend adds a cursor-anchored `ContextMenu` and a single inline draft row in `FileBrowserTree` that serves all three naming flows.

**Tech Stack:** Rust (Tauri v2 commands, `objc2-foundation` for Trash), TypeScript/React 19, Zustand (`useChanges`), Vitest + Testing Library, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-08-30-file-tree-mutations-design.md`

## Global Constraints

- Branch: `feat/editor-cursor-polish`. Never commit to `main`/`master`.
- `pnpm check` must pass before every commit. Rust commits need `PATH="$HOME/.cargo/bin:$PATH" git commit` or the lefthook rust hooks fail with "cargo not found".
- Stage named files only — `git add <paths>`, never `git add -u`/`git add -A`. Other sessions share this checkout. Never stage or delete untracked local files.
- Formatting and JS/TS lint are owned by Ultracite + Biome: run `pnpm fix`, never hand-format. Biome forbids a regex literal inside a function — hoist every test regex to a module-level `const`.
- All design values come from `src/theme/tokens.ts`. No hardcoded colors, spacing, or radii in components.
- Rust: `pedantic` + `correctness` clippy enforced. Commands take typed args and return `Result<_, String>`.
- Conventional commits, small and frequent.
- A term must appear in `CONTEXT.md` before it becomes a module/type name — Task 1 adds **New-entry sandbox** before `NewSandboxedPath` is used anywhere else.
- TDD: write the failing test, run it, watch it fail, then implement.
- Rust tests that need git open with `if !git_available() { return; }` — the mutation commands do not touch git, so they need no such guard.

---

### Task 1: `resolve_new` — containment for a path that does not exist yet

**Files:**
- Modify: `src-tauri/src/sandbox.rs` (add `valid_leaf_name`, `NewSandboxedPath`, `SandboxRoot::resolve_new`; tests in the existing `mod tests`)
- Modify: `CONTEXT.md` (new **New-entry sandbox** term, and one sentence on the existing **File sandbox** entry)

**Interfaces:**
- Consumes: existing `SandboxRoot::resolve`, `SandboxedPath::as_path`, `tagged_failure`, `FILE_MISSING`, `WRITE_MISSING_ERROR`.
- Produces:
  - `pub(crate) struct NewSandboxedPath` with `pub(crate) fn as_path(&self) -> PathBuf` and `pub(crate) fn exists(&self) -> bool`
  - `pub(crate) fn SandboxRoot::resolve_new(&self, path: &str, verb: &str) -> Result<NewSandboxedPath, String>`
  - Error strings: `"name must not be empty"`, `"name must not contain a path separator"`, `"name must not be . or .."`, `"refusing to {verb} inside .git"`, `"name is too long"`

- [ ] **Step 1: Write the failing tests**

Add to `src-tauri/src/sandbox.rs`'s `mod tests`:

```rust
/// A leaf is a *name*, not a path: the whole reason `resolve_new` can trust
/// a target that does not exist yet is that the parent was canonicalized and
/// the leaf cannot walk out of it.
#[test]
fn valid_leaf_name_refuses_anything_that_could_traverse() {
    for bad in ["", ".", "..", "a/b", "a\\b", "a\0b", ".git", &"x".repeat(256)] {
        assert!(
            valid_leaf_name(bad).is_err(),
            "leaf {bad:?} must be refused"
        );
    }
    for good in ["a.txt", "New Folder", ".env", "a.b.c", &"x".repeat(255)] {
        assert!(valid_leaf_name(good).is_ok(), "leaf {good:?} must be allowed");
    }
}

#[test]
fn resolve_new_accepts_a_name_under_an_existing_directory() {
    let root = tempfile::tempdir().expect("temp root");
    std::fs::create_dir(root.path().join("src")).expect("mkdir");
    let store = store_with_project_root(&root.path().to_string_lossy());
    let sandbox = SandboxRoot::validate(&store, root.path().to_str().unwrap()).expect("root");

    let target = sandbox.resolve_new("src/new.ts", "write").expect("resolve");

    assert_eq!(
        target.as_path(),
        root.path().canonicalize().expect("canon").join("src/new.ts")
    );
    assert!(!target.exists(), "the point of this type is that it need not exist yet");
}

#[test]
fn resolve_new_refuses_a_parent_outside_the_root() {
    let root = tempfile::tempdir().expect("temp root");
    let cwd = root.path().join("cwd");
    std::fs::create_dir(&cwd).expect("mkdir");
    let store = store_with_project_root(&cwd.to_string_lossy());
    let sandbox = SandboxRoot::validate(&store, cwd.to_str().unwrap()).expect("root");

    let err = sandbox.resolve_new("../evil.txt", "write").unwrap_err();

    assert_eq!(err, "path escapes cwd");
}

#[test]
fn resolve_new_refuses_a_dot_git_parent() {
    let root = tempfile::tempdir().expect("temp root");
    std::fs::create_dir(root.path().join(".git")).expect("mkdir");
    let store = store_with_project_root(&root.path().to_string_lossy());
    let sandbox = SandboxRoot::validate(&store, root.path().to_str().unwrap()).expect("root");

    let err = sandbox.resolve_new(".git/hook", "write").unwrap_err();

    assert_eq!(err, "refusing to write inside .git");
}

/// The escape the 2026-08-30 security review found in `discard_file_changes`,
/// aimed at the new resolver: a symlink to a deeper directory plus `..`
/// disagrees with a lexical reading. Containment is settled on the canonical
/// parent, so the leaf lands wherever the parent really is — inside the root.
#[test]
fn resolve_new_settles_containment_on_the_canonical_parent() {
    let root = tempfile::tempdir().expect("temp root");
    std::fs::create_dir_all(root.path().join("a/b/c")).expect("mkdir");
    #[cfg(unix)]
    std::os::unix::fs::symlink("a/b/c", root.path().join("short")).expect("symlink");
    let store = store_with_project_root(&root.path().to_string_lossy());
    let sandbox = SandboxRoot::validate(&store, root.path().to_str().unwrap()).expect("root");

    let target = sandbox.resolve_new("short/../new.txt", "write").expect("resolve");

    let canonical_root = root.path().canonicalize().expect("canon");
    assert_eq!(target.as_path(), canonical_root.join("a/b/new.txt"));
    assert!(
        target.as_path().starts_with(&canonical_root),
        "the resolved target must sit inside the root"
    );
}

/// An empty parent means the root itself, which is the "right-click the tree's
/// empty area" case.
#[test]
fn resolve_new_treats_a_bare_name_as_a_child_of_the_root() {
    let root = tempfile::tempdir().expect("temp root");
    let store = store_with_project_root(&root.path().to_string_lossy());
    let sandbox = SandboxRoot::validate(&store, root.path().to_str().unwrap()).expect("root");

    let target = sandbox.resolve_new("top.txt", "write").expect("resolve");

    assert_eq!(
        target.as_path(),
        root.path().canonicalize().expect("canon").join("top.txt")
    );
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test --lib sandbox::tests`
Expected: compile error — `valid_leaf_name` and `resolve_new` do not exist.

- [ ] **Step 3: Implement**

Add to `src-tauri/src/sandbox.rs`, above `mod tests`:

```rust
/// The longest single filename every filesystem Kriyon targets accepts.
const MAX_LEAF_BYTES: usize = 255;

/// Validate the final segment of a not-yet-existing path as a *name*.
///
/// LOAD-BEARING. [`SandboxRoot::resolve_new`] settles containment on the
/// canonical parent and then joins this on. That join is safe only because a
/// value passing here cannot traverse: no separator, no `.`/`..`, no NUL. Relax
/// any one of those and the parent's containment stops implying the target's.
///
/// `.git` is refused here too, so a name cannot create the one directory the
/// sandbox otherwise refuses to write inside.
///
/// # Errors
/// A message naming the rule the candidate broke.
fn valid_leaf_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("name must not be empty".to_string());
    }
    if name.len() > MAX_LEAF_BYTES {
        return Err("name is too long".to_string());
    }
    if name == "." || name == ".." {
        return Err("name must not be . or ..".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err("name must not contain a path separator".to_string());
    }
    if name.eq_ignore_ascii_case(".git") {
        return Err("refusing to use .git as a name".to_string());
    }
    Ok(())
}

/// A path that is proven to land inside a [`SandboxRoot`] but does not exist
/// yet — the target of a create or a rename.
///
/// Deliberately NOT a [`SandboxedPath`]. That type means "this canonicalized,
/// as a whole, inside the root"; this one means "its parent did, and its leaf
/// cannot leave that parent". A function wanting an existing sandboxed file
/// must not silently accept a name that might become one, so they are separate
/// types with no conversion between them.
///
/// Unconstructable outside this module, the same discipline
/// [`SandboxedPath`] holds: private fields, and
/// [`SandboxRoot::resolve_new`] is the only producer.
#[derive(Debug)]
pub(crate) struct NewSandboxedPath {
    parent: PathBuf,
    leaf: String,
}

impl NewSandboxedPath {
    /// The target itself — the canonical parent with the validated leaf joined.
    pub(crate) fn as_path(&self) -> PathBuf {
        self.parent.join(&self.leaf)
    }

    /// Whether something is already there. Callers decide what that means:
    /// a create refuses, a rename target refuses, nothing silently overwrites.
    pub(crate) fn exists(&self) -> bool {
        self.as_path().symlink_metadata().is_ok()
    }
}
```

Add to `impl SandboxRoot`:

```rust
    /// Resolve a frontend-supplied `path` whose final segment does not exist
    /// yet: the parent goes through [`Self::resolve`] unchanged (canonical
    /// containment, `.git` refusal), and the leaf through [`valid_leaf_name`].
    ///
    /// Splitting rather than canonicalizing the whole path is what makes this
    /// possible at all — `canonicalize` fails on a missing target — and doing
    /// the split *before* the containment check is what keeps it safe: the
    /// parent is a real directory, so it canonicalizes, so `..` and symlinks
    /// are resolved by the filesystem rather than by string arithmetic.
    ///
    /// # Errors
    /// Anything [`Self::resolve`] returns for the parent, `cwd is not a
    /// directory` if the parent is a file, or a [`valid_leaf_name`] message.
    pub(crate) fn resolve_new(
        &self,
        path: &str,
        verb: &str,
    ) -> Result<NewSandboxedPath, String> {
        let (parent, leaf) = match path.rsplit_once('/') {
            Some((parent, leaf)) => (parent, leaf),
            // No separator: a direct child of the root itself.
            None => ("", path),
        };
        valid_leaf_name(leaf)?;
        // `resolve` cannot take an empty path (it would canonicalize the root
        // and then be asked to contain itself, which it does), so "" is spelled
        // "." — the root as its own parent.
        let parent_spec = if parent.is_empty() { "." } else { parent };
        let resolved = self.resolve(parent_spec, verb)?;
        if !resolved.as_path().is_dir() {
            return Err("cwd is not a directory".to_string());
        }
        Ok(NewSandboxedPath {
            parent: resolved.as_path().to_path_buf(),
            leaf: leaf.to_string(),
        })
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test --lib sandbox::tests`
Expected: PASS, all 6 new tests included.

- [ ] **Step 5: Add the CONTEXT.md terms**

In `CONTEXT.md`, insert after the **File sandbox** entry (alphabetical order puts it after **File viewer**, before **Sandbox root** — place it so the list stays alphabetical):

```markdown
- **New-entry sandbox** (`SandboxRoot::resolve_new`, `NewSandboxedPath`) — the [File sandbox]'s
  rule for a path that does not exist *yet*: the target of a create or a rename. The parent goes
  through `resolve` unchanged, so containment is still settled canonically, on a directory that
  really exists; only the final segment is new, and it is validated as a *name* — no separator,
  no `.`/`..`, no NUL, not `.git`, ≤255 bytes — so it cannot walk out of the parent that was just
  proven contained. Splitting is what makes it possible (`canonicalize` fails on a missing path);
  checking the parent canonically rather than normalizing the string lexically is what makes it
  safe. Its result is a `NewSandboxedPath`, a *different* type from `SandboxedPath` so that a
  command wanting an existing file cannot be handed a name that merely might become one.
  _Avoid_: create path, unchecked path.
```

And append to the **File sandbox** entry, after "…must not be folded into `resolve`":
```markdown
  A path that does not exist yet cannot go through `resolve` at all — that is the [New-entry
  sandbox]'s job.
```

- [ ] **Step 6: Commit**

```bash
PATH="$HOME/.cargo/bin:$PATH" git add src-tauri/src/sandbox.rs CONTEXT.md
PATH="$HOME/.cargo/bin:$PATH" git commit -m "feat(sandbox): resolve_new names a path that does not exist yet"
```

---

### Task 2: `create_file` and `create_dir`

**Files:**
- Create: `src-tauri/src/entry_cmd.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod entry_cmd;` beside the other command modules, and register both commands in `invoke_handler` after `git_cmd::discard_file_changes` at line ~316)
- Modify: `src/ipc/bridge.ts` (two wrappers, after `discardFileChanges`)

**Interfaces:**
- Consumes: `SandboxRoot::validate`, `SandboxRoot::resolve_new`, `NewSandboxedPath::{as_path, exists}` from Task 1.
- Produces:
  - Rust: `entry_cmd::create_file(store, cwd: String, path: String) -> Result<(), String>`, `entry_cmd::create_dir(store, cwd: String, path: String) -> Result<(), String>`
  - TS: `createFile(cwd: string, path: string): Promise<void>`, `createDir(cwd: string, path: string): Promise<void>`
  - Error string used by both: `"already exists"`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/entry_cmd.rs` with only the test module and the `use` lines, so the tests reference functions that do not exist yet:

```rust
#[cfg(test)]
mod tests {
    use parking_lot::Mutex;

    use super::*;
    use crate::store::{ProjectRow, Store};
    use crate::StoreState;

    /// Mirrors `file_cmd::tests::store_with_project_root`: an in-memory store
    /// with a single registered project root, so these tests exercise the same
    /// known-roots validation the real commands perform.
    fn store_with_project_root(path: &str) -> StoreState {
        let store = Store::in_memory().expect("store");
        store
            .upsert_project(&ProjectRow {
                path: path.to_string(),
                ..ProjectRow::default()
            })
            .expect("project");
        Mutex::new(store)
    }

    fn sandbox(store: &StoreState, cwd: &str) -> SandboxRoot {
        SandboxRoot::validate(store, cwd).expect("cwd must be a known root")
    }

    #[test]
    fn create_file_writes_an_empty_file() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::create_dir(root.path().join("src")).expect("mkdir");
        let store = store_with_project_root(&root.path().to_string_lossy());

        create_file_sync(&sandbox(&store, root.path().to_str().unwrap()), "src/new.ts")
            .expect("create");

        assert_eq!(
            std::fs::read_to_string(root.path().join("src/new.ts")).expect("read"),
            ""
        );
    }

    /// `create` must never be a disguised truncate: the whole reason it uses
    /// `create_new` is that a name collision is a refusal, not a silent
    /// overwrite of whatever was there.
    #[test]
    fn create_file_refuses_an_existing_path_without_touching_it() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::write(root.path().join("a.txt"), "PRECIOUS").expect("write");
        let store = store_with_project_root(&root.path().to_string_lossy());

        let err = create_file_sync(&sandbox(&store, root.path().to_str().unwrap()), "a.txt")
            .unwrap_err();

        assert_eq!(err, "already exists");
        assert_eq!(
            std::fs::read_to_string(root.path().join("a.txt")).expect("read"),
            "PRECIOUS"
        );
    }

    #[test]
    fn create_file_refuses_a_name_that_escapes() {
        let root = tempfile::tempdir().expect("temp root");
        let cwd = root.path().join("cwd");
        std::fs::create_dir(&cwd).expect("mkdir");
        let store = store_with_project_root(&cwd.to_string_lossy());

        let err = create_file_sync(&sandbox(&store, cwd.to_str().unwrap()), "../evil.txt")
            .unwrap_err();

        assert_eq!(err, "path escapes cwd");
        assert!(!root.path().join("evil.txt").exists());
    }

    #[test]
    fn create_dir_makes_one_directory() {
        let root = tempfile::tempdir().expect("temp root");
        let store = store_with_project_root(&root.path().to_string_lossy());

        create_dir_sync(&sandbox(&store, root.path().to_str().unwrap()), "docs").expect("create");

        assert!(root.path().join("docs").is_dir());
    }

    /// Leaf-only, deliberately: `create_dir_all` would let one call
    /// materialize a whole chain of directories the user never named.
    #[test]
    fn create_dir_refuses_when_the_parent_does_not_exist() {
        let root = tempfile::tempdir().expect("temp root");
        let store = store_with_project_root(&root.path().to_string_lossy());

        let err = create_dir_sync(&sandbox(&store, root.path().to_str().unwrap()), "a/b")
            .unwrap_err();

        assert_eq!(err, "kind:file-missing: path does not exist");
        assert!(!root.path().join("a").exists());
    }

    #[test]
    fn create_dir_refuses_dot_git() {
        let root = tempfile::tempdir().expect("temp root");
        let store = store_with_project_root(&root.path().to_string_lossy());

        let err = create_dir_sync(&sandbox(&store, root.path().to_str().unwrap()), ".git")
            .unwrap_err();

        assert_eq!(err, "refusing to use .git as a name");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test --lib entry_cmd`
Expected: compile error — `create_file_sync` / `create_dir_sync` not found (and `mod entry_cmd;` missing from `lib.rs`).

- [ ] **Step 3: Implement**

Prepend to `src-tauri/src/entry_cmd.rs`:

```rust
//! Creating, renaming and deleting entries in the [File browser tree].
//!
//! Separate from `file_cmd.rs` on purpose: that module is about a file's
//! *content* (read it, write it, diff it against HEAD) and already runs long.
//! These four are about the *entry* — its existence and its name — and share
//! one thing none of the content commands can use: [`SandboxRoot::resolve_new`],
//! the containment rule for a path that does not exist yet.
//!
//! Every one of them is destructive-adjacent, so every one of them refuses
//! rather than overwrites: a create will not truncate, a rename will not
//! clobber, and a delete goes to the Trash.

use crate::sandbox::SandboxRoot;
use crate::StoreState;

/// Shared refusal when something is already at a create/rename target.
const ALREADY_EXISTS_ERROR: &str = "already exists";

/// Create an empty file at `path` (relative to `root`).
///
/// `create_new(true)` rather than `create(true)`: a name collision must be a
/// refusal the user sees, never a silent truncation of a file they forgot was
/// there. The check and the create are one syscall, so there is no window
/// between them.
///
/// # Errors
/// Anything [`SandboxRoot::resolve_new`] returns, [`ALREADY_EXISTS_ERROR`], or
/// the underlying `io::Error`'s message.
fn create_file_sync(root: &SandboxRoot, path: &str) -> Result<(), String> {
    let target = root.resolve_new(path, "write")?;
    match std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(target.as_path())
    {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(ALREADY_EXISTS_ERROR.to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Create one directory at `path` (relative to `root`).
///
/// `create_dir`, never `create_dir_all`: the leaf rule says exactly one new
/// name, and `create_dir_all` would quietly materialize a whole chain of
/// directories the user never typed.
///
/// # Errors
/// Anything [`SandboxRoot::resolve_new`] returns, [`ALREADY_EXISTS_ERROR`], or
/// the underlying `io::Error`'s message.
fn create_dir_sync(root: &SandboxRoot, path: &str) -> Result<(), String> {
    let target = root.resolve_new(path, "write")?;
    if target.exists() {
        return Err(ALREADY_EXISTS_ERROR.to_string());
    }
    std::fs::create_dir(target.as_path()).map_err(|e| e.to_string())
}

/// Create an empty file in the [File browser tree].
///
/// `(async)` for the same reason as `file_cmd::write_file`: this does
/// filesystem I/O and must never run on the main thread.
///
/// # Errors
/// See [`create_file_sync`], plus an error string if `cwd` is not a known
/// session/project root.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
pub fn create_file(
    store: tauri::State<'_, StoreState>,
    cwd: String,
    path: String,
) -> Result<(), String> {
    create_file_sync(&SandboxRoot::validate(store.inner(), &cwd)?, &path)
}

/// Create one directory in the [File browser tree].
///
/// `(async)` for the same reason as [`create_file`].
///
/// # Errors
/// See [`create_dir_sync`], plus an error string if `cwd` is not a known
/// session/project root.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
pub fn create_dir(
    store: tauri::State<'_, StoreState>,
    cwd: String,
    path: String,
) -> Result<(), String> {
    create_dir_sync(&SandboxRoot::validate(store.inner(), &cwd)?, &path)
}
```

In `src-tauri/src/lib.rs`, add `mod entry_cmd;` beside the other command modules, and add to `invoke_handler` immediately after `git_cmd::discard_file_changes,`:

```rust
            entry_cmd::create_file,
            entry_cmd::create_dir,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test --lib entry_cmd`
Expected: PASS (6 tests).

- [ ] **Step 5: Add the bridge wrappers**

In `src/ipc/bridge.ts`, after `discardFileChanges`:

```typescript
/**
 * Create an empty file at `path` (relative to `cwd`) for the Code Changes
 * View's file browser. Same sandboxing as {@link readFile}, resolved through
 * the [New-entry sandbox] because the target does not exist yet.
 *
 * Rejects with `"already exists"` rather than truncating whatever is there.
 */
export function createFile(cwd: string, path: string): Promise<void> {
  return invoke("create_file", { cwd, path });
}

/**
 * Create one directory at `path` (relative to `cwd`). Same sandboxing as
 * {@link createFile}; the parent must already exist (one new name per call,
 * never a whole chain).
 */
export function createDir(cwd: string, path: string): Promise<void> {
  return invoke("create_dir", { cwd, path });
}
```

- [ ] **Step 6: Verify and commit**

Run: `pnpm fix && PATH="$HOME/.cargo/bin:$PATH" pnpm check`
Expected: exit 0.

```bash
PATH="$HOME/.cargo/bin:$PATH" git add src-tauri/src/entry_cmd.rs src-tauri/src/lib.rs src/ipc/bridge.ts
PATH="$HOME/.cargo/bin:$PATH" git commit -m "feat(files): create_file and create_dir for the file tree"
```

---

### Task 3: `rename_entry` and `delete_entry`

**Files:**
- Modify: `src-tauri/src/entry_cmd.rs`
- Modify: `src-tauri/src/lib.rs` (register both)
- Modify: `src-tauri/Cargo.toml` (`objc2-foundation` gains the `NSFileManager` + `NSURL` features)
- Modify: `src/ipc/bridge.ts` (two wrappers)

**Interfaces:**
- Consumes: Task 1's `resolve_new`, Task 2's `ALREADY_EXISTS_ERROR`.
- Produces:
  - Rust: `entry_cmd::rename_entry(store, cwd, path, new_name) -> Result<(), String>`, `entry_cmd::delete_entry(store, cwd, path) -> Result<(), String>`
  - TS: `renameEntry(cwd: string, path: string, newName: string): Promise<void>`, `deleteEntry(cwd: string, path: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Add to `entry_cmd.rs`'s `mod tests`:

```rust
    #[test]
    fn rename_entry_moves_the_name_within_the_same_directory() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::create_dir(root.path().join("src")).expect("mkdir");
        std::fs::write(root.path().join("src/old.ts"), "body").expect("write");
        let store = store_with_project_root(&root.path().to_string_lossy());

        rename_entry_sync(
            &sandbox(&store, root.path().to_str().unwrap()),
            "src/old.ts",
            "new.ts",
        )
        .expect("rename");

        assert!(!root.path().join("src/old.ts").exists());
        assert_eq!(
            std::fs::read_to_string(root.path().join("src/new.ts")).expect("read"),
            "body"
        );
    }

    /// `new_name` is a *leaf*, so a rename is structurally incapable of moving
    /// an entry somewhere else — there is no spelling of "up one directory"
    /// that survives `valid_leaf_name`.
    #[test]
    fn rename_entry_cannot_move_an_entry_out_of_its_directory() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::create_dir(root.path().join("src")).expect("mkdir");
        std::fs::write(root.path().join("src/a.ts"), "body").expect("write");
        let store = store_with_project_root(&root.path().to_string_lossy());

        let err = rename_entry_sync(
            &sandbox(&store, root.path().to_str().unwrap()),
            "src/a.ts",
            "../escaped.ts",
        )
        .unwrap_err();

        assert_eq!(err, "name must not contain a path separator");
        assert!(root.path().join("src/a.ts").exists());
        assert!(!root.path().join("escaped.ts").exists());
    }

    #[test]
    fn rename_entry_refuses_to_clobber_an_existing_name() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::write(root.path().join("a.txt"), "a").expect("write");
        std::fs::write(root.path().join("b.txt"), "PRECIOUS").expect("write");
        let store = store_with_project_root(&root.path().to_string_lossy());

        let err = rename_entry_sync(
            &sandbox(&store, root.path().to_str().unwrap()),
            "a.txt",
            "b.txt",
        )
        .unwrap_err();

        assert_eq!(err, "already exists");
        assert_eq!(
            std::fs::read_to_string(root.path().join("b.txt")).expect("read"),
            "PRECIOUS"
        );
    }

    #[test]
    fn delete_entry_removes_a_file_from_the_tree() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::write(root.path().join("a.txt"), "body").expect("write");
        let store = store_with_project_root(&root.path().to_string_lossy());

        delete_entry_sync(&sandbox(&store, root.path().to_str().unwrap()), "a.txt")
            .expect("delete");

        assert!(!root.path().join("a.txt").exists());
    }

    #[test]
    fn delete_entry_removes_a_directory_and_its_contents() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::create_dir(root.path().join("docs")).expect("mkdir");
        std::fs::write(root.path().join("docs/a.md"), "body").expect("write");
        let store = store_with_project_root(&root.path().to_string_lossy());

        delete_entry_sync(&sandbox(&store, root.path().to_str().unwrap()), "docs")
            .expect("delete");

        assert!(!root.path().join("docs").exists());
    }

    #[test]
    fn delete_entry_refuses_dot_git() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::create_dir(root.path().join(".git")).expect("mkdir");
        let store = store_with_project_root(&root.path().to_string_lossy());

        let err = delete_entry_sync(&sandbox(&store, root.path().to_str().unwrap()), ".git")
            .unwrap_err();

        assert_eq!(err, "refusing to write inside .git");
        assert!(root.path().join(".git").exists());
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test --lib entry_cmd`
Expected: compile error — `rename_entry_sync` / `delete_entry_sync` not found.

- [ ] **Step 3: Add the Cargo features**

In `src-tauri/Cargo.toml`, change the `objc2-foundation` line to:

```toml
objc2-foundation = { version = "0.3", features = ["NSString", "NSDictionary", "NSObject", "NSError", "NSBundle", "NSFileManager", "NSURL"] }
```

- [ ] **Step 4: Implement**

Add to `src-tauri/src/entry_cmd.rs`:

```rust
/// Rename `path`'s final segment to `new_name`, in place.
///
/// Same-directory only, and structurally so: `new_name` goes through
/// [`SandboxRoot::resolve_new`] against the source's own parent, so the leaf
/// rule alone rules out every spelling of "somewhere else". A move is a
/// different operation with a different blast radius; this is not it.
///
/// # Errors
/// Anything `resolve`/`resolve_new` returns, [`ALREADY_EXISTS_ERROR`] if the
/// target name is taken, or the underlying `io::Error`'s message.
fn rename_entry_sync(root: &SandboxRoot, path: &str, new_name: &str) -> Result<(), String> {
    // The source must exist, so it takes the ordinary (whole-path canonical)
    // rule; only the target is new.
    let source = root.resolve(path, "write")?;
    let parent = match path.rsplit_once('/') {
        Some((parent, _)) => parent,
        None => "",
    };
    let target_spec = if parent.is_empty() {
        new_name.to_string()
    } else {
        format!("{parent}/{new_name}")
    };
    let target = root.resolve_new(&target_spec, "write")?;
    if target.exists() {
        return Err(ALREADY_EXISTS_ERROR.to_string());
    }
    std::fs::rename(source.as_path(), target.as_path()).map_err(|e| e.to_string())
}

/// Move `path` to the Trash.
///
/// **Not** `remove_file`/`remove_dir_all`. This tree has no undo, the menu item
/// sits one row below Rename, and a directory delete is recursive — so the
/// recoverable option is worth an API call. A `trashItemAtURL` failure is
/// returned as an error and never falls through to a permanent delete.
///
/// # Errors
/// Anything [`SandboxRoot::resolve`] returns, or the `NSError`'s description.
fn delete_entry_sync(root: &SandboxRoot, path: &str) -> Result<(), String> {
    let target = root.resolve(path, "write")?;
    trash(target.as_path())
}

/// `NSFileManager.trashItemAtURL:` — macOS's own "move to Trash", so the entry
/// lands where Finder's Put Back can restore it.
///
/// # Errors
/// The `NSError`'s localized description.
fn trash(path: &std::path::Path) -> Result<(), String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let path_str = path
        .to_str()
        .ok_or_else(|| "path is not valid UTF-8".to_string())?;
    // SAFETY: `path_str` is a valid UTF-8 path; the URL is a file URL built
    // from it and used only for the duration of this call.
    unsafe {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path_str));
        NSFileManager::defaultManager()
            .trashItemAtURL_resultingItemURL_error(&url, None)
            .map_err(|e| e.localizedDescription().to_string())
    }
}

/// Rename an entry in the [File browser tree], in place.
///
/// `(async)` for the same reason as [`create_file`].
///
/// # Errors
/// See [`rename_entry_sync`], plus an error string if `cwd` is not a known
/// session/project root.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
pub fn rename_entry(
    store: tauri::State<'_, StoreState>,
    cwd: String,
    path: String,
    new_name: String,
) -> Result<(), String> {
    rename_entry_sync(
        &SandboxRoot::validate(store.inner(), &cwd)?,
        &path,
        &new_name,
    )
}

/// Move an entry in the [File browser tree] to the Trash.
///
/// **Destructive**, though recoverable from Finder. The frontend confirms with
/// the user before calling this.
///
/// `(async)` for the same reason as [`create_file`].
///
/// # Errors
/// See [`delete_entry_sync`], plus an error string if `cwd` is not a known
/// session/project root.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
pub fn delete_entry(
    store: tauri::State<'_, StoreState>,
    cwd: String,
    path: String,
) -> Result<(), String> {
    delete_entry_sync(&SandboxRoot::validate(store.inner(), &cwd)?, &path)
}
```

Register in `lib.rs` after `entry_cmd::create_dir,`:

```rust
            entry_cmd::rename_entry,
            entry_cmd::delete_entry,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test --lib entry_cmd`
Expected: PASS (12 tests).

If `trashItemAtURL_resultingItemURL_error` does not compile, the objc2 method name has changed between versions — check the current signature with `npx ctx7@latest library "objc2-foundation"` then `npx ctx7@latest docs <id> "NSFileManager trashItemAtURL"` before changing the call. Do not fall back to `remove_file`.

- [ ] **Step 6: Add the bridge wrappers**

In `src/ipc/bridge.ts`, after `createDir`:

```typescript
/**
 * Rename the entry at `path` (relative to `cwd`) to `newName`, in place.
 *
 * Same-directory only: `newName` is a single name, not a path, so a rename
 * cannot move an entry elsewhere. Rejects with `"already exists"` rather than
 * clobbering the target.
 */
export function renameEntry(
  cwd: string,
  path: string,
  newName: string
): Promise<void> {
  return invoke("rename_entry", { cwd, newName, path });
}

/**
 * Move the entry at `path` (relative to `cwd`) to the macOS Trash.
 *
 * **Destructive** — recoverable from Finder, not from inside Kriyon. Confirm
 * with the user before calling this. Deletes a directory with its contents.
 */
export function deleteEntry(cwd: string, path: string): Promise<void> {
  return invoke("delete_entry", { cwd, path });
}
```

- [ ] **Step 7: Verify and commit**

Run: `pnpm fix && PATH="$HOME/.cargo/bin:$PATH" pnpm check`
Expected: exit 0.

```bash
PATH="$HOME/.cargo/bin:$PATH" git add src-tauri/src/entry_cmd.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock src/ipc/bridge.ts
PATH="$HOME/.cargo/bin:$PATH" git commit -m "feat(files): rename_entry in place, delete_entry to the Trash"
```

---

### Task 4: `ContextMenu` — a cursor-anchored menu

**Files:**
- Create: `src/ui/ContextMenu.tsx`
- Create: `src/ui/ContextMenu.test.tsx`
- Modify: `src/ui/AnchoredMenu.tsx` (extract the dismissal effect into `useDismissOnOutside`, used by both)

**Interfaces:**
- Consumes: `anchoredMenuSurfaceStyle`, `tokens`.
- Produces:
  - `export type ContextMenuItem = { danger?: boolean; label: string; onSelect: () => void }`
  - `export function ContextMenu(props: { at: { x: number; y: number }; items: ContextMenuItem[]; label: string; onClose: () => void }): JSX.Element`
  - `export function useDismissOnOutside(open: boolean, onDismiss: () => void, insideRef: RefObject<HTMLElement | null>): void` (in `AnchoredMenu.tsx`)

- [ ] **Step 1: Write the failing tests**

Create `src/ui/ContextMenu.test.tsx`:

```typescript
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ContextMenu } from "./ContextMenu.tsx";

const NEW_FILE_RE = /new file/i;
const DELETE_RE = /delete/i;

function renderMenu(overrides: Partial<Parameters<typeof ContextMenu>[0]> = {}) {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  render(
    <ContextMenu
      at={{ x: 40, y: 60 }}
      items={[
        { label: "New File", onSelect },
        { danger: true, label: "Delete", onSelect: vi.fn() },
      ]}
      label="File actions"
      onClose={onClose}
      {...overrides}
    />
  );
  return { onClose, onSelect };
}

test("opens at the pointer position", () => {
  renderMenu();

  const menu = screen.getByRole("menu", { name: "File actions" });
  expect(menu).toHaveStyle({ left: "40px", top: "60px" });
});

test("running an item closes the menu", () => {
  const { onClose, onSelect } = renderMenu();

  fireEvent.click(screen.getByRole("menuitem", { name: NEW_FILE_RE }));

  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("Escape dismisses without running anything", () => {
  const { onClose, onSelect } = renderMenu();

  fireEvent.keyDown(document, { key: "Escape" });

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onSelect).not.toHaveBeenCalled();
});

test("a press outside dismisses", () => {
  const { onClose } = renderMenu();

  fireEvent.pointerDown(document.body);

  expect(onClose).toHaveBeenCalledTimes(1);
});

test("arrow keys move focus between items", () => {
  renderMenu();
  const items = screen.getAllByRole("menuitem");
  expect(items[0]).toHaveFocus();

  fireEvent.keyDown(items[0], { key: "ArrowDown" });

  expect(items[1]).toHaveFocus();
});

/** A menu opened near the right/bottom edge must not render off-screen. */
test("flips away from the viewport edge", () => {
  renderMenu({ at: { x: window.innerWidth - 4, y: window.innerHeight - 4 } });

  const menu = screen.getByRole("menu", { name: "File actions" });
  expect(menu.style.left).not.toBe(`${window.innerWidth - 4}px`);
});

test("marks the destructive item so it does not read like the others", () => {
  renderMenu();

  expect(screen.getByRole("menuitem", { name: DELETE_RE })).toHaveAttribute(
    "data-danger",
    "true"
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ui/ContextMenu.test.tsx`
Expected: FAIL — cannot resolve `./ContextMenu.tsx`.

- [ ] **Step 3: Extract the shared dismissal hook**

In `src/ui/AnchoredMenu.tsx`, replace the body of `useAnchoredMenu`'s `useEffect` with a call to a new exported hook, and add the hook above it:

```typescript
/**
 * Escape-or-press-outside dismissal, the one behavior every menu in the app
 * shares. Extracted so the anchored menu and the context menu cannot drift
 * apart on it — they differ in where they are positioned, not in how they go
 * away. Listeners attach only while `open`.
 */
export function useDismissOnOutside(
  open: boolean,
  onDismiss: () => void,
  insideRef: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        onDismiss();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!insideRef.current?.contains(event.target as Node)) {
        onDismiss();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, onDismiss, insideRef]);
}
```

and inside `useAnchoredMenu`, replace its effect with:

```typescript
  const dismiss = useCallback(() => setOpen(false), []);
  useDismissOnOutside(open, dismiss, anchorRef);
```

(add `useCallback` to the React import; `anchorRef` is already `RefObject<T | null>`, which satisfies `RefObject<HTMLElement | null>` for `T extends HTMLElement`).

- [ ] **Step 4: Implement `ContextMenu`**

Create `src/ui/ContextMenu.tsx`:

```typescript
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { tokens } from "../theme/tokens.ts";
import { anchoredMenuSurfaceStyle, useDismissOnOutside } from "./AnchoredMenu.tsx";

/** How far from the viewport edge the menu refuses to sit. */
const EDGE_MARGIN = 8;

export interface ContextMenuItem {
  /** Renders in the destructive ink, below a separator. */
  danger?: boolean;
  label: string;
  onSelect: () => void;
}

const surfaceStyle: CSSProperties = {
  ...anchoredMenuSurfaceStyle,
  // The anchored variant pins itself to a container; this one is placed from
  // the pointer, so the container-relative offsets have to go.
  gap: "1px",
  minWidth: "168px",
  padding: "4px",
  right: "auto",
  top: "auto",
};

const itemStyle: CSSProperties = {
  background: "none",
  border: "none",
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.primary,
  cursor: "pointer",
  fontFamily: tokens.font.sans,
  fontSize: "12.5px",
  padding: "5px 9px",
  textAlign: "left",
  width: "100%",
};

const dangerItemStyle: CSSProperties = {
  ...itemStyle,
  color: tokens.color.status.error,
};

const separatorStyle: CSSProperties = {
  background: tokens.color.line.soft,
  height: "1px",
  margin: "3px 0",
};

/**
 * A menu opened at the pointer — the right-click companion to
 * {@link useAnchoredMenu}, which pins itself to a container instead.
 *
 * Positioning is measured after mount rather than guessed: the menu's own size
 * is not known until it renders, and "would this overflow the viewport" cannot
 * be answered without it. It renders at the raw pointer position for one frame
 * with `visibility: hidden`, then commits the corrected position — which is why
 * the flip is a `useLayoutEffect` and not a `useEffect` (the latter would paint
 * the uncorrected position first).
 */
export function ContextMenu({
  at,
  items,
  label,
  onClose,
}: {
  at: { x: number; y: number };
  items: ContextMenuItem[];
  label: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | undefined>(undefined);

  useDismissOnOutside(true, onClose, ref);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const { height, width } = el.getBoundingClientRect();
    const left =
      at.x + width + EDGE_MARGIN > window.innerWidth
        ? Math.max(EDGE_MARGIN, at.x - width)
        : at.x;
    const top =
      at.y + height + EDGE_MARGIN > window.innerHeight
        ? Math.max(EDGE_MARGIN, at.y - height)
        : at.y;
    setPlaced({ left, top });
  }, [at.x, at.y]);

  // Focus lands on the first item so the menu is usable from the keyboard the
  // moment it opens, and so Escape has somewhere to return focus *from*.
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    event.preventDefault();
    const buttons = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? []
    );
    const here = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = (here + step + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div
      aria-label={label}
      onKeyDown={onKeyDown}
      ref={ref}
      role="menu"
      style={{
        ...surfaceStyle,
        left: `${placed?.left ?? at.x}px`,
        position: "fixed",
        top: `${placed?.top ?? at.y}px`,
        visibility: placed ? "visible" : "hidden",
      }}
    >
      {items.map((item, index) => (
        <div key={item.label}>
          {item.danger && index > 0 ? <div style={separatorStyle} /> : null}
          <button
            data-danger={item.danger === true}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
            role="menuitem"
            style={item.danger ? dangerItemStyle : itemStyle}
            type="button"
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/ui/ContextMenu.test.tsx src/ui/AnchoredMenu.test.tsx`
Expected: PASS — the new file's 7 tests and every pre-existing `AnchoredMenu` test (the extraction must not change its behavior).

- [ ] **Step 6: Verify and commit**

Run: `pnpm fix && PATH="$HOME/.cargo/bin:$PATH" pnpm check`
Expected: exit 0.

```bash
git add src/ui/ContextMenu.tsx src/ui/ContextMenu.test.tsx src/ui/AnchoredMenu.tsx
git commit -m "feat(ui): a cursor-anchored ContextMenu, sharing the menu dismissal rule"
```

---

### Task 5: the inline draft row, New File and New Folder

**Files:**
- Modify: `src/changes/FileBrowserTree.tsx`
- Modify: `src/changes/FileBrowserTree.test.tsx`

**Interfaces:**
- Consumes: `createFile`, `createDir` (Task 2), `ContextMenu`/`ContextMenuItem` (Task 4), existing `fetchDir`, `childPath`, `toggleDir`, `selectFile`, `requestRefresh`.
- Produces: within `FileBrowserTree` — `type Draft = { error?: string; kind: "file" | "dir"; parentDir: string; renaming?: string }` and the `data-testid="file-browser-draft"` input consumed by Task 6's rename tests.

- [ ] **Step 1: Write the failing tests**

Add to `src/changes/FileBrowserTree.test.tsx` (hoist every regex to module level per Biome):

```typescript
const NEW_FILE_ITEM_RE = /new file/i;
const NEW_FOLDER_ITEM_RE = /new folder/i;

test("right-clicking a folder offers New File and New Folder", async () => {
  mockedListDir.mockResolvedValue([
    { ignored: false, isDir: true, name: "src" },
  ]);
  render(<FileBrowserTree cwd="/repo" sessionId="s1" />);

  fireEvent.contextMenu(await screen.findByTitle("src"));

  expect(screen.getByRole("menuitem", { name: NEW_FILE_ITEM_RE })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: NEW_FOLDER_ITEM_RE })).toBeInTheDocument();
});

test("New File opens a draft row and Enter creates the file inside that folder", async () => {
  mockedListDir.mockResolvedValue([
    { ignored: false, isDir: true, name: "src" },
  ]);
  render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
  fireEvent.contextMenu(await screen.findByTitle("src"));
  fireEvent.click(screen.getByRole("menuitem", { name: NEW_FILE_ITEM_RE }));

  const input = await screen.findByTestId("file-browser-draft");
  fireEvent.change(input, { target: { value: "new.ts" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await waitFor(() => {
    expect(mockedCreateFile).toHaveBeenCalledWith("/repo", "src/new.ts");
  });
});

test("Escape cancels the draft without creating anything", async () => {
  mockedListDir.mockResolvedValue([
    { ignored: false, isDir: true, name: "src" },
  ]);
  render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
  fireEvent.contextMenu(await screen.findByTitle("src"));
  fireEvent.click(screen.getByRole("menuitem", { name: NEW_FILE_ITEM_RE }));

  const input = await screen.findByTestId("file-browser-draft");
  fireEvent.change(input, { target: { value: "new.ts" } });
  fireEvent.keyDown(input, { key: "Escape" });

  expect(screen.queryByTestId("file-browser-draft")).not.toBeInTheDocument();
  expect(mockedCreateFile).not.toHaveBeenCalled();
});

/** A rejected name must stay on screen: retyping it because it vanished into a
 * toast is the failure mode this row exists to avoid. */
test("a refused name keeps the draft row and shows why", async () => {
  mockedListDir.mockResolvedValue([]);
  mockedCreateFile.mockRejectedValueOnce("already exists");
  render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
  fireEvent.contextMenu(await screen.findByTestId("file-browser-empty-area"));
  fireEvent.click(screen.getByRole("menuitem", { name: NEW_FILE_ITEM_RE }));

  const input = await screen.findByTestId("file-browser-draft");
  fireEvent.change(input, { target: { value: "a.txt" } });
  fireEvent.keyDown(input, { key: "Enter" });

  expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
  expect(screen.getByTestId("file-browser-draft")).toHaveValue("a.txt");
});

test("New Folder creates a directory and asks the Changes view to refresh", async () => {
  mockedListDir.mockResolvedValue([]);
  render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
  fireEvent.contextMenu(await screen.findByTestId("file-browser-empty-area"));
  fireEvent.click(screen.getByRole("menuitem", { name: NEW_FOLDER_ITEM_RE }));

  const input = await screen.findByTestId("file-browser-draft");
  fireEvent.change(input, { target: { value: "docs" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await waitFor(() => {
    expect(mockedCreateDir).toHaveBeenCalledWith("/repo", "docs");
  });
  await waitFor(() => {
    expect(mockedRequestRefresh).toHaveBeenCalledWith("s1", "manual");
  });
});
```

Extend the file's existing `vi.mock("../ipc/bridge.ts", …)` with `createFile: vi.fn().mockResolvedValue(undefined)`, `createDir: vi.fn().mockResolvedValue(undefined)`, `renameEntry: vi.fn().mockResolvedValue(undefined)`, `deleteEntry: vi.fn().mockResolvedValue(undefined)`, and add the matching `const mockedCreateFile = vi.mocked(createFile)` etc.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/changes/FileBrowserTree.test.tsx`
Expected: FAIL — no `contextmenu` handler, no draft row, no empty area.

- [ ] **Step 3: Implement**

In `src/changes/FileBrowserTree.tsx`:

```typescript
/** An open naming row: one at a time, tree-wide. `renaming` carries the
 * existing name when this draft is a rename rather than a create — the three
 * flows differ only in what commits, so they share one row. */
type Draft = {
  error?: string;
  kind: "file" | "dir";
  parentDir: string;
  renaming?: string;
};

const draftInputStyle: CSSProperties = {
  background: tokens.color.surface.s2,
  border: `1px solid ${tokens.color.accent}`,
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.primary,
  fontFamily: tokens.font.sans,
  fontSize: "12px",
  minWidth: 0,
  outline: "none",
  padding: "1px 4px",
};

const draftErrorStyle: CSSProperties = {
  color: tokens.color.status.error,
  fontFamily: tokens.font.sans,
  fontSize: "11px",
  padding: "1px 0 3px",
};
```

Inside the component, add state and handlers:

```typescript
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [menu, setMenu] = useState<
    { at: { x: number; y: number }; dir: string; entry?: { isDir: boolean; path: string } } | undefined
  >(undefined);

  // Where a create started from a given row lands: inside a folder, or beside
  // a file. Matches VS Code, and is the only place that decision is made.
  function targetDirFor(entry: { isDir: boolean; path: string } | undefined, dir: string) {
    if (!entry) {
      return dir;
    }
    return entry.isDir ? entry.path : dir;
  }

  function openDraft(kind: "file" | "dir", parentDir: string) {
    if (parentDir !== "") {
      // The row has to be visible to be typed into.
      const expanded = useChanges.getState().expandedDirs[sessionId] ?? {};
      if (expanded[parentDir] !== true) {
        toggleDir(sessionId, parentDir);
      }
    }
    setDraft({ kind, parentDir });
  }

  function commitDraft(name: string) {
    if (draft === undefined) {
      return;
    }
    const trimmed = name.trim();
    if (trimmed === "") {
      setDraft(undefined);
      return;
    }
    const path = childPath(draft.parentDir, trimmed);
    const gen = genRef.current;
    const run =
      draft.kind === "file"
        ? createFile(cwd, path)
        : createDir(cwd, path);
    run
      .then(() => {
        setDraft(undefined);
        fetchDir(draft.parentDir, gen);
        requestRefresh(sessionId, "manual");
        if (draft.kind === "file") {
          selectFile(sessionId, path);
        } else {
          toggleDir(sessionId, path);
        }
      })
      .catch((error: unknown) => {
        // Kept open, with the typed name intact — see the draft row's docs.
        setDraft((d) => (d ? { ...d, error: errorMessage(error) } : d));
      });
  }
```

Render the draft row inside `renderDir`, immediately after the `sorted.map(...)` result when `draft?.parentDir === dir`:

```typescript
    const rows = sorted.map((entry) => { /* unchanged body */ });
    if (draft?.parentDir !== dir) {
      return rows;
    }
    return [
      ...rows,
      <div key={`${dir}:draft`} style={{ ...rowStyle, ...indentStyle(depth) }}>
        <Guides depth={depth} />
        <span style={chevronSpacerStyle} />
        {draft.kind === "dir" ? <DirIcon open={false} /> : <FileIcon path="" />}
        <input
          autoFocus
          data-testid="file-browser-draft"
          defaultValue={draft.renaming ?? ""}
          onBlur={(e) => commitDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commitDraft(e.currentTarget.value);
            } else if (e.key === "Escape") {
              setDraft(undefined);
            }
          }}
          style={draftInputStyle}
        />
      </div>,
      draft.error === undefined ? null : (
        <div key={`${dir}:draft-error`} style={{ ...draftErrorStyle, ...indentStyle(depth) }}>
          {draft.error}
        </div>
      ),
    ];
```

Add `onContextMenu` to both row buttons:

```typescript
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({
                  at: { x: e.clientX, y: e.clientY },
                  dir,
                  entry: { isDir: entry.isDir, path },
                });
              }}
```

Wrap the tree's output in a relative container with an empty area that also takes a context menu, and render the menu:

```tsx
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      {renderDir("", 0)}
      <div
        data-testid="file-browser-empty-area"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ at: { x: e.clientX, y: e.clientY }, dir: "" });
        }}
        style={{ flex: 1, minHeight: "24px" }}
      />
      {menu ? (
        <ContextMenu
          at={menu.at}
          items={menuItems(menu)}
          label="File actions"
          onClose={() => setMenu(undefined)}
        />
      ) : null}
    </div>
  );
```

with, for this task, only the two create items:

```typescript
  function menuItems(m: NonNullable<typeof menu>): ContextMenuItem[] {
    const into = targetDirFor(m.entry, m.dir);
    return [
      { label: "New File", onSelect: () => openDraft("file", into) },
      { label: "New Folder", onSelect: () => openDraft("dir", into) },
    ];
  }
```

Import `createDir`, `createFile` from `../ipc/bridge.ts`, `requestRefresh` from `../state/changesRefresh.ts`, and `ContextMenu`, `type ContextMenuItem` from `../ui/ContextMenu.tsx`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/changes/FileBrowserTree.test.tsx`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Verify and commit**

Run: `pnpm fix && PATH="$HOME/.cargo/bin:$PATH" pnpm check`
Expected: exit 0.

```bash
git add src/changes/FileBrowserTree.tsx src/changes/FileBrowserTree.test.tsx
git commit -m "feat(files): New File and New Folder from the tree's context menu"
```

---

### Task 6: Rename, Delete, and keeping the open viewer honest

**Files:**
- Modify: `src/changes/FileBrowserTree.tsx`
- Modify: `src/changes/FileBrowserTree.test.tsx`

**Interfaces:**
- Consumes: `renameEntry`, `deleteEntry` (Task 3), `ConfirmDialog`, the `Draft` type and `commitDraft` from Task 5, `dirtyPath`/`drafts` selectors already in the component.
- Produces: nothing further tasks depend on.

- [ ] **Step 1: Write the failing tests**

Add to `src/changes/FileBrowserTree.test.tsx`:

```typescript
const RENAME_ITEM_RE = /rename/i;
const DELETE_ITEM_RE = /delete/i;
const CONFIRM_DELETE_RE = /^move to trash$/i;
const UNSAVED_RE = /unsaved/i;

test("Rename seeds the row with the current name and commits the new one", async () => {
  mockedListDir.mockResolvedValue([
    { ignored: false, isDir: false, name: "a.ts" },
  ]);
  render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
  fireEvent.contextMenu(await screen.findByTitle("a.ts"));
  fireEvent.click(screen.getByRole("menuitem", { name: RENAME_ITEM_RE }));

  const input = await screen.findByTestId("file-browser-draft");
  expect(input).toHaveValue("a.ts");
  fireEvent.change(input, { target: { value: "b.ts" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await waitFor(() => {
    expect(mockedRenameEntry).toHaveBeenCalledWith("/repo", "a.ts", "b.ts");
  });
});

test("Delete asks first and moves the entry to the Trash", async () => {
  mockedListDir.mockResolvedValue([
    { ignored: false, isDir: false, name: "a.ts" },
  ]);
  render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
  fireEvent.contextMenu(await screen.findByTitle("a.ts"));
  fireEvent.click(screen.getByRole("menuitem", { name: DELETE_ITEM_RE }));

  expect(mockedDeleteEntry).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: CONFIRM_DELETE_RE }));

  await waitFor(() => {
    expect(mockedDeleteEntry).toHaveBeenCalledWith("/repo", "a.ts");
  });
});

test("cancelling the delete confirm does nothing", async () => {
  mockedListDir.mockResolvedValue([
    { ignored: false, isDir: false, name: "a.ts" },
  ]);
  render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
  fireEvent.contextMenu(await screen.findByTitle("a.ts"));
  fireEvent.click(screen.getByRole("menuitem", { name: DELETE_ITEM_RE }));
  fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

  expect(mockedDeleteEntry).not.toHaveBeenCalled();
});

/** Renaming the open file must not leave the viewer pointing at a ghost. */
test("renaming the open file re-points the viewer at its new path", async () => {
  mockedListDir.mockResolvedValue([
    { ignored: false, isDir: false, name: "a.ts" },
  ]);
  useChanges.getState().selectFile("s1", "a.ts");
  render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
  fireEvent.contextMenu(await screen.findByTitle("a.ts"));
  fireEvent.click(screen.getByRole("menuitem", { name: RENAME_ITEM_RE }));
  const input = await screen.findByTestId("file-browser-draft");
  fireEvent.change(input, { target: { value: "b.ts" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await waitFor(() => {
    expect(useChanges.getState().ui.s1?.selectedFile).toBe("b.ts");
  });
});

test("deleting the open file closes the viewer", async () => {
  mockedListDir.mockResolvedValue([
    { ignored: false, isDir: false, name: "a.ts" },
  ]);
  useChanges.getState().selectFile("s1", "a.ts");
  render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
  fireEvent.contextMenu(await screen.findByTitle("a.ts"));
  fireEvent.click(screen.getByRole("menuitem", { name: DELETE_ITEM_RE }));
  fireEvent.click(screen.getByRole("button", { name: CONFIRM_DELETE_RE }));

  await waitFor(() => {
    expect(useChanges.getState().ui.s1?.selectedFile).toBeUndefined();
  });
});

/** A rename that silently throws away an unsaved draft is a data loss the user
 * did not ask for. Refused up front instead. */
test("refuses to rename a file with unsaved edits", async () => {
  mockedListDir.mockResolvedValue([
    { ignored: false, isDir: false, name: "a.ts" },
  ]);
  useChanges.getState().setDirtyFile("s1", "a.ts");
  render(<FileBrowserTree cwd="/repo" sessionId="s1" />);
  fireEvent.contextMenu(await screen.findByTitle("a.ts"));
  fireEvent.click(screen.getByRole("menuitem", { name: RENAME_ITEM_RE }));

  expect(await screen.findByText(UNSAVED_RE)).toBeInTheDocument();
  expect(screen.queryByTestId("file-browser-draft")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/changes/FileBrowserTree.test.tsx`
Expected: FAIL — no Rename/Delete menu items.

- [ ] **Step 3: Implement**

Extend `menuItems` and add the rename/delete handlers:

```typescript
  function isDirty(path: string) {
    return dirtyPath === path || Boolean(drafts?.[path]);
  }

  function menuItems(m: NonNullable<typeof menu>): ContextMenuItem[] {
    const into = targetDirFor(m.entry, m.dir);
    const items: ContextMenuItem[] = [
      { label: "New File", onSelect: () => openDraft("file", into) },
      { label: "New Folder", onSelect: () => openDraft("dir", into) },
    ];
    const entry = m.entry;
    if (!entry) {
      return items;
    }
    items.push({
      label: "Rename…",
      onSelect: () => {
        if (isDirty(entry.path)) {
          setBlocked("This file has unsaved edits — save it before renaming.");
          return;
        }
        setDraft({
          kind: entry.isDir ? "dir" : "file",
          parentDir: m.dir,
          renaming: baseName(entry.path),
        });
      },
    });
    items.push({
      danger: true,
      label: "Delete",
      onSelect: () => {
        if (isDirty(entry.path)) {
          setBlocked("This file has unsaved edits — save it before deleting.");
          return;
        }
        setConfirming(entry);
      },
    });
    return items;
  }
```

with the supporting state and commit paths:

```typescript
  const [confirming, setConfirming] = useState<{ isDir: boolean; path: string } | undefined>(undefined);
  const [blocked, setBlocked] = useState<string | undefined>(undefined);

  function baseName(path: string) {
    return path.slice(path.lastIndexOf("/") + 1);
  }

  function commitRename(name: string) {
    if (draft?.renaming === undefined) {
      return;
    }
    const trimmed = name.trim();
    const from = childPath(draft.parentDir, draft.renaming);
    if (trimmed === "" || trimmed === draft.renaming) {
      setDraft(undefined);
      return;
    }
    const gen = genRef.current;
    renameEntry(cwd, from, trimmed)
      .then(() => {
        setDraft(undefined);
        fetchDir(draft.parentDir, gen);
        requestRefresh(sessionId, "manual");
        if (useChanges.getState().ui[sessionId]?.selectedFile === from) {
          selectFile(sessionId, childPath(draft.parentDir, trimmed));
        }
      })
      .catch((error: unknown) => {
        setDraft((d) => (d ? { ...d, error: errorMessage(error) } : d));
      });
  }

  function commitDelete() {
    const entry = confirming;
    if (!entry) {
      return;
    }
    setConfirming(undefined);
    const parentDir = entry.path.includes("/")
      ? entry.path.slice(0, entry.path.lastIndexOf("/"))
      : "";
    const gen = genRef.current;
    deleteEntry(cwd, entry.path)
      .then(() => {
        fetchDir(parentDir, gen);
        requestRefresh(sessionId, "manual");
        if (useChanges.getState().ui[sessionId]?.selectedFile === entry.path) {
          selectFile(sessionId, undefined);
        }
      })
      .catch((error: unknown) => showToast(errorMessage(error)));
  }
```

Route the draft row's commit through whichever flow is open — change the two call sites in the draft row's `onKeyDown`/`onBlur` from `commitDraft(v)` to:

```typescript
            draft.renaming === undefined ? commitDraft(v) : commitRename(v)
```

Render the confirm and the blocked notice below the menu:

```tsx
      {confirming ? (
        <ConfirmDialog
          backdropTestId="delete-entry-backdrop"
          body={
            confirming.isDir
              ? "The folder and everything in it moves to the Trash."
              : "The file moves to the Trash."
          }
          confirmLabel="Move to Trash"
          confirmTestId="confirm-delete-entry"
          label={`Keep ${baseName(confirming.path)}`}
          onCancel={() => setConfirming(undefined)}
          onConfirm={commitDelete}
          title={`Delete ${baseName(confirming.path)}?`}
        />
      ) : null}
      {blocked ? (
        <div style={draftErrorStyle}>{blocked}</div>
      ) : null}
```

Clear `blocked` whenever a menu opens (`setBlocked(undefined)` inside both `onContextMenu` handlers).

Import `deleteEntry`, `renameEntry` from `../ipc/bridge.ts`, `ConfirmDialog` from `../ui/ConfirmDialog.tsx`, `showToast` from `../ui/Toast.tsx`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/changes/FileBrowserTree.test.tsx`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `pnpm fix && PATH="$HOME/.cargo/bin:$PATH" pnpm check`
Expected: exit 0.

```bash
git add src/changes/FileBrowserTree.tsx src/changes/FileBrowserTree.test.tsx
git commit -m "feat(files): rename and delete from the tree, with the viewer kept in step"
```

---

### Task 7: Smoke-test the whole flow and finish the branch

**Files:**
- Modify: `CONTEXT.md` only if a term drifted during implementation.

- [ ] **Step 1: Full gate**

Run: `pnpm fix && PATH="$HOME/.cargo/bin:$PATH" pnpm check`
Expected: exit 0, JS and Rust suites both green.

- [ ] **Step 2: Build the smoke app**

```bash
env -u APPLE_SIGNING_IDENTITY -u APPLE_API_KEY -u APPLE_API_ISSUER -u APPLE_CERTIFICATE \
  PATH="$HOME/.cargo/bin:$PATH" \
  pnpm tauri build --debug --bundles app --config src-tauri/tauri.smoke.conf.json
```

- [ ] **Step 3: Relaunch it**

Kill any existing smoke instance with **exactly** this pattern — a looser one kills the user's production Kriyon:

```bash
pkill -9 -f "KriyonSmoke.app/Contents/MacOS/kriyon($| )"
```

Skip the kill entirely if none is running. Then:

```bash
nohup /Users/dev/Projects/kriyon/target/debug/bundle/macos/KriyonSmoke.app/Contents/MacOS/kriyon \
  > /tmp/kriyon-smoke-$(date +%H%M%S).log 2>&1 < /dev/null & disown
ps -Ao pid,etime,command | grep 'KriyonSmoke.app/Contents/MacOS/kriyon$'
```

Expected: exactly one instance. `notification authorization granted=false` in the log is a known adhoc-build limitation, not a failure.

- [ ] **Step 4: Hand to the user for a verdict**

Ask them to check, in the Files & Changes tab: right-click a folder → New File → type a name → Enter; New Folder; Rename an existing file; Delete one and confirm it lands in the Trash; and that right-clicking empty space creates at the repo root.

- [ ] **Step 5: On approval, push and update PR #25**

```bash
PATH="$HOME/.cargo/bin:$PATH" git push
```

PR #25 already targets `feat/architecture-deepening`; update its description to cover the code palette work, the discard work, the pathspec security fix, and this file-tree feature.
