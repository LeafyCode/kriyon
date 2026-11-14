//! The relay end to end, on loopback only: a local iroh relay with the
//! [Relay pass] contract's check (`docs/superpowers/specs/2026-11-13-relay-pass-contract.md`),
//! and a host and a phone that reach each other through it alone, with no
//! direct path. Nothing of the real relay's is used.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr, RelayConfig, RelayMode, RelayUrl, SecretKey, TransportAddr};
use iroh_relay::server::{
    Access, AccessControl, CertConfig, ClientRequest, RelayConfig as RelayServerConfig, Server,
    ServerConfig, TlsConfig,
};
use kriyon_remote::device_view::{EntriesEvent, LinkPath, LinkState, ScreenEvent};
use kriyon_remote::link_policy::CodeCheck;
use kriyon_remote::message::Role;
use kriyon_remote::relay::RelayAction;
use kriyon_remote_link::device_runtime::{
    DeviceEvents, DeviceRuntime, EntriesSink, HostEntry, ScreenView, SessionView, Timing,
};
use kriyon_remote_link::test_support::host_world::{answer, asked, world_on_endpoint, World};
use kriyon_remote_link::test_support::{run, wait_until, RecordingEvents};
use kriyon_remote_link::ALPN_PAIR;
use parking_lot::Mutex;

/// The valid pass from the pass contract's test vectors (fixed test keys, never used
/// anywhere real), as the app carries it: here the phone's.
const PHONE_PASS: &str = "kp1.AQ8eLTxLWml4h5altMPS4fCgmqX0emdZgC_5VfjcLSoUpcmdI76X-GQSf_k4NFWk8AAAAABq96SAAAAAAGsfMYA.vg7dZ8vaIGxbWpMVoOvTHz28Lbk9B9LnD9v15n4spiy5_rxih0c_gDHWoz9M5OnDnn3vuuPcF_qIBrPzSEvMDA";
/// The host's pass: opaque to the app, so any text the relay knows.
const HOST_PASS: &str = "kp1.host-test-pass";
/// A pass the relay says is out of date.
const EXPIRED_PASS: &str = "kp1.expired-test-pass";

const PHONE_KEY: [u8; 32] = [3; 32];
const HOST_KEY: [u8; 32] = [9; 32];

/// The relay's check, as the contract has it: a pass it knows, from the
/// device it is bound to; else refused with the contract's reason.
#[derive(Debug, Default)]
struct PassCheck {
    bound: Mutex<HashMap<String, iroh::EndpointId>>,
}

impl PassCheck {
    fn with(passes: &[(&str, [u8; 32])]) -> Arc<Self> {
        let check = Self::default();
        for (pass, key) in passes {
            check
                .bound
                .lock()
                .insert((*pass).to_string(), SecretKey::from_bytes(key).public());
        }
        Arc::new(check)
    }
}

fn denied(reason: &str) -> Access {
    Access::Deny {
        reason: Some(reason.to_string()),
    }
}

impl PassCheck {
    fn decide(&self, request: &ClientRequest) -> Access {
        let Some(pass) = request.auth_token() else {
            return Access::Deny { reason: None };
        };
        let bound = self.bound.lock().get(&pass).copied();
        match bound {
            Some(device) if device == request.endpoint_id() => Access::Allow,
            Some(_) => denied("pass-wrong-device"),
            None if pass == EXPIRED_PASS => denied("pass-expired"),
            // A reason added after this app was built.
            None => denied("relay-has-a-new-reason"),
        }
    }
}

impl AccessControl for PassCheck {
    fn on_connect(
        &self,
        request: &ClientRequest,
    ) -> impl std::future::Future<Output = Access> + Send {
        std::future::ready(self.decide(request))
    }
}

