//! Per-session daemon discovery helpers: socket-path derivation and the
//! session-id validation that gates it (the path-containment trust boundary).
//!
//! Kriyon session ids cross the Rust↔JS boundary, so before one is interpolated
//! into a socket path it must be proven safe — non-empty and only the characters
//! a UUID uses — so it can never traverse or escape the run directory.

use std::path::{Path, PathBuf};

/// `true` if `id` is safe to interpolate into a [Session socket] path: non-empty
/// and only ASCII alphanumerics or `-` (Kriyon ids are UUIDs). Rejects anything
/// that could traverse (`..`, `/`) or otherwise escape the run directory.
#[must_use]
pub fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// [`is_valid_session_id`] as a check for an IPC command: the one error text
/// every command returns for a bad id.
///
/// # Errors
/// When `id` is not a valid session id.
pub fn check_session_id(id: &str) -> Result<(), String> {
    if is_valid_session_id(id) {
        Ok(())
    } else {
        Err("invalid session id".to_string())
    }
}

/// The bundle identifier of the released app, whose run dir is the historical
/// `run`.
const RELEASED_IDENTIFIER: &str = "com.leafycode.kriyon";

/// The name of the run directory (under `~/.claude/kriyon/`) for the app with
/// this bundle `identifier`, or `None` for one that is not a plain identifier.
///
/// One run dir per app identity, because each identity has its own store. A
/// build with a different identifier (the smoke app) owns none of the released
/// app's session rows; in a shared run dir each build's [Orphan daemon] reaper
/// would see the other's live sessions as unowned and stop them. The released
/// identifier keeps `run`, so an update still finds the daemons its predecessor
/// left running.
#[must_use]
pub fn run_dir_name(identifier: &str) -> Option<String> {
    let plain = !identifier.is_empty()
        && identifier != ".."
        && identifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_');
    if !plain {
        return None;
    }
    Some(if identifier == RELEASED_IDENTIFIER {
        "run".to_string()
    } else {
        format!("run-{identifier}")
    })
}

/// Whether this instance may send `Shutdown` down a connection it holds.
///
/// A [PTY daemon] serves one client at a time; any other connection waits in its
/// accept backlog, and a frame written there is read later — whenever the real
/// client next lets go. So a `Shutdown` from an instance that is *not* the
/// daemon's client is a delayed kill of someone else's live session: it lands
/// the next time that session's owner reloads, or first opens it.
///
/// Two instances on one [Run dir] is a real workflow — a dev build beside the
/// installed app shares its identifier, store and run dir. So:
/// - the instance that owns the run dir (holds its lock) is the only one that
///   adopts, so every connection it holds really is the daemon's client, and it
///   may always stop — including a daemon too old to greet its client;
/// - any other instance may stop only a connection the daemon has *proven*
///   accepted, by greeting it. One still queued behind the owner's is let go of
///   silently.
#[must_use]
pub const fn may_stop_held(owns_run_dir: bool, connection_accepted: bool) -> bool {
    owns_run_dir || connection_accepted
}

/// Whether a create may bind a fresh [PTY daemon] to a [Session socket] it
/// could not reach.
///
/// Binding unlinks the path first, so taking one a live daemon still holds
/// strands it for good: unreachable, unreapable (its id is owned, so no
/// [Orphan daemon] sweep will touch it) and still holding a `claude` tree. ADR
/// 0022 states the rule — never unlink a live daemon's socket — and this is
/// where it is decided.
///
/// Unreachable is never proof the daemon is gone; only the sweep is. So a
/// create refuses the path while a daemon for the id is alive and this instance
/// may not retire it (a dev build beside the installed app, which shares its
/// [Run dir] but must never reach into its sessions). The owner retires the
/// daemon first, and then there is nothing left to strand.
#[must_use]
pub const fn may_bind_session_socket(daemon_alive: bool, may_retire: bool) -> bool {
    !daemon_alive || may_retire
}

/// The session's socket path inside `run_dir`, or `None` if `id` is invalid.
#[must_use]
pub fn session_socket_path(run_dir: &Path, id: &str) -> Option<PathBuf> {
    if is_valid_session_id(id) {
        Some(run_dir.join(format!("{id}.sock")))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn a_live_daemons_socket_is_never_taken_by_an_instance_that_may_not_retire_it() {
        // Binding unlinks the path, so taking it strands the daemon already
        // there: unreachable for good, still holding a claude tree, and owned
        // by an id the reaper will therefore never touch (ADR 0022, "Never
        // unlink a live daemon's socket").
        assert!(
            !may_bind_session_socket(true, false),
            "a dev build beside the installed app must refuse, not take it"
        );
        // The owner may: it retires the daemon first, then binds.
        assert!(may_bind_session_socket(true, true));
        // Nothing is there, so there is nothing to strand.
        assert!(may_bind_session_socket(false, false));
        assert!(may_bind_session_socket(false, true));
    }

    #[test]
    fn only_the_run_dir_owner_may_stop_a_connection_the_daemon_never_accepted() {
        // The owner: always, even a daemon too old to greet.
        assert!(may_stop_held(true, false));
        assert!(may_stop_held(true, true));
        // A second instance: only what the daemon proved is its client. A
        // connection still queued behind the owner's must never carry Shutdown —
        // it would be read, and obeyed, the next time the owner lets go.
        assert!(may_stop_held(false, true));
        assert!(!may_stop_held(false, false));
    }

    #[test]
    fn the_released_app_keeps_its_run_dir_and_every_other_build_gets_its_own() {
        // The released identifier must keep the historical path, or an update
        // could never reattach to the daemons the previous version left running.
        assert_eq!(run_dir_name("com.leafycode.kriyon").as_deref(), Some("run"));
        // Any other build (the smoke app) has its own database, so it owns none
        // of the released app's sessions. Sharing a run dir would let each
        // build's orphan reaper stop the other's live sessions.
        assert_eq!(
            run_dir_name("com.leafycode.kriyon.smoke").as_deref(),
            Some("run-com.leafycode.kriyon.smoke")
        );
    }

    #[test]
    fn an_identifier_that_could_escape_the_kriyon_dir_gets_no_run_dir() {
        for bad in ["", "../evil", "a/b", "a b", ".."] {
            assert_eq!(run_dir_name(bad), None, "{bad:?} must be refused");
        }
    }

    #[test]
    fn valid_ids_accepted_traversal_rejected() {
        assert!(is_valid_session_id("a1b2-c3d4"));
        assert!(is_valid_session_id("0e8f9a2b-1c3d-4e5f-8a9b-0c1d2e3f4a5b"));
        assert!(!is_valid_session_id(""));
        assert!(!is_valid_session_id("../etc/passwd"));
        assert!(!is_valid_session_id("a/b"));
        assert!(!is_valid_session_id("a.b"));
        assert!(!is_valid_session_id("a b"));
    }

    #[test]
    fn socket_path_built_only_for_valid_id() {
        let run = Path::new("/run/kriyon");
        assert_eq!(
            session_socket_path(run, "abc-123"),
            Some(run.join("abc-123.sock"))
        );
        assert_eq!(session_socket_path(run, "../x"), None);
        assert_eq!(session_socket_path(run, ""), None);
    }
}
