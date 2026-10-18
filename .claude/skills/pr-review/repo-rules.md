# What to check in this repo

The rules from `AGENTS.md`, `src/AGENTS.md`, `src-tauri/AGENTS.md` and the ADRs that a
reviewer can actually catch in a diff. Breaking one of these is worth a score of 75 or more on
its own. Name the rule in the finding.

Only check the sections that match the files the pull request touches.

## The IPC boundary — `src-tauri/src/*_cmd.rs`, `commands.rs`, `lib.rs`, `src/ipc/`, `src/types.ts`

The Rust↔JS boundary is a trust boundary. Everything the webview sends is untrusted.

- A `#[tauri::command]` that uses a frontend-supplied path, id, branch name, URL or command
  without validating it. Paths go through `SandboxRoot` (ADR 0021); ids are looked up, never
  trusted.
- A new command not registered in `generate_handler![…]` in `lib.rs`, or registered but not
  reachable through `src/ipc/bridge.ts`.
- `invoke` or `Channel` used anywhere in `src/` outside `src/ipc/bridge.ts`, or a command name
  written as a string outside it.
- A Rust event or payload shape changed without the mirror in `src/types.ts` (same variant
  names), or the reverse.
- `.unwrap()` or `.expect()` in a command handler. Return `Result` and propagate.
- PTY output sent as per-keystroke JSON instead of binary and batched over a `Channel`.
- A change to `src-tauri/capabilities/*.json` or the CSP in `tauri.conf.json` that widens what
  the webview may reach. Name what it now allows.

## Core and shell — `crates/kriyon-core`, `src-tauri`

- Decision logic added to `src-tauri` that could live in `kriyon-core` and be unit-tested
  there. The command should be glue.
- `kriyon-core` reaching for Tauri, a window, or the real filesystem where an injected
  location would do (see `ManagedLocations`, ADR 0031). Tests must never read the real
  `~/.claude` or `/Library`.

## Frontend — `src/`

The frontend is a thin UI. It calls commands and renders.

- Process, filesystem or network access from the frontend.
- Business logic in a component: deriving, parsing or fusing data that belongs in a store
  (`state/`) or in Rust.
- A colour, spacing value, radius, shadow or status colour written as a literal outside
  `src/theme/tokens.ts`.
- A lint rule switched off to allow `console.*` in `src/**`.

## Claude Code — anything that spawns `claude`, touches `~/.claude`, or reads the transcript

Kriyon wraps the user's own, unmodified Claude Code. It never handles their identity.

- Reading, copying or storing credentials, OAuth tokens, API keys or Keychain items; setting an
  auth variable on a session; calling Anthropic's API from Kriyon's code; bundling,
  downloading or patching the `claude` binary (ADR 0030).
- Stripping an environment variable that is not on the named identity list, or adding a
  prefix rule (ADR 0028). User settings must pass through.
- Writing anything to `~/.claude` (settings, plugins, hooks, status line) before the user
  consented, or without a way to remove it again (ADR 0033).
- Treating an event from a nested or foreign `claude` as the session's own. Only the process
  leading the PTY's foreground group speaks for a session (ADR 0039).
- Treating an unreadable managed policy as "allowed" (ADR 0031). `unknown` behaves like
  `blocked`.
- A transcript or hook parser that can error, panic or drop the whole stream on a line it
  does not understand. Unknown input becomes `StructuredEvent::Unknown`.
- Kriyon answering a CLI prompt or dialog for the user. The user answers in the terminal
  (ADR 0040).

## Processes, the PTY daemon and signals — `crates/kriyon-ptyd`, `tree_stop.rs`, `orphan.rs`, `quit.rs`, `daemon*.rs`

ADR 0022. Every one of these kills or leaks something on the user's machine.

- A signal sent to a pid read from disk, a store or a message, rather than one from a sweep
  just taken. A stale pid can point at an unrelated process.
- A signal that skips the signal gate: pid ≤ 1, Kriyon itself, or one of its ancestors.
- A process, socket, file or watcher started with no matching stop on every exit path,
  including the error path.
- A path where a closed or archived session leaves its processes running, or where quit waits
  on a slow child.
- A loop, retry or wait with no ceiling.

