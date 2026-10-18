//! One home for the failure-tagging convention `git_cmd.rs` and `file_cmd.rs`
//! both need — see the ADR-0006 addendum
//! (`docs/adr/0006-string-typed-ipc-error-seam.md`).
//!
//! ADR-0006 keeps the Rust↔TS IPC error seam `Result<T, String>`: no typed
//! error enum crosses the boundary. Its stated revisit trigger — "the
//! frontend needs to react differently to a *kind* of failure" — has now
//! fired four times, independently: a pruned [Session baseline] object, an
//! over-[Working-tree budget] tree, a `write_file` save conflict, and a
//! deleted file. Each grew its own hand-synced prefix constant
//! (`BASELINE_OBJECT_MISSING_PREFIX`, `WORKING_TREE_TOO_LARGE_PREFIX`,
//! `WRITE_CONFLICT_ERROR`, `WRITE_MISSING_ERROR`) matched on the TS side with
//! two different disciplines (`startsWith` for the git pair,
//! case-insensitive `includes` for the file pair).
//!
//! [`tagged_failure`] replaces that pattern with ONE leader format,
//! `"kind:<slug>: "`, that every recoverable error site prepends to its
//! existing (unchanged) human-readable message. `src/ipc/failures.ts`'s
//! `commandFailure`/`failureMessage` are the one classifier on the TS side —
//! a fifth recoverable kind now costs a slug and a match arm on each side,
//! not a new hand-rolled prefix. Every OTHER command failure — the ones the
//! frontend has no differentiated reaction to — stays untagged, a plain
//! string; this is deliberately not a general typed-error migration.

/// Tag `message` with `kind` in the one format both `git_cmd.rs` and
/// `file_cmd.rs`'s recoverable error sites use, and `src/ipc/failures.ts`'s
/// `commandFailure`/`failureMessage` parse: `"kind:<slug>: <message>"`.
///
/// `message` keeps its current wording byte-identical — this only prepends a
/// leader, so `failureMessage(err)` on the TS side reproduces exactly what
/// used to be the whole error string, and every banner/test asserting that
/// display text keeps passing unchanged.
#[must_use]
pub fn tagged_failure(kind: &str, message: &str) -> String {
    format!("kind:{kind}: {message}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn produces_the_kind_colon_slug_colon_space_message_leader() {
        assert_eq!(
            tagged_failure("save-conflict", "file changed on disk since it was opened"),
            "kind:save-conflict: file changed on disk since it was opened"
        );
    }

    #[test]
    fn preserves_the_message_byte_identically() {
        // The whole point: a caller migrating an existing untagged error to
        // `tagged_failure` must not have to touch its wording, or any
        // existing test/banner asserting that wording breaks. Modeled on the
        // real `snapshot_tree` over-budget message (git_cmd.rs): the
        // `WORKING_TREE_TOO_LARGE_PREFIX` text is part of the message this
        // site tags, not a separate detail tacked on afterward.
        let message =
            "working tree too large: over 10000 untracked files (including opt/, vendor/)";
        let tagged = tagged_failure("over-budget", message);
        assert!(tagged.ends_with(message));
    }
}
