//! The host's one check (spec §8): every message from a [Remote device]
//! passes [`authorize`] before anything acts on it, and the PTY-writer task
//! repeats the input checks with [`recheck_at_write`], atomically with the
//! write, so a takeover, removal or new dialog in between still wins.
//!
//! Pure: the host resolves what needs IO first and hands in the result —
//! the project folder's check (`kriyon_core::folder::check_folder`) as
//! [`ProjectFolder`], the CLI dialog as [`Dialog`].

use std::time::Instant;

use kriyon_core::session::check_screen_size;

use crate::codec::Decoded;
use crate::control::Control;
use crate::message::{EndpointId, Epoch, FromDevice, Holder, RefuseReason, Role};

/// What [`authorize`] decided.
pub type Verdict = Result<(), RefuseReason>;

/// The most cells (columns × rows) a session's screen may have to be viewed
/// remotely, so its worst snapshot fits [`crate::compress::MAX_SNAPSHOT`].
pub const MAX_REMOTE_CELLS: u32 = 250_000;

/// The narrowest a remote device may make a session (spec §7).
pub const MIN_REMOTE_COLS: u16 = 80;

/// The longest title a remote start may give, in bytes.
pub const MAX_TITLE: usize = 200;

/// The longest sealed push token the host keeps.
pub const MAX_SEALED_PUSH_TOKEN: usize = 2 * 1024;

/// The stream a message arrived on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stream<'a> {
    /// The connection's first stream: hello, control, starts, push tokens.
    Control,
    /// A session stream whose `Open` hasn't arrived yet.
    Unopened,
    /// A session stream, opened on this session.
    Session(&'a str),
}

/// A project's folder, as the host found it before calling [`authorize`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProjectFolder {
    /// The project exists and its folder is inside an approved root.
    Approved,
    /// The project exists, but its folder isn't inside an approved root.
    NotAllowed,
    NoSuchProject,
}

impl ProjectFolder {
    /// Whether a session may start in it, or why not.
    ///
    /// # Errors
    /// [`RefuseReason::FolderNotAllowed`] or [`RefuseReason::NoSuchProject`].
    pub fn allows(self) -> Result<(), RefuseReason> {
        match self {
            Self::Approved => Ok(()),
            Self::NotAllowed => Err(RefuseReason::FolderNotAllowed),
            Self::NoSuchProject => Err(RefuseReason::NoSuchProject),
        }
    }
}

/// The CLI dialog of a session, as the host's dialog watch sees it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Dialog {
    /// A dialog shows now.
    pub showing: bool,
    /// The screen `seq` at which a dialog last appeared or changed; `None`
    /// when none has this run.
    pub changed_at_seq: Option<u64>,
}

/// What the check needs to know about one session.
#[derive(Clone, Copy, Debug)]
pub struct SessionView<'a> {
    /// The current [Session run].
    pub run: u64,
    pub control: &'a Control,
    pub dialog: Dialog,
    /// The host's screen size now.
    pub cols: u16,
    pub rows: u16,
}

/// Whether a `cols` × `rows` screen is small enough to view remotely.
fn viewable(cols: u16, rows: u16) -> bool {
    u32::from(cols) * u32::from(rows) <= MAX_REMOTE_CELLS
}

/// What the host knows, looked up as the check needs it.
pub trait HostState {
    /// The role of `device` if it is paired.
    fn role(&self, device: &EndpointId) -> Option<Role>;
    fn session(&self, id: &str) -> Option<SessionView<'_>>;
    fn project_folder(&self, project_id: &str) -> ProjectFolder;
    /// The oldest protocol minor the host accepts.
    fn min_protocol_minor(&self) -> u16;
}

/// The checks a write to the PTY needs, taken from `Input`, `Compose` or
/// `Resize` so the writer task can run them again at the moment it writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PendingWrite {
    pub run: u64,
    pub epoch: Epoch,
    /// `None` for a resize, which answers no dialog.
    pub seen_seq: Option<u64>,
    /// `Compose`, which is refused while a dialog shows.
    pub compose: bool,
}

impl PendingWrite {
    /// The write `message` asks for, if it is one.
    #[must_use]
    pub fn of(message: &FromDevice) -> Option<Self> {
        match *message {
            FromDevice::Input {
                run,
                epoch,
                seen_seq,
                ..
            } => Some(Self {
                run,
                epoch,
                seen_seq: Some(seen_seq),
                compose: false,
            }),
            FromDevice::Compose {
                run,
                epoch,
                seen_seq,
                ..
            } => Some(Self {
                run,
                epoch,
                seen_seq: Some(seen_seq),
                compose: true,
            }),
            FromDevice::Resize { run, epoch, .. } => Some(Self {
                run,
                epoch,
                seen_seq: None,
                compose: false,
            }),
            _ => None,
        }
    }
}

