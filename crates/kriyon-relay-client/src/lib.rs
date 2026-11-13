//! Our relay as an app uses it (the [Relay pass] contract,
//! `docs/superpowers/specs/2026-11-13-relay-pass-contract.md`): [Device
//! sign-in], the `BisBig` API calls, this device's pass and when to renew it.
//! The desktop and the phone share it; each passes its own client id, the
//! API's address and where its secrets are kept. The pure rules are
//! `kriyon_remote::relay`'s.

pub mod api;
pub mod runtime;
