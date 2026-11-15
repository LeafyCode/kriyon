//! `kriyon-push`: run the push sender, or `kriyon-push new-key` to print a
//! fresh X25519 secret (64 hex digits) for `KRIYON_PUSH_SECRET_FILE`.
//! Settings: see [`kriyon_push::config`].

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use kriyon_push::config::Config;
use kriyon_push::deliver::PushServices;
use kriyon_push::gate::Gate;
use kriyon_push::server::{serve, App};
use ring::rand::SecureRandom as _;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

fn main() -> std::process::ExitCode {
    if std::env::args().nth(1).as_deref() == Some("new-key") {
        let mut secret = [0u8; 32];
        if ring::rand::SystemRandom::new().fill(&mut secret).is_err() {
            eprintln!("kriyon-push: no randomness");
            return std::process::ExitCode::FAILURE;
        }
        let hex = secret.iter().fold(String::new(), |mut out, b| {
            use std::fmt::Write as _;
            let _ = write!(out, "{b:02x}");
            out
        });
        println!("{hex}");
        return std::process::ExitCode::SUCCESS;
    }
    let config = match Config::read(
        |name| std::env::var(name).ok(),
        |path| std::fs::read_to_string(path).ok(),
        now(),
    ) {
        Ok(config) => config,
        Err(why) => {
            eprintln!("kriyon-push: {why}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let Ok(runtime) = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    else {
        eprintln!("kriyon-push: no runtime");
        return std::process::ExitCode::FAILURE;
    };
    runtime.block_on(async move {
        let services = match PushServices::new(config.apns, config.fcm, now) {
            Ok(services) => services,
            Err(why) => {
                eprintln!("kriyon-push: {why}");
                return std::process::ExitCode::FAILURE;
            }
        };
        let gate = config.retired.iter().fold(
            Gate::new(config.key_id, config.secret),
            |gate, &(key_id, secret, retired_at)| gate.with_retired(key_id, secret, retired_at),
        );
        let app = Arc::new(App::new(
            gate,
            services,
            Arc::new(|line: &str| eprintln!("{line}")),
            now,
        ));
        let Ok(listener) = tokio::net::TcpListener::bind(config.listen).await else {
            eprintln!("kriyon-push: can't listen on KRIYON_PUSH_LISTEN");
            return std::process::ExitCode::FAILURE;
        };
        tokio::select! {
            served = serve(listener, app) => {
                if served.is_err() {
                    eprintln!("kriyon-push: the listener failed");
                    return std::process::ExitCode::FAILURE;
                }
            }
            _ = tokio::signal::ctrl_c() => {}
        }
        std::process::ExitCode::SUCCESS
    })
}
