//! App-side client for the out-of-process `kriyon-ptyd` daemon. Implements the
//! [`SessionEngine`] trait so the rest of the app is unchanged: the PTY lives
//! in the daemon, and this client keeps reading its output whether or not the
//! window draws — the [Output gate] paces it by a webview that drains, and
//! holds or drops what a stalled one can't take yet.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Instant;

use kriyon_core::output_gate::{CatchUp, OutputGate};
use kriyon_core::session::{EngineError, SessionEngine, SessionId};
use kriyon_core::wire::{Frame, FrameDecoder};
use parking_lot::{Condvar, Mutex};

/// Hold output for the webview once this many bytes are delivered but not drained.
const HIGH_WATER: usize = 128 * 1024;
/// Release held output once in-flight bytes drain to this or below.
const LOW_WATER: usize = 16 * 1024;
/// The most output held for a webview that has stopped painting (a hidden
/// window gets no animation frames). Past it the held bytes are dropped and the
/// webview repaints from the daemon's screen snapshot when it is back. Bounds
/// the app's memory per session however long the window stays hidden.
const HOLD_CAP: usize = 1024 * 1024;
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
    /// Output on its way to the webview. The reader waits on it only while
    /// the webview is still draining: if it waited on a webview that stopped
    /// (a hidden window gets no frames), the daemon's socket write would
    /// block, then its pty read, and every session would freeze (12 Nov).
    /// Shared with `report_drained`, which releases held output under the same
    /// lock, so bytes reach the webview in order.
    outlet: Arc<Outlet>,
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

/// The [Output gate] and the sink it feeds, behind one lock.
struct Delivery {
    gate: OutputGate,
    deliver: Box<dyn FnMut(Vec<u8>) + Send>,
}

/// [`Delivery`], and the signal a pacing reader waits on: the webview drained
/// some bytes, or the client is closing.
struct Outlet {
    delivery: Mutex<Delivery>,
    progress: Condvar,
}

impl DaemonClient {
    /// Connect to a daemon's socket. Every output byte goes to `on_read` as
    /// soon as it is read; the same bytes go to the webview through
    /// `on_output`, paced by [`DaemonClient::report_drained`]. Foreground-busy
    /// transitions go to `on_busy`, and a single session-death notification to
    /// `on_exit`. The caller should send [`DaemonClient::attach`] next to set
    /// the initial size.
    ///
    /// `on_exit` fires exactly once, from the reader thread, when the daemon
    /// side closes the connection (the shell exited, or the daemon died) — and
    /// never for a disconnect this client initiated itself.
    ///
    /// # Errors
    /// Returns [`EngineError::Pty`] if the socket cannot be connected or cloned.
    pub fn connect<R, F, G, H>(
        socket: &Path,
        id: SessionId,
        on_read: R,
        on_output: F,
        on_busy: G,
        on_exit: H,
    ) -> Result<Self, EngineError>
    where
        R: FnMut(&[u8]) + Send + 'static,
        F: FnMut(Vec<u8>) + Send + 'static,
        G: Fn(bool) + Send + 'static,
        H: FnOnce() + Send + 'static,
    {
        let stream = UnixStream::connect(socket).map_err(io_err)?;
        Self::from_stream(stream, id, on_read, on_output, on_busy, on_exit)
    }

    /// Build a client from an already-connected stream. Lets the caller probe a
    /// daemon's liveness with a real connection and then reuse it, instead of
    /// opening a throwaway probe (which the daemon would attach + replay, draining
    /// the scrollback ring before the real client ever connects).
    ///
    /// # Errors
    /// Returns [`EngineError::Pty`] if the stream cannot be cloned.
    pub fn from_stream<R, F, G, H>(
        stream: UnixStream,
        id: SessionId,
        on_read: R,
        on_output: F,
        on_busy: G,
        on_exit: H,
    ) -> Result<Self, EngineError>
    where
        R: FnMut(&[u8]) + Send + 'static,
        F: FnMut(Vec<u8>) + Send + 'static,
        G: Fn(bool) + Send + 'static,
        H: FnOnce() + Send + 'static,
    {
        let gate = OutputGate::new(HIGH_WATER, LOW_WATER, HOLD_CAP, Instant::now());
        Self::build(stream, id, on_read, on_output, on_busy, on_exit, gate)
    }

    /// [Daemon adoption]: connect to a live daemon nobody is looking at, so the
    /// session is first-class to the [Resource sweep], the [Sleep ledger] and
    /// `close_session` before its pane ever mounts.
    ///
    /// Output is discarded — the daemon's own emulator keeps the screen
    /// snapshot current and repaints the real client when `create_session`
    /// replaces this one. Nothing reports bytes drained for a sink-less client,
    /// so its gate is unpaced and never holds anything.
    /// No `Attach` is sent either: that frame resizes the PTY, and a live TUI
    /// must not be reflowed to a default size behind the user's back.
    ///
    /// # Errors
    /// Returns [`EngineError::Pty`] if the stream cannot be cloned.
    pub fn adopt(stream: UnixStream, id: SessionId) -> Result<Self, EngineError> {
        Self::build(
            stream,
            id,
            |_| {},
            |_| {},
            |_| {},
            || {},
            OutputGate::unpaced(Instant::now()),
        )
    }