## Files and the sandbox — `sandbox.rs`, `file_cmd.rs`, `entry_cmd.rs`, git commands

ADR 0021.

- Lexical path maths (`join`, string prefix checks) instead of canonicalising through
  `SandboxRoot`. A new path's parent is canonicalised; only its leaf is validated as a name.
- A path that skipped validation turned into a type other code can hold (`PathBuf`,
  `String`) and passed to git or the filesystem.
- Deleting instead of moving to Trash; a save that drops file permissions or truncates on
  failure.
- A git command built from user input without `--` before paths.

## Saved data — the store, settings, anything persisted

- A stored field renamed or removed, or its meaning changed, within one minor release. A
  downgrade to the previous minor must still read it. Add fields; remove them a release later.
- A new stored value with no default for data written by an older version.

## Public text — root `*.md`, `docs/`, `website/`, `.github/`, user-facing strings, tests and fixtures

This repository is public. Everything committed is published.

- A client or customer name, a real home path (`/Users/<name>`), a real Team ID, account id,
  session id, or an email that is not a LeafyCode address. Use `acme`, `globex`, `Initech`,
  `/Users/you`.
- Another product named in a bug story or comparison.
- Commentary on the legal risk of Anthropic's terms. State Kriyon's plain rules instead (ADR
  0030).
- A claim about what Kriyon does that the code does not back: a feature, a requirement, a
  version, a command, a path or a link. Check it against the code, the scripts and the config.
- A link to something private: a private repo, an internal doc, a claude.ai artifact.

## GitHub workflows — `.github/workflows/`

- A workflow or job without least-privilege `permissions` (start from `{}` or
  `contents: read`, grant per job).
- An action not pinned to a full commit SHA with a version comment.
- `pull_request_target`, or a fork pull request reaching a secret or a write token.
- `${{ github.event.* }}` or another user-controlled value expanded straight into a `run:`
  script. Pass it through `env:` instead.
- A bot that closes, labels or comments on more than its comment says it does.

## Docs and decisions

- A new module or type named with a term that is not in the glossary (`CONTEXT.md`).
- A notable decision (a new boundary, a reversed ADR, a heavy new dependency) with no ADR in
  `docs/adr/`.

## Structure — anywhere

Reuse before adding; keep a module worth its interface.

- A function, component, type or constant copied instead of imported. Name the other copy,
  with its path. Without that there is no finding.
- One decision written in two places that now have to stay in sync: two constants for one
  timeout, a rule in Rust and again in TypeScript. Check the sibling before you accept a
  changed number.
- A new trait, interface or injected dependency with exactly one implementation and no test
  double. `SessionEngine` is the documented exception (ADR 0013).
- A seam that exists only so a test can reach in.
- A helper every caller has to remember to call.
- A module whose interface is as hard to understand as the code inside it. Apply the deletion
  test.

Raise these on any pass that adds a file, changes an export, moves a decision or adds a seam.
Only for code this pull request touches, and only when you can point at the duplicate, the
caller or the sibling. "This could be cleaner" is not a finding.

## Errors — anywhere

- An empty `catch`, a `.catch(() => {})`, or a catch whose only job is to return a default,
  so the caller believes it worked.
- A Rust `Result` thrown away with `let _ =` or `.ok()` where the failure matters.
- A failure the user is never told about, on an action they started.
- A `TODO`, commented-out block or debug output left in a shipping path.

## What the change left behind — anywhere

A change that moves a decision usually leaves its old home standing.

- The module, command or bridge function it replaced is still there with no callers. `grep`
  the old name.
- A stored value under an old key that is never read or migrated, so a saved setting
  silently resets.
- A comment, doc or `FEATURES.md` line that still describes what was removed.
- A test that still mocks a module the code no longer imports.

## Tests

TDD is the rule. A test that cannot fail is not coverage.

- New behaviour with no test: a new command, a new stored field, a new state transition, a
  new parser case.
- A test that would still pass with the fix reverted.
- A fixture that skips the new field, so the new branch never runs.
- Pure logic tested through the Tauri shell when it could be tested in `kriyon-core`.
- A test that reads the real home folder, the real `~/.claude`, or the network.
