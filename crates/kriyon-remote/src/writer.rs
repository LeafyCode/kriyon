//! One session's writer gate (plan Step C, "one writer per session"): the
//! single place that decides whether a write or resize reaches the session,
//! held under one lock with the write itself, so a takeover, removal or new
//! dialog between a check and a write still wins.
//!
//! - The desktop writes as the host. Typing takes [Typing control] back at
//!   once and records when the host last typed, for the takeover rule.
//! - The desktop's window size is the host's size. While a device holds
//!   control the device's size stands and the host's is remembered; it comes
//!   back when control does.
//! - A device's write is checked again here with
//!   [`crate::authorize::recheck_at_write`].

use std::time::Instant;

use crate::authorize::{
    recheck_at_write, Dialog, HostState, PendingWrite, ProjectFolder, SessionView,
};
use crate::control::{Change, Control, HostIsTyping};
use crate::message::{EndpointId, Holder, RefuseReason, Role};

/// What the host's typing did besides reaching the session.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HostTook {
    /// Control came back to the host: tell every device.
    pub change: Option<Change>,
    /// The host's size to put back, from before a device resized it.
    pub restore: Option<(u16, u16)>,
}

/// One session's gate.
#[derive(Clone, Debug)]
pub struct SessionGate {
    control: Control,
    /// The [Session run] now; `None` until the daemon says.
    run: Option<u64>,
    dialog: Dialog,
    /// The size the session's screen has now.
    screen: (u16, u16),
    /// The host's own size: what the desktop window last asked for.
    host_size: (u16, u16),
}

impl SessionGate {
    /// A gate for a session under this app start (`host_boot_id`), whose
    /// screen is `screen` big.
    #[must_use]
    pub fn new(host_boot_id: u64, screen: (u16, u16)) -> Self {
        Self {
            control: Control::new(host_boot_id),
            run: None,
            dialog: Dialog::default(),
            screen,
            host_size: screen,
        }
    }

    #[must_use]
    pub fn control(&self) -> &Control {
        &self.control
    }

    /// The session's process (re)started: a new run.
    pub fn set_run(&mut self, run: u64) {
        self.run = Some(run);
    }

    /// The dialog watch saw the session's dialog change.
    pub fn set_dialog(&mut self, dialog: Dialog) {
        self.dialog = dialog;
    }

    /// The person typed at the host.
    pub fn host_input(&mut self, now: Instant) -> HostTook {
        let change = self.control.host_typed(now);
        self.back_to_host(change)
    }

    /// Control went back to the host (or didn't): put the host's size back if
    /// a device's stood.
    fn back_to_host(&mut self, change: Option<Change>) -> HostTook {
        let restore = (change.is_some() && self.screen != self.host_size).then(|| {
            self.screen = self.host_size;
            self.host_size
        });
        HostTook { change, restore }
    }

    /// The desktop's window gave the session `size`. Returns the size to
    /// apply now: `None` while a device's size stands (it is remembered).
    pub fn host_resize(&mut self, size: (u16, u16)) -> Option<(u16, u16)> {
        self.host_size = size;
        if self.control.holder() == Holder::Host {
            self.screen = size;
            Some(size)
        } else {
            None
        }
    }

    /// A Controller asks for control.
    ///
    /// # Errors
    /// [`HostIsTyping`] within the takeover wait.
    pub fn take(
        &mut self,
        device: EndpointId,
        now: Instant,
    ) -> Result<Option<Change>, HostIsTyping> {
        self.control.take(device, now)
    }

    /// The person clicked "Let <device> type".
    pub fn let_device_type(&mut self, device: EndpointId) -> Option<Change> {
        self.control.let_device_type(device)
    }

    /// `device` left, was removed or became a Viewer: control goes back to
    /// the host, and so does the host's size.
    pub fn release(&mut self, device: EndpointId) -> HostTook {
        let change = self.control.release(device);
        self.back_to_host(change)
    }

    /// Check a device's write again, now, under the writer's lock. A resize
    /// that passes becomes the session's size.
    ///
    /// # Errors
    /// The [`RefuseReason`]; nothing is written.
    pub fn device_write(
        &mut self,
        device: &EndpointId,
        role: Option<Role>,
        write: &PendingWrite,
        resize_to: Option<(u16, u16)>,
    ) -> Result<(), RefuseReason> {
        // Before the run is known, no run a device names can match it.
        let run = self.run.unwrap_or_else(|| write.run.wrapping_add(1));
        let host = OneSession {
            device: *device,
            role,
            view: SessionView {
                run,
                control: &self.control,
                dialog: self.dialog,
                cols: self.screen.0,
                rows: self.screen.1,
            },
        };
        recheck_at_write(device, "", write, &host)?;
        if let Some(size) = resize_to {
            self.screen = size;
        }
        Ok(())
    }

    /// The session's screen size now.
    #[must_use]
    pub fn screen(&self) -> (u16, u16) {
        self.screen
    }
}

/// The host as the recheck sees it from inside one session's gate: this one
/// device, this one session.
struct OneSession<'a> {
    device: EndpointId,
    role: Option<Role>,
    view: SessionView<'a>,
}

