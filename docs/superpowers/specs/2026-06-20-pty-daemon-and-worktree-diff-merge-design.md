# Phase 5 — out-of-process PTY daemon + worktree diff/merge

Date: 2026-06-20
Branch: `feat/session-activity`
Part of the perf and command-center work (workstream C4).

This is the final phase of the Kriyon perf + command-center effort. It is two
separable, net-new builds. They ship as two commits, **git diff/merge first**
(self-contained, lower risk), then the **PTY daemon** (the large infra).

The high-level decisions are locked by the plan ("Decisions locked" block):
out-of-process PTY daemon so sessions survive an app crash; worktrees stay loose
(optional per session); build the net-new git diff/merge review loop. The
remaining design — lifecycle, topology, wire formats — is settled below.

---

## Deliverable 1 — Git diff/merge + review (commit 1)

### What it does

A loose-worktree session runs on its own branch. The review answers "what did
this session change, and can I merge it?" — without leaving Kriyon.

- **Diff** = the committed changes on the session's branch since it forked:
  `git -C <worktree> diff <base>...HEAD` (three-dot: the merge-base diff). No
  working-tree / uncommitted state is mixed in — keep it to what `git merge`
  would actually take.
- **Merge** = a real merge of the session's branch into the base checkout:
  `git -C <repo> merge <branch>`. Clean → reported clean. Conflict → the
  conflicted file list is surfaced **read-only**; the user resolves in the real
  terminal. Kriyon never edits files or injects keystrokes (the terminal is the
  source of truth — see ADR 0008). No
  abort/auto-resolve machinery in v1.

### Base ref

The base is the repo's **default branch**, auto-detected:

1. `git -C <repo> symbolic-ref --short refs/remotes/origin/HEAD` (strip the
   `origin/` prefix) when an origin HEAD exists; else
2. the first of `main`, `master` that exists as a local branch
   (`git rev-parse --verify`); else
3. error surfaced to the UI ("could not determine a base branch").

No per-review picker and no per-session persistence in v1 (YAGNI).

### Wire format — parsed in the core, not the UI

AGENTS.md forbids the frontend doing parsing / business logic, and
`kriyon-core/src/git.rs` already has the exact pattern: pure, unit-tested
`parse_status` / `parse_worktrees`. We add one more parser. The frontend renders;
it does not parse.

Types (Rust in `kriyon-core::git`, mirrored in `src/types.ts`). The line/kind
types **reuse the existing** `DiffLine` / `DiffKind` from `transcript.rs` (added
/ removed / context) rather than introducing a parallel pair:

```rust
pub struct SessionDiff { pub base: String, pub files: Vec<FileDiff> }

pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,      // Some(..) only for renames
    pub status: FileChange,            // Added | Modified | Deleted | Renamed
    pub hunks: Vec<DiffHunk>,
}

pub struct DiffHunk { pub header: String, pub lines: Vec<DiffLine> }
// DiffLine { kind: DiffKind, text: String }  — reused from transcript.rs

pub enum MergeOutcome {
    Clean,
    Conflicted { files: Vec<String> },
}
```

`parse_diff(&str) -> Vec<FileDiff>` parses `git diff` output: `diff --git`
boundaries open a file; `rename from/to`, `new file`, `deleted file` set the
status; `@@ … @@` opens a hunk; `+`/`-`/` ` classify lines. Tolerant of binary
files (a `FileDiff` with no hunks) and of unexpected lines (skipped, never
panics) — same spirit as the transcript parser.

`parse_merge_conflicts` derives the conflicted set from
`git -C <repo> diff --name-only --diff-filter=U` after a conflicting merge.

### Plumbing

- `src-tauri/src/git_cmd.rs`: `diff_worktree(worktree, base)` and
  `merge_worktree(repo, branch)` — thin shell-outs reusing `reject_flag_like`
  and the `--` positional guard (the Rust↔JS trust boundary). The default-branch
  detection (`default_branch(repo)`) lives here too.
- `src-tauri/src/commands.rs` + `lib.rs` handler list: `diff_worktree`,
  `merge_worktree`, `default_branch` Tauri commands (typed args, `Result`).
