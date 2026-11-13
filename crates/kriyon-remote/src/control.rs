//! [Typing control] of one session (spec §7): who may type and resize, and
//! the epoch every input must carry.
//!
//! - The person at the host's keyboard always wins: typing there takes control
//!   back at once.
//! - A Controller takes control from another remote device at once, but from
//!   the host only once nobody has typed at the host for
//!   [`HOST_IDLE_BEFORE_TAKEOVER`], or when the person clicks "Let <device>
//!   type".
//! - A device that disconnects, is removed or becomes a Viewer releases
//!   control back to the host.
//!
//! Every change of holder bumps the epoch, so input sent under the old holder
//! is refused as stale. The role check (only Controllers) is `authorize`'s.

use std::time::{Duration, Instant};

use crate::message::{EndpointId, Epoch, Holder};

/// How long the host's keyboard must be quiet before a device may take control
/// from it without the person's click.
pub const HOST_IDLE_BEFORE_TAKEOVER: Duration = Duration::from_secs(10);

/// A change every device should hear as `Control { holder, epoch }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Change {
    pub holder: Holder,
    pub epoch: Epoch,
}

/// The host typed less than [`HOST_IDLE_BEFORE_TAKEOVER`] ago, so control
/// can't be taken from it without the person's click.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostIsTyping;

/// [Typing control] of one session.
#[derive(Clone, Debug)]
pub struct Control {
    holder: Holder,
    epoch: Epoch,
    host_typed_at: Option<Instant>,
}

impl Control {
    /// Control of a session that just started under this app start: the host
    /// holds it.
    #[must_use]
    pub fn new(host_boot_id: u64) -> Self {
        Self {
            holder: Holder::Host,
            epoch: Epoch {
                host_boot_id,
                counter: 0,
            },
            host_typed_at: None,
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

    /// The person typed at the host. Takes control back if a device held it.
    pub fn host_typed(&mut self, now: Instant) -> Option<Change> {
        self.host_typed_at = Some(now);
        self.hand_to(Holder::Host)
    }

    /// The person clicked "Let <device> type".
    pub fn let_device_type(&mut self, device: EndpointId) -> Option<Change> {
        self.hand_to(Holder::Device(device))
    }

    /// A Controller sent `TakeControl`. `Ok(None)` when it already holds it.
    ///
    /// # Errors
    /// [`HostIsTyping`] while the host holds control and typed too recently.
    pub fn take(
        &mut self,
        device: EndpointId,
        now: Instant,
    ) -> Result<Option<Change>, HostIsTyping> {
        if !self.may_take(now) {
            return Err(HostIsTyping);
        }
        Ok(self.hand_to(Holder::Device(device)))
    }

    /// Whether a device's `TakeControl` would succeed at `now`: the host
    /// doesn't hold control, or hasn't typed for [`HOST_IDLE_BEFORE_TAKEOVER`].
    #[must_use]
    pub fn may_take(&self, now: Instant) -> bool {
        self.holder != Holder::Host
            || self.host_typed_at.is_none_or(|typed| {
                now.saturating_duration_since(typed) >= HOST_IDLE_BEFORE_TAKEOVER
            })
    }

    /// `device` disconnected, was removed or became a Viewer: control goes
    /// back to the host if it held it.
    pub fn release(&mut self, device: EndpointId) -> Option<Change> {
        if self.holder == Holder::Device(device) {
            self.hand_to(Holder::Host)
        } else {
            None
        }
    }

    /// Give control to `holder`, bumping the epoch, unless it already has it.
    fn hand_to(&mut self, holder: Holder) -> Option<Change> {
        if self.holder == holder {
            return None;
        }
        self.holder = holder;
        // A u64 counter bumped per control change can't wrap in practice.
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

    fn control() -> (Control, Instant) {
        (Control::new(42), Instant::now())
    }

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn the_host_holds_a_new_session() {
        let (c, _) = control();
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
    fn a_device_takes_from_a_host_that_has_not_typed() {
        let (mut c, t) = control();
        let change = c.take(PHONE, t).expect("taken").expect("a change");
        assert_eq!(change.holder, Holder::Device(PHONE));
        assert_eq!(change.epoch.counter, 1);
        assert_eq!((c.holder(), c.epoch()), (change.holder, change.epoch));
    }

    #[test]
    fn a_device_waits_ten_seconds_after_the_host_typed() {
        let (mut c, t) = control();
        assert_eq!(c.host_typed(t), None, "the host already held it");
        assert_eq!(c.take(PHONE, t + secs(9)), Err(HostIsTyping));
        assert_eq!(c.holder(), Holder::Host);
        assert!(c.take(PHONE, t + HOST_IDLE_BEFORE_TAKEOVER).is_ok());
        assert_eq!(c.holder(), Holder::Device(PHONE));
    }

    #[test]
    fn the_persons_click_lets_a_device_type_at_once() {
        let (mut c, t) = control();
        c.host_typed(t);
        let change = c.let_device_type(PHONE).expect("a change");
        assert_eq!(change.holder, Holder::Device(PHONE));
    }

    #[test]
    fn a_device_takes_from_another_device_at_once() {
        let (mut c, t) = control();
        c.take(PHONE, t).expect("taken");
        let change = c.take(LAPTOP, t).expect("taken").expect("a change");
        assert_eq!(change.holder, Holder::Device(LAPTOP));
        assert_eq!(change.epoch.counter, 2);
    }

    #[test]
    fn typing_at_the_host_always_takes_control_back() {
        let (mut c, t) = control();
        c.take(PHONE, t).expect("taken");
        let change = c.host_typed(t + secs(1)).expect("a change");
        assert_eq!(change.holder, Holder::Host);
        assert_eq!(change.epoch.counter, 2);
        // And the host's typing starts the ten seconds again.
        assert_eq!(c.take(PHONE, t + secs(2)), Err(HostIsTyping));
    }

    #[test]
    fn taking_what_you_hold_changes_nothing() {
        let (mut c, t) = control();
        c.take(PHONE, t).expect("taken");
        let epoch = c.epoch();
        assert_eq!(c.take(PHONE, t), Ok(None));
        assert_eq!(c.let_device_type(PHONE), None);
        assert_eq!(c.epoch(), epoch);
    }

    #[test]
    fn a_device_that_leaves_gives_control_back_to_the_host() {
        let (mut c, t) = control();
        c.take(PHONE, t).expect("taken");
        assert_eq!(c.release(LAPTOP), None, "it never held it");
        let change = c.release(PHONE).expect("a change");
        assert_eq!(change.holder, Holder::Host);
        assert_eq!(change.epoch.counter, 2);
        assert_eq!(c.release(PHONE), None);
    }

    #[test]
    fn a_new_app_start_never_reuses_an_epoch() {
        let a = Control::new(1).epoch();
        let b = Control::new(2).epoch();
        assert_ne!(a, b);
    }
}
