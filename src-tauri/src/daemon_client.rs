//! App-side client for the out-of-process `kriyon-ptyd` daemon. Implements the
//! [`SessionEngine`] trait so the rest of the app is unchanged: the PTY now
//! lives in the daemon, but stdin/resize/close and the Phase-1 backpressure look
//! exactly as they did when the PTY was in-process.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use kriyon_core::backpressure::Backpressure;
use kriyon_core::session::{EngineError, SessionEngine, SessionId};
use kriyon_core::wire::{Frame, FrameDecoder};
use parking_lot::Mutex;

/// Park the socket reader once this many bytes are sent-but-not-drained.
const HIGH_WATER: usize = 128 * 1024;
/// Resume a parked socket reader once pending falls to/below this.
const LOW_WATER: usize = 16 * 1024;
const READ_BUF_LEN: usize = 8192;
/// How long one frame may take to reach the daemon. A frame is a few bytes to a
/// few kilobytes on a local socket, and the daemon drains its client on a thread
/// that never blocks on output — so a write that takes this long means the daemon
/// is wedged. Without a bound, a wedged daemon would hold the writer lock forever
/// and freeze the app's exit behind it.
const WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const ACCEPT_POLL: std::time::Duration = std::time::Duration::from_millis(10);

fn io_err<E: std::fmt::Display>(e: E) -> EngineError {
    EngineError::Pty(e.to_string())
}

/// A [`SessionEngine`] backed by a connection to a per-session daemon socket.
pub struct DaemonClient {
    id: SessionId,
    writer: Mutex<UnixStream>,
    reader_thread: Mutex<Option<JoinHandle<()>>>,
    /// Parking the socket reader here transitively backpressures the daemon: a
    /// parked reader stops draining the socket, the daemon's socket write
    /// blocks, its PTY read stalls, and the child is paced — no ack protocol.
    backpressure: Arc<Backpressure>,
    /// Set before the socket is deliberately severed (close/drop), so the
    /// reader thread can tell our own disconnect from a daemon-side EOF — the
    /// latter means the shell died and must surface as an exit event.
    closing: Arc<AtomicBool>,
    /// Whether the daemon has sent this connection anything. It greets each
    /// client it accepts, and serves one at a time, so a first frame is proof
    /// that this connection *is* the daemon's client rather than one waiting in
    /// its accept backlog. See [`kriyon_core::daemon::may_stop_held`].
    accepted: Arc<AtomicBool>,
}

impl DaemonClient {
    /// Connect to a daemon's socket and stream its output to `on_output`, its
    /// foreground-busy transitions to `on_busy`, and a single session-death
    /// notification to `on_exit`. The caller should send
    /// [`DaemonClient::attach`] next to set the initial size.
    ///
    /// `on_exit` fires exactly once, from the reader thread, when the daemon
    /// side closes the connection (the shell exited, or the daemon died) — and
    /// never for a disconnect this client initiated itself.
    ///
    /// # Errors
    /// Returns [`EngineError::Pty`] if the socket cannot be connected or cloned.
    pub fn connect<F, G, H>(
        socket: &Path,
        id: SessionId,
        on_output: F,
        on_busy: G,
        on_exit: H,
    ) -> Result<Self, EngineError>
    where
        F: Fn(Vec<u8>) + Send + 'static,
        G: Fn(bool) + Send + 'static,
        H: FnOnce() + Send + 'static,
    {
        let stream = UnixStream::connect(socket).map_err(io_err)?;
        Self::from_stream(stream, id, on_output, on_busy, on_exit)
    }

    /// Build a client from an already-connected stream. Lets the caller probe a
    /// daemon's liveness with a real connection and then reuse it, instead of
    /// opening a throwaway probe (which the daemon would attach + replay, draining
    /// the scrollback ring before the real client ever connects).
    ///
    /// # Errors
    /// Returns [`EngineError::Pty`] if the stream cannot be cloned.
    pub fn from_stream<F, G, H>(
        stream: UnixStream,
        id: SessionId,
        on_output: F,
        on_busy: G,
        on_exit: H,
    ) -> Result<Self, EngineError>
    where
        F: Fn(Vec<u8>) + Send + 'static,
        G: Fn(bool) + Send + 'static,
        H: FnOnce() + Send + 'static,
    {
        let backpressure = Backpressure::new(HIGH_WATER, LOW_WATER);
        Self::build(stream, id, on_output, on_busy, on_exit, backpressure)
    }

