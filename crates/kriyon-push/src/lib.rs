//! Kriyon's push sender (spec §10, ADR 0057). A host asks it to wake a
//! phone with a token the phone sealed to this sender's key; it checks the
//! host's signature, the time, the request id and the limits, opens the
//! token in memory, sends one plain "A session needs you" alert through
//! APNs or FCM, and forgets it. Nothing is written to disk, and no IP
//! address, token or id reaches a log.

pub mod config;
pub mod deliver;
pub mod gate;
pub mod jwt;
pub mod server;
