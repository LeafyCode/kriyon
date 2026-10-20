# ADR 0006 — The Rust↔JS IPC error seam stays String-typed

**Date:** 2026-07-04
**Status:** Accepted

## Context

Every Tauri command returns `Result<T, String>`: the typed errors that exist
inside `kriyon-core` (`EngineError`, `StoreError`, both `thiserror` enums) are
flattened with `.map_err(|e| e.to_string())` at the command boundary. An
architecture review flagged this as "typed errors destroyed at the seam" and
proposed a serializable `CommandError` enum shared across the IPC boundary so
the frontend could branch on error *kind* rather than on message text.

Before adopting that, we checked who actually consumes a command error on the
frontend. Every call site does one of two things:

- **Ignores it** — the fire-and-forget `promise.catch(() => {})` pattern used for
  all non-fatal IPC (persistence, stdin writes, drained reports, …), or
- **Displays the message as a string** — `ReviewPanel` is the only place that
  surfaces an error to the user, via `e instanceof Error ? e.message : String(e)`,
  straight into a toast/inline label.

No frontend code inspects an error's kind — no `err.kind`, no message
string-matching, no `instanceof` on a typed error. There is exactly **one
adapter** at this seam (string display).

## Decision

Keep the IPC error seam String-typed. Do **not** introduce a `CommandError` enum
across the boundary until a frontend caller genuinely needs to branch on error
kind.

This follows two rules the project already holds:

- **One adapter means a hypothetical seam; two means a real one.** A typed error
  the frontend immediately flattens back to a string for display is a seam with
  no second adapter — a premature abstraction.
- **YAGNI** (`AGENTS.md`): don't add an abstraction for one caller. Threading a
  typed error through all ~34 commands and the bridge, only to `.toString()` it
  at the single display site, is ceremony without leverage.

`kriyon-core` keeps its typed errors (`EngineError`, `StoreError`) — they earn
their keep *inside* the core, where code does branch on them. Only their
projection across the command boundary is a String.

## Consequences

- The command surface stays uniform and simple: `Result<T, String>`.
- **Revisit trigger:** the first time the frontend needs to react differently to
  a *kind* of failure — e.g. "session id invalid" → re-sync the store vs.
  "daemon unreachable" → offer a retry — introduce a serializable `CommandError`
  for exactly the commands and kinds that caller distinguishes, not all of them.
  That is a real (two-adapter) seam and worth the typing then.
- Future architecture reviews should not re-suggest a blanket typed-error seam
  without a concrete branching consumer.

## Addendum, 2026-08-30 — Command failure kind

The revisit trigger above — "the frontend needs to react differently to a
*kind* of failure" — has now fired **four times**, independently, each
growing its own hand-synced prefix or substring pair on both sides of the
IPC boundary:

| Kind | Rust constant (`git_cmd.rs` / `file_cmd.rs`) | Frontend match (before) |
|---|---|---|
| a pruned [Session baseline] object | `BASELINE_OBJECT_MISSING_PREFIX` | `startsWith` |
| an over-[Working-tree budget] tree | `WORKING_TREE_TOO_LARGE_PREFIX` | `startsWith` |
| a `write_file` save conflict | `WRITE_CONFLICT_ERROR` | case-insensitive `includes` |
| a deleted file (read or write) | `WRITE_MISSING_ERROR` | case-insensitive `includes` |

Four adapters, two different matching disciplines, no shared codegen across
the boundary — exactly the "real seam" this ADR's decision rule (two or more
adapters) says is worth typing. But a full `CommandError` enum crossing
**every** command is still more than these four cases justify: the
overwhelming majority of command failures are still the ADR's original
"ignore or display as a string" shape, and only these four are ever branched
on.

**Decision: a leader, not an enum.** Rust's `tagged_failure(kind, message)`
(`crates/kriyon-core/src/failure.rs`) prepends one format,
`"kind:<slug>: <message>"`, to exactly these four kinds, at the five error
sites that produce them (`overBudget` tags twice — `snapshot_tree`'s file-
and byte-ceiling refusals both return the same kind) — the human wording
(`message`) is unchanged, byte-identical to what each site already
returned. `src/ipc/failures.ts` is the one classifier on the TS side:
`commandFailure(err): FailureKind` reads the leader's slug (`"unknown"` for
anything untagged), and `failureMessage(err)` strips it for display. The four
`is*Error` helpers (`isMissingBaselineObjectError`,
`isWorkingTreeTooLargeError` in `state/changes.ts`; `isConflictError`,
`isMissingFileError` in `changes/useFileEditorSession.ts`) became thin
wrappers over `commandFailure`, so their call sites and exports didn't churn.

This keeps the ADR's core decision intact: the IPC seam is still
`Result<T, String>` — the "kind" lives *inside* the string as a parseable
leader, not as a new field or a serialized enum crossing the boundary. Every
failure that isn't one of these four stays a plain, untagged string exactly
as the original decision describes; this is not a reversal, just a scoped
answer to the trigger firing four times over instead of once.

**Revisit trigger, updated:** a fifth kind the frontend needs to branch on
adds a slug to `KIND_BY_SLUG` (`src/ipc/failures.ts`) and a `tagged_failure`
call at its Rust site — not a new hand-rolled prefix. If a future kind needs
to carry *structured* data (not just a message string), that's the point to
revisit this decision properly, the same way `BudgetExceeded` already crosses
as real structured JSON on `SessionDiff` rather than being shoehorned into an
error string.