/// A relay on loopback with `check`, serving https on `https` (port 0: any).
async fn relay(check: Arc<PassCheck>, https: SocketAddr) -> (Server, RelayUrl) {
    let mut tries = 0;
    loop {
        let (_certs, server_config) =
            iroh_relay::server::testing::self_signed_tls_certs_and_config();
        let mut config = RelayServerConfig::new((Ipv4Addr::LOCALHOST, 0));
        config.tls = Some(TlsConfig::new(https, CertConfig::Manual { server_config }));
        config.key_cache_capacity = Some(1024);
        config.access = Arc::clone(&check) as _;
        let mut server = ServerConfig::default();
        server.relay = Some(config);
        // A fixed port may still be held for a moment by the relay before.
        match Server::spawn(server).await {
            Ok(server) => {
                let url = format!("https://{}", server.https_addr().expect("https"))
                    .parse()
                    .expect("a url");
                return (server, url);
            }
            Err(why) => {
                tries += 1;
                assert!(tries < 40, "relay: {why:?}");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

/// An endpoint that reaches others only through the relay at `url`, with
/// `pass`: no IP transport at all, so no direct path either.
async fn relay_only(key: [u8; 32], url: &RelayUrl, pass: &str, alpns: Vec<Vec<u8>>) -> Endpoint {
    Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::from_bytes(&key))
        .alpns(alpns)
        .relay_mode(RelayMode::Custom(
            RelayConfig::from(url.clone())
                .with_auth_token(pass.to_string())
                .into(),
        ))
        // The local relay's certificate is self-signed.
        .ca_tls_config(iroh::tls::CaTlsConfig::insecure_skip_verify())
        .clear_ip_transports()
        .bind()
        .await
        .expect("binds")
}

/// Where the host is: its relay, nothing else.
fn through(world: &World, url: &RelayUrl) -> EndpointAddr {
    EndpointAddr::from_parts(
        iroh::PublicKey::from_bytes(&world.host.id()).expect("a key"),
        [TransportAddr::Relay(url.clone())],
    )
}

/// What the apps make of the relay's word on `endpoint` (`relay_cmd.rs` and
/// kriyon-mobile watch it alike): the first action it calls for.
async fn relay_action(endpoint: &Endpoint) -> RelayAction {
    use iroh::Watcher as _;
    let mut status = endpoint.home_relay_status();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let relays = status.get();
            let action = relays.iter().find_map(|one| {
                let error = one.last_error().map(|e| format!("{e:#}"));
                RelayAction::from_status(one.auth_denied_reason(), error.as_deref())
            });
            if let Some(action) = action {
                return action;
            }
            status.updated().await.expect("the endpoint is open");
        }
    })
    .await
    .expect("the relay said why in time")
}

