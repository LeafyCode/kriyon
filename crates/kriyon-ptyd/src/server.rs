//! Per-session daemon server: owns one PTY + child, byte-proxies to one client
//! at a time over a Unix socket. It keeps a server-side screen snapshot — a
//! headless VT emulator fed by *every* byte of child output, attached or not —
//! so a reattaching client repaints the current screen even when the child has
//! produced nothing since the last detach (ADR-0004). Live output still streams
//! raw to the attached client.

use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use kriyon_core::lease::DetachedLease;
use kriyon_core::session::{SessionEngine, SessionId, SpawnSpec};
use kriyon_core::wire::{Frame, FrameDecoder};
use parking_lot::Mutex;

use crate::pty::PtyEngine;

const READ_BUF_LEN: usize = 8192;
const REAP_INTERVAL: Duration = Duration::from_millis(500);
/// How often to sample the tty's foreground process group for the busy signal.
const BUSY_POLL_INTERVAL: Duration = Duration::from_millis(250);
/// The emulator's initial size; the first client's `Attach` frame resizes it to
/// the real terminal dimensions.
const INITIAL_ROWS: u16 = 24;
const INITIAL_COLS: u16 = 80;

/// DECSET 1049 — switch the client to the alternate screen buffer.
const ENTER_ALTERNATE_SCREEN: &[u8] = b"\x1b[?1049h";
/// DECRST 1049 — switch the client back to the normal screen buffer.
const LEAVE_ALTERNATE_SCREEN: &[u8] = b"\x1b[?1049l";

/// The escape codes that reconstruct the emulator's current screen in a client
/// terminal: **which buffer the child is in**, then the screen itself.
///
/// `vt100::Screen::state_formatted()` is the contents plus the input modes
/// (application keypad and cursor, bracketed paste, mouse protocol mode and
/// encoding). The alternate-screen flag is *not* among them — `alternate_screen()`
/// is a getter the serialiser never consults — so on its own the snapshot paints
/// an alternate grid into whatever buffer the client happens to be in.
///
/// That divergence is silent and it compounds (ADR-0024): the client's wheel
/// handling branches on which buffer it is in, a child's later DECRST 1049
/// restores a buffer the client never entered, and a full-screen app's repaints
/// pile into a scrollback that should not have been collecting them. Claude
/// Code's fullscreen renderer makes it the common case rather than an exotic
/// one, so the snapshot states the buffer explicitly in both directions — a
/// repaint has to be able to move a client *out* of the alternate screen as
/// well as into it.
///
/// The switch leads, because `state_formatted()` opens with a clear: emitted
/// after it, the clear and the contents would land in the buffer being left.
fn screen_snapshot(parser: &vt100::Parser) -> Vec<u8> {
    let screen = parser.screen();
    let mut snapshot = if screen.alternate_screen() {
        ENTER_ALTERNATE_SCREEN.to_vec()
    } else {
        LEAVE_ALTERNATE_SCREEN.to_vec()
    };
    snapshot.extend_from_slice(&screen.state_formatted());
    snapshot
}

/// State shared between the PTY reader thread (which produces output) and the
/// accept loop (which attaches/detaches clients). Lock order is always
/// `client` then `emulator` — never the reverse — so the two paths cannot
/// deadlock.
struct Shared {
    client: Mutex<Option<UnixStream>>,
    /// Headless terminal emulator consuming every output byte, so its screen is
    /// always the current one to repaint a reattaching client from.
    emulator: Mutex<vt100::Parser>,
    /// Last-known foreground-busy state, updated by the busy poller and replayed
    /// to each new client on attach. An atomic (not a lock) so `attach` can read
    /// it while holding the client lock without any lock-ordering hazard.
    busy: AtomicBool,
    /// The [Detached lease]: renewed by output and by a client arriving or
    /// leaving, read by the reaper. A leaf lock — taken alone, or last and
    /// briefly under `client` — so it can never take part in a deadlock.
    lease: Mutex<DetachedLease>,
}

impl Shared {
    /// Route a chunk of PTY output: feed the server-side emulator (always, so
    /// the screen snapshot stays current even while detached), then stream the
    /// raw bytes to the live client if one is attached.
    ///
    /// Holding the `client` lock across the (possibly blocking) write is safe
    /// because there is only ever one client at a time: `attach` for the next
    /// client runs only after the current one disconnects and the accept loop
    /// calls `detach`. While a client is alive but slow, the blocking write here
    /// is the intended backpressure and no `attach`/`detach` competes for the
    /// lock; when the client dies, the write fails fast (`AF_UNIX` delivers EOF
    /// on peer close) and the lock is released.
    fn on_output(&self, bytes: &[u8]) {
        // Output is the proof of work that keeps a detached daemon alive.
        self.lease.lock().note_output(Instant::now());
        let mut client = self.client.lock();
        self.emulator.lock().process(bytes);
        // The blocking write inside `write_or_drop` IS the backpressure: if the
        // app has stopped draining the socket, it stalls, stalling the PTY read,
        // which backpressures the child. A failed write drops the dead client.
        write_or_drop(&mut client, &Frame::Output(bytes.to_vec()));
    }

