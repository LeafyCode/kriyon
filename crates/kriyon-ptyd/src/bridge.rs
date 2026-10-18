//! The [Companion bridge]: the session's companion mod posts each event to a
//! Unix socket this daemon serves, and the daemon appends it to the session's
//! [Bridge spool]. The daemon lives exactly as long as the session and
//! survives an app crash, so no event is lost while the app restarts. A
//! [Partial reply] (the reply as it streams) replaces the session's last one
//! in its own small file instead: only the newest is worth reading.
//!
//! Started only when the app set `KRIYON_BRIDGE_SOCKET` for this session (the
//! user turned the companion on). What a request means is decided in
//! `kriyon_core::bridge`.

use std::io::{Read as _, Write as _};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::time::Duration;

use kriyon_core::bridge::{
    is_partial, parse_request, spool_line, Request, BAD_REQUEST, MAX_BODY, NO_CONTENT,
};

/// Serve the bridge for session `id` if the app asked for one (it put the
/// socket path in this daemon's env). Best-effort: the terminal works the same
/// without it.
pub fn spawn(id: &str) {
    let (Ok(socket), Ok(home)) = (std::env::var("KRIYON_BRIDGE_SOCKET"), std::env::var("HOME"))
    else {
        return;
    };
    if !kriyon_core::daemon::is_valid_session_id(id) {
        return;
    }
    let files = Files {
        spool: kriyon_core::paths::bridge_spool(Path::new(&home), id),
        partial: kriyon_core::paths::bridge_partial(Path::new(&home), id),
        session_tty: crate::pty::hosted_tty,
    };
    std::thread::spawn(move || {
        if let Err(e) = serve(Path::new(&socket), &files) {
            eprintln!("kriyon-ptyd: companion bridge: {e}");
        }
    });
}

/// Remove the bridge socket [`spawn`] bound, if the app asked for one. Part of
/// the daemon's way out: nothing serves the path once the daemon is gone.
pub fn remove_socket() {
    if let Ok(socket) = std::env::var("KRIYON_BRIDGE_SOCKET") {
        let _ = std::fs::remove_file(socket);
    }
}

/// Where a session's events go: every event to the spool, except a partial
/// reply, which replaces the last one.
struct Files {
    spool: std::path::PathBuf,
    partial: std::path::PathBuf,
    /// The device number of the session's terminal, once known: only posts
    /// from the [Owning claude] on it are kept.
    session_tty: fn() -> Option<u64>,
}

/// Bind `socket` and keep every event posted to it.
fn serve(socket: &Path, files: &Files) -> std::io::Result<()> {
    let listener = bind(socket)?;
    for stream in listener.incoming().flatten() {
        handle(stream, files);
    }
    Ok(())
}

/// Bind `socket` owner-only, replacing a stale file (never a live one).
fn bind(socket: &Path) -> std::io::Result<UnixListener> {
    use std::os::unix::fs::PermissionsExt as _;
    if UnixStream::connect(socket).is_ok() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AddrInUse,
            "a live bridge already serves this socket",
        ));
    }
    let _ = std::fs::remove_file(socket);
    let listener = UnixListener::bind(socket)?;
    std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

fn handle(mut stream: UnixStream, files: &Files) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let owned = posted_by_owner(&stream, files);
    let mut buf = Vec::new();
    let mut chunk = [0_u8; 16 * 1024];
    let reply = loop {
        let n = match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break BAD_REQUEST,
            Ok(n) => n,
        };
        buf.extend_from_slice(&chunk[..n]);
        match parse_request(&buf) {
            Request::Incomplete if buf.len() <= MAX_BODY + 16 * 1024 => {}
            Request::Post(body) => {
                // A post from any other `claude` (one the session started) is
                // answered as kept and dropped, so its mod has nothing to retry.
                let kept = if !owned {
                    Ok(())
                } else if is_partial(body) {
                    replace(&files.partial, body)
                } else {
                    append(&files.spool, body)
                };
                break if kept.is_ok() {
                    NO_CONTENT
                } else {
                    BAD_REQUEST
                };
            }
            _ => break BAD_REQUEST,
        }
    };
    let _ = stream.write_all(reply);
}