/// The world's host on the relay at `url`, a phone paired with it through
/// the relay alone, and the phone's runtime connected to it.
async fn paired_over(url: &RelayUrl) -> (World, DeviceRuntime, Arc<RecordingEvents>) {
    let host = relay_only(HOST_KEY, url, HOST_PASS, Vec::new()).await;
    let world = world_on_endpoint(host);
    let phone = relay_only(PHONE_KEY, url, PHONE_PASS, Vec::new()).await;
    let device = kriyon_remote_link::device::Device::from_endpoint(phone.clone());
    // Pairing, through the relay.
    let secret = [7; 32];
    world.host.start_pairing(secret, Role::Controller);
    let (pairing, attempt) = tokio::join!(
        device.pair(through(&world, url), &secret, "Test phone"),
        async {
            let link =
                tokio::time::timeout(Duration::from_secs(20), world.pairing.lock().await.recv())
                    .await
                    .expect("in time")
                    .expect("a pairing connection");
            link.request().await.expect("the right proof")
        }
    );
    let fake = Arc::clone(&world.fake);
    let mut attempt = attempt;
    let pairing = pairing.expect("pairs through the relay");
    let code = pairing.code().to_string();
    let (check, finished) = tokio::join!(
        attempt.confirm(&code, "Test Mac", |id, role| {
            fake.paired.lock().insert(id, role);
            true
        }),
        pairing.finish()
    );
    assert!(matches!(check, Ok(CodeCheck::Paired { .. })), "{check:?}");
    assert_eq!(finished.expect("paired"), "Test Mac");
    // Then the session link, through the relay too.
    // Counted lost after 2 s without a heartbeat (the host beats every
    // 200 ms), so a link through a relay that went is dialed again soon.
    let rt = DeviceRuntime::with_timing(Timing {
        lost_after: Duration::from_secs(2),
        tick: Duration::from_millis(50),
    });
    let beating = world.serve.clone();
    tokio::spawn(async move {
        let mut at = 0;
        loop {
            at += 1;
            beating.heartbeat(at);
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    });
    rt.attach(phone).await;
    let seen = Arc::new(RecordingEvents::default());
    rt.connect(
        HostEntry {
            id: world.host.id(),
            addr: through(&world, url),
        },
        Arc::clone(&seen) as Arc<dyn DeviceEvents>,
    )
    .await
    .expect("connects");
    wait_until("connected through the relay", || {
        seen.state() == Some(LinkState::Connected)
    })
    .await;
    (world, rt, seen)
}

#[test]
fn a_phone_pairs_and_works_a_session_through_the_relay_alone() {
    run(async {
        let check = PassCheck::with(&[(PHONE_PASS, PHONE_KEY), (HOST_PASS, HOST_KEY)]);
        let (_relay, url) = relay(check, (Ipv4Addr::LOCALHOST, 0).into()).await;
        let (world, rt, seen) = paired_over(&url).await;
        let host = world.host.id();
        wait_until("the relay path", || {
            seen.facts()
                .is_some_and(|facts| facts.path == Some(LinkPath::Relay))
        })
        .await;
        // Its entries, then its screen, on the one stream.
        *world.fake.entries.lock() = Ok(vec![kriyon_core::readable::Keyed {
            key: "a".into(),
            kind: kriyon_remote::message::EntryKind::Note { text: "A".into() },
        }]);
        let read: Arc<Mutex<Vec<EntriesEvent>>> = Arc::default();
        let into = Arc::clone(&read);
        let reading: EntriesSink = Arc::new(move |event| into.lock().push(event));
        rt.set_view(
            &host,
            "s",
            1,
            SessionView::Open {
                screen: ScreenView::Off,
                entries: Some(Arc::clone(&reading)),
            },
        )
        .await
        .expect("opens for its entries");
        wait_until("the entries", || {
            read.lock()
                .iter()
                .any(|event| matches!(event, EntriesEvent::Entries(entries) if !entries.is_empty()))
        })
        .await;
        let screen: Arc<Mutex<Vec<ScreenEvent>>> = Arc::default();
        let into = Arc::clone(&screen);
        rt.set_view(
            &host,
            "s",
            2,
            SessionView::Open {
                screen: ScreenView::Fresh(Arc::new(move |event| into.lock().push(event))),
                entries: Some(reading),
            },
        )
        .await
        .expect("its screen on");
        let id = asked(&world).await;
        answer(&world, id, b"through the relay");
        wait_until("the screen", || {
            screen.lock().iter().any(
                |event| matches!(event, ScreenEvent::Screen { bytes, .. } if bytes == b"through the relay"),
            )
        })
        .await;
    });
}

#[test]
fn a_refused_pass_calls_for_what_the_contract_says() {
    run(async {
        let check = PassCheck::with(&[(PHONE_PASS, PHONE_KEY)]);
        let (_relay, url) = relay(check, (Ipv4Addr::LOCALHOST, 0).into()).await;
        // Out of date: a new pass is fetched and the endpoint rebuilt.
        let expired = relay_only(PHONE_KEY, &url, EXPIRED_PASS, Vec::new()).await;
        assert_eq!(relay_action(&expired).await, RelayAction::Renew);
        // Another device's pass: a pass for this device.
        let copied = relay_only([4; 32], &url, PHONE_PASS, Vec::new()).await;
        assert_eq!(relay_action(&copied).await, RelayAction::Renew);
        // A reason this build doesn't know: as account-blocked, the status
        // is asked for and shown.
        let unknown = relay_only(PHONE_KEY, &url, "kp1.unknown", vec![ALPN_PAIR.to_vec()]).await;
        assert_eq!(relay_action(&unknown).await, RelayAction::CheckStatus);
    });
}

#[test]
fn a_relay_restarted_mid_session_is_reconnected_through() {
    run(async {
        let check = PassCheck::with(&[(PHONE_PASS, PHONE_KEY), (HOST_PASS, HOST_KEY)]);
        let (relay_server, url) = relay(Arc::clone(&check), (Ipv4Addr::LOCALHOST, 0).into()).await;
        let https = relay_server.https_addr().expect("https");
        let (world, rt, seen) = paired_over(&url).await;
        let host = world.host.id();
        rt.set_view(
            &host,
            "s",
            1,
            SessionView::Open {
                screen: ScreenView::Off,
                entries: None,
            },
        )
        .await
        .expect("opens");
        // The relay goes, and comes back on the same address.
        relay_server.shutdown().await.expect("stops");
        wait_until("the link lost or dialing", || {
            seen.state() != Some(LinkState::Connected)
        })
        .await;
        let (_again, _) = relay(check, https).await;
        rt.wake();
        tokio::time::timeout(Duration::from_secs(60), async {
            while seen.state() != Some(LinkState::Connected) {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("connected again through the restarted relay");
        // And the session still answers there.
        let screen: Arc<Mutex<Vec<ScreenEvent>>> = Arc::default();
        let into = Arc::clone(&screen);
        rt.set_view(
            &host,
            "s",
            2,
            SessionView::Open {
                screen: ScreenView::Fresh(Arc::new(move |event| into.lock().push(event))),
                entries: None,
            },
        )
        .await
        .expect("its screen on");
        let id = asked(&world).await;
        answer(&world, id, b"after the restart");
        wait_until("the screen", || {
            screen.lock().iter().any(
                |event| matches!(event, ScreenEvent::Screen { bytes, .. } if bytes == b"after the restart"),
            )
        })
        .await;
    });
}