- `src/ipc/bridge.ts`: `diffWorktree`, `mergeWorktree`, `defaultBranch` wrappers.
- `src/types.ts`: `SessionDiff`, `FileDiff`, `DiffHunk`, `FileChange`,
  `MergeOutcome` (camelCase, mirroring serde).

### Review UI

Lives in the **existing worktree surface** — no new top-level view. The Inspector
already has a "Changes" section keyed off `useRepoStatus`. We add a **Review**
affordance there for a session that is on a worktree/branch: it loads the
`SessionDiff`, renders per-file collapsible hunks (added/removed/context colored
from `theme/tokens.ts`), and offers **Merge**. On merge: clean shows success;
conflict lists the files and points the user to the terminal. All colors/spacing
from `theme/tokens.ts`; no literals.

### Tests (TDD)

- `kriyon-core::git`: `parse_diff` over modified / added / deleted / renamed /
  binary / empty fixtures; `parse_merge_conflicts`. (Pure, no process.)
- `git_cmd`: integration like the existing `create_and_list_worktrees` — init a
  temp repo, branch, commit, assert `diff_worktree` returns the change and
  `merge_worktree` returns `Clean`, then a conflicting case returns
  `Conflicted`. Guarded by `git_available()`.
- `default_branch`: temp repo on `main` resolves to `main`.
- Frontend: a Vitest render test of the diff view (file list + hunk lines) and
  the conflict surface.

---

## Deliverable 2 — Out-of-process PTY daemon (commit 2)

### Goal / acceptance

Today the PTY lives in the app process (`PtyEngine` in `src-tauri/src/pty.rs`),
so a session survives a **webview reload** but not an **app crash** — the process
tree dies with the app. Move the PTY into a **long-lived per-session daemon** so
the session survives an app crash + upgrade. `v-crash`: kill the app mid-session,
confirm the session resumes **via the daemon** (not just `claude --resume`).

### Topology — one daemon per session (dtach/abduco model)

Each session is one `kriyon-ptyd` process owning exactly one PTY + child shell,
listening on a Unix domain socket at `~/.claude/kriyon/run/<session-id>.sock`.
Rationale: isolated (one daemon crashing cannot affect other sessions or the
app), simplest lifecycle, matches the "supervised, bounded, isolated" reliability
theme from C1. No shared multiplexer / internal routing.

`session-id` is Kriyon's own UUID (already gates the hook and names per-session
files). It is validated as a plain id (alphanumeric + `-`, non-empty) before it
is interpolated into the socket path — the path-containment trust-boundary rule.

### Mechanism — byte-proxy (all-safe Rust)

The plan's locked wording was "fd-handoff", but to keep it simple we take
the **byte-proxy** model instead. Byte-proxy is all-safe Rust
(no `SCM_RIGHTS`, no raw `TIOCSWINSZ` ioctl), and gives scrollback-replay for
free. Crash-survival is identical either way — the daemon keeps the PTY + child
alive while detached.

- The **daemon owns the PTY** (the existing `PtyEngine` moves into the
  `kriyon-ptyd` crate). Its `on_output` either frames bytes to the connected
  client over the socket, or — when no client is attached — appends to a
  **bounded scrollback ring** (~256 KB, oldest dropped).
- On a client **Attach**, the daemon replays the ring (repaint), then streams
  live. A `Resize` after attach pokes the TUI to redraw.
- The **app** runs a `DaemonClient` that implements the existing `SessionEngine`
  trait. Its reader thread reads frames off the socket, feeds `on_output`, and
  calls the **unchanged Phase-1 `Backpressure`** (`after_send`). `report_drained`
  is unchanged: it parks/unparks the *socket* reader. Parking the socket reader
  stops draining the socket → the OS socket buffer fills → the daemon's socket
  write blocks → the daemon stops reading the PTY → the child is backpressured.
  **End-to-end backpressure with no new ack protocol across the socket.**

### Wire protocol — pure, in `kriyon-core`

A length-prefixed framed protocol, encode/decode pure and unit-tested in
`kriyon-core` (a new `wire` module); both `kriyon-ptyd` and `src-tauri` depend on
it. Frame on the wire: `[u8 tag][u32 len (LE)][payload]`.

