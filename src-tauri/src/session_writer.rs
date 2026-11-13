//! One writer per session (plan Step C): every write and resize that reaches
//! a session's PTY passes its [`SessionGate`], under the gate's lock, so the
//! check and the write are one step. The desktop writes as the host; a remote
//! device's input will be a second caller, rechecked here.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use kriyon_core::session::{SessionEngine as _, SessionId};
use kriyon_remote::message::EndpointId;
use kriyon_remote::writer::SessionGate;
use parking_lot::Mutex;

use crate::daemon_client::DaemonClient;

/// The size a session's PTY has until its terminal says otherwise.
const DEFAULT_SCREEN: (u16, u16) = (80, 24);

/// Every session's gate, made on first use.
pub struct Writers {
    /// Random per app start, so a control epoch never repeats across starts.
    host_boot_id: u64,
    gates: Mutex<HashMap<SessionId, Arc<Mutex<SessionGate>>>>,
}

impl Default for Writers {
    fn default() -> Self {
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
    /// The gate of session `id`. Gates of sessions no longer live are
    /// dropped as new ones are made.
    fn gate(&self, id: &SessionId, live: impl Fn(&SessionId) -> bool) -> Arc<Mutex<SessionGate>> {
        let mut gates = self.gates.lock();
        if let Some(gate) = gates.get(id) {
            return Arc::clone(gate);
        }
        gates.retain(|known, _| live(known));
        let gate = Arc::new(Mutex::new(SessionGate::new(
            self.host_boot_id,
            DEFAULT_SCREEN,
        )));
        gates.insert(id.clone(), Arc::clone(&gate));
        gate
    }

    /// The person typed `bytes` at the host into session `id`.
    ///
    /// # Errors
    /// The write's error.
    pub fn host_write(
        &self,
        id: &SessionId,
        engine: &DaemonClient,
        live: impl Fn(&SessionId) -> bool,
        bytes: &[u8],
    ) -> Result<(), String> {
        let gate = self.gate(id, live);
        let mut gate = gate.lock();
        let took = gate.host_input(Instant::now());
        if let Some((cols, rows)) = took.restore {
            engine.resize(cols, rows).map_err(|e| e.to_string())?;
        }
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
        engine: &DaemonClient,
        live: impl Fn(&SessionId) -> bool,
        size: (u16, u16),
    ) -> Result<(), String> {
        let gate = self.gate(id, live);
        let mut gate = gate.lock();
        match gate.host_resize(size) {
            Some((cols, rows)) => engine.resize(cols, rows).map_err(|e| e.to_string()),
            None => Ok(()),
        }
    }

    /// `device` was removed or made a Viewer: give control, and the host's
    /// size, back on every session it held.
    pub fn release_device(
        &self,
        device: &EndpointId,
        engine_of: impl Fn(&SessionId) -> Option<Arc<DaemonClient>>,
    ) {
        let gates: Vec<(SessionId, Arc<Mutex<SessionGate>>)> = self
            .gates
            .lock()
            .iter()
            .map(|(id, gate)| (id.clone(), Arc::clone(gate)))
            .collect();
        for (id, gate) in gates {
            let mut gate = gate.lock();
            let took = gate.release(*device);
            if let (Some((cols, rows)), Some(engine)) = (took.restore, engine_of(&id)) {
                // Best effort: a session that is gone has no size to restore.
                let _ = engine.resize(cols, rows);
            }
        }
    }
}
