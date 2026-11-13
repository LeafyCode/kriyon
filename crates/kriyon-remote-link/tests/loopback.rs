//! A host and devices in one process, over loopback, relay off.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use iroh::EndpointAddr;
use kriyon_remote::codec::Decoded;
use kriyon_remote::link_policy::{CloseCode, CodeCheck};
use kriyon_remote::message::{FromDevice, RefuseReason, Role, ToDevice};
use kriyon_remote_link::device::{stay_connected, Device};
use kriyon_remote_link::host::{Accepted, Host, PairedDevices};
use kriyon_remote_link::test_support::{loopback_config, MemoryPaired};
use kriyon_remote_link::{LinkConfig, LinkError};
use tokio::time::timeout;

const WAIT: Duration = Duration::from_secs(10);
const SECRET: [u8; 32] = [7; 32];

/// The host's paired devices.
type Store = MemoryPaired;

fn config(key: u8) -> LinkConfig {
    loopback_config(key)
}

async fn host(store: &Arc<Store>, unpaired_per_minute: u32) -> Host {
    let paired: Arc<dyn PairedDevices> = store.clone();
    Host::bind(&config(1), paired, unpaired_per_minute)
        .await
        .expect("host binds")
}

/// The host's id and its loopback address: what a QR code would carry.
fn reach(host: &Host) -> EndpointAddr {
    host.addr()
}

async fn device(key: u8) -> Device {
    Device::bind(&config(key)).await.expect("device binds")
}

async fn next_accepted(host: &Host) -> Accepted {
    timeout(WAIT, host.accept())
        .await
        .expect("in time")
        .expect("endpoint open")
}

/// Pair `device` as `role` the way the person would: the host shows a QR,
/// the device shows a code, the person types it into the host.
async fn pair(host: Arc<Host>, store: &Arc<Store>, device: &Device, role: Role) {
    host.start_pairing(SECRET, role);
    let host_side = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let Accepted::Pair(link) = next_accepted(&host).await else {
                panic!("a pairing connection");
            };
            link.request().await.expect("the right proof")
        })
    };
    let pairing = device
        .pair(reach(&host), &SECRET, "Test phone")
        .await
        .expect("the device pairs");
    let mut attempt = host_side.await.expect("host task");
    assert_eq!(attempt.name(), "Test phone");
    assert_eq!(attempt.device(), device.id());
    // The person types the code the device shows, while the device waits.
    let code = pairing.code().to_string();
    let (check, answer) = tokio::join!(
        attempt.confirm(&code, "Test Mac", |device, role| {
            store.add(device, role);
            true
        }),
        pairing.finish()
    );
    let check = check.expect("told");
    assert_eq!(
        check,
        CodeCheck::Paired {
            device: device.id(),
            role
        },
        "the code derived on both ends is the same"
    );
    assert_eq!(answer, Ok("Test Mac".to_string()));
}

#[tokio::test]
async fn a_device_pairs_end_to_end_with_the_code_both_ends_derive() {
    let store = Arc::new(Store::default());
    let host = Arc::new(host(&store, 10).await);
    let phone = device(2).await;
    pair(Arc::clone(&host), &store, &phone, Role::Controller).await;
    assert_eq!(store.role(&phone.id()), Some(Role::Controller));
}

#[tokio::test]
async fn a_wrong_code_typed_three_times_burns_the_pairing() {
    let store = Arc::new(Store::default());
    let host = Arc::new(host(&store, 10).await);
    let phone = device(2).await;
    host.start_pairing(SECRET, Role::Viewer);
    let host_side = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let Accepted::Pair(link) = next_accepted(&host).await else {
                panic!("a pairing connection");
            };
            let mut attempt = link.request().await.expect("the right proof");
            let mut last = None;
            for wrong in ["000000", "000001", "000002"] {
                last = Some(
                    attempt
                        .confirm(wrong, "Test Mac", |_, _| -> bool {
                            panic!("nothing is stored")
                        })
                        .await
                        .expect("told"),
                );
            }
            last
        })
    };
    let pairing = phone
        .pair(reach(&host), &SECRET, "Test phone")
        .await
        .expect("connects");
    let (host_result, answer) = tokio::join!(host_side, pairing.finish());
    assert_eq!(host_result.expect("host task"), Some(CodeCheck::Burned));
    assert_eq!(answer, Err(LinkError::Refused(RefuseReason::NotPaired)));
}

