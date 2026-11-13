# ADR 0058 — One folder check, against the person's approved roots

**Date:** 2026-11-13
**Status:** Accepted

**Relates to:** [Approved root], [Chosen folder], [Checked folder], [Sandbox root] (CONTEXT.md); ADR-0021
(file-entry sandbox); ADR-0011 (Kriyon-owned worktree sessions); ADR-0037 (attachments)

## Context

The IPC boundary is a trust boundary: a folder path from the webview is untrusted until
checked. The file commands already held that line through `SandboxRoot::validate` →
`validate_cwd`, which canonicalized the `cwd` and required it to sit inside a "known session
or project root". Other commands that take a folder did not:

- `create_session` started a shell, and with it `claude`, in whatever `cwd` it was given.
- `upsert_project` and `upsert_session` save any path, and every saved path widens the list
  the file sandbox trusts.
- Worktree setup copies `.env` files and runs install scripts with no path check.

Remote access will start sessions from a phone or another computer. A second path that skips
the rule is how most bugs here start, so the rule has to live in one function every command
calls, local and remote alike.

## Decision

**An [Approved root] is a folder the person chose on this computer**: a project's folder, or
one of that project's worktrees. The store's project and session rows are the record of them
(`known_roots` reads every project path, session `cwd` and session `worktree_path`). Nothing
outside them is approved.

**Every folder path from the webview goes through `kriyon_core::folder::check_folder(path,
approved_roots)`**, which returns a `CheckedFolder` or a `FolderRefusal`. The rules, in order:

1. **Absolute.** Empty or relative paths are refused: they would resolve against wherever the
   app runs.
2. **No `.` or `..` parts.** Refused even when they would land inside, so the spelling a caller
   hands a shell or git cannot resolve differently from the spelling checked (the ADR-0021
   lesson).
3. **Exists and is a directory.**
4. **Inside an approved root**, decided on canonical forms (every symlink resolved) and by path
   parts, never a string prefix. A symlink inside a root that points out of it is refused.
   Approved roots are canonicalized inside the check, so callers pass them as stored; one that
   no longer resolves approves nothing.

`CheckedFolder` has no other constructor, so holding one proves the check ran.

Where it runs:

- **`validate_cwd`** (behind `SandboxRoot` and the composer commands) delegates to it. Its two
  old messages are unchanged; the two new rules add `cwd is not absolute` and `cwd has a '.' or
  '..' part`.
- **`create_session`** checks its `cwd` (empty means HOME, which is approved only as the Home
  project's folder) before it reads the folder or starts a fresh shell. A daemon still live from
  the last run reattaches whatever the check says: its shell already exists, and refusing would
  only orphan it. The shell still starts in the
  spelling given, not the canonical one: Claude keys transcripts by the folder it starts in, so
  resume depends on it. Rule 2 makes that safe.
- **Save before start.** A new session's project and session rows are what approve its folder,
  so the frontend's session host (`ensureSession`, which every start goes through: the launch
  and a mounting terminal alike) waits for those writes to settle before it calls
  `create_session`.

**Saving a row is what approves a folder, so the store commands check it too:**

- **`upsert_project`** saves a project whose folder is the one it was saved with before (not
  re-checked: a parked or removed project's row must still save once its folder is gone), or
  is exactly a [Chosen folder]: one the person picked in a native folder dialog that the Rust
  core ran (`pick_folder`, recorded in memory as `ChosenFolders`, the same shape as the
  attachment registry of ADR-0037), or the home folder (the Home project). Exactly, not
  inside: the home folder is chosen, and "inside it" would be nearly everything. Resuming a
  past session needs no rule of its own: Kriyon lists past sessions only for a saved project's
  folder, so the resumed folder is that project's.
- **`upsert_session`** saves a session only once its project is saved, and only when its `cwd`
  and `worktree_path` are each the value saved before, or exactly the project's folder or one of
  the project repository's linked worktrees (`git worktree list`, without the main checkout,
  asked only when the project folder does not settle it, since rows are re-saved on every title
  change). Exactly again: every session starts in one of those, and "inside" would let a session
  of the Home project approve any folder under HOME. The main checkout is left out because it
  can sit above a project kept in a subfolder of a monorepo.
- The frontend saves a new session's project before the session, and records the baseline only
  after both, so neither write races the check.

Worktree setup will check its paths with the same function. Remote starts will call it with the
person's approved roots and never add one themselves.

## Consequences

- One function decides "is this folder one the person approved". Remote access reuses it as is.
- Rows saved before this rule are not re-checked; they stay approved as they were.
- The webview can still name the home folder as a new project, the Home project. A session can
  only ever start in the home folder itself, not under it.
- A linked worktree counts once git lists it, so `create_worktree` must check where it puts one;
  the worktree-setup change does that.
- `ChosenFolders` lives in memory, so a folder picked but never saved is forgotten on quit.
- A session whose folder was deleted, or whose project was removed, no longer starts a fresh
  shell; it fails with the check's message instead. One whose daemon is still live reattaches.
- The check and the spawn are not atomic: a symlink in the given spelling could be re-pointed
  between them. Doing that takes write access to the person's own folders, which already means
  full access as them, so it is outside what this check defends.

## Alternatives rejected

- **Require the path to equal its canonical form.** Folders reached through a symlink (macOS's
  own `/tmp` and `/var` among them) would be refused, and existing sessions saved that way
  would stop resuming.
- **Check only that the folder exists.** Any folder on the disk would still be a valid place to
  start `claude`, which is exactly what remote access must not allow.
- **A separate check per command.** That is how `create_session` came to have none.
