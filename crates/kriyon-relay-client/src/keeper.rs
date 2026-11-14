//! Keeping this device's [Relay pass] fresh and in use, the same on the
//! desktop and the phone: renew it when due (or at once when the relay
//! refused the one in hand, at most once every [`FORCED_RENEW_GAP`]), and
//! rebuild the endpoint with a newer one at a quiet moment, or before the
//! one in use runs out. Each app says how its endpoint is bound through
//! [`Rebind`].

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};

use kriyon_remote::relay::{rebuild_due, RelayAction};
use kriyon_remote_link::RelayAccess;

use crate::runtime::{RelayRuntime, ThisDevice};

/// The least time between two passes fetched because the relay refused the
/// one in hand (seconds), so a relay that refuses every pass isn't asked in
/// a loop.
pub const FORCED_RENEW_GAP_S: u64 = 10 * 60;

/// How often an app checks the pass: renews it when due, and puts a newer
/// one to use when it is time.
pub const CHECK_EVERY: std::time::Duration = std::time::Duration::from_secs(60);

/// The endpoint bound now, as [`Rebind::want`] finds it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InUse {
    /// It is bound with another relay or pass than the one wanted: it has to
    /// be rebuilt to change. `false` with nothing bound: the next bind takes
    /// the one wanted.
    pub stale: bool,
    /// When the pass it was bound with expires (Unix seconds).
    pub expires_s: Option<u64>,
}

/// How an app's endpoint takes a relay pass: iroh reads the pass only when
/// it binds, so a new pass needs a new endpoint. The desktop and the phone
/// bind theirs differently; the keeper decides when.
pub trait Rebind: Send + Sync {
    /// The app's relay, whose pass this keeps.
    fn relay(&self) -> &RelayRuntime;

    /// This device as the relay account knows it; `None` while that can't
    /// be told (its key unreadable), and nothing is fetched.
    fn this_device(&self) -> Option<ThisDevice>;

    /// Use `relay` (with when its pass expires) from the next bind on, and
    /// say how the endpoint bound now stands.
    fn want(&self, relay: Option<(RelayAccess, u64)>) -> impl Future<Output = InUse> + Send;

    /// Whether nothing would notice the endpoint going: no session open
    /// through it, nothing watched.
    fn quiet(&self) -> impl Future<Output = bool> + Send;

    /// Bring the endpoint back with the relay wanted, everything on it
    /// moving to the new one.
    ///
    /// # Errors
    /// Why it couldn't be bound; the old one stays.
    fn rebind(&self) -> impl Future<Output = Result<(), String>> + Send;

    /// The relay's state changed: the settings read it again.
    fn changed(&self);
}

/// Keeps this device's pass fresh and in use, one per app.
#[derive(Default)]
pub struct PassKeeper {
    /// A check is running: another leaves it to that one.
    busy: AtomicBool,
    /// The relay refused the pass in hand: the next check fetches a new one,
    /// when [`FORCED_RENEW_GAP_S`] allows.
    force_wanted: AtomicBool,
    last_forced_s: std::sync::Mutex<Option<u64>>,
    /// Held while the relay is put to use, so two rebuilds never overlap.
    applying: tokio::sync::Mutex<()>,
}

impl PassKeeper {
    /// Whether a forced renewal may run at `now_s`; if so, it is counted.
    fn may_force(&self, now_s: u64) -> bool {
        let mut last = self
            .last_forced_s
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if last.is_some_and(|at| now_s.saturating_sub(at) < FORCED_RENEW_GAP_S) {
            return false;
        }
        *last = Some(now_s);
        true
    }