#[tokio::test]
async fn pairing_is_refused_when_none_is_pending() {
    let store = Arc::new(Store::default());
    let host = Arc::new(host(&store, 10).await);
    let accept = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.accept().await.is_some() })
    };
    let phone = device(2).await;
    let result = timeout(WAIT, phone.pair(reach(&host), &SECRET, "Test phone"))
        .await
        .expect("in time");
    assert!(result.is_err(), "no pairing pending");
    assert!(!accept.is_finished(), "nothing reached the app");
    accept.abort();
}

#[tokio::test]
async fn a_wrong_secret_is_refused() {
    let store = Arc::new(Store::default());
    let host = Arc::new(host(&store, 10).await);
    host.start_pairing(SECRET, Role::Viewer);
    let host_side = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let Accepted::Pair(link) = next_accepted(&host).await else {
                panic!("a pairing connection");
            };
            link.request().await.err()
        })
    };
    let phone = device(2).await;
    // The device hears the refusal before it would show a code.
    let pairing = timeout(WAIT, phone.pair(reach(&host), &[8; 32], "Test phone"))
        .await
        .expect("in time");
    assert_eq!(
        pairing.err(),
        Some(LinkError::Refused(RefuseReason::NotPaired))
    );
    assert_eq!(
        host_side.await.expect("host task"),
        Some(LinkError::Refused(RefuseReason::NotPaired))
    );
}

#[tokio::test]
async fn a_session_stream_carries_a_snapshot_then_updates() {
    let store = Arc::new(Store::default());
    let host = Arc::new(host(&store, 10).await);
    let phone = device(2).await;
    pair(Arc::clone(&host), &store, &phone, Role::Viewer).await;

    let host_side = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let Accepted::Remote(link) = next_accepted(&host).await else {
                panic!("a remote connection");
            };
            assert_eq!(link.role(), Role::Viewer);
            let (mut control_out, mut control_in) = link.accept_stream().await.expect("control");
            let hello = control_in.next().await.expect("reads");
            assert!(matches!(
                hello,
                Some(Decoded::Message(FromDevice::Hello { .. }))
            ));
            control_out
                .send(&ToDevice::Heartbeat { seq: 1, at: 0 })
                .await
                .expect("sends");
            let (mut out, mut incoming) = link.accept_stream().await.expect("session");
            let open = incoming.next().await.expect("reads");
            assert_eq!(
                open,
                Some(Decoded::Message(FromDevice::Open {
                    session_id: "s1".into(),
                    screen: true,
                }))
            );
            out.send(&ToDevice::Snapshot {
                run: 9,
                seq: 0,
                cols: 80,
                rows: 24,
                bytes: b"screen".to_vec(),
                skipped: false,
            })
            .await
            .expect("sends");
            for seq in 1..=2 {
                out.send(&ToDevice::Update {
                    run: 9,
                    seq,
                    bytes: vec![u8::try_from(seq).expect("small")],
                })
                .await
                .expect("sends");
            }
            // Keep the connection until the device has read it all.
            link
        })
    };

    let link = timeout(WAIT, phone.connect(reach(&host)))
        .await
        .expect("in time")
        .expect("connects");
    let (mut control_out, mut control_in) = link.open_stream().await.expect("control");
    control_out
        .send(&FromDevice::Hello {
            app_version: "1".into(),
            protocol_minor: 0,
        })
        .await
        .expect("sends");
    assert_eq!(
        control_in.next().await.expect("reads"),
        Some(Decoded::Message(ToDevice::Heartbeat { seq: 1, at: 0 }))
    );
    let (mut out, mut incoming) = link.open_stream().await.expect("session");
    out.send(&FromDevice::Open {
        session_id: "s1".into(),
        screen: true,
    })
    .await
    .expect("sends");
    let mut got = Vec::new();
    for _ in 0..3 {
        got.push(incoming.next().await.expect("reads"));
    }
    assert!(matches!(
        got[0],
        Some(Decoded::Message(ToDevice::Snapshot { seq: 0, .. }))
    ));
    assert!(matches!(
        got[1],
        Some(Decoded::Message(ToDevice::Update { seq: 1, .. }))
    ));
    assert!(matches!(
        got[2],
        Some(Decoded::Message(ToDevice::Update { seq: 2, .. }))
    ));
    drop(host_side.await.expect("host task"));
}