    /// [Daemon adoption]: connect to a live daemon nobody is looking at, so the
    /// session is first-class to the [Resource sweep], the [Sleep ledger] and
    /// `close_session` before its pane ever mounts.
    ///
    /// Output is discarded — the daemon's own emulator keeps the screen
    /// snapshot current and repaints the real client when `create_session`
    /// replaces this one. Nothing reports bytes drained for a sink-less client,
    /// so its watermark is unreachable: a parked reader would stall the daemon's
    /// socket write, then its PTY read, and freeze an agent nobody is watching.
    /// No `Attach` is sent either: that frame resizes the PTY, and a live TUI
    /// must not be reflowed to a default size behind the user's back.
    ///
    /// # Errors
    /// Returns [`EngineError::Pty`] if the stream cannot be cloned.
    pub fn adopt(stream: UnixStream, id: SessionId) -> Result<Self, EngineError> {
        let unpaced = Backpressure::new(usize::MAX, usize::MAX);
        Self::build(stream, id, |_| {}, |_| {}, || {}, unpaced)
    }

    fn build<F, G, H>(
        stream: UnixStream,
        id: SessionId,
        on_output: F,
        on_busy: G,
        on_exit: H,
        backpressure: Backpressure,
    ) -> Result<Self, EngineError>
    where
        F: Fn(Vec<u8>) + Send + 'static,
        G: Fn(bool) + Send + 'static,
        H: FnOnce() + Send + 'static,
    {
        let mut reader = stream.try_clone().map_err(io_err)?;
        // Bounds the writer only: the option lives on the shared socket, but the
        // reader never writes.
        let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
        let accepted = Arc::new(AtomicBool::new(false));
        let reader_accepted = Arc::clone(&accepted);
        let backpressure = Arc::new(backpressure);
        let reader_bp = Arc::clone(&backpressure);
        let closing = Arc::new(AtomicBool::new(false));
        let reader_closing = Arc::clone(&closing);

        let reader_thread = std::thread::spawn(move || {
            let mut dec = FrameDecoder::new();
            let mut buf = [0u8; READ_BUF_LEN];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        dec.push(&buf[..n]);
                        while let Some(frame) = dec.next_frame() {
                            reader_accepted.store(true, Ordering::Relaxed);
                            match frame {
                                Frame::Output(bytes) => {
                                    let len = bytes.len();
                                    on_output(bytes);
                                    // Park here if the frontend has fallen behind.
                                    reader_bp.after_send(len);
                                }
                                Frame::Busy(busy) => on_busy(busy),
                                // Other frames are app → daemon; never arrive here.
                                _ => {}
                            }
                        }
                    }
                }
            }
            // EOF without a deliberate disconnect: the daemon side is gone —
            // the user's shell exited or the daemon crashed. Surface it so the
            // UI can say so instead of leaving a silently wedged pane.
            if !reader_closing.load(Ordering::Relaxed) {
                on_exit();
            }
        });

        Ok(Self {
            id,
            writer: Mutex::new(stream),
            reader_thread: Mutex::new(Some(reader_thread)),
            backpressure,
            closing,
            accepted,
        })
    }

    /// Wait up to `timeout` for proof that the daemon accepted this connection.
    /// Returns at once when it already has.
    #[must_use]
    pub fn wait_accepted(&self, timeout: std::time::Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while !self.accepted.load(Ordering::Relaxed) {
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(ACCEPT_POLL);
        }
        true
    }

    /// Let go of the daemon without asking it to stop — what `Drop` does, by
    /// name. For a connection that may not be the daemon's client at all.
    pub fn release(&self) {
        self.disconnect();
    }

    /// Ask the daemon to resend its screen snapshot (as a normal `Output`
    /// frame). Sent when a terminal component (re)attaches to this live
    /// session, whose xterm starts blank.
    ///
    /// # Errors
    /// Returns [`EngineError::Pty`] on write failure.
    pub fn request_repaint(&self) -> Result<(), EngineError> {
        self.send(&Frame::Repaint)
    }

    fn send(&self, frame: &Frame) -> Result<(), EngineError> {
        let mut w = self.writer.lock();
        let sent = w
            .write_all(&frame.encode())
            .and_then(|()| w.flush())
            .map_err(io_err);
        if sent.is_err() {
            // A write that failed or timed out may have left half a frame on
            // the wire; anything sent after it would be read as garbage. Sever
            // the connection instead — the reader sees EOF and reports the
            // session gone, which a wedged or dead daemon effectively is.
            let _ = w.shutdown(std::net::Shutdown::Both);
        }
        sent
    }

    /// Send the initial Attach (which also sets the daemon's PTY size).
    ///
    /// # Errors
    /// Returns [`EngineError::Pty`] on write failure.
    pub fn attach(&self, cols: u16, rows: u16) -> Result<(), EngineError> {
        self.send(&Frame::Attach { cols, rows })
    }

    /// Acknowledge `bytes` drained from the frontend sink, resuming a parked
    /// socket reader. Wired to the `report_drained` Tauri command.
    pub fn report_drained(&self, bytes: usize) {
        self.backpressure.report_drained(bytes);
    }

    /// Sever the connection without touching the daemon's child: wake any
    /// parked reader, shut the socket down for every dup (the reader thread
    /// holds a clone — dropping our writer alone would leave the connection
    /// open and the daemon blocked on this client forever), then join the
    /// reader. Idempotent; used by both `close()` and `Drop`.
    fn disconnect(&self) {
        // Mark the disconnect as ours BEFORE severing, so the reader thread
        // never mistakes it for the daemon dying and fires a phantom exit.
        self.closing.store(true, Ordering::Relaxed);
        self.backpressure.close();
        let _ = self.writer.lock().shutdown(std::net::Shutdown::Both);
        if let Some(handle) = self.reader_thread.lock().take() {
            let _ = handle.join();
        }
    }
}

