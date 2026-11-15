//! Our relay client against a real `BisBig` API running on this computer, for a
//! developer to run by hand. Off by default: it needs a local API, test
//! accounts and an approval helper, none of which CI has.
//!
//! Run with:
//!
//! ```text
//! KRIYON_RELAY_LOCAL_API=http://localhost:4001 \
//! KRIYON_RELAY_LOCAL_APPROVE=/path/to/dev-approve.sh \
//! cargo test -p kriyon-relay-client --test local_api -- --ignored --test-threads=1
//! ```
//!
//! `KRIYON_RELAY_LOCAL_APPROVE` is a script that approves a sign-in code:
//! `<script> <user code> [email] [password]`. The subscribed account is the
//! script's default; `KRIYON_RELAY_LOCAL_FREE` names an account with no
//! active subscription, as `email:password`.

use std::process::Command;
use std::time::Duration;

use kriyon_relay_client::api::{ApiError, RelayApi, DESKTOP_CLIENT_ID};
use kriyon_remote::relay::{ApiRefusal, SignInPoll};

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// A device key no real device has: 64 hex, fixed per test so a rerun reuses it.
fn test_key(n: u8) -> String {
    format!("{:02x}", 0xf0 | n).repeat(32)
}

/// Sign in by device code, approving the code with the helper as `account`
/// (`None`: the helper's default, subscribed account).
async fn sign_in(base: &str, approve: &str, account: Option<(&str, &str)>) -> RelayApi {
    let api = RelayApi::new(base, DESKTOP_CLIENT_ID).expect("client");
    let code = api.device_code().await.expect("device code");
    assert_eq!(code.user_code.len(), 8, "an 8-letter user code");
    assert!(code.interval >= 1);

    let mut cmd = Command::new(approve);
    cmd.arg(&code.user_code);
    if let Some((email, password)) = account {
        cmd.arg(email).arg(password);
    }
    let out = cmd.output().expect("run the approval helper");
    assert!(out.status.success(), "approval helper failed: {out:?}");

    let mut wait = Duration::from_secs(code.interval);
    for _ in 0..20 {
        tokio::time::sleep(wait).await;
        match api.poll(&code.device_code).await.expect("poll") {
            SignInPoll::Token(token) => {
                return RelayApi::new(base, DESKTOP_CLIENT_ID)
                    .expect("client")
                    .signed_in(&token)
            }
            SignInPoll::Pending => {}
            SignInPoll::SlowDown => wait += Duration::from_secs(5),
            other => panic!("sign-in ended: {other:?}"),
        }
    }
    panic!("never signed in");
}

fn refused(result: Result<impl std::fmt::Debug, ApiError>) -> ApiRefusal {
    match result {
        Err(ApiError::Refused(why)) => why,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[tokio::test]
#[ignore = "needs a local BisBig API: see the file's header"]
async fn a_subscribed_account_signs_in_registers_gets_a_pass_and_removes_the_device() {
    let (Some(base), Some(approve)) = (
        env("KRIYON_RELAY_LOCAL_API"),
        env("KRIYON_RELAY_LOCAL_APPROVE"),
    ) else {
        eprintln!("skipped: KRIYON_RELAY_LOCAL_API / _APPROVE not set");
        return;
    };
    let api = sign_in(&base, &approve, None).await;

    let status = api.status().await.expect("status");
    let sub = status
        .subscription
        .expect("the test account has a subscription");
    assert_eq!(sub.state, "active");
    assert_eq!(status.device_limit, 10);
    assert!(!status.blocked);

    let key = test_key(1);
    let device = api
        .register(&key, "Kriyon test", "macos")
        .await
        .expect("register");
    assert_eq!(device.device_key, key);
    // Registering again is safe.
    let again = api
        .register(&key, "Kriyon test", "macos")
        .await
        .expect("register again");
    assert_eq!(again.device_id, device.device_id);

    let pass = api.pass(&key).await.expect("pass");
    assert!(pass.pass.starts_with("kp1."), "a kp1 pass");
    assert!(pass.pass.len() <= 512, "within the relay's size limit");
    assert!(pass.relay_url.starts_with("https://"));
    assert!(pass.renew_after < pass.expires_at);

    let listed = api.status().await.expect("status");
    assert!(listed.devices.iter().any(|d| d.device_key == key));

    api.remove_device(&device.device_id)
        .await
        .expect("remove the device");
    assert_eq!(refused(api.pass(&key).await), ApiRefusal::DeviceRemoved);
}

#[tokio::test]
#[ignore = "needs a local BisBig API: see the file's header"]
async fn the_contract_refusals_reach_the_app_as_named() {
    let (Some(base), Some(approve)) = (
        env("KRIYON_RELAY_LOCAL_API"),
        env("KRIYON_RELAY_LOCAL_APPROVE"),
    ) else {
        eprintln!("skipped: KRIYON_RELAY_LOCAL_API / _APPROVE not set");
        return;
    };

    // No token, or a bad one: sign in again.
    let bad = RelayApi::new(&base, DESKTOP_CLIENT_ID)
        .expect("client")
        .signed_in("not-a-token");
    assert_eq!(refused(bad.status().await), ApiRefusal::SignedOut);

    // A key never registered.
    let api = sign_in(&base, &approve, None).await;
    assert_eq!(
        refused(api.pass(&test_key(2)).await),
        ApiRefusal::DeviceUnknown
    );

    // An account without a subscription.
    if let Some(free) = env("KRIYON_RELAY_LOCAL_FREE") {
        let (email, password) = free.split_once(':').expect("email:password");
        let free_api = sign_in(&base, &approve, Some((email, password))).await;
        // Never subscribed, or a first payment still pending: no pass either way.
        let status = free_api.status().await.expect("status");
        assert!(status
            .subscription
            .as_ref()
            .is_none_or(|sub| sub.state != "active"));
        let key = test_key(3);
        let device = free_api
            .register(&key, "Kriyon test", "ios")
            .await
            .expect("register without a subscription");
        assert_eq!(
            refused(free_api.pass(&key).await),
            ApiRefusal::NoSubscription
        );
        free_api
            .remove_device(&device.device_id)
            .await
            .expect("remove");
    }
}
