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
use kriyon_remote::control::{Change, Control};
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
    /// Told each size the host gives a session's PTY (see [`Writers::on_resize`]).
    on_resize: Mutex<Option<OnResize>>,
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

/// What hears the host giving a session's PTY a new size.
type OnResize = Arc<dyn Fn(&SessionId) + Send + Sync>;

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
            on_resize: Mutex::new(None),
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
        let took = gate.device_write(device, Some(role), write, None)?;
        if let Some((cols, rows)) = took.restore {
            // The keys still go in if the device's size can't be applied.
            if let Err(e) = engine.resize(cols, rows) {
                eprintln!("kriyon: couldn't give the session the device's size: {e}");
            }
        }
        let written = engine.write_stdin(bytes).is_ok();
        // Under the gate's lock, in epoch order.
        self.tell(id, took.change);
        drop(gate);
        if took.restore.is_some() {
            self.told_resized(id);
        }
        Ok(written)
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
        // Checked first; the device's size is recorded, and is the session's
        // now only if it typed last (ADR-0063), all under the one lock.
        let role = self.role_now(device, role).ok_or(RefuseReason::NotPaired)?;
        let took = gate.device_write(device, Some(role), write, Some(size))?;
        if let Some((cols, rows)) = took.restore {
            if engine.resize(cols, rows).is_err() {
                return Ok(false);
            }
            drop(gate);
            self.told_resized(id);
        }
        Ok(true)
    }

    /// Call `hook` on every change of [Typing control] these writers make,
    /// so every device hears it: the host typing, a device taking control,
    /// a device let go. Set once at app start.
    pub fn on_change(&self, hook: impl Fn(&SessionId, Change) + Send + Sync + 'static) {
        *self.on_change.lock() = Some(Arc::new(hook));
    }

    /// Call `hook` each time the host gives session `id`'s PTY a size (its
    /// window resized, or its size put back when control came back), after
    /// the resize reached the daemon and with no gate lock held, so devices
    /// can redraw at it. Set once at app start.
    pub fn on_resize(&self, hook: impl Fn(&SessionId) + Send + Sync + 'static) {
        *self.on_resize.lock() = Some(Arc::new(hook));
    }

    /// Tell the resize hook about session `id`. Never under a gate's lock.
    fn told_resized(&self, id: &SessionId) {
        let hook = self.on_resize.lock().clone();
        if let Some(hook) = hook {
            hook(id);
        }
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
        // The terminal answering the program on its own isn't the person
        // typing: it goes in, and control stays where it is.
        if kriyon_remote::writer::is_terminal_reply(bytes) {
            engine.write_stdin(bytes).map_err(|e| e.to_string())?;
            return Ok(HostTook::default());
        }
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
        if took.restore.is_some() {
            self.told_resized(id);
        }
        written?;
        Ok(took)
    }

    /// Kriyon itself types `bytes` into session `id` (a wake's resume, as a
    /// device opened it): in turn with every other write, but not as the
    /// person at the host, so control stays where it is and nobody is held
    /// off.
    ///
    /// # Errors
    /// The write's error.
    pub fn app_write(
        &self,
        id: &SessionId,
        engine: &dyn SessionEngine,
        bytes: &[u8],
    ) -> Result<(), String> {
        let gate = self.gate(id);
        let _turn = gate.lock();
        engine.write_stdin(bytes).map_err(|e| e.to_string())
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
        let Some((cols, rows)) = gate.host_resize(size) else {
            return Ok(());
        };
        engine.resize(cols, rows).map_err(|e| e.to_string())?;
        drop(gate);
        self.told_resized(id);
        Ok(())
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
            if took.restore.is_some() {
                self.told_resized(id);
            }
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

    use kriyon_core::uds::UnixStream;
    use kriyon_remote::authorize::PendingWrite;
    use kriyon_remote::message::{Holder, RefuseReason, Role};
    use std::io::Read as _;

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

    /// The phone types nothing into session "s": it typed last now.
    fn phone_types(writers: &Writers, id: &SessionId, engine: &DaemonClient) {
        let write = input(writers, id, 0, 0);
        assert_eq!(
            writers.device_input(id, engine, &PHONE, Some(Role::Controller), &write, b""),
            Ok(true)
        );
    }

    /// A phone typing "a" in session "s"; the daemon's end.
    fn typing_phone(writers: &Writers, id: &SessionId) -> (DaemonClient, UnixStream, PendingWrite) {
        let (engine, daemon) = engine();
        writers.set_run(id, 1);
        let write = input(writers, id, 0, 0);
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

    /// ADR-0063: no handover. The host and every Controller type in turn, in
    /// any order, with an epoch nobody keeps up with, and all of it reaches
    /// the session; a Viewer's typing never does.
    #[test]
    fn the_host_and_every_controller_type_in_turn_without_a_handover() {
        const TABLET: EndpointId = [8; 32];
        const WATCHER: EndpointId = [9; 32];
        let writers = Writers::default();
        let id = SessionId("s".into());
        let (engine, mut daemon) = engine();
        writers.set_run(&id, 1);
        let write = PendingWrite {
            run: 1,
            epoch: kriyon_remote::message::Epoch {
                host_boot_id: 0,
                counter: 0,
            },
            seen_seq: Some(0),
            compose: false,
        };
        let from = |device: &EndpointId, role: Role, bytes: &[u8]| {
            writers.device_input(&id, &engine, device, Some(role), &write, bytes)
        };
        writers.host_write(&id, &engine, b"h1").expect("host");
        assert_eq!(from(&PHONE, Role::Controller, b"p1"), Ok(true));
        writers.host_write(&id, &engine, b"h2").expect("host");
        assert_eq!(from(&TABLET, Role::Controller, b"t1"), Ok(true));
        assert_eq!(from(&PHONE, Role::Controller, b"p2"), Ok(true));
        assert_eq!(
            from(&WATCHER, Role::Viewer, b"v"),
            Err(RefuseReason::NotAllowed)
        );
        assert_eq!(typed(&mut daemon), b"h1p1h2t1p2");
        // Who typed last is told, for a "typing from" hint.
        let holder = writers.facts(&id).expect("live").control.holder();
        assert_eq!(holder, Holder::Device(PHONE));
    }

    /// ADR-0063: the session takes the size of whoever typed last: a phone's
    /// own size once it types, the window's again at the host's next key.
    #[test]
    fn the_session_takes_the_size_of_whoever_typed_last() {
        let writers = Writers::default();
        let resized = Arc::new(Mutex::new(0_u32));
        let hook = Arc::clone(&resized);
        writers.on_resize(move |_id| *hook.lock() += 1);
        let id = SessionId("s".into());
        let (engine, _daemon) = engine();
        writers.set_run(&id, 1);
        writers
            .host_resize(&id, &engine, (120, 40))
            .expect("the window");
        let write = PendingWrite {
            run: 1,
            epoch: kriyon_remote::message::Epoch {
                host_boot_id: 0,
                counter: 0,
            },
            seen_seq: None,
            compose: false,
        };
        let size = |w: &Writers| w.facts(&id).expect("live").size;
        // The phone says its size: it stands only once the phone types.
        assert_eq!(
            writers.device_resize(
                &id,
                &engine,
                &PHONE,
                Some(Role::Controller),
                &write,
                (80, 30)
            ),
            Ok(true)
        );
        assert_eq!(size(&writers), (120, 40), "watching changes nothing");
        assert_eq!(
            writers.device_input(&id, &engine, &PHONE, Some(Role::Controller), &write, b"a"),
            Ok(true)
        );
        assert_eq!(size(&writers), (80, 30), "the phone typed");
        writers.host_write(&id, &engine, b"b").expect("typed");
        assert_eq!(size(&writers), (120, 40), "the window's size is back");
        assert_eq!(*resized.lock(), 3, "each size reached the devices");
    }

    /// Devices are told each size the host's window gives the PTY, so they
    /// can redraw at it; not while a device's own size stands.
    #[test]
    fn every_size_the_host_gives_the_pty_is_told_to_the_resize_hook() {
        let writers = Writers::default();
        let heard = Arc::new(Mutex::new(0_u32));
        let hook = Arc::clone(&heard);
        writers.on_resize(move |_id| *hook.lock() += 1);
        let id = SessionId("s".into());
        let (engine, _daemon) = engine();
        writers.set_run(&id, 1);
        writers
            .host_resize(&id, &engine, (100, 30))
            .expect("resized");
        assert_eq!(*heard.lock(), 1, "the window's size");
        phone_types(&writers, &id, &engine);
        writers
            .host_resize(&id, &engine, (120, 40))
            .expect("remembered");
        assert_eq!(*heard.lock(), 1, "a device's size stands");
        // The person types: control and the window's size come back.
        writers.host_write(&id, &engine, b"x").expect("typed");
        assert_eq!(*heard.lock(), 2, "the window's size put back");
    }

    /// The host's terminal answers what the program asks of it on its own (a
    /// focus change, its version when Claude Code starts): that isn't the
    /// person typing, so a device keeps control. Seen on the Windows test
    /// PC: control dropped back to the host as Claude started.
    #[test]
    fn the_host_terminals_own_replies_leave_a_devices_control() {
        let writers = Writers::default();
        let id = SessionId("s".into());
        let (engine, mut daemon) = engine();
        writers.set_run(&id, 1);
        phone_types(&writers, &id, &engine);
        let replies: [&[u8]; 3] = [
            b"\x1b[I",
            b"\x1bP>|xterm.js(6.1.0-beta.304)\x1b\\",
            b"\x1b[O",
        ];
        for reply in replies {
            writers.host_write(&id, &engine, reply).expect("written");
        }
        let holder = |w: &Writers| w.facts(&id).expect("live").control.holder();
        assert_eq!(holder(&writers), Holder::Device(PHONE));
        // The program still gets its answers.
        assert_eq!(typed(&mut daemon), replies.concat());
        // A key the person presses takes control back, as before.
        writers.host_write(&id, &engine, b"x").expect("typed");
        assert_eq!(holder(&writers), Holder::Host);
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
        phone_types(&writers, &id, &engine);
        writers.host_write(&id, &engine, b"x").expect("typed");
        assert_eq!(
            heard.lock().as_slice(),
            [
                ("s".to_string(), Holder::Device(PHONE)),
                ("s".to_string(), Holder::Host)
            ]
        );
    }

    /// Kriyon waking a sleeping session (a device opened it) types into it,
    /// but isn't the person at the host: who typed last stays as it is.
    #[test]
    fn kriyon_typing_a_wake_leaves_control_where_it_is() {
        let writers = Writers::default();
        let heard = Arc::new(Mutex::new(Vec::new()));
        let hook = Arc::clone(&heard);
        writers.on_change(move |_id, change| hook.lock().push(change.holder));
        let id = SessionId("s".into());
        let (engine, _daemon) = engine();
        writers.set_run(&id, 1);
        phone_types(&writers, &id, &engine);
        writers
            .app_write(&id, &engine, b"claude --resume x\r")
            .expect("typed");
        assert_eq!(
            heard.lock().as_slice(),
            [Holder::Device(PHONE)],
            "no change"
        );
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