/// A replaced client (the webview reloaded and `create_session` re-ran for a
/// live id) must release its connection: the daemon serves one client at a
/// time, so a leaked connection blocks the replacement from ever attaching.
/// Drop severs the connection but sends no `Shutdown` — the daemon and its
/// shell outlive any one client.
impl Drop for DaemonClient {
    fn drop(&mut self) {
        self.disconnect();
    }
}

impl SessionEngine for DaemonClient {
    fn id(&self) -> &SessionId {
        &self.id
    }

    fn write_stdin(&self, bytes: &[u8]) -> Result<(), EngineError> {
        self.send(&Frame::Stdin(bytes.to_vec()))
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), EngineError> {
        self.send(&Frame::Resize { cols, rows })
    }

    fn close(&self) -> Result<(), EngineError> {
        // Ask the daemon to terminate, then sever the connection. Best-effort:
        // never panic on teardown.
        let _ = self.send(&Frame::Shutdown);
        self.disconnect();
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::io::{Read as _, Write as _};
    use std::os::unix::net::UnixListener;
    use std::path::Path;
    use std::sync::{Arc, Mutex as StdMutex};

    use kriyon_core::wire::{Frame, FrameDecoder};

    /// A fake daemon serving one client at a time, like the real one: it greets
    /// whoever it accepts with a `Busy` frame, serves them until they hang up,
    /// then moves on to whoever was queued. Records every `Shutdown` it reads.
    pub(crate) fn spawn_greeting_daemon(socket: &Path) -> Arc<StdMutex<u32>> {
        let listener = UnixListener::bind(socket).expect("bind greeting daemon");
        let shutdowns = Arc::new(StdMutex::new(0));
        let seen = Arc::clone(&shutdowns);
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut stream) = conn else { return };
                let _ = stream.write_all(&Frame::Busy(false).encode());
                let mut dec = FrameDecoder::new();
                let mut buf = [0u8; 4096];
                while let Ok(n) = stream.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    dec.push(&buf[..n]);
                    while let Some(frame) = dec.next_frame() {
                        if frame == Frame::Shutdown {
                            *seen.lock().expect("lock") += 1;
                        }
                    }
                }
            }
        });
        shutdowns
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::spawn_greeting_daemon;
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::sync::Mutex as StdMutex;
    use std::time::{Duration, Instant};

    /// A minimal in-process fake daemon: accepts one client, and echoes every
    /// `Stdin` frame back as an `Output` frame. Records whether it saw Shutdown.
    fn spawn_fake_daemon(socket: &Path) -> Arc<StdMutex<bool>> {
        let listener = UnixListener::bind(socket).expect("bind fake daemon");
        let saw_shutdown = Arc::new(StdMutex::new(false));
        let flag = Arc::clone(&saw_shutdown);
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut writer = stream.try_clone().expect("clone");
            let mut dec = FrameDecoder::new();
            let mut buf = [0u8; 4096];
            loop {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        dec.push(&buf[..n]);
                        while let Some(frame) = dec.next_frame() {
                            match frame {
                                Frame::Stdin(bytes) => {
                                    let _ = writer.write_all(&Frame::Output(bytes).encode());
                                    let _ = writer.flush();
                                }
                                Frame::Shutdown => {
                                    *flag.lock().expect("lock") = true;
                                    return;
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
        });
        saw_shutdown
    }

    #[test]
    fn a_connection_the_daemon_greeted_is_proven_accepted() {
        let dir = tempfile::tempdir().expect("tmp dir");
        let socket = dir.path().join("s.sock");
        let _shutdowns = spawn_greeting_daemon(&socket);

        let stream = UnixStream::connect(&socket).expect("connect");
        let client = DaemonClient::adopt(stream, SessionId("s".into())).expect("client");

        assert!(client.wait_accepted(Duration::from_secs(2)));
    }

    /// The bug this guards: a second app instance connects to a daemon the first
    /// instance is using. Its connection only queues. If it then wrote `Shutdown`
    /// and left, the daemon would read that frame the moment the first instance
    /// next let go — killing a live session its owner had just opened.
    #[test]
    fn a_queued_connection_is_never_accepted_and_releasing_it_stops_nothing() {
        let dir = tempfile::tempdir().expect("tmp dir");
        let socket = dir.path().join("s.sock");
        let shutdowns = spawn_greeting_daemon(&socket);

        let owner = DaemonClient::adopt(
            UnixStream::connect(&socket).expect("connect owner"),
            SessionId("s".into()),
        )
        .expect("owner");
        assert!(owner.wait_accepted(Duration::from_secs(2)));

        let intruder = DaemonClient::adopt(
            UnixStream::connect(&socket).expect("connect intruder"),
            SessionId("s".into()),
        )
        .expect("intruder");
        assert!(
            !intruder.wait_accepted(Duration::from_millis(300)),
            "queued behind the owner: the daemon never greeted it"
        );

        intruder.release();
        // The owner lets go; the daemon now reads whatever the intruder left.
        drop(owner);
        std::thread::sleep(Duration::from_millis(300));

        assert_eq!(*shutdowns.lock().expect("lock"), 0);
    }

    /// An adopted client has no frontend to report bytes drained. With the
    /// normal watermark its reader would park after `HIGH_WATER` bytes, the
    /// daemon's socket write would block, and the unwatched agent would freeze.
    #[test]
    fn an_adopted_client_never_parks_the_daemon_however_much_it_prints() {
        let dir = tempfile::tempdir().expect("tmp dir");
        let socket = dir.path().join("s.sock");
        let listener = UnixListener::bind(&socket).expect("bind");
        let wrote_all = Arc::new(StdMutex::new(false));
        let flag = Arc::clone(&wrote_all);
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            // Several times the paced client's high-water mark.
            let chunk = Frame::Output(vec![b'x'; 64 * 1024]).encode();
            for _ in 0..(HIGH_WATER * 4 / (64 * 1024)) {
                if stream.write_all(&chunk).is_err() {
                    return;
                }
            }
            *flag.lock().expect("lock") = true;
        });

        let stream = UnixStream::connect(&socket).expect("connect");
        let client = DaemonClient::adopt(stream, SessionId("adopted".into())).expect("adopt");

        let deadline = Instant::now() + Duration::from_secs(5);
        while !*wrote_all.lock().expect("lock") {
            assert!(
                Instant::now() < deadline,
                "the daemon's writes stalled: the adopted reader parked"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        drop(client);
    }

    /// Replacing a client (webview reload calls `create_session` again for a
    /// live id) drops the old `DaemonClient`. The daemon serves one client at a
    /// time, so the drop MUST fully close the old connection — reader-thread
    /// clone included — or the daemon never accepts the replacement and the new
    /// terminal stays blank. It must NOT send `Shutdown`: that would kill the
    /// daemon and the user's shell during a handover.
    #[test]
    fn drop_closes_the_connection_without_requesting_shutdown() {
        let dir = tempfile::tempdir().expect("tmp");
        let socket = dir.path().join("s.sock");
        let saw_shutdown = spawn_fake_daemon(&socket);
        let deadline = Instant::now() + Duration::from_secs(2);
        while !socket.exists() {
            assert!(Instant::now() < deadline, "fake socket never appeared");
            std::thread::sleep(Duration::from_millis(10));
        }

        let client =
            DaemonClient::connect(&socket, SessionId("s1".to_string()), |_| {}, |_| {}, || {})
                .expect("connect");
        client.attach(80, 24).expect("attach");
        drop(client);

        // The fake daemon's read loop exits only on EOF, i.e. once every dup of
        // the app-side socket (writer AND reader-thread clone) is closed.
        let mut daemon_saw_eof = false;
        for _ in 0..100 {
            if socket_peer_closed(&socket) {
                daemon_saw_eof = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            daemon_saw_eof,
            "dropping the client must close the connection so the daemon can serve a replacement"
        );
        assert!(
            !*saw_shutdown.lock().expect("lock"),
            "a handover drop must never ask the daemon to shut down"
        );
    }

    /// True once the fake daemon's accept loop has finished serving its one
    /// client: it then accepts (and immediately drops) new probes, which a
    /// still-attached daemon never does.
    fn socket_peer_closed(socket: &Path) -> bool {
        // The fake daemon accepts exactly one client and returns on EOF; once
        // returned, its listener is dropped and connect() starts failing.
        UnixStream::connect(socket).is_err()
    }

    #[test]
    fn client_streams_output_and_sends_shutdown_on_close() {
        let dir = tempfile::tempdir().expect("tmp");
        let socket = dir.path().join("s.sock");
        let saw_shutdown = spawn_fake_daemon(&socket);

        // Wait for the listener to be ready.
        let deadline = Instant::now() + Duration::from_secs(2);
        while !socket.exists() {
            assert!(Instant::now() < deadline, "fake socket never appeared");
            std::thread::sleep(Duration::from_millis(10));
        }

        let collected = Arc::new(StdMutex::new(Vec::<u8>::new()));
        let sink = Arc::clone(&collected);
        let client = DaemonClient::connect(
            &socket,
            SessionId("s1".to_string()),
            move |bytes| {
                sink.lock().expect("lock").extend_from_slice(&bytes);
            },
            |_| {},
            || {},
        )
        .expect("connect");

        assert_eq!(client.id(), &SessionId("s1".to_string()));
        client.attach(80, 24).expect("attach");
        client.write_stdin(b"ECHO_ME").expect("stdin");

        let mut found = false;
        for _ in 0..100 {
            if String::from_utf8_lossy(&collected.lock().expect("lock")).contains("ECHO_ME") {
                found = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(found, "client should receive the echoed output");

        client.close().expect("close");
        // Give the fake a beat to record the Shutdown it received.
        for _ in 0..50 {
            if *saw_shutdown.lock().expect("lock") {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            *saw_shutdown.lock().expect("lock"),
            "close() should send a Shutdown frame to the daemon"
        );
    }

    #[test]
    fn client_delivers_busy_frames_to_the_on_busy_callback() {
        let dir = tempfile::tempdir().expect("tmp");
        let socket = dir.path().join("s.sock");
        // A fake daemon that pushes a single Busy(true) frame on connect.
        let listener = UnixListener::bind(&socket).expect("bind");
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let _ = stream.write_all(&Frame::Busy(true).encode());
                let _ = stream.flush();
                // Hold the connection open so the client keeps reading.
                std::thread::sleep(Duration::from_millis(500));
            }
        });

        let deadline = Instant::now() + Duration::from_secs(2);
        while !socket.exists() {
            assert!(Instant::now() < deadline, "fake socket never appeared");
            std::thread::sleep(Duration::from_millis(10));
        }

        let busy = Arc::new(StdMutex::new(None::<bool>));
        let sink = Arc::clone(&busy);
        let client = DaemonClient::connect(
            &socket,
            SessionId("s1".to_string()),
            |_| {},
            move |b| {
                *sink.lock().expect("lock") = Some(b);
            },
            || {},
        )
        .expect("connect");
        client.attach(80, 24).expect("attach");

        let mut got = None;
        for _ in 0..100 {
            if let Some(b) = *busy.lock().expect("lock") {
                got = Some(b);
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(got, Some(true), "on_busy should receive the Busy frame");
    }

    /// The shell dying (daemon closes the socket) must surface as an exit
    /// event — a silently wedged pane was the old behavior.
    #[test]
    fn daemon_side_eof_fires_on_exit() {
        let dir = tempfile::tempdir().expect("tmp");
        let socket = dir.path().join("s.sock");
        // A fake daemon that accepts one client and immediately hangs up.
        let listener = UnixListener::bind(&socket).expect("bind");
        std::thread::spawn(move || {
            let _ = listener.accept();
            // Dropping the accepted stream closes the connection: EOF.
        });

        let exited = Arc::new(StdMutex::new(false));
        let flag = Arc::clone(&exited);
        let client = DaemonClient::connect(
            &socket,
            SessionId("s1".to_string()),
            |_| {},
            |_| {},
            move || {
                *flag.lock().expect("lock") = true;
            },
        )
        .expect("connect");

        let mut fired = false;
        for _ in 0..100 {
            if *exited.lock().expect("lock") {
                fired = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(fired, "a daemon-side EOF must fire on_exit");
        drop(client);
    }

    /// Our own disconnect (close/drop — e.g. the webview reloading and the
    /// replacement client taking over) must NOT fire `on_exit`: the shell is
    /// alive and a phantom "shell exited" banner would be wrong.
    #[test]
    fn deliberate_disconnect_does_not_fire_on_exit() {
        let dir = tempfile::tempdir().expect("tmp");
        let socket = dir.path().join("s.sock");
        let listener = UnixListener::bind(&socket).expect("bind");
        std::thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept() {
                // Hold the connection open until the client hangs up.
                let mut buf = [0u8; 64];
                let mut s = stream;
                while matches!(s.read(&mut buf), Ok(n) if n > 0) {}
            }
        });

        let exited = Arc::new(StdMutex::new(false));
        let flag = Arc::clone(&exited);
        let client = DaemonClient::connect(
            &socket,
            SessionId("s1".to_string()),
            |_| {},
            |_| {},
            move || {
                *flag.lock().expect("lock") = true;
            },
        )
        .expect("connect");
        client.attach(80, 24).expect("attach");

        // Drop = disconnect (the handover path). Join happens inside drop, so
        // by the time it returns the reader thread has fully exited.
        drop(client);
        assert!(
            !*exited.lock().expect("lock"),
            "a client-initiated disconnect must not fire on_exit"
        );
    }
}