/// Decide whether `device` may have `message`, which arrived on `stream`.
///
/// # Errors
/// The [`RefuseReason`] to answer with `Refused`.
pub fn authorize(
    device: &EndpointId,
    stream: Stream<'_>,
    message: &Decoded<FromDevice>,
    host: &impl HostState,
    now: Instant,
) -> Verdict {
    // Paired first, whatever the message: a removed device must learn it was
    // removed, so it stops retrying.
    let role = host.role(device).ok_or(RefuseReason::NotPaired)?;
    let Decoded::Message(message) = message else {
        return Err(RefuseReason::UnknownMessage);
    };
    let controller = || {
        if role == Role::Controller {
            Ok(())
        } else {
            Err(RefuseReason::NotAllowed)
        }
    };
    let session_exists = |id: &str| {
        host.session(id)
            .map(|_| ())
            .ok_or(RefuseReason::NoSuchSession)
    };
    match (message, stream) {
        (FromDevice::Hello { protocol_minor, .. }, Stream::Control) => {
            let min_minor = host.min_protocol_minor();
            if *protocol_minor < min_minor {
                return Err(RefuseReason::TooOld { min_minor });
            }
            Ok(())
        }
        (FromDevice::Open { session_id }, Stream::Unopened) => {
            let session = host
                .session(session_id)
                .ok_or(RefuseReason::NoSuchSession)?;
            if viewable(session.cols, session.rows) {
                Ok(())
            } else {
                Err(RefuseReason::ScreenTooLarge)
            }
        }
        (FromDevice::Resync | FromDevice::RequestEntries, Stream::Session(id)) => {
            session_exists(id)
        }
        (FromDevice::TakeControl { session_id }, Stream::Control) => {
            controller()?;
            let session = host
                .session(session_id)
                .ok_or(RefuseReason::NoSuchSession)?;
            if session.control.may_take(now) {
                Ok(())
            } else {
                Err(RefuseReason::NotInControl)
            }
        }
        (
            FromDevice::Input { .. } | FromDevice::Compose { .. } | FromDevice::Resize { .. },
            Stream::Session(id),
        ) => {
            // Always a write in this arm; refusing otherwise fails closed.
            let Some(write) = PendingWrite::of(message) else {
                return Err(RefuseReason::NotAllowed);
            };
            recheck_at_write(device, id, &write, host)?;
            if let FromDevice::Resize { cols, rows, .. } = *message {
                if cols < MIN_REMOTE_COLS
                    || check_screen_size(cols, rows).is_err()
                    || !viewable(cols, rows)
                {
                    return Err(RefuseReason::OutOfRange);
                }
            }
            Ok(())
        }
        (
            FromDevice::StartSession {
                project_id,
                title,
                worktree,
                ..
            },
            Stream::Control,
        ) => {
            controller()?;
            if let Some(title) = title {
                crate::text::check_shown_text(title, MAX_TITLE)?;
            }
            // Worktree setup runs scripts, so a remote start never asks for it.
            if *worktree {
                return Err(RefuseReason::NotAllowed);
            }
            host.project_folder(project_id).allows()
        }
        // The codec already refuses a PushToken message over 2 KiB; this is
        // the same bound on the token itself, so the check doesn't rely on it.
        (FromDevice::PushToken { sealed, .. }, Stream::Control) => {
            if sealed.len() > MAX_SEALED_PUSH_TOKEN {
                return Err(RefuseReason::OutOfRange);
            }
            Ok(())
        }
        // A known message on a stream it doesn't belong to.
        _ => Err(RefuseReason::NotAllowed),
    }
}