#[tokio::test]
async fn an_unpaired_device_is_closed_as_not_paired_and_stops_retrying() {
    let store = Arc::new(Store::default());
    let host = Arc::new(host(&store, 10).await);
    let accept = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.accept().await.is_some() })
    };
    let stranger = device(3).await;
    let ended = timeout(
        WAIT,
        stay_connected(&stranger, reach(&host), |link| async move {
            (false, link.closed().await)
        }),
    )
    .await
    .expect("gives up in time, without backing off");
    assert_eq!(ended, LinkError::Closed(Some(CloseCode::NotPaired)));
    assert!(!accept.is_finished(), "nothing reached the app");
    accept.abort();
}

#[tokio::test]
async fn a_removed_device_is_cut_off_and_cannot_come_back() {
    let store = Arc::new(Store::default());
    let host = Arc::new(host(&store, 10).await);
    let phone = device(2).await;
    pair(Arc::clone(&host), &store, &phone, Role::Controller).await;

    let host_side = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let Accepted::Remote(link) = next_accepted(&host).await else {
                panic!("a remote connection");
            };
            link
        })
    };
    let link = timeout(WAIT, phone.connect(reach(&host)))
        .await
        .expect("in time")
        .expect("connects");
    let (mut out, _incoming) = link.open_stream().await.expect("control");
    out.send(&FromDevice::Hello {
        app_version: "1".into(),
        protocol_minor: 0,
    })
    .await
    .expect("sends");
    let _held = host_side.await.expect("host task");

    store.remove(&phone.id());
    host.cut_off(&phone.id());
    assert_eq!(
        timeout(WAIT, link.closed()).await.expect("in time"),
        Some(CloseCode::NotPaired)
    );
    // The host keeps accepting, as it always does; nothing gets through.
    let accept = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.accept().await.is_some() })
    };
    let again = timeout(WAIT, phone.connect(reach(&host)))
        .await
        .expect("in time");
    let refused = match again {
        Ok(link) => timeout(WAIT, link.closed()).await.expect("in time"),
        Err(LinkError::Closed(code)) => code,
        Err(other) => panic!("{other:?}"),
    };
    assert_eq!(refused, Some(CloseCode::NotPaired));
    assert!(!accept.is_finished(), "nothing reached the app");
    accept.abort();
}

#[tokio::test]
async fn a_source_refused_too_often_is_ignored() {
    let store = Arc::new(Store::default());
    let host = Arc::new(host(&store, 2).await);
    let accept = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.accept().await.is_some() })
    };
    let stranger = device(3).await;
    for _ in 0..2 {
        let link = timeout(WAIT, stranger.connect(reach(&host)))
            .await
            .expect("answered in time");
        if let Ok(link) = link {
            assert_eq!(
                timeout(WAIT, link.closed()).await.expect("in time"),
                Some(CloseCode::NotPaired)
            );
        }
    }
    // Over the limit: the host doesn't answer at all.
    let third = timeout(Duration::from_secs(3), stranger.connect(reach(&host))).await;
    assert!(third.is_err(), "the host should ignore it, got {third:?}");
    accept.abort();
}