| Tag | Frame | Direction | Payload |
|---|---|---|---|
| 0 | `Output(Vec<u8>)` | daemon → app | raw PTY bytes |
| 1 | `Stdin(Vec<u8>)` | app → daemon | bytes to write to child stdin |
| 2 | `Resize { cols, rows }` | app → daemon | two `u16` LE |
| 3 | `Attach { cols, rows }` | app → daemon | two `u16` LE (first frame) |
| 4 | `Shutdown` | app → daemon | empty — kill child, exit, remove socket |

A streaming `FrameDecoder` accumulates bytes and yields complete frames,
tolerating partial reads (TCP/Unix stream boundaries are arbitrary). Tests:
round-trip each frame; decode across split buffers; ignore/skip a malformed tag
without panicking.

### Lifecycle

- **Spawn / discovery / re-attach** (`create_session`): compute the socket path.
  If a daemon is already live there (socket connects) → **reattach** (do not
  spawn). Else spawn `kriyon-ptyd` **detached** (its own process group via
  `CommandExt::process_group(0)`, stdio to a log/`/dev/null`) with the spawn spec,
  wait briefly for the socket to appear, then connect and send `Attach`.
- **Crash-survival path**: the app dies; the daemon (separate process group) keeps
  running with the PTY + child alive. On app restart the frontend re-creates its
  persisted sessions; `create_session` finds the live socket and **reattaches** —
  the session resumes. This is `v-crash`.
- **Orphan cleanup**: the daemon exits when the **child exits** (PTY read hits
  EOF) — it removes its socket file and terminates — or on an explicit
  `Shutdown` frame (from `close_session`). A **stale** socket (file present but
  not connectable, i.e. the daemon died uncleanly) is removed lazily on the next
  connect attempt before spawning a fresh daemon.
- The daemon binary is located via `current_exe()`'s sibling `kriyon-ptyd`, with
  a `KRIYON_PTYD_BIN` env override (used by tests and dev). It is bundled
  alongside the main binary.

### App-side changes

- New `crates/kriyon-ptyd` (bin): owns `PtyEngine` (moved from
  `src-tauri/src/pty.rs`), the accept loop, the single-client session, and the
  scrollback ring.
- `src-tauri/src/daemon_client.rs`: `DaemonClient` implementing `SessionEngine`
  (connect, framed reader thread + `Backpressure`, `write_stdin`/`resize`/`close`
  send frames). `src-tauri` no longer spawns `PtyEngine` directly.
- `commands.rs` `create_session`/`close_session`/`report_drained` retarget the
  `SessionEngine` (now `DaemonClient`). The public command surface and
  `bridge.ts` are **unchanged** — the swap is behind the trait.

### Tests (TDD)

- **Pure** (`kriyon-core::wire`): frame round-trip, split-buffer decode, bad-tag
  tolerance.
- **Pure**: socket-path derivation + session-id validation (reject empty / `..` /
  path separators).
- **Integration (automated `v-crash` proxy)** in the daemon crate: build + spawn
  `kriyon-ptyd`, connect, `Attach`, `Stdin("printf hi\n")`, assert `Output`
  contains `hi`. **Disconnect** the client (simulating an app crash), reconnect a
  fresh client, `Attach`, drive the same child, confirm it still responds — the
  child survived the client's death. Then `Shutdown`; assert the daemon exits and
  the socket is removed.

---

## What stays out of scope (YAGNI for v1)

- fd-handoff / `SCM_RIGHTS` (superseded by byte-proxy).
- Multi-client attach (one app client at a time; a new connection replaces the
  old).
- Diff base picker / per-session base persistence.
- Merge abort / interactive conflict resolution inside Kriyon (resolve in the
  terminal).
- A daemon idle-timeout: a detached daemon stays alive while its child lives —
  that *is* crash-survival.

## CONTEXT.md terms to add before they become identifiers

Session diff (`SessionDiff`), File diff (`FileDiff`), Diff hunk (`DiffHunk`),
File change (`FileChange`), Merge outcome (`MergeOutcome`); PTY daemon
(`kriyon-ptyd`), Daemon client (`DaemonClient`), Daemon frame (`Frame` / the
`wire` protocol), Scrollback ring, Session socket.
