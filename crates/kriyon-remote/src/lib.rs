//! The remote access protocol (ADR-0057, `docs/superpowers/specs/2026-11-13-remote-protocol.md`):
//! messages, framing, typing control, the host's one check, screen numbering,
//! per-device queues, pairing crypto and compression. Pure: no network, no IO,
//! shared by the desktop host and the phone library.

pub mod authorize;
pub mod codec;
pub mod compress;
pub mod control;
pub mod message;
pub mod pairing;
pub mod queue;
pub mod screen;