#[tokio::test]
async fn a_device_may_have_at_most_sixteen_streams_open() {
    let store = Arc::new(Store::default());
    let host = Arc::new(host(&store, 10).await);
    let phone = device(2).await;
    pair(Arc::clone(&host), &store, &phone, Role::Viewer).await;
    let host_side = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let Accepted::Remote(link) = next_accepted(&host).await else {
                panic!("a remote connection");
            };
            let mut streams = Vec::new();
            while let Ok(Ok(stream)) = timeout(Duration::from_secs(3), link.accept_stream()).await {
                streams.push(stream);
            }
            streams.len()
        })
    };
    let link = timeout(WAIT, phone.connect(reach(&host)))
        .await
        .expect("in time")
        .expect("connects");
    let mut opened = Vec::new();
    for _ in 0..17 {
        let Ok(Ok((mut out, incoming))) = timeout(Duration::from_secs(2), link.open_stream()).await
        else {
            break;
        };
        // A stream reaches the host only once something is sent on it.
        out.send(&FromDevice::Resync).await.expect("sends");
        opened.push((out, incoming));
    }
    assert_eq!(opened.len(), 16, "the seventeenth waits");
    assert_eq!(host_side.await.expect("host task"), 16);
}

#[tokio::test]
async fn a_device_reconnects_when_the_host_drops_it_until_it_is_removed() {
    let store = Arc::new(Store::default());
    let host = Arc::new(host(&store, 10).await);
    let phone = device(2).await;
    pair(Arc::clone(&host), &store, &phone, Role::Viewer).await;

    let host_side = {
        let host = Arc::clone(&host);
        let store = Arc::clone(&store);
        let phone_id = phone.id();
        tokio::spawn(async move {
            // First connection: the host goes away for a moment.
            let Accepted::Remote(first) = next_accepted(&host).await else {
                panic!("a remote connection");
            };
            first.close(CloseCode::HostClosing);
            // The device comes back on its own; this time it is removed.
            let Accepted::Remote(_second) = next_accepted(&host).await else {
                panic!("a remote connection");
            };
            store.remove(&phone_id);
            host.cut_off(&phone_id);
            // Keep accepting: its next try must be refused.
            host.accept().await.is_some()
        })
    };
    let connections = Arc::new(Mutex::new(0));
    let counted = Arc::clone(&connections);
    let ended = timeout(
        WAIT,
        stay_connected(&phone, reach(&host), move |link| {
            let counted = Arc::clone(&counted);
            async move {
                *counted.lock().expect("lock") += 1;
                (true, link.closed().await)
            }
        }),
    )
    .await
    .expect("ends in time");
    assert_eq!(ended, LinkError::Closed(Some(CloseCode::NotPaired)));
    assert_eq!(*connections.lock().expect("lock"), 2);
    assert!(!host_side.is_finished(), "the removed device got nothing");
    host_side.abort();
}

#[tokio::test]
async fn a_device_that_dials_the_moment_it_is_paired_is_let_in() {
    let store = Arc::new(Store::default());
    let host = Arc::new(host(&store, 10).await);
    let phone = device(2).await;
    host.start_pairing(SECRET, Role::Viewer);
    let host_side = {
        let host = Arc::clone(&host);
        let store = Arc::clone(&store);
        tokio::spawn(async move {
            let Accepted::Pair(link) = next_accepted(&host).await else {
                panic!("a pairing connection");
            };
            let attempt = link.request().await.expect("the right proof");
            (attempt, store)
        })
    };
    let pairing = phone
        .pair(reach(&host), &SECRET, "Test phone")
        .await
        .expect("connects");
    let (mut attempt, store) = host_side.await.expect("host task");
    let code = pairing.code().to_string();
    let confirm = {
        let store = Arc::clone(&store);
        tokio::spawn(async move {
            attempt
                .confirm(&code, "Test Mac", |device, role| {
                    store.add(device, role);
                    true
                })
                .await
        })
    };
    assert_eq!(pairing.finish().await, Ok("Test Mac".to_string()));
    // Straight away, before the host's confirm has even returned.
    let accept = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { next_accepted(&host).await })
    };
    let link = timeout(WAIT, phone.connect(reach(&host)))
        .await
        .expect("in time")
        .expect("connects");
    let (mut out, _incoming) = link.open_stream().await.expect("control");
    out.send(&FromDevice::Resync).await.expect("sends");
    assert!(matches!(
        accept.await.expect("host task"),
        Accepted::Remote(_)
    ));
    assert!(confirm.await.expect("confirm task").is_ok());
}