/// Run the write checks again inside the PTY-writer task, atomically with
/// the write: paired, role, session, holds control, run, epoch and dialog.
///
/// # Errors
/// The [`RefuseReason`] the write is refused for; nothing is written.
pub fn recheck_at_write(
    device: &EndpointId,
    session_id: &str,
    write: &PendingWrite,
    host: &impl HostState,
) -> Verdict {
    if host.role(device).ok_or(RefuseReason::NotPaired)? != Role::Controller {
        return Err(RefuseReason::NotAllowed);
    }
    let session = host
        .session(session_id)
        .ok_or(RefuseReason::NoSuchSession)?;
    if session.control.holder() != Holder::Device(*device) {
        return Err(RefuseReason::NotInControl);
    }
    if write.run != session.run || write.epoch != session.control.epoch() {
        return Err(RefuseReason::Stale);
    }
    // A dialog that appeared or changed after the device's last drawn update:
    // it would be answering something it never saw.
    let missed_dialog = write
        .seen_seq
        .zip(session.dialog.changed_at_seq)
        .is_some_and(|(seen, changed)| seen < changed);
    if missed_dialog {
        return Err(RefuseReason::Stale);
    }
    if write.compose && session.dialog.showing {
        return Err(RefuseReason::DialogOpen);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::Duration;

    use kriyon_core::session::MAX_SCREEN_SIDE;

    use super::*;
    use crate::control::HOST_IDLE_BEFORE_TAKEOVER;

    const PHONE: EndpointId = [1; 32];
    const VIEWER: EndpointId = [2; 32];
    const STRANGER: EndpointId = [9; 32];
    const RUN: u64 = 77;
    const S: &str = "s1";

    struct Host {
        devices: HashMap<EndpointId, Role>,
        control: Control,
        dialog: Dialog,
        session_exists: bool,
        folder: ProjectFolder,
        screen: (u16, u16),
    }

    impl HostState for Host {
        fn role(&self, device: &EndpointId) -> Option<Role> {
            self.devices.get(device).copied()
        }
        fn session(&self, id: &str) -> Option<SessionView<'_>> {
            (self.session_exists && id == S).then_some(SessionView {
                run: RUN,
                control: &self.control,
                dialog: self.dialog,
                cols: self.screen.0,
                rows: self.screen.1,
            })
        }
        fn project_folder(&self, _project_id: &str) -> ProjectFolder {
            self.folder
        }
        fn min_protocol_minor(&self) -> u16 {
            2
        }
    }

    /// A host where PHONE (a Controller) holds control of session S.
    fn host() -> (Host, Instant) {
        let now = Instant::now();
        let mut control = Control::new(5);
        control.take(PHONE, now).expect("taken");
        let host = Host {
            devices: HashMap::from([(PHONE, Role::Controller), (VIEWER, Role::Viewer)]),
            control,
            dialog: Dialog::default(),
            session_exists: true,
            folder: ProjectFolder::Approved,
            screen: (120, 40),
        };
        (host, now)
    }

    fn check(host: &Host, device: EndpointId, stream: Stream<'_>, message: FromDevice) -> Verdict {
        authorize(
            &device,
            stream,
            &Decoded::Message(message),
            host,
            Instant::now(),
        )
    }

    fn hello(minor: u16) -> FromDevice {
        FromDevice::Hello {
            app_version: "1".into(),
            protocol_minor: minor,
        }
    }

    fn input(host: &Host, seen_seq: u64) -> FromDevice {
        FromDevice::Input {
            run: RUN,
            epoch: host.control.epoch(),
            seen_seq,
            bytes: b"y".to_vec(),
        }
    }

    fn compose(host: &Host) -> FromDevice {
        FromDevice::Compose {
            run: RUN,
            epoch: host.control.epoch(),
            seen_seq: 10,
            text: "hi".into(),
        }
    }

    fn resize(host: &Host, cols: u16, rows: u16) -> FromDevice {
        FromDevice::Resize {
            run: RUN,
            epoch: host.control.epoch(),
            cols,
            rows,
        }
    }

    fn start(worktree: bool) -> FromDevice {
        FromDevice::StartSession {
            request_id: [3; 16],
            project_id: "p".into(),
            title: None,
            worktree,
        }
    }

    fn take() -> FromDevice {
        FromDevice::TakeControl {
            session_id: S.into(),
        }
    }

    const SESSION: Stream<'static> = Stream::Session(S);

    // Row: Hello, Resync, Open, RequestEntries — paired, session exists.

    #[test]
    fn an_unpaired_device_is_refused_whatever_it_sends() {
        let (h, _) = host();
        for (stream, message) in [
            (Stream::Control, hello(2)),
            (
                Stream::Unopened,
                FromDevice::Open {
                    session_id: S.into(),
                },
            ),
            (SESSION, FromDevice::Resync),
            (SESSION, input(&h, 0)),
            (
                Stream::Control,
                FromDevice::PushToken {
                    key_id: 1,
                    sealed: vec![],
                },
            ),
        ] {
            assert_eq!(
                check(&h, STRANGER, stream, message),
                Err(RefuseReason::NotPaired)
            );
        }
    }

    #[test]
    fn an_unpaired_device_is_told_so_even_for_an_unknown_message() {
        let (h, now) = host();
        let unknown = Decoded::Unknown { tag: 99 };
        assert_eq!(
            authorize(&STRANGER, Stream::Control, &unknown, &h, now),
            Err(RefuseReason::NotPaired)
        );
    }

    #[test]
    fn a_viewer_may_say_hello_open_resync_and_ask_for_entries() {
        let (h, _) = host();
        assert_eq!(check(&h, VIEWER, Stream::Control, hello(2)), Ok(()));
        let open = FromDevice::Open {
            session_id: S.into(),
        };
        assert_eq!(check(&h, VIEWER, Stream::Unopened, open), Ok(()));
        assert_eq!(check(&h, VIEWER, SESSION, FromDevice::Resync), Ok(()));
        assert_eq!(
            check(&h, VIEWER, SESSION, FromDevice::RequestEntries),
            Ok(())
        );
    }

    #[test]
    fn opening_or_resyncing_a_session_that_is_gone_is_refused() {
        let (mut h, _) = host();
        h.session_exists = false;
        let open = FromDevice::Open {
            session_id: S.into(),
        };
        assert_eq!(
            check(&h, VIEWER, Stream::Unopened, open),
            Err(RefuseReason::NoSuchSession)
        );
        for message in [FromDevice::Resync, FromDevice::RequestEntries] {
            assert_eq!(
                check(&h, VIEWER, SESSION, message),
                Err(RefuseReason::NoSuchSession)
            );
        }
    }

    #[test]
    fn a_host_screen_too_big_to_send_cannot_be_opened() {
        let (mut h, _) = host();
        let open = || FromDevice::Open {
            session_id: S.into(),
        };
        h.screen = (500, 500);
        assert_eq!(check(&h, VIEWER, Stream::Unopened, open()), Ok(()));
        h.screen = (501, 500);
        assert_eq!(
            check(&h, VIEWER, Stream::Unopened, open()),
            Err(RefuseReason::ScreenTooLarge)
        );
    }

    #[test]
    fn a_device_may_not_resize_past_what_it_may_view() {
        let (h, _) = host();
        assert_eq!(check(&h, PHONE, SESSION, resize(&h, 500, 500)), Ok(()));
        assert_eq!(
            check(&h, PHONE, SESSION, resize(&h, 600, 500)),
            Err(RefuseReason::OutOfRange)
        );
    }

    #[test]
    fn a_device_on_an_older_protocol_minor_is_told_the_minimum() {
        let (h, _) = host();
        assert_eq!(
            check(&h, PHONE, Stream::Control, hello(1)),
            Err(RefuseReason::TooOld { min_minor: 2 })
        );
    }

    #[test]
    fn a_message_on_the_wrong_stream_is_refused() {
        let (h, _) = host();
        let open = || FromDevice::Open {
            session_id: S.into(),
        };
        for (stream, message) in [
            (SESSION, hello(2)),
            (Stream::Control, open()),
            (SESSION, open()),
            (Stream::Control, FromDevice::Resync),
            (Stream::Unopened, FromDevice::Resync),
            (Stream::Control, input(&h, 0)),
            (SESSION, take()),
            (SESSION, start(false)),
            (
                SESSION,
                FromDevice::PushToken {
                    key_id: 1,
                    sealed: vec![],
                },
            ),
        ] {
            assert_eq!(
                check(&h, PHONE, stream, message.clone()),
                Err(RefuseReason::NotAllowed),
                "{message:?} on {stream:?}"
            );
        }
    }

    // Row: TakeControl — role, control rules.

    #[test]
    fn a_viewer_may_not_take_control() {
        let (h, _) = host();
        assert_eq!(
            check(&h, VIEWER, Stream::Control, take()),
            Err(RefuseReason::NotAllowed)
        );
    }

    #[test]
    fn control_is_not_taken_from_a_host_that_just_typed() {
        let (mut h, now) = host();
        h.control.host_typed(now);
        let at = |t| authorize(&PHONE, Stream::Control, &Decoded::Message(take()), &h, t);
        assert_eq!(
            at(now + Duration::from_secs(1)),
            Err(RefuseReason::NotInControl)
        );
        assert_eq!(at(now + HOST_IDLE_BEFORE_TAKEOVER), Ok(()));
    }

    #[test]
    fn control_of_a_session_that_is_gone_is_refused() {
        let (mut h, _) = host();
        h.session_exists = false;
        assert_eq!(
            check(&h, PHONE, Stream::Control, take()),
            Err(RefuseReason::NoSuchSession)
        );
    }

    // Row: Input, Resize — role, holds control, run + epoch + seen_seq, size.

    #[test]
    fn input_from_the_holder_on_the_current_run_and_epoch_is_allowed() {
        let (h, _) = host();
        assert_eq!(check(&h, PHONE, SESSION, input(&h, 0)), Ok(()));
        assert_eq!(check(&h, PHONE, SESSION, resize(&h, 80, 24)), Ok(()));
    }

    #[test]
    fn a_viewer_may_not_type_resize_or_compose() {
        let (h, _) = host();
        for message in [input(&h, 0), resize(&h, 80, 24), compose(&h)] {
            assert_eq!(
                check(&h, VIEWER, SESSION, message),
                Err(RefuseReason::NotAllowed)
            );
        }
    }

    #[test]
    fn a_controller_that_does_not_hold_control_may_not_type() {
        let (mut h, now) = host();
        h.control.host_typed(now);
        assert_eq!(
            check(&h, PHONE, SESSION, input(&h, 0)),
            Err(RefuseReason::NotInControl)
        );
    }

    #[test]
    fn input_for_an_old_run_or_epoch_is_stale() {
        let (h, _) = host();
        let old_run = FromDevice::Input {
            run: RUN - 1,
            epoch: h.control.epoch(),
            seen_seq: 0,
            bytes: vec![],
        };
        let mut epoch = h.control.epoch();
        epoch.counter -= 1;
        let old_epoch = FromDevice::Resize {
            run: RUN,
            epoch,
            cols: 80,
            rows: 24,
        };
        for message in [old_run, old_epoch] {
            assert_eq!(check(&h, PHONE, SESSION, message), Err(RefuseReason::Stale));
        }
    }

    #[test]
    fn input_sent_before_the_device_saw_a_new_dialog_is_stale() {
        let (mut h, _) = host();
        h.dialog = Dialog {
            showing: true,
            changed_at_seq: Some(40),
        };
        assert_eq!(
            check(&h, PHONE, SESSION, input(&h, 39)),
            Err(RefuseReason::Stale)
        );
        assert_eq!(check(&h, PHONE, SESSION, input(&h, 40)), Ok(()));
    }

    #[test]
    fn a_size_outside_the_bounds_is_out_of_range() {
        let (h, _) = host();
        let too_big = MAX_SCREEN_SIDE + 1;
        for (cols, rows) in [(79, 24), (80, 0), (too_big, 24), (80, too_big)] {
            assert_eq!(
                check(&h, PHONE, SESSION, resize(&h, cols, rows)),
                Err(RefuseReason::OutOfRange),
                "{cols}x{rows}"
            );
        }
        assert_eq!(
            check(&h, PHONE, SESSION, resize(&h, MAX_SCREEN_SIDE, 250)),
            Ok(())
        );
    }

    // Row: Compose — as Input, plus no dialog showing.

    #[test]
    fn compose_while_a_dialog_shows_is_refused_but_input_is_not() {
        let (mut h, _) = host();
        h.dialog = Dialog {
            showing: true,
            changed_at_seq: Some(5),
        };
        assert_eq!(
            check(&h, PHONE, SESSION, compose(&h)),
            Err(RefuseReason::DialogOpen)
        );
        assert_eq!(check(&h, PHONE, SESSION, input(&h, 10)), Ok(()));
        h.dialog.showing = false;
        assert_eq!(check(&h, PHONE, SESSION, compose(&h)), Ok(()));
    }

    // Row: StartSession — role; project exists, folder approved.

    #[test]
    fn a_session_starts_only_in_an_approved_project_folder() {
        let (mut h, _) = host();
        assert_eq!(check(&h, PHONE, Stream::Control, start(false)), Ok(()));
        h.folder = ProjectFolder::NotAllowed;
        assert_eq!(
            check(&h, PHONE, Stream::Control, start(false)),
            Err(RefuseReason::FolderNotAllowed)
        );
        h.folder = ProjectFolder::NoSuchProject;
        assert_eq!(
            check(&h, PHONE, Stream::Control, start(false)),
            Err(RefuseReason::NoSuchProject)
        );
    }

    #[test]
    fn a_start_title_must_be_short_plain_text() {
        let (h, _) = host();
        let titled = |title: &str| FromDevice::StartSession {
            request_id: [3; 16],
            project_id: "p".into(),
            title: Some(title.into()),
            worktree: false,
        };
        assert_eq!(
            check(&h, PHONE, Stream::Control, titled("Fix the login bug")),
            Ok(())
        );
        for bad in [
            "",
            "x\u{1b}]0;evil\u{7}",
            "two\nlines",
            &"a".repeat(MAX_TITLE + 1),
        ] {
            assert_eq!(
                check(&h, PHONE, Stream::Control, titled(bad)),
                Err(RefuseReason::OutOfRange),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn a_viewer_may_not_start_a_session() {
        let (h, _) = host();
        assert_eq!(
            check(&h, VIEWER, Stream::Control, start(false)),
            Err(RefuseReason::NotAllowed)
        );
    }

    #[test]
    fn a_remote_start_may_not_set_up_a_worktree() {
        let (h, _) = host();
        assert_eq!(
            check(&h, PHONE, Stream::Control, start(true)),
            Err(RefuseReason::NotAllowed)
        );
    }

    // Row: PushToken — size.

    #[test]
    fn any_paired_device_may_send_a_push_token_of_a_sane_size() {
        let (h, _) = host();
        let token = |len| FromDevice::PushToken {
            key_id: 1,
            sealed: vec![0; len],
        };
        assert_eq!(
            check(&h, VIEWER, Stream::Control, token(MAX_SEALED_PUSH_TOKEN)),
            Ok(())
        );
        assert_eq!(
            check(
                &h,
                VIEWER,
                Stream::Control,
                token(MAX_SEALED_PUSH_TOKEN + 1)
            ),
            Err(RefuseReason::OutOfRange)
        );
    }

    // Row: anything else.

    #[test]
    fn an_unknown_message_is_refused_as_unknown() {
        let (h, now) = host();
        let unknown = Decoded::Unknown { tag: 99 };
        assert_eq!(
            authorize(&PHONE, Stream::Control, &unknown, &h, now),
            Err(RefuseReason::UnknownMessage)
        );
    }

    // At the write: the same checks, against the state at that moment.

    #[test]
    fn a_takeover_between_the_check_and_the_write_wins() {
        let (mut h, now) = host();
        let message = input(&h, 0);
        assert_eq!(check(&h, PHONE, SESSION, message.clone()), Ok(()));
        let write = PendingWrite::of(&message).expect("a write");
        h.control.host_typed(now);
        assert_eq!(
            recheck_at_write(&PHONE, S, &write, &h),
            Err(RefuseReason::NotInControl)
        );
    }

    #[test]
    fn a_dialog_that_appears_before_the_write_wins() {
        let (mut h, _) = host();
        let write = PendingWrite::of(&input(&h, 3)).expect("a write");
        assert_eq!(recheck_at_write(&PHONE, S, &write, &h), Ok(()));
        h.dialog = Dialog {
            showing: true,
            changed_at_seq: Some(4),
        };
        assert_eq!(
            recheck_at_write(&PHONE, S, &write, &h),
            Err(RefuseReason::Stale)
        );
        let compose = PendingWrite::of(&compose(&h)).expect("a write");
        assert_eq!(
            recheck_at_write(&PHONE, S, &compose, &h),
            Err(RefuseReason::DialogOpen)
        );
    }

    #[test]
    fn a_device_removed_before_the_write_is_refused() {
        let (mut h, _) = host();
        let write = PendingWrite::of(&input(&h, 0)).expect("a write");
        h.devices.remove(&PHONE);
        assert_eq!(
            recheck_at_write(&PHONE, S, &write, &h),
            Err(RefuseReason::NotPaired)
        );
    }

    #[test]
    fn only_input_compose_and_resize_are_writes() {
        let (h, _) = host();
        assert!(PendingWrite::of(&input(&h, 0)).is_some());
        assert!(PendingWrite::of(&compose(&h)).is_some_and(|w| w.compose));
        assert!(PendingWrite::of(&resize(&h, 80, 24)).is_some_and(|w| w.seen_seq.is_none()));
        assert_eq!(PendingWrite::of(&FromDevice::Resync), None);
    }

    #[test]
    fn a_holder_check_names_the_device() {
        // Control held by another device is not this device's control.
        let (mut h, now) = host();
        h.control.take([7; 32], now).expect("taken");
        assert_eq!(h.control.holder(), Holder::Device([7; 32]));
        assert_eq!(
            check(&h, PHONE, SESSION, input(&h, 0)),
            Err(RefuseReason::NotInControl)
        );
    }
}
