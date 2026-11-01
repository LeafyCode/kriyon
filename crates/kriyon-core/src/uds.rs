//! The [Session socket]'s stream type on every platform: a Unix-domain socket.
//!
//! Windows has served `AF_UNIX` stream sockets since Windows 10 1803, as files
//! on disk exactly like on macOS, so the daemon protocol, the socket paths and
//! the "a socket file that refuses a connect is stale" rule are the same on
//! both. Rust's standard library only exposes them on Unix; on Windows the
//! `uds_windows` crate supplies the same `UnixListener` / `UnixStream` shape.

#[cfg(unix)]
pub use std::os::unix::net::{UnixListener, UnixStream};
#[cfg(windows)]
pub use uds_windows::{UnixListener, UnixStream};
