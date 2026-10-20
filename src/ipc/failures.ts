/**
 * Classifies a Rust IPC command failure by declared *kind*, not by
 * re-matching (or mis-matching) its human-readable wording.
 *
 * ADR-0006 (`docs/adr/0006-string-typed-ipc-error-seam.md`) keeps the
 * Rust↔TS IPC error seam `Result<T, String>` — no typed error enum crosses
 * the boundary — but names "the frontend needs to react differently to a
 * kind of failure" as the trigger to revisit that. It fired four times,
 * independently, each growing its own hand-synced prefix/substring pair on
 * both sides of the boundary: a pruned [Session baseline] object and an
 * over-[Working-tree budget] tree (`git_cmd.rs`'s
 * `BASELINE_OBJECT_MISSING_PREFIX`/`WORKING_TREE_TOO_LARGE_PREFIX`, matched
 * via `startsWith`), and a `write_file` save conflict and a deleted file
 * (`file_cmd.rs`'s `WRITE_CONFLICT_ERROR`/`WRITE_MISSING_ERROR`, matched via
 * case-insensitive `includes`). This module is that revisit: Rust's
 * `tagged_failure` (`crates/kriyon-core/src/failure.rs`) prepends every one
 * of the four with ONE leader format, `"kind:<slug>: "`, and this is the ONE
 * classifier on this side — a fifth recoverable kind adds a slug and a case
 * arm instead of a new hand-rolled prefix. Every OTHER failure — the ones
 * the frontend has no differentiated reaction to — stays a plain, untagged
 * string; this is not a general typed-error migration, just the four cases
 * that already proved they need one.
 */

/** The recoverable failure kinds the frontend reacts to differently — see
 * the module doc comment. `"unknown"` covers every other failure, including
 * every plain, untagged error string, which is the overwhelming majority:
 * recoverable-kind tagging is the exception, not the rule. */
export type FailureKind =
  | "baselinePruned"
  | "overBudget"
  | "saveConflict"
  | "fileMissing"
  | "outsideRoots"
  | "unknown";

/** Rust's `tagged_failure` slugs, mapped to their {@link FailureKind}. The
 * Rust side (`tagged_failure`'s call sites in `git_cmd.rs`/`file_cmd.rs`) is
 * the source of truth for the slug spelling.
 *
 * A `switch`, not a `Record<string, FailureKind>` object-literal lookup
 * table: a plain object lookup on an attacker- or test-controlled key walks
 * the prototype chain — `{}["constructor"]` resolves to `Object`, a
 * function, not `undefined` — so a `table[slug] ?? "unknown"` shape would
 * return that function for `kind:constructor: …`, silently violating this
 * function's own `FailureKind` return type (see the `kind:constructor:`
 * case in `failures.test.ts`). `switch` does plain string equality only. */
function kindForSlug(slug: string): FailureKind {
  switch (slug) {
    case "baseline-pruned":
      return "baselinePruned";
    case "file-missing":
      return "fileMissing";
    case "over-budget":
      return "overBudget";
    case "outside-roots":
      return "outsideRoots";
    case "save-conflict":
      return "saveConflict";
    default:
      return "unknown";
  }
}

/** Matches Rust's `tagged_failure` leader, `"kind:<slug>: "`, anchored to
 * the very start of the message — a message that merely mentions "kind:"
 * further in must not be mistaken for one. Captures the slug so
 * {@link commandFailure} can look it up and {@link failureMessage} can find
 * where the leader ends. */
const LEADER = /^kind:([a-z-]+): /;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Classify a caught IPC failure by its {@link FailureKind}. `err` is
 * whatever a rejected `invoke()` throws — an `Error` whose `message` is the
 * backend's raw string in production, or (in a test, or a non-Error throw)
 * the string itself; either is accepted identically. Returns `"unknown"`
 * for anything not tagged with Rust's `tagged_failure` leader.
 */
export function commandFailure(err: unknown): FailureKind {
  const match = LEADER.exec(messageOf(err));
  return match ? kindForSlug(match[1]) : "unknown";
}

/**
 * The human-visible half of a caught IPC failure, with Rust's
 * `tagged_failure` leader stripped when present — what a banner should
 * actually display. A plain, untagged message passes through unchanged, so
 * this is always safe to call regardless of what {@link commandFailure}
 * returns for the same `err`.
 */
export function failureMessage(err: unknown): string {
  const message = messageOf(err);
  const match = LEADER.exec(message);
  return match ? message.slice(match[0].length) : message;
}