    /// Attach `stream` as the live client: repaint it from the server-side
    /// screen snapshot (the escape codes that reconstruct the current contents,
    /// colours, cursor, and modes), then store the writer clone. Held under the
    /// client lock so output produced mid-attach is serialized after the repaint.
    fn attach(&self, stream: &mut UnixStream) {
        let mut client = self.client.lock();
        let snapshot = screen_snapshot(&self.emulator.lock());
        if !snapshot.is_empty() {
            let _ = stream.write_all(&Frame::Output(snapshot).encode());
            let _ = stream.flush();
        }
        // Replay the current busy state so a reattaching client (post-reload)
        // learns it immediately instead of waiting for the next transition.
        let _ = stream.write_all(&Frame::Busy(self.busy.load(Ordering::Relaxed)).encode());
        let _ = stream.flush();
        if let Ok(clone) = stream.try_clone() {
            *client = Some(clone);
        }
        self.lease.lock().note_attached(Instant::now());
    }

    /// Resend the screen snapshot to the live client, on request. A terminal
    /// component that (re)mounts against this already-connected session starts
    /// from a blank xterm; the snapshot (which begins with a clear) rebuilds
    /// the current screen. Held under the `client` lock so it serializes with
    /// [`Shared::on_output`] — output produced mid-repaint lands after it.
    fn repaint(&self) {
        let mut client = self.client.lock();
        let snapshot = screen_snapshot(&self.emulator.lock());
        if snapshot.is_empty() {
            return;
        }
        write_or_drop(&mut client, &Frame::Output(snapshot));
    }

    /// Push a busy-state change to the live client, if one is attached. Held
    /// under the same `client` lock as [`Shared::on_output`], so the two never
    /// interleave a half-written frame.
    fn push_busy(&self, busy: bool) {
        let mut client = self.client.lock();
        write_or_drop(&mut client, &Frame::Busy(busy));
    }

    /// Resize the server-side emulator so its screen snapshot matches the
    /// client's terminal. Called alongside the PTY resize.
    fn resize(&self, cols: u16, rows: u16) {
        self.emulator.lock().screen_mut().set_size(rows, cols);
    }

    fn detach(&self) {
        *self.client.lock() = None;
        // The lease runs from the moment the app goes away.
        self.lease.lock().note_detached(Instant::now());
    }
}

/// Run the daemon: bind the socket, spawn the PTY, and serve clients until the
/// child exits (handled by the reaper) or a `Shutdown` frame arrives. The socket
/// file is removed on the way out. `stop_signals` is what
/// [`block_stop_signals`] returned, called before any thread was spawned.
///
/// # Errors
/// Returns an error if the socket cannot be bound or the PTY cannot be spawned.
pub fn run(
    socket_path: &Path,
    id: SessionId,
    spec: &SpawnSpec,
    detached_ttl: Duration,
    stop_signals: libc::sigset_t,
) -> std::io::Result<()> {
    // A stale socket file from an unclean prior exit blocks bind and must go —
    // but only a *stale* one. Unlinking a path a live daemon still serves
    // strands that daemon for good: running, hosting a `claude`, unreachable.
    if UnixStream::connect(socket_path).is_ok() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AddrInUse,
            "a live daemon already serves this socket",
        ));
    }
    let _ = std::fs::remove_file(socket_path);
    let listener = UnixListener::bind(socket_path)?;

    let shared = Arc::new(Shared {
        client: Mutex::new(None),
        emulator: Mutex::new(vt100::Parser::new(INITIAL_ROWS, INITIAL_COLS, 0)),
        busy: AtomicBool::new(false),
        lease: Mutex::new(DetachedLease::new(detached_ttl, Instant::now())),
    });

    let out_shared = Arc::clone(&shared);
    let engine = PtyEngine::spawn(id, spec, move |bytes| out_shared.on_output(&bytes))
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let engine = Arc::new(engine);

    spawn_reaper(
        Arc::clone(&engine),
        Arc::clone(&shared),
        socket_path.to_path_buf(),
    );
    spawn_terminator(Arc::clone(&engine), socket_path.to_path_buf(), stop_signals);
    spawn_busy_poller(Arc::clone(&engine), Arc::clone(&shared));

    for conn in listener.incoming() {
        let Ok(mut stream) = conn else { continue };
        shared.attach(&mut stream);
        let shutdown = serve_client(&mut stream, &engine, &shared);
        shared.detach();
        if shutdown || engine.child_has_exited() {
            break;
        }
    }

    stop_and_clear(&engine, socket_path);
    Ok(())
}