/// Whether the process that posted on `stream` is the session's [Owning
/// claude]. The companion rides in every `claude` that inherits the session's
/// env (a nested `claude -p` from a Bash command, a test script's), and each
/// would post here as if it were the session's own. Fails open when it can't
/// tell: before the terminal is open, or off macOS.
fn posted_by_owner(stream: &UnixStream, files: &Files) -> bool {
    let Some(session_tty) = (files.session_tty)() else {
        return true;
    };
    peer_seat(stream, session_tty).is_none_or(|seat| seat.owns_session())
}

/// Where the peer of `stream` sits on its terminal, from the kernel: its pid
/// (`LOCAL_PEERPID`), then its process group, controlling terminal and that
/// terminal's foreground group (`proc_pidinfo`).
#[cfg(target_os = "macos")]
fn peer_seat(stream: &UnixStream, session_tty: u64) -> Option<kriyon_core::proc::TerminalSeat> {
    use std::os::fd::AsRawFd as _;
    let mut pid: libc::pid_t = 0;
    let mut len = libc::socklen_t::try_from(std::mem::size_of::<libc::pid_t>()).ok()?;
    // SAFETY: `pid` and `len` are valid for writes and `len` is `pid`'s size.
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&raw mut pid).cast(),
            &raw mut len,
        )
    };
    if rc != 0 || pid <= 0 {
        return None;
    }
    // SAFETY: `proc_bsdinfo` is plain old data; all zeroes is a valid value.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = libc::c_int::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).ok()?;
    // SAFETY: `info` is valid for `size` bytes of writes.
    let read =
        unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size) };
    if read != size {
        return None;
    }
    Some(kriyon_core::proc::TerminalSeat {
        pgid: i32::try_from(info.pbi_pgid).ok()?,
        foreground_pgid: i32::try_from(info.e_tpgid).unwrap_or(0),
        on_session_tty: u64::from(info.e_tdev) == session_tty,
    })
}

#[cfg(not(target_os = "macos"))]
fn peer_seat(_stream: &UnixStream, _session_tty: u64) -> Option<kriyon_core::proc::TerminalSeat> {
    None
}

/// One event as it is kept: redacted, stamped with when it arrived.
fn kept_line(body: &[u8]) -> std::io::Result<String> {
    let received_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
    spool_line(body, received_ms)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "not a JSON object"))
}

/// Append one event to the spool: owner-only, one `O_APPEND` write per line.
fn append(spool: &Path, body: &[u8]) -> std::io::Result<()> {
    let line = kept_line(body)?;
    kriyon_core::private_fs::append_private(spool, format!("{line}\n").as_bytes())
}

