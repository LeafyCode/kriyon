//! Who typed last in one session (ADR-0063, superseding spec §7's handover):
//! information, not permission.
//!
//! - Input from the host and from any Controller goes straight to the
//!   session; nobody takes or hands over anything.
//! - The session's size follows whoever typed last, so the holder is tracked:
//!   the host after its keys, a device after its own.
//! - A device that disconnects, is removed or becomes a Viewer stops being
//!   the holder: the host is again.
//!
//! Every change of holder bumps the epoch and is told to every device as
//! `Control { holder, epoch }`, for a "typing from" hint. Nothing is refused
//! for an old epoch. The role check (only Controllers type) is `authorize`'s.

use std::time::Instant;

use crate::message::{EndpointId, Epoch, Holder};

/// A change every device should hear as `Control { holder, epoch }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Change {
    pub holder: Holder,
    pub epoch: Epoch,
}

/// Who typed last in one session.
#[derive(Clone, Debug)]
pub struct Control {
    holder: Holder,
    epoch: Epoch,
}

impl Control {
    /// A session that just started under this app start: the host holds it.
    #[must_use]
    pub fn new(host_boot_id: u64) -> Self {
        Self {
            holder: Holder::Host,
            epoch: Epoch {
                host_boot_id,
                counter: 0,
            },
        }
    }

    #[must_use]
    pub fn holder(&self) -> Holder {
        self.holder
    }

    #[must_use]
    pub fn epoch(&self) -> Epoch {
        self.epoch
    }

    /// The person typed at the host.
    pub fn host_typed(&mut self, _now: Instant) -> Option<Change> {
        self.hand_to(Holder::Host)
    }

    /// A Controller typed (or composed) into the session.
    pub fn device_typed(&mut self, device: EndpointId) -> Option<Change> {
        self.hand_to(Holder::Device(device))
    }

    /// `device` disconnected, was removed or became a Viewer: the host holds
    /// it again if that device did.
    pub fn release(&mut self, device: EndpointId) -> Option<Change> {
        if self.holder == Holder::Device(device) {
            self.hand_to(Holder::Host)
        } else {
            None
        }
    }

    /// Make `holder` the one who typed last, bumping the epoch, unless it is.
    fn hand_to(&mut self, holder: Holder) -> Option<Change> {
        if self.holder == holder {
            return None;
        }
        self.holder = holder;
        // A u64 counter bumped per change can't wrap in practice.
        self.epoch.counter = self.epoch.counter.saturating_add(1);
        Some(Change {
            holder,
            epoch: self.epoch,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PHONE: EndpointId = [1; 32];
    const LAPTOP: EndpointId = [2; 32];

    #[test]
    fn the_host_holds_a_new_session() {
        let c = Control::new(42);
        assert_eq!(c.holder(), Holder::Host);
        assert_eq!(
            c.epoch(),
            Epoch {
                host_boot_id: 42,
                counter: 0
            }
        );
    }

    #[test]
    fn whoever_types_holds_it_at_once() {
        let mut c = Control::new(42);
        let t = Instant::now();
        assert_eq!(c.host_typed(t), None, "the host already held it");
        let change = c.device_typed(PHONE).expect("a change");
        assert_eq!(change.holder, Holder::Device(PHONE));
        assert_eq!(change.epoch.counter, 1);
        assert_eq!(c.device_typed(PHONE), None, "no change, no bump");
        let change = c.device_typed(LAPTOP).expect("a change");
        assert_eq!(change.holder, Holder::Device(LAPTOP));
        let change = c.host_typed(t).expect("a change");
        assert_eq!((change.holder, change.epoch.counter), (Holder::Host, 3));
    }

    #[test]
    fn a_device_that_leaves_hands_back_to_the_host() {
        let mut c = Control::new(42);
        c.device_typed(PHONE);
        assert_eq!(c.release(LAPTOP), None, "it never held it");
        let change = c.release(PHONE).expect("a change");
        assert_eq!(change.holder, Holder::Host);
        assert_eq!(c.release(PHONE), None);
    }

    #[test]
    fn a_new_app_start_never_reuses_an_epoch() {
        let a = Control::new(1).epoch();
        let b = Control::new(2).epoch();
        assert_ne!(a, b);
    }
}