impl HostState for OneSession<'_> {
    fn role(&self, device: &EndpointId) -> Option<Role> {
        (*device == self.device).then_some(self.role).flatten()
    }
    fn session(&self, _id: &str) -> Option<SessionView<'_>> {
        Some(self.view)
    }
    fn project_folder(&self, _project_id: &str) -> ProjectFolder {
        ProjectFolder::NoSuchProject
    }
    fn min_protocol_minor(&self) -> u16 {
        0
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    const PHONE: EndpointId = [1; 32];
    const RUN: u64 = 9;

    fn gate() -> (SessionGate, Instant) {
        let mut g = SessionGate::new(3, (120, 40));
        g.set_run(RUN);
        (g, Instant::now())
    }

    fn input(g: &SessionGate, seen_seq: u64) -> PendingWrite {
        PendingWrite {
            run: RUN,
            epoch: g.control().epoch(),
            seen_seq: Some(seen_seq),
            compose: false,
        }
    }

    fn resize(g: &SessionGate) -> PendingWrite {
        PendingWrite {
            run: RUN,
            epoch: g.control().epoch(),
            seen_seq: None,
            compose: false,
        }
    }

    #[test]
    fn host_typing_while_the_host_holds_control_changes_nothing() {
        let (mut g, t) = gate();
        assert_eq!(g.host_input(t), HostTook::default());
        assert_eq!(g.control().holder(), Holder::Host);
    }

    #[test]
    fn host_typing_takes_control_back_and_starts_the_takeover_wait() {
        let (mut g, t) = gate();
        g.take(PHONE, t).expect("taken");
        let took = g.host_input(t);
        assert_eq!(took.change.map(|c| c.holder), Some(Holder::Host));
        assert_eq!(g.take(PHONE, t + Duration::from_secs(1)), Err(HostIsTyping));
    }

    #[test]
    fn the_host_size_is_kept_while_a_device_size_stands_and_comes_back_with_control() {
        let (mut g, t) = gate();
        assert_eq!(g.host_resize((130, 40)), Some((130, 40)));
        g.take(PHONE, t).expect("taken");
        let phone_size = resize(&g);
        g.device_write(&PHONE, Some(Role::Controller), &phone_size, Some((80, 30)))
            .expect("the holder may resize");
        assert_eq!(g.screen(), (80, 30));
        // The desktop window changes meanwhile: remembered, not applied.
        assert_eq!(g.host_resize((140, 45)), None);
        assert_eq!(g.screen(), (80, 30));
        // Typing at the host brings control and the host's size back.
        let took = g.host_input(t);
        assert_eq!(took.restore, Some((140, 45)));
        assert_eq!(g.screen(), (140, 45));
    }

    #[test]
    fn a_device_leaving_gives_back_control_and_the_host_size() {
        let (mut g, t) = gate();
        g.take(PHONE, t).expect("taken");
        let phone_size = resize(&g);
        g.device_write(&PHONE, Some(Role::Controller), &phone_size, Some((80, 30)))
            .expect("resized");
        let back = g.release(PHONE);
        assert_eq!(back.change.map(|c| c.holder), Some(Holder::Host));
        assert_eq!(back.restore, Some((120, 40)));
        assert_eq!(
            g.release(PHONE),
            HostTook::default(),
            "nothing more to give"
        );
    }

    #[test]
    fn the_holders_current_write_goes_through() {
        let (mut g, t) = gate();
        g.take(PHONE, t).expect("taken");
        let write = input(&g, 0);
        assert_eq!(
            g.device_write(&PHONE, Some(Role::Controller), &write, None),
            Ok(())
        );
    }

    #[test]
    fn a_takeover_between_the_check_and_the_write_wins() {
        let (mut g, t) = gate();
        g.take(PHONE, t).expect("taken");
        let write = input(&g, 0);
        g.host_input(t);
        assert_eq!(
            g.device_write(&PHONE, Some(Role::Controller), &write, None),
            Err(RefuseReason::NotInControl)
        );
    }

    #[test]
    fn a_removed_device_or_a_viewer_writes_nothing() {
        let (mut g, t) = gate();
        g.take(PHONE, t).expect("taken");
        let write = input(&g, 0);
        assert_eq!(
            g.device_write(&PHONE, None, &write, None),
            Err(RefuseReason::NotPaired)
        );
        assert_eq!(
            g.device_write(&PHONE, Some(Role::Viewer), &write, None),
            Err(RefuseReason::NotAllowed)
        );
    }

    #[test]
    fn a_dialog_that_appeared_before_the_write_makes_it_stale() {
        let (mut g, t) = gate();
        g.take(PHONE, t).expect("taken");
        let write = input(&g, 4);
        g.set_dialog(Dialog {
            showing: true,
            changed_at_seq: Some(5),
        });
        assert_eq!(
            g.device_write(&PHONE, Some(Role::Controller), &write, None),
            Err(RefuseReason::Stale)
        );
    }

    #[test]
    fn before_the_run_is_known_no_device_write_goes_through() {
        let mut g = SessionGate::new(3, (120, 40));
        let t = Instant::now();
        g.take(PHONE, t).expect("taken");
        let write = PendingWrite {
            run: 0,
            epoch: g.control().epoch(),
            seen_seq: Some(0),
            compose: false,
        };
        assert_eq!(
            g.device_write(&PHONE, Some(Role::Controller), &write, None),
            Err(RefuseReason::Stale)
        );
    }
}
