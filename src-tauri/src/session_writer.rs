//! One writer per session (plan Step C): every write and resize that reaches
//! a session's PTY passes its [`SessionGate`], under the gate's lock, so the
//! check and the write are one step. The desktop writes as the host; a remote
//! device's input will be a second caller, rechecked here.
//!
//! Lock order, outermost first: a session's gate → `Serve`'s control map
//! (`kriyon_remote_link::host_runtime`) → a device's `ControlOut` queue. A change of [Typing
//! control] is told to the hook ([`Writers::on_change`]) under the gate's
//! lock, so devices hear changes in epoch order; the hook only queues for
//! the devices and never calls back into these writers (or the app), which
//! would take a gate lock again. A gate's lock is never held while taking
//! the sessions lock, and the gates map's lock is held only to find or drop
//! a gate.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use kriyon_core::session::{SessionEngine, SessionId};
use kriyon_remote::authorize::{Dialog, PendingWrite};
use kriyon_remote::control::{Change, Control, HostIsTyping};
use kriyon_remote::message::{EndpointId, RefuseReason, Role};
use kriyon_remote::writer::{HostTook, SessionGate};
use parking_lot::Mutex;

pub(crate) use kriyon_remote::writer::DEFAULT_SCREEN;

/// Every live session's gate, made on first use and dropped with the session
/// ([`crate::session_registry::forget`]).
pub struct Writers {
    /// Random per app start, so a control epoch never repeats across starts.
    host_boot_id: u64,
    gates: Mutex<HashMap<SessionId, Arc<Mutex<SessionGate>>>>,
    /// Told every change of [Typing control] (see [`Writers::on_change`]).
    on_change: Mutex<Option<OnChange>>,
    /// Devices removed or made Viewers since they connected: what every
    /// check reads, so a connection's role never outlives the person's
    /// change (spec §4, §8).
    revoked: Mutex<HashMap<EndpointId, Revoked>>,
}

/// What the person changed about a paired device while it may be connected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Revoked {
    /// No longer paired.
    Removed,
    /// Its role is now this, at most.
    Demoted(Role),
}

/// What hears a change of [Typing control].
type OnChange = Arc<dyn Fn(&SessionId, Change) + Send + Sync>;

/// One session's gate as the host's one check sees it, copied out from under
/// its lock.
#[derive(Clone, Debug)]
pub struct GateFacts {
    pub run: u64,
    pub control: Control,
    pub dialog: Dialog,
    pub size: (u16, u16),
}

impl Default for Writers {
    fn default() -> Self {
        // Any OS-random u64 does; the key generator is the random source the
        // app already has.
        let random = kriyon_remote_link::endpoint::generate_secret_key();
        let mut boot = [0_u8; 8];
        boot.copy_from_slice(&random[..8]);
        Self {
            host_boot_id: u64::from_le_bytes(boot),
            gates: Mutex::new(HashMap::new()),
            on_change: Mutex::new(None),
            revoked: Mutex::new(HashMap::new()),
        }
    }
}

impl Writers {
    fn gate(&self, id: &SessionId) -> Arc<Mutex<SessionGate>> {
        Arc::clone(self.gates.lock().entry(id.clone()).or_insert_with(|| {
            Arc::new(Mutex::new(SessionGate::new(
                self.host_boot_id,
                DEFAULT_SCREEN,
            )))
        }))
    }

    /// `device`'s role now: what its connection was made with, never more
    /// than the person has left it since. `None`: not paired.
    #[must_use]
    pub fn role_now(&self, device: &EndpointId, connected: Option<Role>) -> Option<Role> {
        let rank = |role: Role| match role {
            Role::Viewer => 0,
            Role::Controller => 1,
        };
        match self.revoked.lock().get(device) {
            None => connected,
            Some(Revoked::Removed) => None,
            Some(Revoked::Demoted(to)) => connected.map(|connected| {
                if rank(*to) < rank(connected) {
                    *to
                } else {
                    connected
                }
            }),
        }
    }