/// The daemon's one way out: become unreachable, *then* [Tree stop]. The order
/// matters. A stop can take seconds, and while the socket file exists a client
/// can still connect — `create_session` would reattach to a daemon that is
/// already dying, skip launching `claude` because it "reattached", and be left
/// holding a dead pane a moment later (quit-and-relaunch, or archive-then-open,
/// inside the window). With the path gone first, that connect fails, the app
/// sees a daemon that is alive but unreachable, waits it out, and spawns fresh.
fn stop_and_clear(engine: &PtyEngine, socket_path: &Path) {
    remove_socket(socket_path);
    crate::bridge::remove_socket();
    let _ = engine.close();
}

/// Poll for the two reasons a daemon ends on its own: its shell died — attached
/// or not, so a detached daemon never lingers after its shell is gone — or its
/// [Detached lease] lapsed, so one nobody returns to never lingers either. Both
/// end the same way: a [Tree stop], then exit.
fn spawn_reaper(engine: Arc<PtyEngine>, shared: Arc<Shared>, socket_path: PathBuf) {
    std::thread::spawn(move || loop {
        std::thread::sleep(REAP_INTERVAL);
        let lapsed = shared.lease.lock().lapsed(Instant::now());
        if lapsed {
            eprintln!("kriyon-ptyd: detached and silent for the whole lease; stopping");
        }
        if lapsed || engine.child_has_exited() {
            stop_and_clear(&engine, &socket_path);
            std::process::exit(0);
        }
    });
}

/// Every signal whose default disposition would kill the daemon outright. Each
/// is turned into a [Tree stop] instead: SIGTERM (a plain `kill`, the app's
/// reaper), SIGINT and SIGQUIT (a dev build's terminal), SIGHUP (that terminal
/// closing — the daemon shares its session when the app was launched from one).
const STOP_SIGNALS: [libc::c_int; 4] = [libc::SIGTERM, libc::SIGINT, libc::SIGQUIT, libc::SIGHUP];

/// Block the [`STOP_SIGNALS`] for the calling thread. Must be called before the daemon spawns
/// any thread — the [Companion bridge]'s included — so all of them inherit the mask and the
/// signal can only ever be delivered to the `sigwait` in [`spawn_terminator`]. A thread
/// without the mask takes the signal on its default disposition, killing the daemon
/// outright and leaving its whole tree to launchd. The hosted shell is not
/// affected: portable-pty clears the signal mask in the child before `exec`.
pub fn block_stop_signals() -> libc::sigset_t {
    // SAFETY: `sigset_t` is plain data initialised by `sigemptyset` before use;
    // the calls only read and write that local and this thread's signal mask.
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&raw mut set);
        for signal in STOP_SIGNALS {
            libc::sigaddset(&raw mut set, signal);
        }
        libc::pthread_sigmask(libc::SIG_BLOCK, &raw const set, std::ptr::null_mut());
        set
    }
}

/// Turn the [`STOP_SIGNALS`] into a [Tree stop]. Dying on the default disposition would close
/// the PTY master and leave everything the daemon hosts to launchd — so a plain
/// `kill <pid>`, or the app's reaper falling back on a daemon whose socket is
/// dead, would cause exactly the leak the tree stop exists to prevent.
fn spawn_terminator(engine: Arc<PtyEngine>, socket_path: PathBuf, signals: libc::sigset_t) {
    std::thread::spawn(move || {
        let mut delivered: libc::c_int = 0;
        // SAFETY: `signals` is an initialised set and `delivered` a valid out
        // pointer; `sigwait` blocks until one of the (blocked) signals arrives.
        if unsafe { libc::sigwait(&raw const signals, &raw mut delivered) } == 0 {
            stop_and_clear(&engine, &socket_path);
            std::process::exit(0);
        }
    });
}

/// Sample the tty's foreground process group on an interval and push a [`Frame::Busy`]
/// to the client whenever it flips. One sample per daemon is a single `tcgetpgrp`
/// syscall; the thread exits with the process when the reaper calls `exit`.
fn spawn_busy_poller(engine: Arc<PtyEngine>, shared: Arc<Shared>) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(BUSY_POLL_INTERVAL);
            let busy = engine.foreground_busy().unwrap_or(false);
            // swap returns the previous value; only push on an actual change.
            if shared.busy.swap(busy, Ordering::Relaxed) != busy {
                shared.push_busy(busy);
            }
        }
    });
}

