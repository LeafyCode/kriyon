//! The per-[Session] lifecycle in [`AppState`]: what a session owns, when it
//! starts owning it, and the one call that releases all of it.
//!
//! [`AppState`] keys several structures by [`SessionId`] — the [Daemon client],
//! the watch, the [Session runtime], the [Sleep ledger], the [Resource sweep],
//! and the two marks that referee an overlapping create and close. They are
//! filled from four different places and in no fixed order: a create registers
//! a client, [Daemon adoption] registers one for a session nobody has opened,
//! a hook signal creates a runtime for a session with no client at all, and the
//! watch subscribes its own.
//!
//! Releasing them was a hand-written checklist at the one close site, each line
//! carrying its own comment about why it had to be there and nothing keeping
//! the list complete. This module is that list's single home, so "what does a
//! session own" has one answer and one test rather than a review.
//!
//! **The locks stay fine-grained.** `AppState` documents that no two of its
//! locks are ever held at once and that the engine is `Arc`-wrapped so a
//! blocking socket write happens with every lock released; one coarse lock over
//! all of it would put a wedged daemon in front of every status read. So this
//! is a lifecycle module, not a gatekeeper: the read paths still take the one
//! lock they need, directly.

use kriyon_core::runtime::SessionRuntime;
use kriyon_core::session::SessionId;

use crate::{AppState, Session};

/// Marks `id`'s `create_session` as in flight for as long as it lives, and
/// clears the mark however the create returns — including on an early `?`.
///
/// This is the window in which a close and a create can disagree about whether
/// the session exists, and it is the only window in which a close leaves a mark
/// for the create to read.
pub(crate) struct CreateInFlight<'a> {
    state: &'a AppState,
    id: SessionId,
}

impl<'a> CreateInFlight<'a> {
    pub(crate) fn begin(state: &'a AppState, id: &SessionId) -> Self {
        state.creating.lock().insert(id.clone());
        Self {
            state,
            id: id.clone(),
        }
    }
}

impl Drop for CreateInFlight<'_> {
    fn drop(&mut self) {
        self.state.creating.lock().remove(&self.id);
    }
}

/// A close landed; tell the create still spawning this session's daemon that
/// its row is gone, so it stops the daemon rather than registering a client for
/// a session nothing owns.
///
/// Only while a create is actually in flight. A mark nobody will ever read is a
/// leak — closing a restored row whose pane never mounted is the common case,
/// and it used to add one id per close for the life of the process.
pub(crate) fn note_close_during_create(state: &AppState, id: &SessionId) {
    if state.creating.lock().contains(id) {
        state.closed_mid_create.lock().insert(id.clone());
    }
}

/// Give `id` a [Session runtime] if it has none, so the sidebar shows an Idle
/// dot the moment the row exists rather than waiting for the first hook.
///
/// Two paths need this — the watch subscribing, and a hook signal arriving for
/// a session whose pane never mounted — and both used to write
/// `.entry(id).or_default()` themselves.
pub(crate) fn ensure_runtime(state: &AppState, id: &SessionId) {
    state.runtimes.lock().entry(id.clone()).or_default();
}

/// Run `f` against `id`'s [Session runtime], creating it if this is the first
/// signal for the session. The lock is held only for the call.
pub(crate) fn with_runtime<T>(
    state: &AppState,
    id: &SessionId,
    f: impl FnOnce(&mut SessionRuntime) -> T,
) -> T {
    let mut runtimes = state.runtimes.lock();
    f(runtimes.entry(id.clone()).or_default())
}

