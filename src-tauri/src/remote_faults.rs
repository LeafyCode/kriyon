//! The fault tests of the remote protocol spec, §11: each fault ends in the
//! behaviour the spec gives it, with no lost session and no replayed input.
//!
//! These run the real host side ([`crate::remote_serve`] on a real host
//! endpoint, its daemon faked by the test) against the real device side
//! ([`DeviceRuntime`]) over loopback, and assert what the person sees: the
//! link's state, the screen, and what reached the PTY.
//!
//! Where each §11 fault is tested:
//!
//! | Fault | Test |
//! |---|---|
//! | Cut the network mid-stream | `a_link_cut_mid_stream_reconnects_and_redraws_without_replaying_input` |
//! | Sleep and wake the host | `a_host_asleep_past_the_heartbeat_shows_lost_then_recovers` |
//! | Kill and restart the relay | not yet: there is no relay support (plan, later steps) |
//! | Crash the host mid-write | `a_host_that_crashed_mid_write_comes_back_with_nothing_replayed` |
//! | A slow device beside a fast one | `remote_serve::a_slow_device_skips_ahead_while_a_fast_one_follows`, `fanout::a_slow_device_skips_ahead_alone` |
//! | A device that never reads its control stream | `a_device_that_never_reads_its_control_stream_is_closed_too_slow` |
//! | A stale epoch after a takeover | `remote_serve::typing_from_before_another_device_took_over_is_refused`, `authorize::input_for_an_old_run_or_epoch_is_stale` |
//! | Input buffered across a reconnect | the cut, sleep and crash tests here, `remote_serve::a_device_that_drops_gives_control_back_to_the_host`, `remote_serve::a_device_that_reconnects_before_its_old_connection_goes_must_take_control_again` |
//! | A dialog after `seen_seq` | `remote_serve::typing_from_before_a_dialog_appeared_is_refused`, `writer::a_dialog_that_appeared_before_the_write_makes_it_stale` |
//! | A resend of `StartSession` | not yet: remote starts are refused until `create_session` runs without the webview |
//! | An oversize length prefix | `an_oversize_length_ends_that_stream_and_nothing_else`, `codec::a_length_over_the_direction_limit_fails_from_the_header_alone` |
//! | A zstd bomb | `compress::a_small_frame_that_unpacks_past_the_cap_is_refused`, `device_view::a_frame_that_does_not_unpack_asks_for_a_snapshot` |
//! | An unknown message | `an_unknown_message_is_refused_and_the_link_goes_on`, `codec::an_unknown_tag_is_skipped_and_the_next_message_still_reads` |
//! | A device removed while connected | `a_device_removed_while_watching_shows_removed_and_stops` |
//! | A leaked pairing QR used first | `loopback::a_phone_that_lost_the_race_to_a_leaked_qr_shows_no_code` |
//!
//! Each runs in a few seconds: the device counts the host lost after
//! [`LOST_AFTER`] here, not the spec's 40 s.

use kriyon_remote::device_view::LinkState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use kriyon_remote::codec::Decoded;
use kriyon_remote::device_view::ScreenEvent;
use kriyon_remote::link_policy::CloseCode;
use kriyon_remote::message::{EndpointId, FromDevice, Holder, RefuseReason, Role, ToDevice};
use parking_lot::Mutex;

use crate::remote_test_support::{
    answer, asked, device, next, on_loopback, run, wait_until, world, world_on, RecordingEvents,
    World,
};
use kriyon_remote_link::device_runtime::{
    DeviceError, DeviceEvents, DeviceRuntime, HostEntry, ScreenSink, StartError, Timing,
};

/// How long the device here waits on a quiet host before it counts it lost.
const LOST_AFTER: Duration = Duration::from_millis(600);

/// How long a test waits for something before it fails.
const PATIENCE: Duration = Duration::from_secs(10);