fn remove_socket(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// Write one frame to the live client, dropping the client on any write or
/// flush failure (an `AF_UNIX` peer close surfaces as an error here). A no-op
/// when no client is attached. The single place the "write a frame or drop the
/// dead client" rule lives — the app side has the same primitive in
/// `daemon_client::DaemonClient::send`.
///
/// Generic over the writer so the drop-on-failure path is unit-testable without
/// a real socket. Callers hold the `client` lock across this (see
/// [`Shared::on_output`]'s safety note); the blocking write is the backpressure.
fn write_or_drop<W: Write>(client: &mut Option<W>, frame: &Frame) {
    if let Some(w) = client.as_mut() {
        if w.write_all(&frame.encode()).is_ok() && w.flush().is_ok() {
            return;
        }
        *client = None;
    }
}

/// Read frames from one client until it disconnects or asks to shut down.
/// Returns `true` only if `Shutdown` was requested.
fn serve_client(stream: &mut UnixStream, engine: &Arc<PtyEngine>, shared: &Arc<Shared>) -> bool {
    let mut dec = FrameDecoder::new();
    let mut buf = [0u8; READ_BUF_LEN];
    loop {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => return false, // client disconnected
            Ok(n) => {
                dec.push(&buf[..n]);
                while let Some(frame) = dec.next_frame() {
                    match frame {
                        Frame::Stdin(bytes) => {
                            let _ = engine.write_stdin(&bytes);
                        }
                        // Attach carries the initial size; treat like a resize.
                        // Both the PTY and the server-side emulator must track it.
                        Frame::Resize { cols, rows } | Frame::Attach { cols, rows } => {
                            let _ = engine.resize(cols, rows);
                            shared.resize(cols, rows);
                        }
                        Frame::Repaint => shared.repaint(),
                        Frame::Shutdown => return true,
                        // Daemon → app frames never arrive from a client; ignore.
                        Frame::Output(_) | Frame::Busy(_) => {}
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{screen_snapshot, write_or_drop, ENTER_ALTERNATE_SCREEN, LEAVE_ALTERNATE_SCREEN};
    use kriyon_core::wire::Frame;
    use std::io::{self, Write};

    /// An emulator fed `bytes`, at a size big enough that nothing wraps.
    fn emulator(bytes: &[u8]) -> vt100::Parser {
        let mut parser = vt100::Parser::new(24, 80, 0);
        parser.process(bytes);
        parser
    }

    #[test]
    fn a_child_on_the_alternate_screen_puts_the_client_there_first() {
        let snapshot = screen_snapshot(&emulator(b"\x1b[?1049hhello"));
        assert!(
            snapshot.starts_with(ENTER_ALTERNATE_SCREEN),
            "the buffer switch must lead the snapshot, or the contents \
             land in the buffer the client was already in"
        );
        assert!(
            String::from_utf8_lossy(&snapshot).contains("hello"),
            "the alternate grid's contents must still be serialised"
        );
    }

    #[test]
    fn a_child_on_the_normal_screen_puts_the_client_back_there() {
        let snapshot = screen_snapshot(&emulator(b"hello"));
        assert!(
            snapshot.starts_with(LEAVE_ALTERNATE_SCREEN),
            "a repaint must move a client out of the alternate buffer too, \
             not only into it"
        );
    }

    #[test]
    fn a_child_that_left_the_alternate_screen_is_followed_back() {
        let snapshot = screen_snapshot(&emulator(b"\x1b[?1049hfullscreen\x1b[?1049l"));
        assert!(snapshot.starts_with(LEAVE_ALTERNATE_SCREEN));
    }

    /// A writer whose first write fails, standing in for a client whose socket
    /// peer has closed.
    struct FailingWriter;
    impl Write for FailingWriter {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("peer closed"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// A writer that accepts the bytes but fails to flush — the other half of
    /// the drop condition (a peer that closes between write and flush).
    struct FlushFailsWriter;
    impl Write for FlushFailsWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Err(io::Error::other("peer closed on flush"))
        }
    }

    #[test]
    fn delivers_the_encoded_frame_to_a_live_client() {
        let mut client: Option<Vec<u8>> = Some(Vec::new());
        write_or_drop(&mut client, &Frame::Busy(true));
        assert_eq!(
            client.as_deref(),
            Some(Frame::Busy(true).encode().as_slice())
        );
    }

    #[test]
    fn drops_a_client_whose_write_fails() {
        let mut client = Some(FailingWriter);
        write_or_drop(&mut client, &Frame::Output(vec![1, 2, 3]));
        assert!(client.is_none(), "a dead client must be dropped");
    }

    #[test]
    fn drops_a_client_whose_flush_fails() {
        let mut client = Some(FlushFailsWriter);
        write_or_drop(&mut client, &Frame::Output(vec![1, 2, 3]));
        assert!(client.is_none(), "a flush failure must drop the client too");
    }

    #[test]
    fn is_a_noop_when_no_client_is_attached() {
        let mut client: Option<Vec<u8>> = None;
        write_or_drop(&mut client, &Frame::Repaint);
        assert!(client.is_none());
    }
}
