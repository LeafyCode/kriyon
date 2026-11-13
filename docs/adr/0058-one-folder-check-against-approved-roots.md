# ADR 0058 — One folder check, against the person's approved roots

**Date:** 2026-11-13
**Status:** Accepted

**Relates to:** [Approved root], [Checked folder], [Sandbox root] (CONTEXT.md); ADR-0021
(file-entry sandbox); ADR-0011 (Kriyon-owned worktree sessions)

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
  project's folder) before it reads the folder or starts a shell. The shell still starts in the
  spelling given, not the canonical one: Claude keys transcripts by the folder it starts in, so
  resume depends on it. Rule 2 makes that safe.
- **Save before start.** A new session's project and session rows are what approve its folder,
  so the frontend waits for those writes to settle before it calls `create_session`.

Next, in their own pull requests: `upsert_project` / `upsert_session` will check the paths
they save (a session's folders must sit inside its project's folder or be a worktree of it), so
saving a row can no longer approve an arbitrary folder; worktree setup will check its paths
with the same function. Remote starts will call it with the person's approved roots and never
add one themselves.

## Consequences

- One function decides "is this folder one the person approved". Remote access reuses it as is.
- Until the store commands are checked, the approved list is only as narrow as what the
  webview saved. This PR closes `create_session`; the store PR closes that gap.
- A session whose folder was deleted, or whose project was removed, no longer starts; it fails
  with the check's message instead of a shell in a missing folder.

## Alternatives rejected

- **Require the path to equal its canonical form.** Folders reached through a symlink (macOS's
  own `/tmp` and `/var` among them) would be refused, and existing sessions saved that way
  would stop resuming.
- **Check only that the folder exists.** Any folder on the disk would still be a valid place to
  start `claude`, which is exactly what remote access must not allow.
- **A separate check per command.** That is how `create_session` came to have none.