#[tokio::test]
async fn an_attempt_from_an_earlier_pairing_cannot_confirm_a_newer_one() {
    let store = Arc::new(Store::default());
    let host = Arc::new(host(&store, 10).await);
    let first = device(2).await;
    let second = device(4).await;

    // The first device takes a pairing; the person then starts another.
    host.start_pairing(SECRET, Role::Controller);
    let host_side = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let Accepted::Pair(link) = next_accepted(&host).await else {
                panic!("a pairing connection");
            };
            link.request().await.expect("the right proof")
        })
    };
    let first_pairing = first
        .pair(reach(&host), &SECRET, "First")
        .await
        .expect("connects");
    let mut stale = host_side.await.expect("host task");

    let newer = [9; 32];
    host.start_pairing(newer, Role::Controller);
    let host_side = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let Accepted::Pair(link) = next_accepted(&host).await else {
                panic!("a pairing connection");
            };
            link.request().await.expect("the right proof")
        })
    };
    let second_pairing = second
        .pair(reach(&host), &newer, "Second")
        .await
        .expect("connects");
    let mut current = host_side.await.expect("host task");

    // The first device's code typed into its stale attempt pairs nobody.
    let first_code = first_pairing.code().to_string();
    let (check, answer) = tokio::join!(
        stale.confirm(&first_code, "Test Mac", |_, _| -> bool {
            panic!("nothing is stored")
        }),
        first_pairing.finish()
    );
    assert_eq!(check.expect("told"), CodeCheck::Burned);
    assert!(answer.is_err());

    // The newer pairing is untouched.
    let second_code = second_pairing.code().to_string();
    let (check, answer) = tokio::join!(
        current.confirm(&second_code, "Test Mac", |device, role| {
            store.add(device, role);
            true
        }),
        second_pairing.finish()
    );
    assert_eq!(
        check.expect("told"),
        CodeCheck::Paired {
            device: second.id(),
            role: Role::Controller
        }
    );
    assert_eq!(answer, Ok("Test Mac".to_string()));
    assert_eq!(store.role(&first.id()), None);
}

#[tokio::test]
async fn a_phone_that_lost_the_race_to_a_leaked_qr_shows_no_code() {
    let store = Arc::new(Store::default());
    let host = Arc::new(host(&store, 10).await);
    host.start_pairing(SECRET, Role::Controller);
    let host_side = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let mut attempts = Vec::new();
            for _ in 0..2 {
                let Accepted::Pair(link) = next_accepted(&host).await else {
                    panic!("a pairing connection");
                };
                attempts.push(link.request().await);
            }
            attempts
        })
    };
    // Someone with a photo of the QR gets there first.
    let thief = device(9).await;
    let stolen = thief
        .pair(reach(&host), &SECRET, "Not your phone")
        .await
        .expect("the leaked QR works once");
    assert_eq!(stolen.code().len(), 6);
    // The real phone is told pairing failed, and shows no code to type.
    let phone = device(2).await;
    let real = phone.pair(reach(&host), &SECRET, "Test phone").await;
    assert_eq!(
        real.err(),
        Some(LinkError::Refused(RefuseReason::NotPaired))
    );
    let attempts = host_side.await.expect("host task");
    assert!(attempts[0].is_ok());
    assert!(matches!(
        attempts[1],
        Err(LinkError::Refused(RefuseReason::NotPaired))
    ));
}