    /// Renew the pass if it is due, or now if the relay refused it (when the
    /// gap allows; else at a later check), and put a newer one to use when
    /// it is time. A check already running leaves this one to it, or to the
    /// next.
    pub async fn check<R: Rebind>(&self, now_s: u64, rebind: &R) {
        if self.busy.swap(true, Ordering::AcqRel) {
            return;
        }
        let force = self.force_wanted.swap(false, Ordering::AcqRel) && {
            let allowed = self.may_force(now_s);
            if !allowed {
                self.force_wanted.store(true, Ordering::Release);
            }
            allowed
        };
        if let Some(this) = rebind.this_device() {
            if rebind.relay().renew(now_s, &this, force).await {
                rebind.changed();
            }
        }
        if let Err(why) = self.apply(now_s, rebind, force).await {
            eprintln!("kriyon: couldn't put the new relay pass to use: {why}");
        }
        self.busy.store(false, Ordering::Release);
    }

    /// Put the relay as it stands to use: the next bind takes it, and an
    /// endpoint bound now is rebuilt when `now` (the person asked, or the
    /// relay refused the pass in use), at a quiet moment, or when its pass
    /// runs low. Returns whether it was rebuilt.
    ///
    /// # Errors
    /// Why the new endpoint couldn't be bound; the old one stays.
    pub async fn apply<R: Rebind>(
        &self,
        now_s: u64,
        rebind: &R,
        now: bool,
    ) -> Result<bool, String> {
        let _applying = self.applying.lock().await;
        let in_use = rebind.want(rebind.relay().access().await).await;
        if !in_use.stale {
            return Ok(false);
        }
        if now || rebuild_due(now_s, in_use.expires_s, true, rebind.quiet().await) {
            rebind.rebind().await?;
            rebind.changed();
            return Ok(true);
        }
        Ok(false)
    }

    /// The relay said `action` about the endpoint (the contract's table):
    /// remembered for the settings, and a pass it won't take replaced.
    pub async fn refused<R: Rebind>(&self, now_s: u64, action: RelayAction, rebind: &R) {
        let renew = rebind.relay().relay_refused(action).await;
        rebind.changed();
        if renew {
            self.force_wanted.store(true, Ordering::Release);
            self.check(now_s, rebind).await;
        }
    }

    /// Watch what the relay says about `endpoint` until it closes, and act on
    /// each new refusal ([`Self::refused`]).
    pub async fn watch<R: Rebind>(&self, endpoint: &iroh::Endpoint, rebind: &R) {
        use iroh::Watcher as _;
        let mut status = endpoint.home_relay_status();
        let mut last: Option<RelayAction> = None;
        loop {
            let relays = tokio::select! {
                () = endpoint.closed() => return,
                next = status.updated() => match next {
                    Ok(relays) => relays,
                    Err(_) => return,
                },
            };
            let action = relays.iter().find_map(|relay| {
                let error = relay.last_error().map(|e| format!("{e:#}"));
                RelayAction::from_status(relay.auth_denied_reason(), error.as_deref())
            });
            if action == last {
                continue;
            }
            last = action;
            if let Some(action) = action {
                self.refused(now_s(), action, rebind).await;
            }
        }
    }
}

