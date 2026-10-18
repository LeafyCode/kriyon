# File-tree mutations — design

**Date:** 2026-08-30
**Status:** Approved: right-click the file tree to create a file or folder, as in VS Code; scope widened to Rename + Delete with inline naming; same branch and PR.
**Base:** `feat/editor-cursor-polish` (PR #25, stacked on `feat/architecture-deepening` → PR #24 → PR #23 → main)
**Relates to:** CONTEXT.md ([File sandbox], [Sandbox root] — one new term below), ADR-0017 (Working-tree budget), the 2026-08-30 security review of `discard_file_changes`

## Goal

Right-clicking the [File browser tree] opens a context menu that can create a
file, create a folder, rename an entry, and delete one — the four mutations VS
Code's explorer offers, with VS Code's inline-naming feel. Everything crosses
the Rust↔JS trust boundary through one new containment rule, because the
existing one cannot express a path that does not exist yet.

Non-goals: drag-to-move, duplicate, multi-select, copy/paste, "New File…" with
a nested path (`a/b/c.ts` creating intermediate directories), and an undo
stack. Delete is recoverable through Finder's Trash instead of through an app
undo.

## The problem this design exists to solve

Every path crossing into Rust today is validated by `resolve_within`
(`src-tauri/src/sandbox.rs`), which **canonicalizes** the joined path. That is
what makes the sandbox trustworthy: canonicalization resolves `..` and symlinks
*before* containment is checked, so a symlink pointing out of the root is
rejected exactly like an absolute escape. It is also why the sandbox cannot
name a file that does not exist — `canonicalize` fails on a missing path, so
"create `src/new.ts`" has nowhere to hang.

The 2026-08-30 security review made the cost of getting this wrong concrete:
`discard_file_changes` validated one spelling of a path and handed git another,
and both a glob widening and a symlink-plus-`..` escape followed. Any new rule
here must keep containment settled *canonically*, never lexically.

### Approaches considered

1. **Resolve the parent, validate the leaf.** (chosen) The parent directory
   exists, so it canonicalizes and passes the existing containment check
   unchanged. The final segment is then validated as a plain filename. A leaf
   that cannot contain a separator, `.`, `..`, or a NUL cannot traverse
   anywhere, so joining it onto an already-canonical contained directory yields
   a path that is contained by construction.
2. **Lexically normalize `..` and check containment without canonicalizing.**
   Rejected. This is the divergence the security review just closed: text-level
   path math and the filesystem disagree, and the disagreement runs in the
   escaping direction.
3. **Create first, then canonicalize and unlink if it landed outside.**
   Rejected. It writes to disk before deciding the caller is allowed to, and
   the check races anything watching the directory.

## Design

### 1. `SandboxRoot::resolve_new` — the new containment rule

New method on `SandboxRoot`, beside `resolve` / `resolve_for_listing`:

```rust
pub(crate) fn resolve_new(&self, path: &str, verb: &str)
    -> Result<NewSandboxedPath, String>
```

- Split `path` into parent + final segment on the last `/`. An empty parent
  means the root itself.
- `self.resolve(parent, verb)?` — the existing rule, unchanged, including the
  `.git` refusal. This is where containment is settled, canonically.
- Require the resolved parent to be a directory.
- Validate the final segment with a new private `valid_leaf_name`: non-empty;
  not `.` or `..`; contains no `/`, no `\`, no NUL; is not `.git`; length ≤ 255
  bytes (the ceiling every filesystem Kriyon targets shares).
- Return `NewSandboxedPath` — the canonical parent plus the validated leaf,
  with `as_path()` yielding the join. Same unforgeability discipline as
  `SandboxedPath`: private fields, no public constructor, so a path that
  skipped the check is not a value the rest of the app can hold.

`NewSandboxedPath` is deliberately a *separate* type from `SandboxedPath`
rather than a flag on it: the two carry different guarantees (one has been
canonicalized as a whole, one has a canonical parent and a leaf that cannot
escape it), and a function that means "an existing sandboxed file" must not
silently accept "a name that might become one".

**Symlinked-parent note.** `resolve` canonicalizes the parent, so a symlinked
directory inside the root resolves to its target and is contained only if that
target is inside the root. A leaf created under it therefore also lands inside
the root. This is the property approach 2 could not offer.

### 2. Four Rust commands

All in a new `src-tauri/src/entry_cmd.rs` (the file-mutation commands as a
group; `file_cmd.rs` is already 600+ lines and is about *content*, this is
about *entries*). All take `store` + `cwd` + `path`, return `Result<_, String>`,
and are `#[tauri::command(async)]` because they touch the filesystem.

| Command | Behavior |
|---|---|
| `create_file(cwd, path)` | `resolve_new` with verb `"write"`, then `OpenOptions::new().create_new(true)` — fails if it already exists, which is what makes "create" not silently truncate. Creates an empty file only; no template content. |
| `create_dir(cwd, path)` | `resolve_new`, then `create_dir` (not `create_dir_all` — the parent must already exist, matching the leaf-only rule). |
| `rename_entry(cwd, path, newName)` | `resolve(path, "write")` for the source (it must exist), `resolve_new` on the *same parent* + `newName` for the target, then `std::fs::rename`. Same-directory only: `newName` is a leaf, so a rename can never move an entry elsewhere. Refuses if the target exists. |
| `delete_entry(cwd, path)` | `resolve(path, "write")`, then move to Trash via `NSFileManager.trashItemAtURL`. No new crate: `objc2-foundation` is already a dependency and gains the `NSFileManager` + `NSURL` features. Works for both files and directories. |

Every one of them inherits the `.git` refusal from `resolve`/`resolve_new`
with the `"write"` verb.

**Why Trash, not `remove_file`/`remove_dir_all`.** This tree has no undo, the
menu item sits one row from "Rename", and a directory delete is recursive. The
Trash makes a misclick recoverable in Finder for the price of an API call. A
`trashItemAtURL` failure surfaces as an error, never as a silent fall-through
to permanent deletion.

**Errors.** Plain strings, per ADR-0006 — nothing in the frontend branches on
these; they are shown. The one exception worth a machine-readable kind would be
"already exists", and the frontend does not need to branch on it either: the
inline row shows the message and keeps the typed name so the user can edit it.

### 3. Bridge + types

`src/ipc/bridge.ts` gains four thin wrappers matching the existing
`discardFileChanges` shape. No new TS types: all four return `void`.

### 4. `ContextMenu` — cursor-anchored popover

New `src/ui/ContextMenu.tsx`. `AnchoredMenu` cannot be reused as-is: it pins
its surface to a *container* (`right: 9px; top: 100%`), and a context menu must
open at the pointer. What it *does* own that this needs — open/close state,
Escape-to-dismiss, outside-`pointerdown` dismissal — is extracted into a shared
hook so the two menus cannot drift apart on dismissal behavior.

- Opens at `(clientX, clientY)`, flipped left/up when it would overflow the
  viewport.
- `role="menu"`, items `role="menuitem"`, arrow-key roving focus, Enter/Space
  to activate, Escape to close and return focus to the row.
- Styling reuses `anchoredMenuSurfaceStyle`; all values from `tokens.ts`.
- A destructive item renders in `tokens.color.status.error` and sits below a
  separator.

### 5. Inline naming row in the tree

The one interaction that carries all three naming flows (New File, New Folder,
Rename), in `FileBrowserTree.tsx`:

- Tree-local state `draft: { parentDir, kind: "file" | "dir", renaming?: string }`.
- While a draft is open, the tree renders one extra row at the right depth,
  with the matching file/folder icon and a bare `<input>`, autofocused. Rename
  seeds the input with the current name and selects the stem (not the
  extension), as VS Code does.
- **Enter** commits, **Escape** cancels, **blur** commits (VS Code's behavior);
  an empty or whitespace-only name cancels rather than erroring.
- A failed commit keeps the row open with the error beneath it and refocuses
  the input, so the name the user typed is never lost to a toast — including
  when the commit was triggered by blur.
- The draft row is not a `DirEntry` and never enters `listings` — it is
  rendered alongside them, so a refresh landing mid-typing cannot destroy it.

**WebKit caret note.** In WebKit, an input's caret can anchor outside the field
when selection is manipulated by hand, so this input must not have `removeAllRanges` called against it and its
focus must be driven by `autoFocus`/`ref.focus()`, not by manual selection
manipulation.

### 6. Wiring in `FileBrowserTree`

- `onContextMenu` on each row: `preventDefault`, select the row, open the menu
  at the pointer.
- Target directory: right-click a **folder** → create inside it (and expand it
  so the draft row is visible); a **file** → create in its parent; the tree's **empty
  area** (its scroll container's background) → the tree's root.
- After a successful mutation: re-fetch the affected directory's listing
  (the tree already has a per-directory fetch path), and call
  `requestRefresh(sessionId, "manual")` so the Changes view and git gutter
  reflect a new/renamed/deleted file. `"manual"` is the reason that refreshes
  even for a session whose diff was refused by the [Working-tree budget] —
  the same choice `DiscardFileChanges` made.
- Creating a file selects it and opens it in the [File viewer], as VS Code
  does. Creating a folder expands it and leaves the viewer alone.

### 7. Open-viewer consistency

Renaming or deleting the entry currently open in the viewer must not leave the
viewer pointing at a path that no longer exists:

- **Rename** → `selectFile(sessionId, newPath)`, so the viewer follows the file.
- **Delete** → `selectFile(sessionId, undefined)`, closing the viewer.
- Both go through the existing dirty-guard: if the open file has unsaved edits,
  the mutation is refused up front with a message saying so, rather than
  silently discarding the draft. This is the one place the feature deliberately
  says no instead of asking — a rename that throws away unsaved work is a data
  loss the user did not ask for, and Save-then-rename is one keystroke away.

### 8. Delete confirmation

Reuses `ConfirmDialog` (the component `DiscardFileChanges` already reuses).
Title names the entry; body says it moves to the Trash. A directory's body also
says it takes its contents with it. Nothing is hand-rolled.

## Testing

Rust (`entry_cmd.rs` + `sandbox.rs`), following the pattern the security review
established — assert on observable state, and make the *rejection* paths reach
the code under test rather than stopping inside `resolve`:

- `valid_leaf_name` rejects: empty, `.`, `..`, `a/b`, `a\0b`, `.git`, 256 bytes.
- `resolve_new` refuses a leaf whose parent escapes the root; refuses a
  `.git` parent; accepts a leaf under a symlinked-but-contained parent and
  resolves it inside the root.
- `create_file` refuses an existing path (no truncation — the pre-existing
  content is still there afterwards).
- `create_dir` refuses when the parent does not exist.
- `rename_entry` refuses an existing target, and cannot move an entry out of
  its directory (`newName` of `../x` is refused by the leaf rule).
- `delete_entry` removes the entry from the tree and refuses `.git`.
- A directory containing a file is deleted whole.

Frontend:

- `ContextMenu`: opens at the pointer, flips at the viewport edge, Escape and
  outside-click close, arrow keys move focus, `role="menu"` shape.
- `FileBrowserTree`: right-click a folder opens the menu; New File draws a
  draft row at the right depth; Enter commits and calls the bridge with the
  joined path; Escape cancels without calling it; a rejected commit keeps the
  typed name on screen; a refresh landing mid-typing leaves the draft alone.
- Delete asks first and does nothing when cancelled (mirrors the existing
  `discarding a file's git changes` tests).
- Renaming the open file re-points the viewer; deleting it closes the viewer;
  both refuse while the draft is dirty.

## CONTEXT.md

One new term, added before the type exists:

- **New-entry sandbox** (`SandboxRoot::resolve_new`, `NewSandboxedPath`) — the
  containment rule for a path that does not exist yet, used by the four
  file-tree mutation commands. Containment is still settled canonically, on the
  *parent*; the final segment is validated as a leaf name that cannot traverse.

`[File sandbox]`'s entry gains a sentence pointing at it, since "every call
passes `resolve`" stops being the whole truth.

## Build order

1. `valid_leaf_name` + `resolve_new` + `NewSandboxedPath` (sandbox.rs), tests first.
2. `entry_cmd.rs`: `create_file`, `create_dir`; registration; bridge wrappers.
3. `rename_entry`, `delete_entry` (Trash), with the `.git` and existing-target refusals.
4. `ContextMenu` + the extracted dismissal hook.
5. Inline draft row + New File / New Folder wiring, including refresh.
6. Rename + Delete wiring, confirm dialog, open-viewer consistency, dirty guard.
7. CONTEXT.md terms; full `pnpm check`.