    /// The person removed `device`, or lowered its role: from now on every
    /// check sees it, and no write that began before this one returns can
    /// still land (each gate is passed through once, so a write holding one
    /// finishes first). Then close its connection, then release its
    /// control (spec §4).
    pub fn revoke(&self, device: EndpointId, revoked: Revoked) {
        self.revoked.lock().insert(device, revoked);
        let gates: Vec<_> = self.gates.lock().values().map(Arc::clone).collect();
        for gate in gates {
            drop(gate.lock());
        }
    }

    /// `device` was paired again, or given back its role: its connections
    /// are trusted with the role they are made with.
    pub fn unrevoke(&self, device: &EndpointId) {
        self.revoked.lock().remove(device);
    }

    /// Make sure session `id` has a gate. For tests.
    #[cfg(test)]
    pub(crate) fn ensure(&self, id: &SessionId) {
        self.gate(id);
    }

    /// Whether session `id` has a gate. For tests.
    #[cfg(test)]
    pub(crate) fn has_gate(&self, id: &SessionId) -> bool {
        self.gates.lock().contains_key(id)
    }

    /// A device's typing into session `id`: checked again under the gate's
    /// lock, atomically with the write. `Ok(written)` says whether the bytes
    /// reached the PTY (`InputAck`).
    ///
    /// # Errors
    /// Why it was refused; nothing is written.
    pub fn device_input(
        &self,
        id: &SessionId,
        engine: &dyn SessionEngine,
        device: &EndpointId,
        role: Option<Role>,
        write: &PendingWrite,
        bytes: &[u8],
    ) -> Result<bool, RefuseReason> {
        let gate = self.gate(id);
        let mut gate = gate.lock();
        // The role now, read under the gate's lock: a revoke passes through
        // this lock, so it lands before or after this whole write.
        let role = self.role_now(device, role).ok_or(RefuseReason::NotPaired)?;
        gate.device_write(device, Some(role), write, None)?;
        Ok(engine.write_stdin(bytes).is_ok())
    }

    /// A device's resize of session `id`, checked again like its typing.
    /// `Ok(resized)` says whether the PTY took it.
    ///
    /// # Errors
    /// Why it was refused; nothing is resized.
    pub fn device_resize(
        &self,
        id: &SessionId,
        engine: &dyn SessionEngine,
        device: &EndpointId,
        role: Option<Role>,
        write: &PendingWrite,
        size: (u16, u16),
    ) -> Result<bool, RefuseReason> {
        let gate = self.gate(id);
        let mut gate = gate.lock();
        // Checked first, and the size made the session's only once the PTY
        // took it, all under the one lock.
        let role = self.role_now(device, role).ok_or(RefuseReason::NotPaired)?;
        gate.device_write(device, Some(role), write, None)?;
        if engine.resize(size.0, size.1).is_err() {
            return Ok(false);
        }
        gate.set_screen(size);
        Ok(true)
    }

    /// `device`, connected as `role`, takes [Typing control] of session
    /// `id`: `None` for a session that closed, else whether it may
    /// ([`RefuseReason::NotPaired`] once removed, `NotAllowed` once only a
    /// Viewer, `NotInControl` while the host typed in the last 10 s).
    pub fn take(
        &self,
        id: &SessionId,
        device: EndpointId,
        role: Option<Role>,
        now: Instant,
    ) -> Option<Result<Option<Change>, RefuseReason>> {
        // Only a live session's gate: one closed meanwhile isn't made again.
        let gate = self.gates.lock().get(id).cloned()?;
        let mut gate = gate.lock();
        match self.role_now(&device, role) {
            None => return Some(Err(RefuseReason::NotPaired)),
            Some(Role::Viewer) => return Some(Err(RefuseReason::NotAllowed)),
            Some(Role::Controller) => {}
        }
        let change = match gate.take(device, now) {
            Ok(change) => change,
            Err(HostIsTyping) => return Some(Err(RefuseReason::NotInControl)),
        };
        // Under the gate's lock, in epoch order.
        self.tell(id, change);
        Some(Ok(change))
    }