/// The time now, in Unix seconds.
#[must_use]
pub fn now_s() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex as StdMutex};

    use kriyon_remote::relay::RelayAction;
    use kriyon_remote_link::keys::SecretVault;
    use kriyon_remote_link::RelayAccess;

    use super::*;
    use crate::api::test_api::{fake_api, run};
    use crate::runtime::{RelayRuntime, RelaySetup, ThisDevice};

    /// A keychain item in memory.
    #[derive(Clone, Default)]
    struct Memory(Arc<StdMutex<Option<Vec<u8>>>>);

    impl SecretVault for Memory {
        fn read(&self) -> Result<Option<Vec<u8>>, String> {
            Ok(self.0.lock().expect("vault").clone())
        }
        fn write(&self, secret: &[u8]) -> Result<(), String> {
            *self.0.lock().expect("vault") = Some(secret.to_vec());
            Ok(())
        }
        fn remove(&self) -> Result<(), String> {
            *self.0.lock().expect("vault") = None;
            Ok(())
        }
    }

    /// An endpoint as an app binds it: what it was bound with, what the
    /// next bind takes, and whether anything would notice it going.
    struct Endpoint {
        relay: RelayRuntime,
        bound: StdMutex<Option<(RelayAccess, u64)>>,
        wanted: StdMutex<Option<(RelayAccess, u64)>>,
        bound_at_all: AtomicBool,
        busy: AtomicBool,
        rebuilds: AtomicUsize,
    }

    impl Endpoint {
        /// Not bound yet, its relay signed in and on with a first pass.
        async fn unbound(api: &str) -> Self {
            let vault = Memory::default();
            vault
                .write(br#"{"token":"tok","on":false,"pass":null}"#)
                .expect("write");
            let setup = RelaySetup {
                api: api.into(),
                web: None,
                client_id: crate::api::DESKTOP_CLIENT_ID,
            };
            let relay = RelayRuntime::new(Some(setup), Box::new(vault));
            relay.set_on(true, &device()).await.expect("on");
            Self {
                relay,
                bound: StdMutex::default(),
                wanted: StdMutex::default(),
                bound_at_all: AtomicBool::new(false),
                busy: AtomicBool::new(false),
                rebuilds: AtomicUsize::new(0),
            }
        }

        /// Bound, with no relay yet.
        async fn bound(api: &str) -> Self {
            let endpoint = Self::unbound(api).await;
            endpoint.bound_at_all.store(true, Ordering::Relaxed);
            endpoint
        }

        fn rebuilds(&self) -> usize {
            self.rebuilds.load(Ordering::Relaxed)
        }
    }

    // A fake with nothing to wait on; real endpoints bind and close.
    #[allow(clippy::unused_async_trait_impl)]
    impl Rebind for Endpoint {
        fn relay(&self) -> &RelayRuntime {
            &self.relay
        }
        fn this_device(&self) -> Option<ThisDevice> {
            Some(device())
        }
        async fn want(&self, relay: Option<(RelayAccess, u64)>) -> InUse {
            let bound = self.bound.lock().expect("bound").clone();
            *self.wanted.lock().expect("wanted") = relay.clone();
            InUse {
                stale: self.bound_at_all.load(Ordering::Relaxed)
                    && bound.as_ref().map(|(access, _)| access)
                        != relay.as_ref().map(|(access, _)| access),
                expires_s: bound.map(|(_, expires)| expires),
            }
        }
        async fn quiet(&self) -> bool {
            !self.busy.load(Ordering::Relaxed)
        }
        async fn rebind(&self) -> Result<(), String> {
            let wanted = self.wanted.lock().expect("wanted").clone();
            *self.bound.lock().expect("bound") = wanted;
            self.rebuilds.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
        fn changed(&self) {}
    }

    fn device() -> ThisDevice {
        ThisDevice {
            key_hex: "a09aa5f47a6759802ff955f8dc2d2a14a5c99d23be97f864127ff9383455a4f0".into(),
            name: "Mac".into(),
            platform: "macos",
        }
    }

    /// Unix seconds of 2026-11-15T00:00:00Z: each pass here renews then.
    const NOV_15: u64 = 1_794_700_800;
    /// Unix seconds of 2026-12-14T00:00:00Z: each pass here expires then.
    const DEC_14: u64 = 1_797_206_400;

    /// A fake API handing out passes, each with its own relay address so
    /// a new one is told apart; and how many it handed out.
    fn passes() -> (String, Arc<AtomicUsize>) {
        let count = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&count);
        let (base, _seen) = fake_api(move |line, _| {
            match line {
            "POST /api/v1/kriyon-relay/devices" => (
                200,
                r#"{"data":{"deviceId":"d1","deviceKey":"k","name":"Mac","platform":"macos"},"meta":{}}"#
                    .into(),
            ),
            "POST /api/v1/kriyon-relay/passes" => {
                let n = counted.fetch_add(1, Ordering::Relaxed);
                (
                    200,
                    format!(
                        r#"{{"data":{{"pass":"{}","expiresAt":"2026-12-14T00:00:00.000Z","renewAfter":"2026-11-15T00:00:00.000Z","relayUrl":"https://relay{n}.example.test/"}},"meta":{{}}}}"#,
                        crate::api::test_api::TEST_PASS
                    ),
                )
            }
            _ => (404, "{}".into()),
        }
        });
        (base, count)
    }

    #[test]
    fn a_newer_pass_waits_for_a_quiet_moment_unless_the_one_in_use_runs_low() {
        let (api, _) = passes();
        run(async {
            let keeper = PassKeeper::default();
            let endpoint = Endpoint::bound(&api).await;
            // Something is open: the new pass waits while the old has time.
            endpoint.busy.store(true, Ordering::Relaxed);
            *endpoint.bound.lock().expect("bound") = Some((
                RelayAccess {
                    url: "https://old.example.test/".parse().expect("url"),
                    pass: "old".into(),
                },
                DEC_14,
            ));
            keeper.check(NOV_15 - 1, &endpoint).await;
            assert_eq!(endpoint.rebuilds(), 0, "waits while busy");
            // The one in use is about to run out: rebuilt, busy or not.
            keeper.check(DEC_14 - 60, &endpoint).await;
            assert_eq!(endpoint.rebuilds(), 1, "rebuilt before it runs out");
        });
    }

    #[test]
    fn a_quiet_endpoint_takes_the_newer_pass_at_once() {
        let (api, _) = passes();
        run(async {
            let keeper = PassKeeper::default();
            let endpoint = Endpoint::bound(&api).await;
            keeper.check(NOV_15 - 1, &endpoint).await;
            assert_eq!(endpoint.rebuilds(), 1);
            // Nothing newer: no rebuild.
            keeper.check(NOV_15 - 1, &endpoint).await;
            assert_eq!(endpoint.rebuilds(), 1);
        });
    }

    #[test]
    fn a_due_pass_is_renewed_and_put_to_use() {
        let (api, handed) = passes();
        run(async {
            let keeper = PassKeeper::default();
            let endpoint = Endpoint::bound(&api).await;
            keeper.check(NOV_15 - 1, &endpoint).await;
            let before = handed.load(Ordering::Relaxed);
            keeper.check(NOV_15, &endpoint).await;
            assert_eq!(handed.load(Ordering::Relaxed), before + 1, "renewed");
            assert_eq!(endpoint.rebuilds(), 2, "the new one is used");
        });
    }

    #[test]
    fn a_refused_pass_is_replaced_once_per_gap_and_a_later_refusal_waits_its_turn() {
        let (api, handed) = passes();
        run(async {
            let keeper = PassKeeper::default();
            let endpoint = Endpoint::bound(&api).await;
            keeper.check(NOV_15 - 3600, &endpoint).await;
            let before = handed.load(Ordering::Relaxed);
            // The relay refuses the pass in hand: a new one at once, used at
            // once even with something open.
            endpoint.busy.store(true, Ordering::Relaxed);
            keeper
                .refused(NOV_15 - 3000, RelayAction::Renew, &endpoint)
                .await;
            assert_eq!(handed.load(Ordering::Relaxed), before + 1, "forced");
            assert_eq!(endpoint.rebuilds(), 2, "used at once");
            // Refused again within the gap: not fetched now, kept for later.
            keeper
                .refused(NOV_15 - 2900, RelayAction::Renew, &endpoint)
                .await;
            assert_eq!(handed.load(Ordering::Relaxed), before + 1, "waits");
            // A check once the gap has passed fetches it.
            let after_gap = NOV_15 - 3000 + FORCED_RENEW_GAP_S;
            keeper.check(after_gap, &endpoint).await;
            assert_eq!(handed.load(Ordering::Relaxed), before + 2, "its turn");
        });
    }

    #[test]
    fn an_endpoint_not_bound_takes_the_pass_when_it_binds() {
        let (api, _) = passes();
        run(async {
            let keeper = PassKeeper::default();
            let endpoint = Endpoint::unbound(&api).await;
            keeper.check(NOV_15 - 1, &endpoint).await;
            assert_eq!(endpoint.rebuilds(), 0, "nothing to rebuild");
            assert!(endpoint.wanted.lock().expect("wanted").is_some());
        });
    }
}