#[tokio::test]
async fn a_device_pairs_from_the_qr_text_alone() {
    use kriyon_remote::pairing::PairingInvite;
    use kriyon_remote_link::invite::{host_addr, invite};

    let store = Arc::new(Store::default());
    let host = Arc::new(host(&store, 10).await);
    host.start_pairing(SECRET, Role::Viewer);
    let qr = invite(&host, SECRET).to_qr_text();

    let host_side = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let Accepted::Pair(link) = next_accepted(&host).await else {
                panic!("a pairing connection");
            };
            link.request().await.expect("the right proof")
        })
    };
    // The device knows only what it scanned.
    let scanned = PairingInvite::from_qr_text(&qr).expect("reads");
    let phone = device(2).await;
    let pairing = phone
        .pair(
            host_addr(&scanned).expect("an address"),
            &scanned.secret,
            "Test phone",
        )
        .await
        .expect("pairs");
    let mut attempt = host_side.await.expect("host task");
    let code = pairing.code().to_string();
    let (check, answer) = tokio::join!(
        attempt.confirm(&code, "Test Mac", |device, role| {
            store.add(device, role);
            true
        }),
        pairing.finish()
    );
    assert!(matches!(check, Ok(CodeCheck::Paired { .. })));
    assert_eq!(answer, Ok("Test Mac".to_string()));
}

#[tokio::test]
async fn a_device_whose_role_changed_reconnects_with_the_new_role() {
    let store = Arc::new(Store::default());
    let host = Arc::new(host(&store, 10).await);
    let phone = device(2).await;
    pair(Arc::clone(&host), &store, &phone, Role::Controller).await;
    let host_side = {
        let host = Arc::clone(&host);
        let store = Arc::clone(&store);
        let phone_id = phone.id();
        tokio::spawn(async move {
            let Accepted::Remote(first) = next_accepted(&host).await else {
                panic!("a remote connection");
            };
            assert_eq!(first.role(), Role::Controller);
            store.add(phone_id, Role::Viewer);
            host.reconnect(&phone_id);
            let Accepted::Remote(second) = next_accepted(&host).await else {
                panic!("a remote connection");
            };
            second.role()
        })
    };
    let connections = Arc::new(Mutex::new(0));
    let counted = Arc::clone(&connections);
    let ended = timeout(
        WAIT,
        stay_connected(&phone, reach(&host), move |link| {
            let counted = Arc::clone(&counted);
            async move {
                let n = {
                    let mut n = counted.lock().expect("lock");
                    *n += 1;
                    *n
                };
                if n == 1 {
                    return (true, link.closed().await);
                }
                // Back, as the host's new view of it: done.
                (true, Some(CloseCode::NotPaired))
            }
        }),
    )
    .await
    .expect("in time");
    assert_eq!(ended, LinkError::Closed(Some(CloseCode::NotPaired)));
    assert_eq!(
        timeout(WAIT, host_side)
            .await
            .expect("came back in time")
            .expect("host task"),
        Role::Viewer
    );
}

#[tokio::test]
async fn a_device_the_host_could_not_store_is_told_pairing_failed() {
    let store = Arc::new(Store::default());
    let host = Arc::new(host(&store, 10).await);
    host.start_pairing(SECRET, Role::Viewer);
    let host_side = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let Accepted::Pair(link) = next_accepted(&host).await else {
                panic!("a pairing connection");
            };
            link.request().await.expect("the right proof")
        })
    };
    let phone = device(2).await;
    let pairing = phone
        .pair(reach(&host), &SECRET, "Test phone")
        .await
        .expect("proof accepted");
    let mut attempt = host_side.await.expect("host task");
    let code = pairing.code().to_string();
    let (check, answer) = tokio::join!(
        attempt.confirm(&code, "Test Mac", |_, _| false),
        pairing.finish()
    );
    assert_eq!(check.expect("told"), CodeCheck::Burned);
    assert_eq!(answer, Err(LinkError::Refused(RefuseReason::NotPaired)));
}

