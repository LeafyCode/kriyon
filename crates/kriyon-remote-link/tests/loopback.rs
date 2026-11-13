//! A host and devices in one process, over loopback, relay off.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use iroh::EndpointAddr;
use kriyon_remote::codec::Decoded;
use kriyon_remote::link_policy::{CloseCode, CodeCheck};
use kriyon_remote::message::{EndpointId, FromDevice, RefuseReason, Role, ToDevice};
use kriyon_remote_link::device::{stay_connected, Device};
use kriyon_remote_link::host::{Accepted, Host, PairedDevices};
use kriyon_remote_link::{LinkConfig, LinkError};
use tokio::time::timeout;

const WAIT: Duration = Duration::from_secs(10);
const SECRET: [u8; 32] = [7; 32];

#[derive(Default)]
struct Store(Mutex<HashMap<EndpointId, Role>>);

impl PairedDevices for Store {
    fn role(&self, device: &EndpointId) -> Option<Role> {
        self.0.lock().expect("lock").get(device).copied()
    }
}

impl Store {
    fn add(&self, device: EndpointId, role: Role) {
        self.0.lock().expect("lock").insert(device, role);
    }
    fn remove(&self, device: &EndpointId) {
        self.0.lock().expect("lock").remove(device);
    }
}

fn config(key: u8) -> LinkConfig {
    LinkConfig {
        bind: SocketAddr::from(([127, 0, 0, 1], 0)),
        ..LinkConfig::new([key; 32])
    }
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
    let (check, answer) = tokio::join!(attempt.confirm(&code, "Test Mac"), pairing.finish());
    let check = check.expect("told");
    assert_eq!(
        check,
        CodeCheck::Paired {
            device: device.id(),
            role
        },
        "the code derived on both ends is the same"
    );
    store.add(device.id(), role);
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
                last = Some(attempt.confirm(wrong, "Test Mac").await.expect("told"));
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
    // The device can't tell its secret is wrong until the host answers.
    let pairing = timeout(WAIT, phone.pair(reach(&host), &[8; 32], "Test phone"))
        .await
        .expect("in time")
        .expect("connects");
    let (host_result, answer) = tokio::join!(host_side, pairing.finish());
    assert_eq!(
        host_result.expect("host task"),
        Some(LinkError::Refused(RefuseReason::NotPaired))
    );
    assert_eq!(answer, Err(LinkError::Refused(RefuseReason::NotPaired)));
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
                    session_id: "s1".into()
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
