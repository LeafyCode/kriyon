//! Kriyon's Claude Code hook and status-line capture, in Rust (ADR-0066).
//! Claude Code runs it on every hook event and status-line refresh, so it is
//! small, fast and never fails Claude: anything it can't read is skipped and
//! it always exits 0 with nothing on stdout.
//!
//! The pure parts live here, unit-tested; `main.rs` reads stdin and the
//! environment and writes the [Hook spool] and the usage files.

pub mod json;
pub mod record;
pub mod time;
pub mod usage;