#[tokio::test]
async fn a_wake_skips_the_backoff_wait() {
    use kriyon_remote_link::device::stay_connected_waking;
    use std::time::Instant;
    use tokio::sync::Notify;

    let store = Arc::new(Store::default());
    let host = Arc::new(host(&store, 10).await);
    let phone = device(2).await;
    pair(Arc::clone(&host), &store, &phone, Role::Viewer).await;
    // The host drops every connection at once, so the device keeps backing off.
    let dropper = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            while let Some(Accepted::Remote(link)) = host.accept().await {
                link.close(CloseCode::HostClosing);
            }
        })
    };
    let wake = Arc::new(Notify::new());
    let tries = Arc::new(Mutex::new(Vec::<Instant>::new()));
    let noted = Arc::clone(&tries);
    let waker = Arc::clone(&wake);
    let staying = tokio::spawn(async move {
        stay_connected_waking(&phone, reach(&host), &waker, move |link| {
            let noted = Arc::clone(&noted);
            async move {
                noted.lock().expect("lock").push(Instant::now());
                (false, link.closed().await)
            }
        })
        .await
    });
    // Three tries: waits of 1 s then 2 s; the next wait is 4 s.
    let deadline = Instant::now() + WAIT;
    while tries.lock().expect("lock").len() < 3 {
        assert!(Instant::now() < deadline, "too few tries");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let woke_at = Instant::now();
    wake.notify_one();
    while tries.lock().expect("lock").len() < 4 {
        assert!(
            woke_at.elapsed() < Duration::from_secs(2),
            "the wake didn't cut the 4 s wait short"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    staying.abort();
    dropper.abort();
}

/// One endpoint per computer: it hosts and it dials, with one id.
#[tokio::test]
async fn one_endpoint_hosts_and_dials_at_once() {
    use kriyon_remote_link::endpoint::bind;

    // Computer A and computer B, each with one endpoint for both roles.
    let a_endpoint = bind(&config(1), Vec::new()).await.expect("binds");
    let b_endpoint = bind(&config(5), Vec::new()).await.expect("binds");
    let a_store = Arc::new(Store::default());
    let b_store = Arc::new(Store::default());
    let a_host = Arc::new(Host::on_endpoint(
        a_endpoint.clone(),
        a_store.clone() as Arc<dyn PairedDevices>,
        10,
    ));
    let b_host = Arc::new(Host::on_endpoint(
        b_endpoint.clone(),
        b_store.clone() as Arc<dyn PairedDevices>,
        10,
    ));
    let a_device = Device::from_endpoint(a_endpoint.clone());
    let b_device = Device::from_endpoint(b_endpoint.clone());
    assert_eq!(a_device.id(), a_host.id(), "one id per computer");

    // Each pairs with the other.
    pair(Arc::clone(&b_host), &b_store, &a_device, Role::Viewer).await;
    pair(Arc::clone(&a_host), &a_store, &b_device, Role::Controller).await;
    assert_eq!(b_store.role(&a_host.id()), Some(Role::Viewer));
    assert_eq!(a_store.role(&b_host.id()), Some(Role::Controller));
}

#[tokio::test]
async fn a_host_that_stopped_accepting_refuses_and_drops_its_links() {
    let store = Arc::new(Store::default());
    let host = Arc::new(host(&store, 10).await);
    let phone = device(2).await;
    pair(Arc::clone(&host), &store, &phone, Role::Viewer).await;
    let held = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let Accepted::Remote(link) = next_accepted(&host).await else {
                panic!("a remote connection");
            };
            link
        })
    };
    let link = timeout(WAIT, phone.connect(reach(&host)))
        .await
        .expect("in time")
        .expect("connects");
    let (mut out, _incoming) = link.open_stream().await.expect("control");
    out.send(&FromDevice::Resync).await.expect("sends");
    let _held = held.await.expect("host task");

    host.stop_accepting();
    assert_eq!(
        timeout(WAIT, link.closed()).await.expect("in time"),
        Some(CloseCode::HostClosing),
        "its links close"
    );
    let again = timeout(WAIT, phone.connect(reach(&host)))
        .await
        .expect("answered in time");
    let refused = match again {
        Err(_) => true,
        Ok(link) => timeout(WAIT, link.closed()).await.is_ok(),
    };
    assert!(refused, "no new connection gets in");

    host.start_accepting();
    let accept = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { next_accepted(&host).await })
    };
    let back = timeout(WAIT, phone.connect(reach(&host)))
        .await
        .expect("in time")
        .expect("connects again");
    let (mut out, _incoming) = back.open_stream().await.expect("control");
    out.send(&FromDevice::Resync).await.expect("sends");
    assert!(matches!(
        accept.await.expect("host task"),
        Accepted::Remote(_)
    ));
}