    /// The person clicked "Let <device> type" on session `id`: control goes
    /// to `device` (connected as `role`) even though the host typed just
    /// now. `None` for a session that closed; refused for a device that is
    /// no longer a Controller.
    pub fn let_device_type(
        &self,
        id: &SessionId,
        device: EndpointId,
        role: Option<Role>,
    ) -> Option<Result<Option<Change>, RefuseReason>> {
        let gate = self.gates.lock().get(id).cloned()?;
        let mut gate = gate.lock();
        match self.role_now(&device, role) {
            None => return Some(Err(RefuseReason::NotPaired)),
            Some(Role::Viewer) => return Some(Err(RefuseReason::NotAllowed)),
            Some(Role::Controller) => {}
        }
        let change = gate.let_device_type(device);
        // Under the gate's lock, in epoch order.
        self.tell(id, change);
        Some(Ok(change))
    }

    /// Call `hook` on every change of [Typing control] these writers make,
    /// so every device hears it: the host typing, a device taking control,
    /// a device let go. Set once at app start.
    pub fn on_change(&self, hook: impl Fn(&SessionId, Change) + Send + Sync + 'static) {
        *self.on_change.lock() = Some(Arc::new(hook));
    }

    /// Tell the hook about `change`. Called with the session's gate lock
    /// held (epoch order), so the hook must not call back into the writers:
    /// see the lock order in the module's header.
    fn tell(&self, id: &SessionId, change: Option<Change>) {
        let Some(change) = change else {
            return;
        };
        let hook = self.on_change.lock().clone();
        if let Some(hook) = hook {
            hook(id, change);
        }
    }

    /// Record the host's own size for session `id` (its window's), to give
    /// back when a device that resized lets go. Sends nothing: the attach
    /// already sized the PTY.
    pub fn note_host_size(&self, id: &SessionId, size: (u16, u16)) {
        let _ = self.gate(id).lock().host_resize(size);
    }

    /// The PTY was just sized to `attached` (a client attaching): if a device
    /// holds its own size, put that back, so the PTY and the gate agree.
    pub fn sync_screen(&self, id: &SessionId, engine: &dyn SessionEngine, attached: (u16, u16)) {
        let screen = self.gate(id).lock().screen();
        if screen != attached {
            let _ = engine.resize(screen.0, screen.1);
        }
    }

    /// The daemon named session `id`'s [Session run].
    pub fn set_run(&self, id: &SessionId, run: u64) {
        self.gate(id).lock().set_run(run);
    }

    /// The dialog watch saw session `id`'s dialog change.
    pub fn set_dialog(&self, id: &SessionId, dialog: Dialog) {
        self.gate(id).lock().set_dialog(dialog);
    }

    /// What the host's one check needs about session `id`: `None` until the
    /// daemon named its run, since no device may act on it before.
    #[must_use]
    pub fn facts(&self, id: &SessionId) -> Option<GateFacts> {
        let gate = self.gates.lock().get(id).cloned()?;
        let gate = gate.lock();
        Some(GateFacts {
            run: gate.run()?,
            control: gate.control().clone(),
            dialog: gate.dialog(),
            size: gate.screen(),
        })
    }

    /// Drop session `id`'s gate: the session is closed.
    pub fn forget(&self, id: &SessionId) {
        self.gates.lock().remove(id);
    }

    /// The person typed `bytes` at the host into session `id`. The returned
    /// [`HostTook`] says whether control came back, for the devices to hear.
    ///
    /// # Errors
    /// The write's error.
    pub fn host_write(
        &self,
        id: &SessionId,
        engine: &dyn SessionEngine,
        bytes: &[u8],
    ) -> Result<HostTook, String> {
        let gate = self.gate(id);
        let mut gate = gate.lock();
        let took = gate.host_input(Instant::now());
        if let Some((cols, rows)) = took.restore {
            // The keystroke still goes in if the size can't be put back.
            if let Err(e) = engine.resize(cols, rows) {
                eprintln!("kriyon: couldn't give the session back its size: {e}");
            }
        }
        let written = engine.write_stdin(bytes).map_err(|e| e.to_string());
        // Told under the gate's lock, so devices hear changes in epoch order;
        // told even when the write failed: control came back all the same.
        self.tell(id, took.change);
        drop(gate);
        written?;
        Ok(took)
    }

