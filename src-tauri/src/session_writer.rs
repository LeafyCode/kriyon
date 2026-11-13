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
use kriyon_remote::message::EndpointId;
use kriyon_remote::writer::{HostTook, SessionGate};
use parking_lot::Mutex;

use crate::daemon_client::DaemonClient;

/// The size a session's PTY has until its terminal says otherwise; the
/// window sends its real size right after attaching.
const DEFAULT_SCREEN: (u16, u16) = (80, 24);

/// Every live session's gate, made on first use and dropped with the session
/// ([`crate::session_registry::forget`]).
pub struct Writers {
    /// Random per app start, so a control epoch never repeats across starts.
    host_boot_id: u64,
    gates: Mutex<HashMap<SessionId, Arc<Mutex<SessionGate>>>>,
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