    fn build<R, F, G, H>(
        stream: UnixStream,
        id: SessionId,
        mut on_read: R,
        on_output: F,
        on_busy: G,
        on_exit: H,
        gate: OutputGate,
    ) -> Result<Self, EngineError>
    where
        R: FnMut(&[u8]) + Send + 'static,
        F: FnMut(Vec<u8>) + Send + 'static,
        G: Fn(bool) + Send + 'static,
        H: FnOnce() + Send + 'static,
    {
        let mut reader = stream.try_clone().map_err(io_err)?;
        // Bounds the writer only: the option lives on the shared socket, but the
        // reader never writes.
        let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
        let accepted = Arc::new(AtomicBool::new(false));
        let reader_accepted = Arc::clone(&accepted);
        let outlet = Arc::new(Outlet {
            delivery: Mutex::new(Delivery {
                gate,
                deliver: Box::new(on_output),
            }),
            progress: Condvar::new(),
        });
        let reader_outlet = Arc::clone(&outlet);
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
                                    on_read(&bytes);
                                    let mut d = reader_outlet.delivery.lock();
                                    // Paced by a webview that draws; never by
                                    // one that has stopped.
                                    while let Some(until) = d.gate.pace_until(Instant::now()) {
                                        if reader_closing.load(Ordering::Relaxed) {
                                            break;
                                        }
                                        reader_outlet.progress.wait_until(&mut d, until);
                                    }
                                    if let Some(out) = d.gate.offer(bytes, Instant::now()) {
                                        (d.deliver)(out);
                                    }
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
            outlet,
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

    /// Acknowledge `bytes` drained from the frontend sink: deliver output held
    /// while it was behind, or, if some had to be dropped, ask the daemon to
    /// repaint the screen. Wired to the `report_drained` Tauri command.
    pub fn report_drained(&self, bytes: usize) {
        let mut d = self.outlet.delivery.lock();
        let catch_up = d.gate.drained(bytes, Instant::now());
        self.outlet.progress.notify_all();
        match catch_up {
            // Under the lock, so it lands before anything read after it.
            CatchUp::Deliver(held) => (d.deliver)(held),
            CatchUp::Repaint => {
                drop(d);
                // A failed send severs the connection; the reader then reports
                // the session gone, so there is nothing more to do with it here.
                let _ = self.request_repaint();
            }
            CatchUp::Nothing => {}
        }
    }

    /// Sever the connection without touching the daemon's child: shut the
    /// socket down for every dup (the reader thread
    /// holds a clone — dropping our writer alone would leave the connection
    /// open and the daemon blocked on this client forever), then join the
    /// reader. Idempotent; used by both `close()` and `Drop`.
    fn disconnect(&self) {
        // Mark the disconnect as ours BEFORE severing, so the reader thread
        // never mistakes it for the daemon dying and fires a phantom exit.
        self.closing.store(true, Ordering::Relaxed);
        self.outlet.progress.notify_all();
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

    /// A fake daemon that writes `total` bytes of output in 64 KB frames as fast
    /// as the client takes them, and flags once every write has gone through —
    /// the stand-in for a pty whose reads never stall.
    fn spawn_flooding_daemon(socket: &Path, total: usize) -> Arc<StdMutex<bool>> {
        let listener = UnixListener::bind(socket).expect("bind");
        let wrote_all = Arc::new(StdMutex::new(false));
        let flag = Arc::clone(&wrote_all);
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let chunk = Frame::Output(vec![b'x'; 64 * 1024]).encode();
            for _ in 0..(total / (64 * 1024)) {
                if stream.write_all(&chunk).is_err() {
                    return;
                }
            }
            *flag.lock().expect("lock") = true;
            // Stay connected, like a live daemon.
            std::thread::sleep(Duration::from_secs(5));
        });
        wrote_all
    }