    /// The desktop's window gave session `id` a new size. Applied unless a
    /// device's size stands; then it is kept for when control comes back.
    ///
    /// # Errors
    /// The resize's error.
    pub fn host_resize(
        &self,
        id: &SessionId,
        engine: &dyn SessionEngine,
        size: (u16, u16),
    ) -> Result<(), String> {
        let gate = self.gate(id);
        let mut gate = gate.lock();
        match gate.host_resize(size) {
            Some((cols, rows)) => engine.resize(cols, rows).map_err(|e| e.to_string()),
            None => Ok(()),
        }
    }

    /// `device` left, was removed or became a Viewer: give control, and the
    /// host's size, back on every session it held. `engines` are the live
    /// sessions' engines, collected by the caller before this takes any gate
    /// lock. Blocking: call it off the async runtime. Returns what changed,
    /// for the devices to hear.
    pub fn release_device<E: SessionEngine + ?Sized>(
        &self,
        device: &EndpointId,
        engines: &[(SessionId, Arc<E>)],
    ) -> Vec<(SessionId, HostTook)> {
        let mut changed = Vec::new();
        for (id, engine) in engines {
            let Some(gate) = self.gates.lock().get(id).map(Arc::clone) else {
                continue;
            };
            let mut gate = gate.lock();
            let took = gate.release(*device);
            if let Some((cols, rows)) = took.restore {
                // Best effort: a session whose daemon is gone has no size.
                let _ = engine.resize(cols, rows);
            }
            // Under the gate's lock, in epoch order.
            self.tell(id, took.change);
            drop(gate);
            if took.change.is_some() {
                changed.push((id.clone(), took));
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon_client::DaemonClient;
    use kriyon_remote::authorize::Dialog;

    use kriyon_remote::authorize::PendingWrite;
    use kriyon_remote::message::{Holder, RefuseReason, Role};
    use std::io::Read as _;
    use std::os::unix::net::UnixStream;

    const PHONE: EndpointId = [7; 32];

    /// A client whose daemon end the test reads.
    fn engine() -> (DaemonClient, UnixStream) {
        let (daemon, app) = UnixStream::pair().expect("pair");
        let client = DaemonClient::adopt(app, SessionId("s".into())).expect("client");
        (client, daemon)
    }

    fn input(writers: &Writers, id: &SessionId, epoch_counter: u64, seen: u64) -> PendingWrite {
        let facts = writers.facts(id).expect("facts");
        PendingWrite {
            run: facts.run,
            epoch: kriyon_remote::message::Epoch {
                counter: epoch_counter,
                ..facts.control.epoch()
            },
            seen_seq: Some(seen),
            compose: false,
        }
    }

    /// A phone in control of session "s", typing "a"; the daemon's end.
    fn typing_phone(writers: &Writers, id: &SessionId) -> (DaemonClient, UnixStream, PendingWrite) {
        let (engine, daemon) = engine();
        writers.set_run(id, 1);
        let change = writers
            .take(
                id,
                PHONE,
                Some(Role::Controller),
                Instant::now() + std::time::Duration::from_secs(60),
            )
            .expect("live")
            .expect("allowed")
            .expect("a change");
        let write = input(writers, id, change.epoch.counter, 0);
        assert_eq!(
            writers.device_input(id, &engine, &PHONE, Some(Role::Controller), &write, b"a"),
            Ok(true)
        );
        (engine, daemon, write)
    }

    /// Everything the daemon was asked to type, within half a second.
    fn typed(daemon: &mut UnixStream) -> Vec<u8> {
        use kriyon_core::wire::{Frame, FrameDecoder};
        daemon
            .set_read_timeout(Some(std::time::Duration::from_millis(500)))
            .expect("timeout");
        let mut decoder = FrameDecoder::new();
        let mut out = Vec::new();
        let mut buf = [0_u8; 4096];
        while let Ok(n) = daemon.read(&mut buf) {
            if n == 0 {
                break;
            }
            decoder.push(&buf[..n]);
            while let Ok(Some(frame)) = decoder.next_frame() {
                if let Frame::Stdin(bytes) = frame {
                    out.extend(bytes);
                }
            }
        }
        out
    }

    #[test]
    fn the_person_lets_a_device_type_even_right_after_typing_here() {
        let writers = Writers::default();
        let id = SessionId("s".into());
        let (engine, _daemon) = engine();
        writers.set_run(&id, 1);
        let now = Instant::now();
        writers
            .host_write(&id, &engine, b"x")
            .expect("the host types");
        assert!(matches!(
            writers.take(&id, PHONE, Some(Role::Controller), now),
            Some(Err(RefuseReason::NotInControl))
        ));
        let change = writers
            .let_device_type(&id, PHONE, Some(Role::Controller))
            .expect("live")
            .expect("allowed")
            .expect("a change");
        assert_eq!(change.holder, Holder::Device(PHONE));
        // Never to a Viewer, nor a device removed since.
        writers.revoke(PHONE, Revoked::Demoted(Role::Viewer));
        assert!(matches!(
            writers.let_device_type(&id, PHONE, Some(Role::Controller)),
            Some(Err(RefuseReason::NotAllowed))
        ));
        writers.revoke(PHONE, Revoked::Removed);
        assert!(matches!(
            writers.let_device_type(&id, PHONE, Some(Role::Controller)),
            Some(Err(RefuseReason::NotPaired))
        ));
    }

    #[test]
    fn nothing_a_removed_device_types_after_the_revoke_reaches_the_pty() {
        let writers = Writers::default();
        let id = SessionId("s".into());
        let (engine, mut daemon, write) = typing_phone(&writers, &id);
        // Removed while typing: its connection still says Controller.
        writers.revoke(PHONE, Revoked::Removed);
        assert_eq!(
            writers.device_input(&id, &engine, &PHONE, Some(Role::Controller), &write, b"b"),
            Err(RefuseReason::NotPaired)
        );
        assert_eq!(
            writers.device_resize(
                &id,
                &engine,
                &PHONE,
                Some(Role::Controller),
                &write,
                (90, 30)
            ),
            Err(RefuseReason::NotPaired)
        );
        assert!(
            matches!(
                writers.take(&id, PHONE, Some(Role::Controller), Instant::now()),
                Some(Err(RefuseReason::NotPaired))
            ),
            "nor takes control again"
        );
        assert_eq!(typed(&mut daemon), b"a");
    }

    #[test]
    fn nothing_a_device_made_a_viewer_types_after_the_revoke_reaches_the_pty() {
        let writers = Writers::default();
        let id = SessionId("s".into());
        let (engine, mut daemon, write) = typing_phone(&writers, &id);
        writers.revoke(PHONE, Revoked::Demoted(Role::Viewer));
        assert!(writers
            .device_input(&id, &engine, &PHONE, Some(Role::Controller), &write, b"b")
            .is_err());
        assert!(matches!(
            writers.take(&id, PHONE, Some(Role::Controller), Instant::now()),
            Some(Err(_))
        ));
        assert_eq!(
            writers.role_now(&PHONE, Some(Role::Controller)),
            Some(Role::Viewer)
        );
        assert_eq!(typed(&mut daemon), b"a");
    }

    #[test]
    fn a_revoke_never_grants_more_than_the_connection_has_and_pairing_again_clears_it() {
        let writers = Writers::default();
        assert_eq!(
            writers.role_now(&PHONE, Some(Role::Viewer)),
            Some(Role::Viewer)
        );
        writers.revoke(PHONE, Revoked::Demoted(Role::Controller));
        assert_eq!(
            writers.role_now(&PHONE, Some(Role::Viewer)),
            Some(Role::Viewer)
        );
        writers.revoke(PHONE, Revoked::Removed);
        assert_eq!(writers.role_now(&PHONE, Some(Role::Controller)), None);
        writers.unrevoke(&PHONE);
        assert_eq!(
            writers.role_now(&PHONE, Some(Role::Controller)),
            Some(Role::Controller)
        );
    }

    #[test]
    fn a_device_types_only_once_it_holds_control_and_with_the_current_epoch() {
        let writers = Writers::default();
        let id = SessionId("s".into());
        let (engine, mut daemon) = engine();
        writers.set_run(&id, 1);
        let write = input(&writers, &id, 0, 0);
        assert_eq!(
            writers.device_input(&id, &engine, &PHONE, Some(Role::Controller), &write, b"x"),
            Err(RefuseReason::NotInControl)
        );
        let change = writers
            .take(
                &id,
                PHONE,
                Some(Role::Controller),
                Instant::now() + std::time::Duration::from_secs(60),
            )
            .expect("live")
            .expect("the host hasn't typed")
            .expect("a change");
        assert_eq!(change.holder, Holder::Device(PHONE));
        let stale = input(&writers, &id, change.epoch.counter - 1, 0);
        assert_eq!(
            writers.device_input(&id, &engine, &PHONE, Some(Role::Controller), &stale, b"x"),
            Err(RefuseReason::Stale)
        );
        let current = input(&writers, &id, change.epoch.counter, 0);
        assert_eq!(
            writers.device_input(
                &id,
                &engine,
                &PHONE,
                Some(Role::Controller),
                &current,
                b"ok"
            ),
            Ok(true)
        );
        daemon
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .expect("timeout");
        let mut buf = [0_u8; 64];
        let n = daemon.read(&mut buf).expect("the bytes reached the daemon");
        assert!(buf[..n].ends_with(b"ok"));
    }
    #[test]
    fn every_change_of_control_is_told_to_the_hook() {
        let writers = Writers::default();
        let heard = Arc::new(Mutex::new(Vec::new()));
        let hook = Arc::clone(&heard);
        writers.on_change(move |id, change| hook.lock().push((id.0.clone(), change.holder)));
        let id = SessionId("s".into());
        let (engine, _daemon) = engine();
        writers.set_run(&id, 1);
        writers
            .take(
                &id,
                PHONE,
                Some(Role::Controller),
                Instant::now() + std::time::Duration::from_secs(60),
            )
            .expect("live")
            .expect("taken");
        writers.host_write(&id, &engine, b"x").expect("typed");
        assert_eq!(
            heard.lock().as_slice(),
            [
                ("s".to_string(), Holder::Device(PHONE)),
                ("s".to_string(), Holder::Host)
            ]
        );
    }

    #[test]
    fn taking_a_session_that_is_gone_makes_nothing() {
        let writers = Writers::default();
        let id = SessionId("gone".into());
        assert!(writers
            .take(&id, PHONE, Some(Role::Controller), Instant::now())
            .is_none());
        assert!(!writers.has_gate(&id));
    }

    #[test]
    fn noting_the_hosts_size_sends_nothing() {
        let writers = Writers::default();
        let id = SessionId("s".into());
        writers.note_host_size(&id, (100, 30));
        writers.set_run(&id, 1);
        assert_eq!(writers.facts(&id).expect("facts").size, (100, 30));
    }

    #[test]
    fn a_session_has_facts_for_the_check_once_its_run_is_known() {
        let writers = Writers::default();
        let id = SessionId("s".into());
        writers.ensure(&id);
        assert!(
            writers.facts(&id).is_none(),
            "no run yet: nothing a device may act on"
        );
        writers.set_run(&id, 7);
        writers.set_dialog(
            &id,
            Dialog {
                showing: true,
                changed_at_seq: Some(3),
            },
        );
        let facts = writers.facts(&id).expect("facts");
        assert_eq!(facts.run, 7);
        assert_eq!(facts.dialog.changed_at_seq, Some(3));
        assert_eq!(facts.size, DEFAULT_SCREEN);
        assert!(writers.facts(&SessionId("other".into())).is_none());
    }
}