/// Replace the last partial reply with this one, whole or not at all: written
/// owner-only beside it, then renamed over it.
fn replace(partial: &Path, body: &[u8]) -> std::io::Result<()> {
    let line = kept_line(body)?;
    if let Some(dir) = partial.parent() {
        kriyon_core::private_fs::create_private_dir(dir)?;
    }
    let next = partial.with_extension("json.next");
    let _ = std::fs::remove_file(&next);
    kriyon_core::private_fs::append_private(&next, line.as_bytes())?;
    std::fs::rename(&next, partial)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn send(socket: &Path, body: &str) -> String {
        let mut stream = UnixStream::connect(socket).expect("connects");
        let request = format!(
            "POST /event HTTP/1.1\r\nHost: kriyon\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).expect("writes");
        let mut reply = String::new();
        stream.read_to_string(&mut reply).expect("reads");
        reply
    }

    #[test]
    fn posted_events_land_in_the_spool_one_redacted_line_each() {
        use std::os::unix::fs::PermissionsExt as _;
        let tmp = tempfile::tempdir().expect("tempdir");
        let socket = tmp.path().join("s.b.sock");
        let spool = tmp.path().join("bridge/s.jsonl");
        let listener = bind(&socket).expect("binds");
        let partial = tmp.path().join("bridge/s.partial.json");
        let files = Files {
            spool: spool.clone(),
            partial: partial.clone(),
            session_tty: || None,
        };
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                handle(stream, &files);
            }
        });

        let hello = send(&socket, r#"{"kind":"hello"}"#);
        assert!(hello.starts_with("HTTP/1.1 204"));
        assert!(
            hello.contains("X-Kriyon-Bridge: 2"),
            "says it takes partials"
        );
        assert!(send(&socket, r#"{"kind":"row","text":"password=x"}"#).starts_with("HTTP/1.1 204"));
        assert!(send(&socket, "not json").starts_with("HTTP/1.1 400"));
        let mode = |p: &Path| std::fs::metadata(p).expect("exists").permissions().mode() & 0o777;
        // A partial reply replaces the last one and never joins the spool.
        send(&socket, r#"{"kind":"partial","text":"Hel"}"#);
        send(&socket, r#"{"kind":"partial","text":"Hello"}"#);
        let newest = std::fs::read_to_string(&partial).expect("partial");
        assert!(newest.contains(r#""text":"Hello""#) && !newest.contains("Hel\""));
        assert_eq!(mode(&partial), 0o600);

        let text = std::fs::read_to_string(&spool).expect("spool");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[1].contains("password=[REDACTED]"));
        assert_eq!(mode(&spool), 0o600);
        assert_eq!(mode(&socket), 0o600);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn posts_from_a_claude_off_the_session_terminal_are_dropped() {
        // The test process stands in for a nested `claude`: it has no
        // controlling terminal, so it can't hold the session's foreground.
        let tmp = tempfile::tempdir().expect("tempdir");
        let socket = tmp.path().join("s.b.sock");
        let spool = tmp.path().join("bridge/s.jsonl");
        let partial = tmp.path().join("bridge/s.partial.json");
        let listener = bind(&socket).expect("binds");
        let files = Files {
            spool: spool.clone(),
            partial: partial.clone(),
            session_tty: || Some(0x1000_0001),
        };
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                handle(stream, &files);
            }
        });

        // Answered as kept, so the nested mod has nothing to retry or report.
        assert!(send(&socket, r#"{"kind":"row","text":"hi"}"#).starts_with("HTTP/1.1 204"));
        assert!(send(&socket, r#"{"kind":"partial","text":"Hel"}"#).starts_with("HTTP/1.1 204"));
        assert!(!spool.exists());
        assert!(!partial.exists());
    }

    /// The terminal [`posts_from_the_claude_holding_the_session_terminal_are_kept`]
    /// treats as the session's.
    #[cfg(target_os = "macos")]
    static TEST_TTY: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    #[cfg(target_os = "macos")]
    #[test]
    fn posts_from_the_claude_holding_the_session_terminal_are_kept() {
        use std::os::unix::fs::MetadataExt as _;
        use std::sync::atomic::Ordering;
        let tmp = tempfile::tempdir().expect("tempdir");
        let socket = tmp.path().join("s.b.sock");
        let spool = tmp.path().join("bridge/s.jsonl");
        let listener = bind(&socket).expect("binds");
        let files = Files {
            spool: spool.clone(),
            partial: tmp.path().join("bridge/s.partial.json"),
            session_tty: || Some(TEST_TTY.load(Ordering::SeqCst)),
        };
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                handle(stream, &files);
            }
        });

        // A process started on a fresh PTY leads its foreground, as the
        // session's `claude` does; it posts like the companion would.
        let pair = portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize::default())
            .expect("openpty");
        let tty = pair.master.tty_name().expect("a tty name");
        TEST_TTY.store(
            std::fs::metadata(&tty).expect("tty").rdev(),
            Ordering::SeqCst,
        );
        let post = format!(
            "import socket; s=socket.socket(socket.AF_UNIX); s.connect({:?}); \
             b=b'{{\"kind\":\"row\"}}'; \
             s.sendall(b'POST /event HTTP/1.1\\r\\nContent-Length: %d\\r\\n\\r\\n' % len(b) + b); \
             s.recv(1024)",
            socket.display().to_string()
        );
        let mut cmd = portable_pty::CommandBuilder::new("python3");
        cmd.args(["-c", &post]);
        let mut child = pair.slave.spawn_command(cmd).expect("spawns");
        drop(pair.slave);
        assert!(child.wait().expect("waits").success());

        let text = std::fs::read_to_string(&spool).expect("the owner's post is kept");
        assert_eq!(text.lines().count(), 1);
    }

    #[test]
    fn a_live_bridge_is_never_replaced() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let socket = tmp.path().join("s.b.sock");
        let _live = bind(&socket).expect("binds");
        assert!(bind(&socket).is_err());
    }
}