    fn wait_for(flag: &StdMutex<bool>, what: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !*flag.lock().expect("lock") {
            assert!(Instant::now() < deadline, "{what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// The hidden-window freeze (12 Nov): a hidden webview gets no animation
    /// frames, so its write queue never flushes and never reports bytes
    /// drained. The session must keep being read anyway — the daemon's writes,
    /// and so its pty reads, must never wait on the webview.
    #[test]
    fn output_keeps_flowing_while_the_webview_drains_nothing() {
        let dir = tempfile::tempdir().expect("tmp dir");
        let socket = dir.path().join("s.sock");
        // Far past the old high-water mark, and past any bound the app holds.
        let wrote_all = spawn_flooding_daemon(&socket, 64 * HIGH_WATER);

        // A live, attached sink that takes bytes but never reports them drained.
        let client = DaemonClient::connect(
            &socket,
            SessionId("s".into()),
            |_| {},
            |_| {},
            |_| {},
            || {},
        )
        .expect("connect");

        wait_for(
            &wrote_all,
            "the daemon's writes stalled: the reader waited on the webview",
        );
        drop(client);
    }

    /// A window that draws drains every frame. A program printing faster than
    /// that must still be paced by it, as before, rather than have its output
    /// dropped: scrollback keeps every line of a fast build log.
    #[test]
    fn a_webview_that_keeps_draining_paces_the_session_and_gets_every_byte() {
        let dir = tempfile::tempdir().expect("tmp dir");
        let socket = dir.path().join("s.sock");
        // Well past what the app would hold for a stalled webview.
        let total = 4 * HOLD_CAP;
        let wrote_all = spawn_flooding_daemon(&socket, total);

        let (tx, rx) = std::sync::mpsc::channel::<usize>();
        let delivered = Arc::new(StdMutex::new(0usize));
        let seen = Arc::clone(&delivered);
        let client = Arc::new(
            DaemonClient::connect(
                &socket,
                SessionId("s".into()),
                |_| {},
                move |bytes| {
                    *seen.lock().expect("lock") += bytes.len();
                    let _ = tx.send(bytes.len());
                },
                |_| {},
                || {},
            )
            .expect("connect"),
        );
        // The write queue: once a "frame", report everything that arrived.
        let drainer = Arc::clone(&client);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(5));
            let mut n = 0;
            loop {
                match rx.try_recv() {
                    Ok(len) => n += len,
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => return,
                }
            }
            drainer.report_drained(n);
        });

        wait_for(&wrote_all, "the daemon's writes stalled");
        let deadline = Instant::now() + Duration::from_secs(5);
        while *delivered.lock().expect("lock") < total {
            assert!(
                Instant::now() < deadline,
                "the webview did not get every byte"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            *delivered.lock().expect("lock"),
            total,
            "nothing dropped, nothing added"
        );
    }

    /// While the webview is away, every byte still reaches `on_read` (status,
    /// notifications), the webview is sent no more than a bounded amount, and
    /// once it drains it is caught up by a screen repaint from the daemon.
    #[test]
    fn a_webview_that_comes_back_after_a_flood_is_caught_up_by_a_repaint() {
        let dir = tempfile::tempdir().expect("tmp dir");
        let socket = dir.path().join("s.sock");
        let total = 64 * HIGH_WATER;
        let listener = UnixListener::bind(&socket).expect("bind");
        let (wrote_all, saw_repaint) = (
            Arc::new(StdMutex::new(false)),
            Arc::new(StdMutex::new(false)),
        );
        let (wrote, repaint) = (Arc::clone(&wrote_all), Arc::clone(&saw_repaint));
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let chunk = Frame::Output(vec![b'x'; 64 * 1024]).encode();
            for _ in 0..(total / (64 * 1024)) {
                if stream.write_all(&chunk).is_err() {
                    return;
                }
            }
            *wrote.lock().expect("lock") = true;
            let mut dec = FrameDecoder::new();
            let mut buf = [0u8; 4096];
            while let Ok(n) = stream.read(&mut buf) {
                if n == 0 {
                    return;
                }
                dec.push(&buf[..n]);
                while let Some(frame) = dec.next_frame() {
                    if frame == Frame::Repaint {
                        *repaint.lock().expect("lock") = true;
                    }
                }
            }
        });

        let read = Arc::new(StdMutex::new(0usize));
        let sent = Arc::new(StdMutex::new(0usize));
        let (read_sink, sent_sink) = (Arc::clone(&read), Arc::clone(&sent));
        let client = DaemonClient::connect(
            &socket,
            SessionId("s".into()),
            move |bytes| *read_sink.lock().expect("lock") += bytes.len(),
            move |bytes| *sent_sink.lock().expect("lock") += bytes.len(),
            |_| {},
            || {},
        )
        .expect("connect");

        wait_for(&wrote_all, "the daemon's writes stalled");
        let deadline = Instant::now() + Duration::from_secs(5);
        while *read.lock().expect("lock") < total {
            assert!(Instant::now() < deadline, "not every byte reached on_read");
            std::thread::sleep(Duration::from_millis(20));
        }
        let delivered = *sent.lock().expect("lock");
        assert!(
            delivered <= HIGH_WATER + 64 * 1024,
            "a webview that drains nothing was sent {delivered} bytes"
        );

        // The window shows again: the write queue flushes what it had.
        client.report_drained(delivered);
        wait_for(
            &saw_repaint,
            "the catching-up webview never asked for a repaint",
        );
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

        let client = DaemonClient::connect(
            &socket,
            SessionId("s1".to_string()),
            |_| {},
            |_| {},
            |_| {},
            || {},
        )
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
            |_| {},
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