/// Release every in-memory structure `id` owns, and hand back its [Daemon
/// client] if one was registered.
///
/// One place, so a close can never release five of six. The order is
/// load-bearing only at the head: telling a create in flight that its row is
/// gone happens *before* anything is read or removed, whatever the session map
/// holds — a sink-less client left by [Daemon adoption] is not evidence that no
/// create is running.
///
/// The persisted sleep mark and the menu-bar badge need the app handle and stay
/// with the close command.
pub(crate) fn forget(state: &AppState, id: &SessionId) -> Option<Session> {
    note_close_during_create(state, id);
    // Dropping the watcher stops its notify watch — and with it the session's
    // [Background shell] bookkeeping, which lives inside it.
    state.watchers.lock().remove(id);
    state.runtimes.lock().remove(id);
    crate::handoff_rt::forget(state, id);
    state.bridged.lock().remove(id);
    // Sleep bookkeeping dies with the session; a stale mark would otherwise
    // greet a future session that reused the id. One call clears every phase.
    state.sleep.lock().forget(&id.0);
    state.memory.lock().forget(&id.0);
    state.sessions.lock().remove(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon_client::DaemonClient;
    use std::os::unix::net::UnixStream;
    use std::path::Path;

    /// A [Daemon client] attached to a fake daemon, standing in for what
    /// [Daemon adoption] leaves in the session map. The returned guard keeps
    /// the fake daemon alive for the length of the test.
    fn adopted_session(
        dir: &Path,
        id: &SessionId,
    ) -> (Session, std::sync::Arc<std::sync::Mutex<u32>>) {
        let socket = dir.join("s.sock");
        let daemon = crate::daemon_client::test_support::spawn_greeting_daemon(&socket);
        let stream = UnixStream::connect(&socket).expect("connect");
        let engine = DaemonClient::adopt(stream, id.clone()).expect("client");
        (
            Session {
                engine: std::sync::Arc::new(engine),
                zdotdir: None,
            },
            daemon,
        )
    }

    /// The race the mark exists for: a close lands while `create_session` is
    /// still spawning a daemon. Whichever finishes second must not resurrect a
    /// row the user already deleted.
    #[test]
    fn a_close_during_a_create_marks_it_however_the_session_map_looks() {
        let state = AppState::default();
        let id = SessionId("s1".into());

        let in_flight = CreateInFlight::begin(&state, &id);
        note_close_during_create(&state, &id);
        assert!(
            state.closed_mid_create.lock().contains(&id),
            "the create must be told its row is gone"
        );
        drop(in_flight);
    }

    /// The regression: [Daemon adoption] puts a sink-less client in `sessions`
    /// for every owned id at launch, so keying the mark on "the close found no
    /// client" missed the race entirely — the create then registered a client
    /// for a deleted row, and that phantom entry kept the id looking owned, so
    /// no orphan sweep would ever touch it.
    #[test]
    fn an_adopted_client_does_not_hide_the_race_from_the_close() {
        let state = AppState::default();
        let id = SessionId("s1".into());
        let _in_flight = CreateInFlight::begin(&state, &id);
        let dir = tempfile::tempdir().expect("tmp dir");
        let (session, _daemon) = adopted_session(dir.path(), &id);
        state.sessions.lock().insert(id.clone(), session);

        let found = forget(&state, &id);

        assert!(found.is_some(), "the adopted client is released");
        assert!(
            state.closed_mid_create.lock().contains(&id),
            "a client in the map is not evidence that no create is in flight"
        );
    }

    /// And the leak the mark used to cause: closing a restored row nobody ever
    /// opened set a mark no create would ever read. Close ten and ten ids sat
    /// there for the life of the process.
    #[test]
    fn forget_drops_the_companion_bridge_mark() {
        let state = AppState::default();
        let id = SessionId("s1".into());
        state.bridged.lock().insert(id.clone());

        forget(&state, &id);

        assert!(
            !state.bridged.lock().contains(&id),
            "a reused id starts unbridged"
        );
    }

    #[test]
    fn closing_a_row_with_no_create_in_flight_leaves_no_mark() {
        let state = AppState::default();
        let id = SessionId("s1".into());

        note_close_during_create(&state, &id);

        assert!(
            state.closed_mid_create.lock().is_empty(),
            "a mark nobody will read is a leak, not a guard"
        );
    }

    #[test]
    fn a_finished_create_is_no_longer_in_flight() {
        let state = AppState::default();
        let id = SessionId("s1".into());
        {
            let _in_flight = CreateInFlight::begin(&state, &id);
            assert!(state.creating.lock().contains(&id));
        }
        assert!(
            state.creating.lock().is_empty(),
            "the window closes however the create returned"
        );
    }

    /// Everything a session owns goes in one call, so a close can never
    /// release five of six.
    #[test]
    fn forgetting_a_session_releases_every_structure_it_owns() {
        let state = AppState::default();
        let id = SessionId("s1".into());
        let dir = tempfile::tempdir().expect("tmp dir");
        let (session, _daemon) = adopted_session(dir.path(), &id);
        state.sessions.lock().insert(id.clone(), session);
        ensure_runtime(&state, &id);
        state.sleep.lock().note_running_shells(&id.0, true);
        {
            let mut sweep = state.memory.lock();
            sweep.per_session.insert(
                id.0.clone(),
                kriyon_core::memory::SessionResources {
                    memory_mb: 512,
                    cpu_pct: None,
                },
            );
            sweep.total_mb = 512;
        }

        forget(&state, &id);

        assert!(state.sessions.lock().is_empty(), "the client");
        assert!(state.runtimes.lock().is_empty(), "the runtime");
        assert!(state.watchers.lock().is_empty(), "the watch");
        assert!(
            !state.sleep.lock().has_running_shells(&id.0),
            "the sleep ledger"
        );
        assert_eq!(state.memory.lock().total_mb, 0, "the footprint sweep");
    }

    #[test]
    fn a_runtime_is_created_once_and_then_reused() {
        let state = AppState::default();
        let id = SessionId("s1".into());

        ensure_runtime(&state, &id);
        with_runtime(&state, &id, SessionRuntime::note_exited);
        ensure_runtime(&state, &id);

        assert!(
            with_runtime(&state, &id, |runtime| runtime.exited()),
            "a second ensure must not replace the runtime"
        );
    }
}
