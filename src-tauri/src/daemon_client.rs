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

use kriyon_core::cli_dialog::DialogState;
use kriyon_core::daemon::DaemonEvent;
use kriyon_core::output_gate::{CatchUp, OutputGate};
use kriyon_core::session::{EngineError, SessionEngine, SessionId};
use kriyon_core::wire::{self, Frame, FrameDecoder};
use parking_lot::{Condvar, Mutex};

const READ_BUF_LEN: usize = 8192;

/// The requester id of the window's own [Screen snapshot]s, which repaint it
/// without the daemon skipping ahead. Never a remote device's.
pub const WINDOW_SNAPSHOT: u32 = u32::MAX;
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
    /// The last [`Frame::Dialog`] the daemon sent, for whoever must know
    /// whether a [CLI dialog] shows without the window (ADR-0040).
    dialog: Arc<Mutex<Option<DialogState>>>,
    /// A remote device is an [Onlooker] of this session (see
    /// [`DaemonClient::set_remote_onlooker`]).
    onlooked: Arc<AtomicBool>,
    /// The daemon said `Hello`: it sends its screen apart from output and
    /// answers requests that carry ids.
    hello: Arc<AtomicBool>,
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
    pub fn connect<E, F, H>(
        socket: &Path,
        id: SessionId,
        on_event: E,
        on_output: F,
        on_exit: H,
    ) -> Result<Self, EngineError>
    where
        E: FnMut(DaemonEvent<'_>) + Send + 'static,
        F: FnMut(Vec<u8>) + Send + 'static,
        H: FnOnce() + Send + 'static,
    {
        let stream = UnixStream::connect(socket).map_err(io_err)?;
        Self::from_stream(stream, id, on_event, on_output, on_exit)
    }

    /// Build a client from an already-connected stream. Lets the caller probe a
    /// daemon's liveness with a real connection and then reuse it, instead of
    /// opening a throwaway probe (which the daemon would attach + replay, draining
    /// the scrollback ring before the real client ever connects).
    ///
    /// # Errors
    /// Returns [`EngineError::Pty`] if the stream cannot be cloned.
    pub fn from_stream<E, F, H>(
        stream: UnixStream,
        id: SessionId,
        on_event: E,
        on_output: F,
        on_exit: H,
    ) -> Result<Self, EngineError>
    where
        E: FnMut(DaemonEvent<'_>) + Send + 'static,
        F: FnMut(Vec<u8>) + Send + 'static,
        H: FnOnce() + Send + 'static,
    {
        let gate = OutputGate::for_webview(Instant::now());
        Self::build(stream, id, on_event, on_output, on_exit, gate)
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
            || {},
            OutputGate::unpaced(Instant::now()),
        )
    }

    fn build<E, F, H>(
        stream: UnixStream,
        id: SessionId,
        mut on_event: E,
        on_output: F,
        on_exit: H,
        gate: OutputGate,
    ) -> Result<Self, EngineError>
    where
        E: FnMut(DaemonEvent<'_>) + Send + 'static,
        F: FnMut(Vec<u8>) + Send + 'static,
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
        let dialog = Arc::new(Mutex::new(None));
        let reader_dialog = Arc::clone(&dialog);
        let onlooked = Arc::new(AtomicBool::new(false));
        let reader_onlooked = Arc::clone(&onlooked);
        let hello = Arc::new(AtomicBool::new(false));
        let reader_hello = Arc::clone(&hello);

        let reader_thread = std::thread::spawn(move || {
            let mut dec = FrameDecoder::new();
            let mut buf = [0u8; READ_BUF_LEN];
            'connection: loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        dec.push(&buf[..n]);
                        loop {
                            let frame = match dec.next_frame() {
                                Ok(Some(frame)) => frame,
                                Ok(None) => break,
                                // Nothing after a frame that long can be read.
                                // Close the socket too, or the daemon would
                                // block writing to a reader that has stopped.
                                Err(_) => {
                                    let _ = reader.shutdown(std::net::Shutdown::Both);
                                    break 'connection;
                                }
                            };
                            reader_accepted.store(true, Ordering::Relaxed);
                            // Every listener first, in the order the frames
                            // came, before the webview's pacing can wait.
                            if let Some(event) = DaemonEvent::of(&frame) {
                                on_event(event);
                            }
                            match frame {
                                Frame::Output(bytes) => {
                                    let mut d = reader_outlet.delivery.lock();
                                    // Paced by a webview that draws, and never
                                    // by one that has stopped. Not paced at all
                                    // while a remote device is an onlooker: a
                                    // slow window must not slow it (ADR-0059).
                                    while let Some(until) = d.gate.pace_until(Instant::now()) {
                                        if reader_closing.load(Ordering::Relaxed)
                                            || reader_onlooked.load(Ordering::Relaxed)
                                        {
                                            break;
                                        }
                                        reader_outlet.progress.wait_until(&mut d, until);
                                    }
                                    if let Some(out) = d.gate.offer(bytes, Instant::now()) {
                                        (d.deliver)(out);
                                    }
                                }
                                Frame::Screen(bytes)
                                | Frame::Snapshot {
                                    id: WINDOW_SNAPSHOT,
                                    bytes,
                                } => {
                                    let mut d = reader_outlet.delivery.lock();
                                    let out = d.gate.offer_screen(bytes, Instant::now());
                                    (d.deliver)(out);
                                }
                                // A daemon that names its run sends its screen
                                // apart from output and answers requests.
                                Frame::Hello { .. } => {
                                    reader_outlet.delivery.lock().gate.expect_screens();
                                    reader_hello.store(true, Ordering::Relaxed);
                                }
                                Frame::Dialog { open, generation } => {
                                    *reader_dialog.lock() = Some(DialogState { open, generation });
                                }
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
            dialog,
            onlooked,
            hello,
        })
    }

    /// Ask the daemon for its [Output history], for requester `id`.
    ///
    /// # Errors
    /// [`EngineError::Pty`] on a write failure, or when the daemon has not said
    /// `Hello`: one built before requests carried ids would misread them.
    pub fn request_history(&self, id: u32) -> Result<(), EngineError> {
        self.require_hello()?;
        self.send(&Frame::RequestHistory { id })
    }

    /// Ask the daemon for a [Screen snapshot] for requester `id` alone, in
    /// order with the output; the window is not repainted. A skip ahead the
    /// window's stream makes (a `Screen` event) drops answers still queued:
    /// a requester that sees one asks again.
    ///
    /// # Errors
    /// As [`Self::request_history`].
    pub fn request_snapshot(&self, id: u32) -> Result<(), EngineError> {
        self.require_hello()?;
        self.send(&Frame::RequestSnapshot { id })
    }

    fn require_hello(&self) -> Result<(), EngineError> {
        if self.hello.load(Ordering::Relaxed) {
            Ok(())
        } else {
            Err(EngineError::Pty(
                "the session's daemon is too old to answer requests".into(),
            ))
        }
    }

    /// Whether a remote device is an [Onlooker] of this session. While one is,
    /// the reader never waits for the webview, and the webview's gate holds
    /// up to [`kriyon_core::output_gate::WEBVIEW_ONLOOKED_HOLD_CAP`] before it
    /// cuts (ADR-0059). Set by the remote layer.
    pub fn set_remote_onlooker(&self, onlooked: bool) {
        self.onlooked.store(onlooked, Ordering::Relaxed);
        self.outlet
            .delivery
            .lock()
            .gate
            .set_remote_onlooker(onlooked);
        // A reader waiting on the webview stops waiting.
        self.outlet.progress.notify_all();
    }

    /// Whether a window shows this session's output. Without one (a session
    /// a [Remote device] started) nothing reports bytes drained, so output
    /// goes out unpaced and is dropped, as an adopted client's is; with one,
    /// it is paced by [`Self::report_drained`] again from an empty gate.
    pub fn set_viewer(&self, viewer: bool) {
        let now = Instant::now();
        let mut gate = if viewer {
            OutputGate::for_webview(now)
        } else {
            OutputGate::unpaced(now)
        };
        if self.hello.load(Ordering::Relaxed) {
            gate.expect_screens();
        }
        gate.set_remote_onlooker(self.onlooked.load(Ordering::Relaxed));
        self.outlet.delivery.lock().gate = gate;
        // A reader waiting on the old gate stops waiting.
        self.outlet.progress.notify_all();
    }

    /// The [CLI dialog] on the daemon's screen and its [Dialog generation], as
    /// the daemon last said; `None` before it said anything (an older daemon
    /// never does). Stored by the reader thread in the order the frames came,
    /// the order `on_read` sees output in, not the webview's gated delivery:
    /// whoever numbers screen updates should do it at `on_read`.
    #[must_use]
    pub fn dialog(&self) -> Option<DialogState> {
        *self.dialog.lock()
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

    /// Ask the daemon to resend its screen snapshot for the window: its own
    /// snapshot from a daemon that said `Hello`, a `Repaint` from an older
    /// one. Sent when a terminal component (re)attaches to this live session,
    /// whose xterm starts blank, and when the window catches up after a cut.
    ///
    /// # Errors
    /// Returns [`EngineError::Pty`] on write failure.
    pub fn request_repaint(&self) -> Result<(), EngineError> {
        // A daemon that said hello repaints the window alone; a `Repaint`
        // would make it drop everything queued, which every other reader of
        // this stream (a remote device) would see as a gap.
        if self.hello.load(Ordering::Relaxed) {
            self.send(&Frame::RequestSnapshot {
                id: WINDOW_SNAPSHOT,
            })
        } else {
            self.send(&Frame::Repaint)
        }
    }

    fn send(&self, frame: &Frame) -> Result<(), EngineError> {
        self.send_encoded(&frame.encode())
    }

    /// Write already-encoded frames, as [`Self::send`] does one.
    fn send_encoded(&self, frames: &[u8]) -> Result<(), EngineError> {
        let mut w = self.writer.lock();
        let sent = w.write_all(frames).and_then(|()| w.flush()).map_err(io_err);
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
        // Under the lock, or the wake can land between a pacing reader's
        // check of `closing` and its wait, and be lost for a whole stall.
        let held = self.outlet.delivery.lock();
        self.outlet.progress.notify_all();
        drop(held);
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
        self.send_encoded(&wire::ByteStream::Stdin.encode(bytes))
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
                    while let Ok(Some(frame)) = dec.next_frame() {
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
    use kriyon_core::output_gate::{
        WEBVIEW_HIGH_WATER as HIGH_WATER, WEBVIEW_HOLD_CAP as HOLD_CAP,
    };

    #[test]
    fn with_no_viewer_output_is_not_held_for_one() {
        let (daemon, app) = UnixStream::pair().expect("pair");
        let delivered = Arc::new(StdMutex::new(0usize));
        let counted = Arc::clone(&delivered);
        let client = DaemonClient::from_stream(
            app,
            SessionId("s".into()),
            |_| {},
            move |bytes: Vec<u8>| *counted.lock().expect("lock") += bytes.len(),
            || {},
        )
        .expect("client");
        client.set_viewer(false);
        let mut daemon = daemon;
        let chunk = vec![b'x'; 16 * 1024];
        let total = HIGH_WATER * 4;
        for _ in 0..total / chunk.len() {
            std::io::Write::write_all(&mut daemon, &Frame::Output(chunk.clone()).encode())
                .expect("write");
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while *delivered.lock().expect("lock") < total {
            assert!(
                Instant::now() < deadline,
                "held for a viewer that isn't there: {}",
                *delivered.lock().expect("lock")
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn the_client_keeps_the_last_dialog_state_the_daemon_sent() {
        let (daemon, app) = UnixStream::pair().expect("pair");
        let client = DaemonClient::adopt(app, SessionId("s".into())).expect("client");
        assert_eq!(client.dialog(), None, "nothing heard yet");
        let mut daemon = daemon;
        std::io::Write::write_all(
            &mut daemon,
            &[
                Frame::Dialog {
                    open: true,
                    generation: 41,
                }
                .encode(),
                Frame::Dialog {
                    open: false,
                    generation: 42,
                }
                .encode(),
            ]
            .concat(),
        )
        .expect("write");
        let deadline = Instant::now() + Duration::from_secs(5);
        while client.dialog().map(|d| d.generation) != Some(42) {
            assert!(
                Instant::now() < deadline,
                "the client never heard the dialog"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            client.dialog(),
            Some(DialogState {
                open: false,
                generation: 42
            })
        );
    }
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
                        while let Ok(Some(frame)) = dec.next_frame() {
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

    /// What a [`spawn_flooding_daemon`] has seen.
    struct Flood {
        /// Every write went through.
        wrote_all: Arc<StdMutex<bool>>,
        /// The client asked for a repaint after that.
        saw_repaint: Arc<StdMutex<bool>>,
        /// The client left, and the daemon read everything it sent.
        read_all: Arc<StdMutex<bool>>,
    }

    /// A fake daemon that writes `total` bytes of output in 64 KB frames as fast
    /// as the client takes them — the stand-in for a pty whose reads never
    /// stall — then stays connected, reading frames, until the client leaves.
    fn spawn_flooding_daemon(socket: &Path, total: usize) -> Flood {
        let listener = UnixListener::bind(socket).expect("bind");
        let flood = Flood {
            wrote_all: Arc::new(StdMutex::new(false)),
            saw_repaint: Arc::new(StdMutex::new(false)),
            read_all: Arc::new(StdMutex::new(false)),
        };
        let wrote = Arc::clone(&flood.wrote_all);
        let repaint = Arc::clone(&flood.saw_repaint);
        let read_all = Arc::clone(&flood.read_all);
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
                    break;
                }
                dec.push(&buf[..n]);
                while let Ok(Some(frame)) = dec.next_frame() {
                    if frame == Frame::Repaint {
                        *repaint.lock().expect("lock") = true;
                    }
                }
            }
            *read_all.lock().expect("lock") = true;
        });
        flood
    }

    #[test]
    fn a_remote_onlooker_is_never_held_back_by_a_slow_window() {
        // A window that drains a little at a time keeps the reader pacing,
        // which holds the daemon's writes back; with a remote device looking
        // on, the reader reads on and every event arrives.
        let dir = tempfile::tempdir().expect("tmp dir");
        let socket = dir.path().join("s.sock");
        let total = 32 * HIGH_WATER;
        let flood = spawn_flooding_daemon(&socket, total);
        let seen = Arc::new(StdMutex::new(0usize));
        let seen_by_listener = Arc::clone(&seen);
        let client = Arc::new(
            DaemonClient::connect(
                &socket,
                SessionId("s".into()),
                move |event| {
                    if let DaemonEvent::Output(bytes) = event {
                        *seen_by_listener.lock().expect("lock") += bytes.len();
                    }
                },
                |_| {},
                || {},
            )
            .expect("connect"),
        );
        client.set_remote_onlooker(true);
        let slow = Arc::clone(&client);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_drainer = Arc::clone(&stop);
        let drainer = std::thread::spawn(move || {
            while !stop_drainer.load(Ordering::Relaxed) {
                slow.report_drained(1024);
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let deadline = Instant::now() + Duration::from_secs(30);
        while *seen.lock().expect("lock") < total {
            assert!(Instant::now() < deadline, "the listener was held back");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(*flood.wrote_all.lock().expect("lock"));
        stop.store(true, Ordering::Relaxed);
        drainer.join().expect("drainer");
    }

    /// The frames `daemon` reads from the client within `wait`.
    fn frames_from_client(daemon: &mut UnixStream, wait: Duration) -> Vec<Frame> {
        daemon.set_read_timeout(Some(wait)).expect("timeout");
        let mut decoder = FrameDecoder::new();
        let mut buf = [0u8; 4096];
        while let Ok(n) = daemon.read(&mut buf) {
            if n == 0 {
                break;
            }
            decoder.push(&buf[..n]);
        }
        let mut frames = Vec::new();
        while let Ok(Some(frame)) = decoder.next_frame() {
            frames.push(frame);
        }
        frames
    }

    #[test]
    fn a_daemon_that_says_hello_repaints_the_window_without_skipping_its_queue() {
        // A `Repaint` makes the daemon drop everything queued, which a remote
        // device reading the same stream would see as a gap; the window's own
        // snapshot repaints it alone.
        let (mut daemon, app) = UnixStream::pair().expect("pair");
        let drawn = Arc::new(StdMutex::new(Vec::new()));
        let window = Arc::clone(&drawn);
        let client = DaemonClient::from_stream(
            app,
            SessionId("s".into()),
            |_| {},
            move |bytes| window.lock().expect("lock").extend(bytes),
            || {},
        )
        .expect("client");
        assert!(
            client.request_history(1).is_err(),
            "not before the daemon says hello"
        );
        client.request_repaint().expect("repaint");
        assert_eq!(
            frames_from_client(&mut daemon, Duration::from_millis(300)),
            [Frame::Repaint],
            "an older daemon gets what it knows"
        );
        daemon
            .write_all(&Frame::Hello { run: 1 }.encode())
            .expect("hello");
        let deadline = Instant::now() + Duration::from_secs(10);
        while client.request_history(1).is_err() {
            assert!(Instant::now() < deadline, "the hello never registered");
            std::thread::sleep(Duration::from_millis(5));
        }
        client.request_repaint().expect("repaint");
        let asked = frames_from_client(&mut daemon, Duration::from_millis(300));
        assert!(
            asked.contains(&Frame::RequestSnapshot {
                id: WINDOW_SNAPSHOT
            }),
            "{asked:?}"
        );
        daemon
            .write_all(
                &[
                    Frame::Snapshot {
                        id: WINDOW_SNAPSHOT,
                        bytes: b"mine".to_vec(),
                    }
                    .encode(),
                    Frame::SnapshotEnd {
                        id: WINDOW_SNAPSHOT,
                    }
                    .encode(),
                ]
                .concat(),
            )
            .expect("snapshot");
        while drawn.lock().expect("lock").as_slice() != b"mine" {
            assert!(
                Instant::now() < deadline,
                "the window never got its snapshot"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn a_screen_goes_to_the_window_but_is_not_output() {
        let (mut daemon, app) = UnixStream::pair().expect("pair");
        let outputs = Arc::new(StdMutex::new(0usize));
        let counted = Arc::clone(&outputs);
        let drawn = Arc::new(StdMutex::new(Vec::new()));
        let window = Arc::clone(&drawn);
        let _client = DaemonClient::from_stream(
            app,
            SessionId("s".into()),
            move |event| {
                if let DaemonEvent::Output(_) = event {
                    *counted.lock().expect("lock") += 1;
                }
            },
            move |bytes| window.lock().expect("lock").extend(bytes),
            || {},
        )
        .expect("client");
        daemon
            .write_all(
                &[
                    Frame::Hello { run: 1 }.encode(),
                    Frame::Screen(b"repaint".to_vec()).encode(),
                ]
                .concat(),
            )
            .expect("write");
        let deadline = Instant::now() + Duration::from_secs(10);
        while drawn.lock().expect("lock").as_slice() != b"repaint" {
            assert!(
                Instant::now() < deadline,
                "the screen never reached the window"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(*outputs.lock().expect("lock"), 0, "a repaint is not output");
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
        let flood = spawn_flooding_daemon(&socket, 64 * HIGH_WATER);

        // A live, attached sink that takes bytes but never reports them drained.
        let client = DaemonClient::connect(&socket, SessionId("s".into()), |_| {}, |_| {}, || {})
            .expect("connect");

        wait_for(
            &flood.wrote_all,
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
        let flood = spawn_flooding_daemon(&socket, total);

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
                || {},
            )
            .expect("connect"),
        );
        // The write queue: once a frame, report everything that arrived — a
        // window that draws, but slower than the daemon can write. Holds the
        // client weakly, and ends when the client goes.
        let drainer = Arc::downgrade(&client);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(5));
            let n: usize = rx.try_iter().sum();
            let Some(client) = drainer.upgrade() else {
                return;
            };
            if n > 0 {
                client.report_drained(n);
            }
        });

        wait_for(&flood.wrote_all, "the daemon's writes stalled");
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
        // Hang up, and let the daemon read everything the client sent first.
        drop(client);
        wait_for(&flood.read_all, "the daemon never saw the client leave");
        assert!(
            !*flood.saw_repaint.lock().expect("lock"),
            "a webview that kept up never needs a repaint"
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
        let flood = spawn_flooding_daemon(&socket, total);

        let read = Arc::new(StdMutex::new(0usize));
        let sent = Arc::new(StdMutex::new(0usize));
        let (read_sink, sent_sink) = (Arc::clone(&read), Arc::clone(&sent));
        let client = DaemonClient::connect(
            &socket,
            SessionId("s".into()),
            move |event| {
                if let DaemonEvent::Output(bytes) = event {
                    *read_sink.lock().expect("lock") += bytes.len();
                }
            },
            move |bytes| *sent_sink.lock().expect("lock") += bytes.len(),
            || {},
        )
        .expect("connect");

        wait_for(&flood.wrote_all, "the daemon's writes stalled");
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
            &flood.saw_repaint,
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
            |_| {},
            move |bytes| {
                sink.lock().expect("lock").extend_from_slice(&bytes);
            },
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
            move |event| {
                if let DaemonEvent::Busy(b) = event {
                    *sink.lock().expect("lock") = Some(b);
                }
            },
            |_| {},
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

    /// A daemon that announces a frame longer than the protocol allows can't be
    /// read any further. The client must say the session is gone and let go of
    /// the socket; it used to wait for the whole frame, buffering as it went.
    #[test]
    fn an_oversized_frame_from_the_daemon_ends_the_connection() {
        let dir = tempfile::tempdir().expect("tmp");
        let socket = dir.path().join("s.sock");
        let listener = UnixListener::bind(&socket).expect("bind");
        let hung_up = Arc::new(StdMutex::new(false));
        let saw_hang_up = Arc::clone(&hung_up);
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            // An Output header (tag 0) announcing 4 GiB that never comes.
            let _ = stream.write_all(&[0, 0xFF, 0xFF, 0xFF, 0xFF]);
            let mut buf = [0u8; 64];
            while matches!(stream.read(&mut buf), Ok(n) if n > 0) {}
            *saw_hang_up.lock().expect("lock") = true;
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

        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline
            && !(*exited.lock().expect("lock") && *hung_up.lock().expect("lock"))
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(*exited.lock().expect("lock"), "on_exit must fire");
        assert!(
            *hung_up.lock().expect("lock"),
            "the client must close the socket, or the daemon blocks writing to it"
        );
        drop(client);
    }

    /// Typed or pasted input has no size limit, but one frame does. Input longer
    /// than a frame must arrive whole, in several frames, not get the connection
    /// refused by the daemon's decoder.
    #[test]
    fn stdin_longer_than_one_frame_is_sent_in_several() {
        use kriyon_core::wire::MAX_PAYLOAD_LEN;

        let dir = tempfile::tempdir().expect("tmp");
        let socket = dir.path().join("s.sock");
        let listener = UnixListener::bind(&socket).expect("bind");
        let total = MAX_PAYLOAD_LEN + 10;
        let daemon = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut dec = FrameDecoder::new();
            let mut buf = vec![0u8; 64 * 1024];
            let mut sizes = Vec::new();
            while sizes.iter().sum::<usize>() < total {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => dec.push(&buf[..n]),
                }
                loop {
                    match dec.next_frame() {
                        Ok(Some(Frame::Stdin(bytes))) => sizes.push(bytes.len()),
                        Ok(Some(_)) => {}
                        Ok(None) => break,
                        // Refused: report what arrived instead of waiting forever.
                        Err(_) => return sizes,
                    }
                }
            }
            sizes
        });

        let client =
            DaemonClient::connect(&socket, SessionId("s1".to_string()), |_| {}, |_| {}, || {})
                .expect("connect");
        client.write_stdin(&vec![b'x'; total]).expect("write");

        assert_eq!(daemon.join().expect("join"), vec![MAX_PAYLOAD_LEN, 10]);
        drop(client);
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
