//! One writer per session (plan Step C): every write and resize that reaches
//! a session's PTY passes its [`SessionGate`], under the gate's lock, so the
//! check and the write are one step. The desktop writes as the host; a remote
//! device's input will be a second caller, rechecked here.
//!
//! Lock order: a gate's lock is never held while taking the sessions lock,
//! and the gates map's lock is held only to find or drop a gate.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use kriyon_core::session::{SessionEngine as _, SessionId};
use kriyon_remote::authorize::{Dialog, PendingWrite};
use kriyon_remote::control::{Change, Control, HostIsTyping};
use kriyon_remote::message::{EndpointId, RefuseReason, Role};
use kriyon_remote::writer::{HostTook, SessionGate};
use parking_lot::Mutex;

use crate::daemon_client::DaemonClient;

/// The size a session's PTY has until its terminal says otherwise; the
/// window sends its real size right after attaching.
pub(crate) const DEFAULT_SCREEN: (u16, u16) = (80, 24);

/// Every live session's gate, made on first use and dropped with the session
/// ([`crate::session_registry::forget`]).
pub struct Writers {
    /// Random per app start, so a control epoch never repeats across starts.
    host_boot_id: u64,
    gates: Mutex<HashMap<SessionId, Arc<Mutex<SessionGate>>>>,
}

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
        engine: &DaemonClient,
        device: &EndpointId,
        role: Option<Role>,
        write: &PendingWrite,
        bytes: &[u8],
    ) -> Result<bool, RefuseReason> {
        let gate = self.gate(id);
        let mut gate = gate.lock();
        gate.device_write(device, role, write, None)?;
        Ok(engine.write_stdin(bytes).is_ok())
    }

    /// A device's resize of session `id`, checked again like its typing.
    ///
    /// # Errors
    /// Why it was refused; nothing is resized.
    pub fn device_resize(
        &self,
        id: &SessionId,
        engine: &DaemonClient,
        device: &EndpointId,
        role: Option<Role>,
        write: &PendingWrite,
        size: (u16, u16),
    ) -> Result<(), RefuseReason> {
        let gate = self.gate(id);
        let mut gate = gate.lock();
        gate.device_write(device, role, write, Some(size))?;
        // Checked and the session's size now; a daemon that's gone has none.
        let _ = engine.resize(size.0, size.1);
        Ok(())
    }

    /// `device` takes [Typing control] of session `id`.
    ///
    /// # Errors
    /// [`HostIsTyping`] while the host typed in the last 10 s.
    pub fn take(
        &self,
        id: &SessionId,
        device: EndpointId,
        now: Instant,
    ) -> Result<Option<Change>, HostIsTyping> {
        self.gate(id).lock().take(device, now)
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
        engine: &DaemonClient,
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
        engine.write_stdin(bytes).map_err(|e| e.to_string())?;
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
        engine: &DaemonClient,
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
    pub fn release_device(
        &self,
        device: &EndpointId,
        engines: &[(SessionId, Arc<DaemonClient>)],
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
                Instant::now() + std::time::Duration::from_secs(60),
            )
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