/// The host's heartbeat, from the test, which can stop it (the host asleep).
/// Stops for good when dropped.
struct Beats {
    asleep: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Beats {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Beats {
    fn start(world: &World) -> Self {
        let asleep = Arc::new(AtomicBool::new(false));
        let quiet = Arc::clone(&asleep);
        let serve = world.serve.clone();
        let task = tokio::spawn(async move {
            let mut at = 0;
            loop {
                if !quiet.load(Ordering::Relaxed) {
                    at += 100;
                    serve.heartbeat(at);
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        });
        Self { asleep, task }
    }

    fn sleep(&self) {
        self.asleep.store(true, Ordering::Relaxed);
    }

    fn wake(&self) {
        self.asleep.store(false, Ordering::Relaxed);
    }
}

/// This computer as a device of the world's host: what the person sees is
/// the link's state and the host view (`seen`), and the open session's
/// screen.
struct Phone {
    rt: DeviceRuntime,
    me: EndpointId,
    host: EndpointId,
    seen: Arc<RecordingEvents>,
    screen: Arc<Mutex<Vec<ScreenEvent>>>,
}

impl Phone {
    /// A paired phone of `role`, connected to `world`.
    async fn connect(world: &World, key: u8, role: Role) -> Self {
        let rt = DeviceRuntime::with_timing(Timing {
            lost_after: LOST_AFTER,
            tick: Duration::from_millis(50),
        });
        let me = on_loopback(&rt, [key; 32]).await;
        world.fake.paired.lock().insert(me, role);
        let seen = Arc::new(RecordingEvents::default());
        let host = world.host.id();
        rt.connect(
            HostEntry {
                id: host,
                addr: world.host.addr(),
            },
            Arc::clone(&seen) as Arc<dyn DeviceEvents>,
        )
        .await
        .expect("connects");
        let phone = Self {
            rt,
            me,
            host,
            seen,
            screen: Arc::default(),
        };
        phone.until_state(LinkState::Connected).await;
        phone
    }

    fn state(&self) -> Option<LinkState> {
        self.seen.state()
    }

    async fn until_state(&self, state: LinkState) {
        wait_until(&format!("{state:?}"), || self.state() == Some(state)).await;
    }

    /// Open session "s"; its screen events are kept in `seen.screen`.
    async fn open(&self) {
        let screen = Arc::clone(&self.screen);
        let sink: ScreenSink = Arc::new(move |event| screen.lock().push(event));
        self.rt
            .open_session(&self.host, "s", sink)
            .await
            .expect("opens");
    }

    /// Wait until the screen shows `bytes` as a whole new screen.
    async fn until_screen(&self, bytes: &[u8]) {
        wait_until(
            &format!("the screen {:?}", String::from_utf8_lossy(bytes)),
            || {
                self.screen.lock().iter().any(
                    |event| matches!(event, ScreenEvent::Screen { bytes: b, .. } if b == bytes),
                )
            },
        )
        .await;
    }

    fn holds_control(&self) -> bool {
        self.seen.last().is_some_and(|(_, view)| {
            view.control
                .get("s")
                .is_some_and(|control| control.holder == Holder::Device(self.me))
        })
    }

    /// Take control of "s" and wait until the host says this phone holds it.
    async fn take_control(&self) {
        self.rt.take_control(&self.host, "s").await.expect("asks");
        wait_until("control", || self.holds_control()).await;
    }

    async fn typed_ack(&self) {
        wait_until("a receipt", || {
            self.screen
                .lock()
                .iter()
                .any(|event| matches!(event, ScreenEvent::InputAck { written: true, .. }))
        })
        .await;
    }
}

/// Session "s" open on `phone`, showing `screen` from the fake daemon.
async fn watching(world: &World, phone: &Phone, screen: &[u8]) {
    phone.open().await;
    let id = asked(world).await;
    answer(world, id, screen);
    phone.until_screen(screen).await;
}

#[test]
fn a_link_cut_mid_stream_reconnects_and_redraws_without_replaying_input() {
    run(async {
        let world = world().await;
        let _beats = Beats::start(&world);
        let phone = Phone::connect(&world, 3, Role::Controller).await;
        watching(&world, &phone, b"before").await;
        phone.take_control().await;
        phone
            .rt
            .input(&phone.host, "s", b"a".to_vec())
            .await
            .expect("types");
        phone.typed_ack().await;

        // The connection drops mid-stream.
        world.host.reconnect(&phone.me);
        wait_until("the drop", || phone.state() != Some(LinkState::Connected)).await;
        assert!(
            phone
                .rt
                .input(&phone.host, "s", b"lost".to_vec())
                .await
                .is_err(),
            "typing is off while the link is down"
        );

        // It comes back by itself, and the open session is drawn afresh.
        phone.rt.wake();
        phone.until_state(LinkState::Connected).await;
        let id = asked(&world).await;
        answer(&world, id, b"after");
        phone.until_screen(b"after").await;

        // Control went back to the host with the drop: nothing typed before
        // it can land, and typing needs control again.
        assert_eq!(
            phone.rt.input(&phone.host, "s", b"stale".to_vec()).await,
            Err(DeviceError::NoControl)
        );
        phone.take_control().await;
        phone
            .rt
            .input(&phone.host, "s", b"b".to_vec())
            .await
            .expect("types");
        wait_until("the new typing", || {
            world.fake.typed.lock().as_slice() == b"ab"
        })
        .await;
        assert_eq!(
            world.fake.typed.lock().as_slice(),
            b"ab",
            "nothing replayed"
        );
    });
}

fn note(key: &str, text: &str) -> kriyon_core::readable::Keyed {
    kriyon_core::readable::Keyed {
        key: key.into(),
        kind: kriyon_remote::message::EntryKind::Note { text: text.into() },
    }
}

#[test]
fn a_phone_reads_a_session_as_entries_across_a_dropped_link() {
    use kriyon_remote::device_view::EntriesEvent;
    run(async {
        let world = world().await;
        let _beats = Beats::start(&world);
        *world.fake.entries.lock() = Ok(vec![note("a", "A")]);
        let phone = Phone::connect(&world, 3, Role::Viewer).await;
        watching(&world, &phone, b"x").await;
        let seen: Arc<Mutex<Vec<EntriesEvent>>> = Arc::default();
        let into = Arc::clone(&seen);
        phone
            .rt
            .read_entries(
                &phone.host,
                "s",
                Arc::new(move |event| into.lock().push(event)),
            )
            .await
            .expect("reads");
        let texts = |seen: &Mutex<Vec<EntriesEvent>>| -> Vec<String> {
            match seen.lock().last() {
                Some(EntriesEvent::Entries(entries)) => entries
                    .iter()
                    .map(|entry| format!("{:?}", entry.kind))
                    .collect(),
                _ => Vec::new(),
            }
        };
        wait_until("the first entry", || texts(&seen).len() == 1).await;
        *world.fake.entries.lock() = Ok(vec![note("a", "A"), note("b", "B")]);
        wait_until("the second", || texts(&seen).len() == 2).await;

        // The link drops; meanwhile a third entry is made. Back, the phone
        // asks from what it has and keeps the two.
        world.host.reconnect(&phone.me);
        wait_until("the drop", || phone.state() != Some(LinkState::Connected)).await;
        *world.fake.entries.lock() = Ok(vec![note("a", "A"), note("b", "B"), note("c", "C")]);
        phone.rt.wake();
        phone.until_state(LinkState::Connected).await;
        let id = asked(&world).await;
        answer(&world, id, b"y");
        wait_until("the third", || texts(&seen).len() == 3).await;

        // Back to the terminal: the host stops building for this phone.
        phone.rt.stop_entries(&phone.host, "s").await;
        tokio::time::sleep(Duration::from_secs(2)).await;
        let builds = world.fake.builds.load(Ordering::Relaxed);
        *world.fake.entries.lock() = Ok(vec![note("a", "A"), note("d", "D")]);
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(world.fake.builds.load(Ordering::Relaxed), builds);
    });
}

#[test]
fn a_host_asleep_past_the_heartbeat_shows_lost_then_recovers() {
    run(async {
        let world = world().await;
        let beats = Beats::start(&world);
        let phone = Phone::connect(&world, 3, Role::Controller).await;
        watching(&world, &phone, b"awake").await;
        phone.take_control().await;

        // The host sleeps: no heartbeat, but the socket is still there.
        beats.sleep();
        phone.until_state(LinkState::Lost).await;
        assert!(
            phone
                .rt
                .input(&phone.host, "s", b"x".to_vec())
                .await
                .is_err(),
            "typing is off while lost"
        );

        // It wakes: the device dials again and redraws.
        beats.wake();
        phone.rt.wake();
        phone.until_state(LinkState::Connected).await;
        let id = asked(&world).await;
        answer(&world, id, b"woke");
        phone.until_screen(b"woke").await;
        assert!(!phone.holds_control(), "control is asked for again");
        assert_eq!(world.fake.typed.lock().as_slice(), b"", "nothing replayed");
    });
}

#[test]
fn a_host_that_crashed_mid_write_comes_back_with_nothing_replayed() {
    run(async {
        let world = world().await;
        // The restarted host listens where this one does: where the device dials.
        let port = world
            .host
            .addr()
            .ip_addrs()
            .copied()
            .find(std::net::SocketAddr::is_ipv4)
            .expect("a loopback address");
        let _beats = Beats::start(&world);
        let phone = Phone::connect(&world, 3, Role::Controller).await;
        watching(&world, &phone, b"before").await;
        phone.take_control().await;

        // Typing, and the host goes down as it arrives.
        let _ = phone.rt.input(&phone.host, "s", b"mid".to_vec()).await;
        world.host.close().await;
        wait_until("the crash", || phone.state() != Some(LinkState::Connected)).await;
        drop(world);

        // The app starts again; the session lived on in its daemon.
        let world = world_on(port).await;
        let _beats = Beats::start(&world);
        world.fake.paired.lock().insert(phone.me, Role::Controller);
        phone.rt.wake();
        phone.until_state(LinkState::Connected).await;
        let id = asked(&world).await;
        answer(&world, id, b"after");
        phone.until_screen(b"after").await;
        assert!(!phone.holds_control(), "a new app start gives no control");

        // Typing again needs control again, and only the new typing lands.
        phone.take_control().await;
        phone
            .rt
            .input(&phone.host, "s", b"new".to_vec())
            .await
            .expect("types");
        wait_until("the new typing", || !world.fake.typed.lock().is_empty()).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(
            world.fake.typed.lock().as_slice(),
            b"new",
            "nothing replayed"
        );
    });
}

#[test]
fn a_device_removed_while_watching_shows_removed_and_stops() {
    run(async {
        let world = world().await;
        let _beats = Beats::start(&world);
        let phone = Phone::connect(&world, 3, Role::Controller).await;
        watching(&world, &phone, b"screen").await;
        phone.take_control().await;

        world.fake.paired.lock().remove(&phone.me);
        world.host.cut_off(&phone.me);
        phone.until_state(LinkState::Removed).await;
        assert!(phone
            .rt
            .input(&phone.host, "s", b"x".to_vec())
            .await
            .is_err());
        // It doesn't come back.
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(phone.state(), Some(LinkState::Removed));
        assert_eq!(world.fake.typed.lock().as_slice(), b"");
    });
}

#[test]
fn a_device_that_never_reads_its_control_stream_is_closed_too_slow() {
    run(async {
        let world = world().await;
        // Says hello, then never reads again.
        let (_stuck, stuck_link, _stuck_writer, _stuck_reader) =
            device(&world, 3, Role::Viewer).await;
        let (_ok, _ok_link, _ok_writer, mut ok_reader) = device(&world, 4, Role::Viewer).await;
        // The other device keeps reading.
        let heard = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let hearing = Arc::clone(&heard);
        tokio::spawn(async move {
            while let Ok(Some(Decoded::Message(message))) = ok_reader.next().await {
                if let ToDevice::Heartbeat { at, .. } = message {
                    hearing.store(at, Ordering::Relaxed);
                }
            }
        });

        // Session changes pile up behind the stuck device until its queue
        // is full: a few KiB each, as a long title makes them.
        let deadline = Instant::now() + PATIENCE;
        let mut at = 0;
        let code = loop {
            for _ in 0..20 {
                at += 1;
                *world.fake.title.lock() = format!("{at:>4000}");
                world.serve.sessions_changed();
            }
            if let Ok(code) =
                tokio::time::timeout(Duration::from_millis(1), stuck_link.closed()).await
            {
                break code;
            }
            assert!(
                Instant::now() < deadline,
                "the stuck device was never closed"
            );
        };
        assert_eq!(code, Some(CloseCode::TooSlow));

        // The host is unaffected: the other device still hears it.
        world.serve.heartbeat(at + 1);
        wait_until("the other device's heartbeat", || {
            heard.load(Ordering::Relaxed) == at + 1
        })
        .await;
    });
}

#[test]
fn an_unknown_message_is_refused_and_the_link_goes_on() {
    run(async {
        let world = world().await;
        let (_phone, _link, mut writer, mut reader) = device(&world, 3, Role::Viewer).await;
        // Length 2: tag 120 (one varint byte), then a body byte.
        writer
            .send_encoded(&[0, 0, 0, 2, 120, 7])
            .await
            .expect("sent");
        assert_eq!(
            next(&mut reader).await,
            ToDevice::Refused {
                reason: RefuseReason::UnknownMessage
            }
        );
        world.serve.heartbeat(42);
        assert!(matches!(
            next(&mut reader).await,
            ToDevice::Heartbeat { at: 42, .. }
        ));
    });
}

#[test]
fn an_oversize_length_ends_that_stream_and_nothing_else() {
    run(async {
        let world = world().await;
        let (_phone, link, _cw, mut control) = device(&world, 3, Role::Viewer).await;
        let (mut writer, mut reader) = link.open_stream().await.expect("stream");
        // Claims 4 GiB: refused from the header, never buffered.
        writer
            .send_encoded(&[0xFF, 0xFF, 0xFF, 0xFF, 0])
            .await
            .expect("sent");
        let ended = tokio::time::timeout(PATIENCE, reader.next())
            .await
            .expect("the stream ends");
        assert!(!matches!(ended, Ok(Some(Decoded::Message(_)))), "{ended:?}");
        // The link and its control stream are fine.
        world.serve.heartbeat(7);
        assert!(matches!(
            next(&mut control).await,
            ToDevice::Heartbeat { at: 7, .. }
        ));
        let (mut again, mut screen) = link.open_stream().await.expect("another stream");
        again
            .send(&FromDevice::Open {
                session_id: "s".into(),
            })
            .await
            .expect("open");
        let id = asked(&world).await;
        answer(&world, id, b"fine");
        assert!(matches!(next(&mut screen).await, ToDevice::Snapshot { .. }));
    });
}

#[test]
fn a_session_opened_while_reconnecting_is_drawn_once_back() {
    run(async {
        let world = world().await;
        let beats = Beats::start(&world);
        let phone = Phone::connect(&world, 3, Role::Viewer).await;
        beats.sleep();
        phone.until_state(LinkState::Lost).await;
        phone.open().await;
        beats.wake();
        phone.rt.wake();
        phone.until_state(LinkState::Connected).await;
        let id = asked(&world).await;
        answer(&world, id, b"late");
        phone.until_screen(b"late").await;
    });
}

// Remote starts: a device starts a session, sees it, and a resend across a
// reconnect still makes one.

/// A world whose project "p" may be started in, a start making session "s".
async fn startable() -> World {
    let world = world().await;
    world.fake.folders.lock().insert(
        "p".into(),
        kriyon_remote::authorize::ProjectFolder::Approved,
    );
    *world.fake.start_result.lock() = Ok("s".into());
    world
}

impl Phone {
    async fn until_projects(&self) {
        wait_until("the project list", || {
            self.seen
                .last()
                .is_some_and(|(_, view)| view.projects.iter().any(|project| project.id == "p"))
        })
        .await;
    }
}

#[test]
fn a_controller_starts_a_session_then_sees_its_screen() {
    run(async {
        let world = startable().await;
        let _beats = Beats::start(&world);
        let phone = Phone::connect(&world, 3, Role::Controller).await;
        phone.until_projects().await;
        let started = phone
            .rt
            .start_session(&phone.host, "p", Some("Fix login".into()))
            .await;
        assert_eq!(started, Ok("s".to_string()));
        let asked_for = world.fake.starts.lock().clone();
        assert_eq!(asked_for.len(), 1);
        assert_eq!(asked_for[0].1.title.as_deref(), Some("Fix login"));
        watching(&world, &phone, b"the new session").await;
    });
}

#[test]
fn a_start_resent_across_a_reconnect_makes_one_session() {
    run(async {
        let world = startable().await;
        let _beats = Beats::start(&world);
        *world.fake.start_delay.lock() = Duration::from_millis(800);
        let phone = Arc::new(Phone::connect(&world, 3, Role::Controller).await);
        phone.until_projects().await;
        let starting = {
            let phone = Arc::clone(&phone);
            tokio::spawn(async move { phone.rt.start_session(&phone.host, "p", None).await })
        };
        wait_until("the start reaching the host", || {
            !world.fake.starts.lock().is_empty()
        })
        .await;
        // The link drops before the answer comes.
        world.host.reconnect(&phone.me);
        wait_until("the drop", || phone.state() != Some(LinkState::Connected)).await;
        phone.rt.wake();
        let started = tokio::time::timeout(PATIENCE, starting)
            .await
            .expect("answered after the reconnect")
            .expect("task");
        assert_eq!(started, Ok("s".to_string()));
        assert_eq!(world.fake.starts.lock().len(), 1, "one session, not two");
    });
}

#[test]
fn a_viewer_cant_start_and_is_told_why_in_words() {
    run(async {
        let world = startable().await;
        let _beats = Beats::start(&world);
        let phone = Phone::connect(&world, 3, Role::Viewer).await;
        phone.until_projects().await;
        let refused = phone.rt.start_session(&phone.host, "p", None).await;
        assert_eq!(refused, Err(StartError::Refused(RefuseReason::NotAllowed)));
        assert_eq!(
            refused.expect_err("refused").words(),
            "This device isn't allowed to do that."
        );
        assert!(world.fake.starts.lock().is_empty());
    });
}
