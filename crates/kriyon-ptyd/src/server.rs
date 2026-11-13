//! Per-session daemon server: owns one PTY + child, byte-proxies to one client
//! at a time over a Unix socket. It keeps a server-side screen snapshot — a
//! headless VT emulator fed by *every* byte of child output, attached or not —
//! so a reattaching client repaints the current screen even when the child has
//! produced nothing since the last detach (ADR-0004). Live output still streams
//! raw to the attached client, through a bounded queue and a writer thread of
//! its own, so a slow or stuck client never stalls the session ([Skip ahead]).

use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use kriyon_core::cli_dialog::{
    dialog_on_screen, look_due, DialogState, DialogWatch, HINT_ROWS, RULE_GLYPH,
};
use kriyon_core::lease::DetachedLease;
use kriyon_core::output_history::OutputHistory;
use kriyon_core::session::{check_screen_size, EngineError, SessionEngine, SessionId, SpawnSpec};
use kriyon_core::skip_ahead::{Next, SkipAheadQueue};
use kriyon_core::wire::{chunked, Frame, FrameDecoder};
use parking_lot::{Condvar, Mutex};

use crate::pty::PtyEngine;

const READ_BUF_LEN: usize = 8192;
const REAP_INTERVAL: Duration = Duration::from_millis(500);
/// How often to sample the tty's foreground process group for the busy signal.
const BUSY_POLL_INTERVAL: Duration = Duration::from_millis(250);
/// The emulator's initial size; the first client's `Attach` frame resizes it to
/// the real terminal dimensions.
const INITIAL_ROWS: u16 = 24;
const INITIAL_COLS: u16 = 80;
/// The most output a client may have waiting before it skips ahead to a fresh
/// screen. Room for a large burst (a long `cat`) while the app is only busy,
/// small enough that a stuck client costs little memory.
const CLIENT_QUEUE_LIMIT: usize = 4 * 1024 * 1024;
/// How long a daemon whose shell exited waits for its client to receive the
/// output still queued, before it stops.
const FINAL_SEND_WAIT: Duration = Duration::from_secs(1);
/// How much recent output each session keeps as its [Output history]. The
/// same as a client's queue, so whatever a skip ahead dropped is still there
/// if the client asks soon after. About 40 MB across ten sessions.
const OUTPUT_HISTORY_LIMIT: usize = CLIENT_QUEUE_LIMIT;

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

/// The attached client, as the daemon's output side sees it: the frames
/// waiting for its writer thread.
struct AttachedClient {
    /// Tells this client's writer apart from a previous client's, which may
    /// still be finishing a write after that client left.
    id: u64,
    queue: SkipAheadQueue,
    /// The writer has taken bytes off the queue and not finished writing them.
    sending: bool,
    /// How many [Output history] answers the client is owed. The writer
    /// sends them outside the queue: at up to the queue's own size, queueing
    /// one would make the client skip ahead.
    history_requests: u32,
}

/// The text of one screen row, as the desktop's terminal reads it: the second
/// half of a wide character is not a cell of its own.
fn row_text(screen: &vt100::Screen, row: u16) -> String {
    let (_, cols) = screen.size();
    (0..cols)
        .filter_map(|col| screen.cell(row, col))
        .filter(|cell| !cell.is_wide_continuation())
        .map(|cell| {
            if cell.has_contents() {
                cell.contents()
            } else {
                " "
            }
        })
        .collect()
}

/// How many rows, ending at its key hint, a dialog's fingerprint covers when
/// no pane rule marks where it starts.
const DIALOG_ROWS: u16 = 15;

/// Whether `screen` shows a [CLI dialog], and a fingerprint of it while it does.
///
/// Runs with the client lock held, so it reads only the rows that can decide
/// (see [`dialog_on_screen`]): those whose first cell is the pane rule's glyph,
/// found one cell per row, and the last few non-blank rows. While a dialog
/// shows, the fingerprint covers only the dialog (from its pane rule, or the
/// [`DIALOG_ROWS`] rows ending at its hint), colours included, so a timer above
/// it doesn't count as a change and a selection shown only by colour does.
fn dialog_look(screen: &vt100::Screen) -> (bool, u64) {
    let (rows, cols) = screen.size();
    let rule = RULE_GLYPH.to_string();
    let rule_rows: Vec<u16> = (0..rows)
        .filter(|row| {
            screen
                .cell(*row, 0)
                .is_some_and(|cell| cell.contents() == rule)
        })
        .collect();
    let filled = |row: &u16| {
        (0..cols).any(|col| {
            screen
                .cell(*row, col)
                .is_some_and(|cell| !cell.contents().trim().is_empty())
        })
    };
    let mut bottom: Vec<u16> = (0..rows).rev().filter(filled).take(HINT_ROWS).collect();
    bottom.reverse();
    let deciding: Vec<String> = rule_rows
        .iter()
        .chain(&bottom)
        .map(|row| row_text(screen, *row))
        .collect();
    if !dialog_on_screen(&deciding) {
        return (false, 0);
    }
    let last = bottom.last().copied().unwrap_or(0);
    let first = rule_rows
        .first()
        .copied()
        .unwrap_or_else(|| last.saturating_sub(DIALOG_ROWS - 1));
    let mut hasher = std::hash::DefaultHasher::new();
    for row in screen
        .rows_formatted(0, cols)
        .skip(usize::from(first))
        .take(usize::from(last.max(first) - first) + 1)
    {
        std::hash::Hash::hash(&row, &mut hasher);
    }
    (true, std::hash::Hasher::finish(&hasher))
}

/// Where a daemon's [Dialog generation]s start: a random number, so a restart
/// of the same session never repeats one (a clock can be set back). `std`'s
/// hasher keys are drawn from the OS's randomness once per process.
fn dialog_generation_base() -> u64 {
    use std::hash::{BuildHasher as _, Hasher as _};
    std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish()
}

/// The daemon's [`DialogWatch`], when it last looked at the screen, and
/// whether output came since.
struct DialogSight {
    watch: DialogWatch,
    last_look: Option<Instant>,
    pending: bool,
}

impl DialogSight {
    fn new(base: u64) -> Self {
        Self {
            watch: DialogWatch::new(base),
            last_look: None,
            pending: false,
        }
    }

    /// After output: look at `screen` if a look is due (see [`look_due`]),
    /// else leave it pending for [`Shared::look_if_pending`]. The new state
    /// when the generation moved.
    fn after_output(&mut self, screen: &vt100::Screen) -> Option<DialogState> {
        let since = self.last_look.map(|last| last.elapsed());
        if look_due(since) {
            self.look(screen)
        } else {
            self.pending = true;
            None
        }
    }

    /// Look at `screen` now. The new state when the generation moved.
    fn look(&mut self, screen: &vt100::Screen) -> Option<DialogState> {
        self.last_look = Some(Instant::now());
        self.pending = false;
        let (open, fingerprint) = dialog_look(screen);
        self.watch.observe(open, fingerprint)
    }
}

/// A [`DialogState`] as its encoded frame.
fn dialog_frame(state: DialogState) -> Vec<u8> {
    Frame::Dialog {
        open: state.open,
        generation: state.generation,
    }
    .encode()
}

/// State shared between the PTY reader thread (which produces output), the
/// accept loop (which attaches/detaches clients) and the client's writer
/// thread. Lock order is always `client` then `emulator` (then `dialog`), never the reverse,
/// so no two paths can deadlock. No lock is ever held across a socket write.
struct Shared {
    client: Mutex<Option<AttachedClient>>,
    /// Wakes the writer when a frame is queued or its client leaves.
    client_ready: Condvar,
    next_client: AtomicU64,
    /// Headless terminal emulator consuming every output byte, so its screen is
    /// always the current one to repaint a reattaching client from.
    emulator: Mutex<vt100::Parser>,
    /// The [Output history], fed every output byte like the emulator. A leaf
    /// lock: taken last under `client`, or alone.
    history: Mutex<OutputHistory>,
    /// The [CLI dialog] on the emulator's screen and its [Dialog generation],
    /// looked at after every output read. A leaf lock: taken last under
    /// `client` and `emulator`, or alone.
    dialog: Mutex<DialogSight>,
    /// Last-known foreground-busy state, updated by the busy poller and sent
    /// with every screen snapshot, so a client that attaches or skips ahead
    /// learns it at once. An atomic (not a lock) so the writer can read it
    /// while holding the client lock without any lock-ordering hazard.
    busy: AtomicBool,
    /// The [Detached lease]: renewed by output and by a client arriving or
    /// leaving, read by the reaper. A leaf lock — taken alone, or last and
    /// briefly under `client` — so it can never take part in a deadlock.
    lease: Mutex<DetachedLease>,
}

impl Shared {
    /// Route a chunk of PTY output: feed the server-side emulator (always, so
    /// the screen snapshot stays current even while detached), then queue the
    /// raw bytes for the live client if one is attached. Never waits on the
    /// client: a client that falls behind skips ahead instead, so the PTY
    /// reader, and the child behind it, keep going.
    fn on_output(&self, bytes: &[u8]) {
        // Output is the proof of work that keeps a detached daemon alive.
        self.lease.lock().note_output(Instant::now());
        let mut client = self.client.lock();
        let moved = {
            let mut emulator = self.emulator.lock();
            emulator.process(bytes);
            self.dialog.lock().after_output(emulator.screen())
        };
        self.history.lock().push(bytes);
        let mut frames = output_frames(bytes);
        // After the output that drew it, so a receiver numbering updates knows
        // which one the dialog changed after.
        if let Some(state) = moved {
            frames.extend(dialog_frame(state));
        }
        self.queue_frame(&mut client, frames);
    }

    /// Look at the screen if output came since the last look and one is due,
    /// and queue the state if it moved. The trailing look: a dialog drawn
    /// just after a look is otherwise not seen until more output comes, and
    /// the CLI is waiting for keys, so none will.
    fn look_if_pending(&self) {
        let mut client = self.client.lock();
        let moved = {
            let emulator = self.emulator.lock();
            let mut dialog = self.dialog.lock();
            let due = look_due(dialog.last_look.map(|last| last.elapsed()));
            if !(dialog.pending && due) {
                return;
            }
            dialog.look(emulator.screen())
        };
        if let Some(state) = moved {
            self.queue_frame(&mut client, dialog_frame(state));
        }
    }

    /// Queue encoded frames for the live client, if any, and wake its writer.
    fn queue_frame(&self, client: &mut Option<AttachedClient>, frames: Vec<u8>) {
        if let Some(attached) = client.as_mut() {
            attached.queue.push(frames);
            self.client_ready.notify_all();
        }
    }

    /// Attach `stream` as the live client and start its writer thread. The
    /// client starts with a [Skip ahead], so the first thing it gets is the
    /// current screen and busy state.
    fn attach(self: &Arc<Self>, stream: &UnixStream) -> Option<std::thread::JoinHandle<()>> {
        let Ok(out) = stream.try_clone() else {
            return None;
        };
        let id = self.next_client.fetch_add(1, Ordering::Relaxed);
        *self.client.lock() = Some(AttachedClient {
            id,
            queue: SkipAheadQueue::starting_with_screen(CLIENT_QUEUE_LIMIT),
            sending: false,
            history_requests: 0,
        });
        let shared = Arc::clone(self);
        // A thread the OS refuses must not panic the daemon (and the session
        // with it): the client just gets no output, and reconnects.
        let writer = std::thread::Builder::new()
            .name("client-writer".into())
            .spawn(move || shared.write_to_client(id, out))
            .map_err(|e| eprintln!("kriyon-ptyd: no writer thread for the client: {e}"))
            .ok();
        self.lease.lock().note_attached(Instant::now());
        writer
    }

    /// Give the client up to `within` to receive what is still queued for it.
    /// Called when the shell has exited, so its last words (often why it
    /// exited) reach the client before the daemon does.
    fn finish_sending(&self, within: Duration) {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            let done = self
                .client
                .lock()
                .as_ref()
                .is_none_or(|attached| attached.queue.is_empty() && !attached.sending);
            if done {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// The client's writer thread: send what its queue holds, at the client's
    /// pace, until the client leaves or a write fails. On a [Skip ahead] it
    /// sends the current screen snapshot and busy state, taken under the
    /// `client` lock so any output queued after them is newer than the screen.
    fn write_to_client(&self, id: u64, mut out: impl Write) {
        loop {
            let bytes = {
                let mut client = self.client.lock();
                loop {
                    let Some(attached) = client.as_mut().filter(|attached| attached.id == id)
                    else {
                        return;
                    };
                    if attached.history_requests > 0 {
                        attached.history_requests -= 1;
                        attached.sending = true;
                        // Built after the `client` lock is released: copying
                        // megabytes under it would stall the PTY reader.
                        break None;
                    }
                    let bytes = match attached.queue.pop() {
                        Next::Frame(bytes) => bytes,
                        Next::SkipAhead => self.screen_frames(),
                        Next::Empty => {
                            self.client_ready.wait(&mut client);
                            continue;
                        }
                    };
                    attached.sending = true;
                    break Some(bytes);
                }
            };
            let bytes = bytes.unwrap_or_else(|| self.history_frames());
            let sent = out.write_all(&bytes).is_ok() && out.flush().is_ok();
            if let Some(attached) = self
                .client
                .lock()
                .as_mut()
                .filter(|attached| attached.id == id)
            {
                attached.sending = false;
            }
            if !sent {
                // A dead client (an `AF_UNIX` peer close surfaces here): stop
                // queueing for it. The accept loop detaches it when its read
                // side ends.
                let mut client = self.client.lock();
                if client.as_ref().is_some_and(|attached| attached.id == id) {
                    *client = None;
                }
                return;
            }
        }
    }

    /// The current screen snapshot (the escape codes that reconstruct the
    /// contents, colours, cursor and modes) and busy state, as frames.
    fn screen_frames(&self) -> Vec<u8> {
        let emulator = self.emulator.lock();
        let mut bytes = output_frames(&screen_snapshot(&emulator));
        bytes.extend(Frame::Busy(self.busy.load(Ordering::Relaxed)).encode());
        // Looked at now, with the screen it goes with: a look left pending
        // would pair this screen with an older state.
        let mut dialog = self.dialog.lock();
        dialog.look(emulator.screen());
        bytes.extend(dialog_frame(dialog.watch.state()));
        bytes
    }

    /// The [Output history] as `History` frames, split to the frame limit,
    /// then the `HistoryEnd` that tells the client it has all of it.
    fn history_frames(&self) -> Vec<u8> {
        let history = self.history.lock().contents();
        let mut bytes: Vec<u8> = chunked(&history, Frame::History)
            .flat_map(|frame| frame.encode())
            .collect();
        bytes.extend(Frame::HistoryEnd.encode());
        bytes
    }

    /// Send the live client the [Output history], on request.
    fn request_history(&self) {
        if let Some(attached) = self.client.lock().as_mut() {
            attached.history_requests = attached.history_requests.saturating_add(1);
            self.client_ready.notify_all();
        }
    }

    /// Resend the screen snapshot to the live client, on request. A terminal
    /// component that (re)mounts against this already-connected session starts
    /// from a blank xterm; the snapshot (which begins with a clear) rebuilds
    /// the current screen. It is a [Skip ahead]: output still queued is already
    /// on the screen it gets.
    fn repaint(&self) {
        if let Some(attached) = self.client.lock().as_mut() {
            attached.queue.skip_ahead();
            self.client_ready.notify_all();
        }
    }

    /// Queue a busy-state change for the live client, if one is attached.
    fn push_busy(&self, busy: bool) {
        let mut client = self.client.lock();
        self.queue_frame(&mut client, Frame::Busy(busy).encode());
    }

    /// Resize the PTY, then the server-side emulator so its screen snapshot
    /// matches. A size out of range reaches neither (a zero side panics the
    /// emulator, a huge one exhausts memory), and a failed PTY resize leaves
    /// the emulator at the size the tty still has.
    fn resize<E: SessionEngine + ?Sized>(
        &self,
        engine: &E,
        cols: u16,
        rows: u16,
    ) -> Result<(), EngineError> {
        check_screen_size(cols, rows)?;
        // Held across the PTY resize, so output the child draws at the new
        // size after SIGWINCH is never parsed at the old one.
        let mut emulator = self.emulator.lock();
        engine.resize(cols, rows)?;
        emulator.screen_mut().set_size(rows, cols);
        Ok(())
    }

    /// Let the client go: shut its socket down, so a writer blocked on a
    /// client that stopped reading fails out instead of leaking, then wake
    /// the writer so it sees its client is gone.
    fn detach(&self, stream: &UnixStream) {
        let _ = stream.shutdown(std::net::Shutdown::Both);
        *self.client.lock() = None;
        self.client_ready.notify_all();
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
        client_ready: Condvar::new(),
        next_client: AtomicU64::new(0),
        emulator: Mutex::new(vt100::Parser::new(INITIAL_ROWS, INITIAL_COLS, 0)),
        history: Mutex::new(OutputHistory::new(OUTPUT_HISTORY_LIMIT)),
        dialog: Mutex::new(DialogSight::new(dialog_generation_base())),
        busy: AtomicBool::new(false),
        lease: Mutex::new(DetachedLease::new(detached_ttl, Instant::now())),
    });

    // The trailing look at the screen for a [CLI dialog] (see
    // `look_if_pending`). Holds the state weakly, so it ends with the daemon.
    let look_shared = Arc::downgrade(&shared);
    let _ = std::thread::Builder::new()
        .name("dialog-look".into())
        .spawn(move || loop {
            std::thread::sleep(kriyon_core::cli_dialog::LOOK_EVERY);
            match look_shared.upgrade() {
                Some(shared) => shared.look_if_pending(),
                None => return,
            }
        })
        .map_err(|e| eprintln!("kriyon-ptyd: no dialog-look thread: {e}"));

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
        shared.attach(&stream);
        let shutdown = serve_client(&mut stream, &engine, &shared);
        shared.detach(&stream);
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
            if !lapsed {
                // The shell's last output often says why it exited.
                shared.finish_sending(FINAL_SEND_WAIT);
            }
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

/// `bytes` as encoded `Output` frames, split so none passes the wire's
/// payload limit. A screen snapshot of a large, colourful screen can, and the
/// app refuses a frame that does.
fn output_frames(bytes: &[u8]) -> Vec<u8> {
    chunked(bytes, Frame::Output)
        .flat_map(|frame| frame.encode())
        .collect()
}

/// Write the person's typing to the session. A failed write is never dropped
/// silently: it goes to `log` (the daemon's stderr, which the app keeps as the
/// per-session log) with its cause. A failed `write_all` can have written
/// part of the bytes, so the line says "may not", never "did not". The client
/// stays attached: the reaper ends the daemon if the child is gone, and a
/// transient failure must not cut a working session.
fn deliver_stdin<E: SessionEngine + ?Sized>(engine: &E, bytes: &[u8], log: &mut impl Write) {
    if let Err(e) = engine.write_stdin(bytes) {
        let _ = writeln!(
            log,
            "kriyon-ptyd: typing write failed; some of {} bytes may not have reached the session: {e}",
            bytes.len()
        );
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
                loop {
                    let frame = match dec.next_frame() {
                        Ok(Some(frame)) => frame,
                        Ok(None) => break,
                        // Nothing after a frame that long can be read, so this
                        // client is finished. The session carries on without it.
                        Err(_) => return false,
                    };
                    match frame {
                        Frame::Stdin(bytes) => {
                            deliver_stdin(engine.as_ref(), &bytes, &mut std::io::stderr());
                        }
                        // Attach carries the initial size; treat like a resize.
                        // Both the PTY and the server-side emulator must track it.
                        Frame::Resize { cols, rows } | Frame::Attach { cols, rows } => {
                            if let Err(e) = shared.resize(engine.as_ref(), cols, rows) {
                                eprintln!("kriyon-ptyd: resize to {cols}x{rows} refused: {e}");
                            }
                        }
                        Frame::Repaint => shared.repaint(),
                        Frame::RequestHistory => shared.request_history(),
                        Frame::Shutdown => return true,
                        // Daemon → app frames never arrive from a client; ignore.
                        Frame::Output(_)
                        | Frame::Busy(_)
                        | Frame::Dialog { .. }
                        | Frame::History(_)
                        | Frame::HistoryEnd => {}
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        deliver_stdin, dialog_look, row_text, screen_snapshot, AttachedClient, Shared,
        CLIENT_QUEUE_LIMIT, ENTER_ALTERNATE_SCREEN, LEAVE_ALTERNATE_SCREEN, OUTPUT_HISTORY_LIMIT,
    };
    use kriyon_core::lease::DetachedLease;
    use kriyon_core::output_history::OutputHistory;
    use kriyon_core::session::{EngineError, SessionEngine, SessionId};
    use kriyon_core::skip_ahead::{Next, SkipAheadQueue};
    use kriyon_core::wire::{Frame, FrameDecoder};
    use parking_lot::Mutex;
    use std::io::{self, Write};
    use std::os::unix::net::UnixStream;
    use std::sync::atomic::AtomicBool;
    use std::time::{Duration, Instant};

    /// Shared daemon state with no client, its emulator at 80x24.
    fn shared() -> Shared {
        Shared {
            client: Mutex::new(None),
            client_ready: parking_lot::Condvar::new(),
            next_client: std::sync::atomic::AtomicU64::new(0),
            emulator: Mutex::new(vt100::Parser::new(24, 80, 0)),
            history: Mutex::new(OutputHistory::new(OUTPUT_HISTORY_LIMIT)),
            dialog: Mutex::new(super::DialogSight::new(0)),
            busy: AtomicBool::new(false),
            lease: Mutex::new(DetachedLease::new(Duration::from_secs(60), Instant::now())),
        }
    }

    /// A session that records each pty resize, and fails them when told to.
    struct ResizeEngine {
        id: SessionId,
        fail: bool,
        resized: Mutex<Vec<(u16, u16)>>,
    }
    impl ResizeEngine {
        fn new(fail: bool) -> Self {
            Self {
                id: SessionId("s".into()),
                fail,
                resized: Mutex::new(Vec::new()),
            }
        }
    }
    impl SessionEngine for ResizeEngine {
        fn id(&self) -> &SessionId {
            &self.id
        }
        fn write_stdin(&self, _: &[u8]) -> Result<(), EngineError> {
            Ok(())
        }
        fn resize(&self, cols: u16, rows: u16) -> Result<(), EngineError> {
            self.resized.lock().push((cols, rows));
            if self.fail {
                Err(EngineError::Pty("not a tty".into()))
            } else {
                Ok(())
            }
        }
        fn close(&self) -> Result<(), EngineError> {
            Ok(())
        }
    }

    #[test]
    fn a_valid_size_resizes_the_pty_and_the_emulator() {
        let (shared, engine) = (shared(), ResizeEngine::new(false));
        shared.resize(&engine, 120, 40).expect("120x40 is valid");
        assert_eq!(*engine.resized.lock(), vec![(120, 40)]);
        assert_eq!(shared.emulator.lock().screen().size(), (40, 120));
    }

    #[test]
    fn a_zero_or_huge_size_reaches_neither_the_pty_nor_the_emulator() {
        for (cols, rows) in [(80, 0), (0, 24), (u16::MAX, u16::MAX)] {
            let (shared, engine) = (shared(), ResizeEngine::new(false));
            assert!(matches!(
                shared.resize(&engine, cols, rows),
                Err(EngineError::InvalidSize { .. })
            ));
            assert_eq!(
                *engine.resized.lock(),
                vec![],
                "{cols}x{rows} reached the pty"
            );
            assert_eq!(shared.emulator.lock().screen().size(), (24, 80));
        }
    }

    #[test]
    fn a_failed_pty_resize_leaves_the_emulator_matching_the_pty() {
        let (shared, engine) = (shared(), ResizeEngine::new(true));
        assert!(shared.resize(&engine, 120, 40).is_err());
        assert_eq!(
            shared.emulator.lock().screen().size(),
            (24, 80),
            "the pty kept its old size, so the snapshot must too"
        );
    }

    /// A session whose stdin write fails or succeeds, as told.
    struct StdinEngine {
        id: SessionId,
        fail: bool,
    }
    impl StdinEngine {
        fn new(fail: bool) -> Self {
            Self {
                id: SessionId("s".into()),
                fail,
            }
        }
    }
    impl SessionEngine for StdinEngine {
        fn id(&self) -> &SessionId {
            &self.id
        }
        fn write_stdin(&self, _: &[u8]) -> Result<(), EngineError> {
            if self.fail {
                Err(EngineError::Pty("broken pipe".into()))
            } else {
                Ok(())
            }
        }
        fn resize(&self, _: u16, _: u16) -> Result<(), EngineError> {
            Ok(())
        }
        fn close(&self) -> Result<(), EngineError> {
            Ok(())
        }
    }

    #[test]
    fn typing_the_session_could_not_take_is_logged_with_the_cause() {
        let mut log = Vec::new();
        deliver_stdin(&StdinEngine::new(true), b"ls\r", &mut log);
        let log = String::from_utf8(log).expect("utf-8 log");
        assert!(
            log.contains("typing") && log.contains("broken pipe"),
            "a failed stdin write must leave a line naming the cause, got {log:?}"
        );
    }

    #[test]
    fn typing_the_session_took_logs_nothing() {
        let mut log = Vec::new();
        deliver_stdin(&StdinEngine::new(false), b"ls\r", &mut log);
        assert_eq!(String::from_utf8_lossy(&log), "");
    }

    #[derive(serde::Deserialize)]
    struct DialogCase {
        name: String,
        dialog: bool,
        rows: Vec<String>,
    }

    /// An emulator showing `rows` from the top, the rest of the screen blank.
    fn screen_of(rows: &[String]) -> vt100::Parser {
        let mut parser = vt100::Parser::new(40, 120, 0);
        parser.process(rows.join("\r\n").as_bytes());
        parser
    }

    #[test]
    fn the_daemon_reads_every_shared_screen_as_the_desktop_does() {
        // The look reads only the rows that can decide, so it must agree with
        // the whole-screen rule on every shared screen.
        let cases: Vec<DialogCase> = serde_json::from_str(include_str!(
            "../../kriyon-core/scripts/dialog-screens.json"
        ))
        .expect("cases");
        for case in cases {
            let (open, _) = dialog_look(screen_of(&case.rows).screen());
            assert_eq!(open, case.dialog, "{}", case.name);
        }
    }

    #[test]
    fn moving_the_selection_in_a_dialog_changes_its_fingerprint() {
        let question = |selected: usize| {
            let rows: Vec<String> = [
                "Pick one",
                "1. Red",
                "2. Blue",
                "",
                "Enter to select · Esc to cancel",
            ]
            .iter()
            .enumerate()
            .map(|(i, row)| {
                if i == selected {
                    format!("❯ {row}")
                } else {
                    (*row).to_string()
                }
            })
            .collect();
            dialog_look(screen_of(&rows).screen())
        };
        let (open_a, a) = question(1);
        let (open_b, b) = question(2);
        assert!(open_a && open_b);
        assert_ne!(a, b);
    }

    #[test]
    fn a_new_dialog_on_screen_queues_its_generation_after_the_output() {
        let shared = with_client(SkipAheadQueue::new(CLIENT_QUEUE_LIMIT));
        shared.on_output(b"Do you want to proceed?\r\n 1. Yes\r\n Esc to cancel");
        let frames = queued(&shared);
        let last = frames.last().expect("frames");
        assert!(
            matches!(last, Frame::Dialog { open: true, .. }),
            "the dialog frame follows the output that drew it: {frames:?}"
        );
        assert!(frames.iter().any(|f| matches!(f, Frame::Output(_))));
    }

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

    /// A writer that hands each write to the test, standing in for a live
    /// client socket.
    struct ChannelWriter(std::sync::mpsc::Sender<Vec<u8>>);
    impl Write for ChannelWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let _ = self.0.send(buf.to_vec());
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// Shared state with a client (id 0) attached, its queue as given.
    fn with_client(queue: SkipAheadQueue) -> Shared {
        let shared = shared();
        *shared.client.lock() = Some(AttachedClient {
            id: 0,
            queue,
            sending: false,
            history_requests: 0,
        });
        shared
    }

    /// Run the client's writer until it has sent one write, then detach the
    /// client so the writer ends. Returns that first write.
    fn first_write(shared: &Shared) -> Vec<u8> {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| shared.write_to_client(0, ChannelWriter(tx)));
            let first = rx
                .recv_timeout(Duration::from_secs(5))
                .expect("the writer sent nothing");
            shared.detach(&UnixStream::pair().expect("socket pair").0);
            first
        })
    }

    #[test]
    fn the_writer_sends_what_is_queued() {
        let mut queue = SkipAheadQueue::new(CLIENT_QUEUE_LIMIT);
        queue.push(Frame::Busy(true).encode());
        assert_eq!(first_write(&with_client(queue)), Frame::Busy(true).encode());
    }

    /// The frames queued for the client since the last call.
    fn queued(shared: &Shared) -> Vec<Frame> {
        let mut decoder = FrameDecoder::new();
        while let Next::Frame(bytes) = shared.client.lock().as_mut().expect("client").queue.pop() {
            decoder.push(&bytes);
        }
        let mut frames = Vec::new();
        while let Ok(Some(frame)) = decoder.next_frame() {
            frames.push(frame);
        }
        frames
    }

    #[test]
    fn a_dialog_drawn_between_looks_is_seen_once_output_stops() {
        // The read that draws it can come straight after a look; the CLI then
        // waits, so no more output will bring another look.
        let shared = with_client(SkipAheadQueue::new(CLIENT_QUEUE_LIMIT));
        shared.on_output(b"working");
        shared.on_output(b"\r\nDo you want to proceed?\r\n Esc to cancel");
        assert!(
            !queued(&shared)
                .iter()
                .any(|f| matches!(f, Frame::Dialog { open: true, .. })),
            "too soon after the last look"
        );
        std::thread::sleep(kriyon_core::cli_dialog::LOOK_EVERY);
        shared.look_if_pending();
        assert!(queued(&shared)
            .iter()
            .any(|f| matches!(f, Frame::Dialog { open: true, .. })));
        shared.look_if_pending();
        assert!(queued(&shared).is_empty(), "nothing new to look at");
    }

    #[test]
    fn an_attaching_client_gets_the_dialog_its_screen_shows() {
        let shared = with_client(SkipAheadQueue::new(CLIENT_QUEUE_LIMIT));
        shared.on_output(b"working");
        shared.on_output(b"\r\nDo you want to proceed?\r\n Esc to cancel");
        let mut decoder = FrameDecoder::new();
        decoder.push(&shared.screen_frames());
        let mut frames = Vec::new();
        while let Ok(Some(frame)) = decoder.next_frame() {
            frames.push(frame);
        }
        assert!(
            frames
                .iter()
                .any(|f| matches!(f, Frame::Dialog { open: true, .. })),
            "the screen and the dialog state go together: {frames:?}"
        );
    }

    /// A screen with `top` on its first row and a question dialog at the
    /// bottom, option `selected` marked by reverse video only.
    fn dialog_under(top: &str, selected: usize) -> vt100::Parser {
        let mut parser = vt100::Parser::new(24, 80, 0);
        let mut bytes = format!("{top}\x1b[18;1HPick one\r\n");
        for (i, option) in ["Red", "Blue"].iter().enumerate() {
            if i == selected {
                bytes.push_str("\x1b[7m");
                bytes.push_str(option);
                bytes.push_str("\x1b[0m\r\n");
            } else {
                bytes.push_str(option);
                bytes.push_str("\r\n");
            }
        }
        bytes.push_str("Enter to select \u{b7} Esc to cancel");
        parser.process(bytes.as_bytes());
        parser
    }

    #[test]
    fn a_dialogs_fingerprint_ignores_the_screen_above_it() {
        let (_, a) = dialog_look(dialog_under("\u{273b} Working 1s", 0).screen());
        let (_, b) = dialog_look(dialog_under("\u{273b} Working 2s", 0).screen());
        assert_eq!(a, b, "a timer above the dialog is not a change to it");
    }

    #[test]
    fn a_selection_shown_only_by_colour_changes_the_fingerprint() {
        let (open, a) = dialog_look(dialog_under("", 0).screen());
        let (_, b) = dialog_look(dialog_under("", 1).screen());
        assert!(open);
        assert_ne!(a, b);
    }

    #[test]
    fn a_wide_character_reads_as_itself() {
        let mut parser = vt100::Parser::new(5, 20, 0);
        parser.process("\u{65e5}\u{672c}x".as_bytes());
        assert_eq!(row_text(parser.screen(), 0).trim_end(), "\u{65e5}\u{672c}x");
    }

    #[test]
    fn a_skip_ahead_sends_the_dialog_state_too() {
        let shared = with_client(SkipAheadQueue::starting_with_screen(CLIENT_QUEUE_LIMIT));
        shared.on_output(b"Pick one\r\nEnter to select \xc2\xb7 Esc to cancel");
        let mut decoder = FrameDecoder::new();
        decoder.push(&shared.screen_frames());
        let mut frames = Vec::new();
        while let Ok(Some(frame)) = decoder.next_frame() {
            frames.push(frame);
        }
        assert!(
            frames
                .iter()
                .any(|f| matches!(f, Frame::Dialog { open: true, .. })),
            "an attaching client learns a dialog is showing: {frames:?}"
        );
    }

    #[test]
    fn a_skip_ahead_sends_the_current_screen() {
        let shared = with_client(SkipAheadQueue::starting_with_screen(CLIENT_QUEUE_LIMIT));
        shared.emulator.lock().process(b"on screen");
        assert!(String::from_utf8_lossy(&first_write(&shared)).contains("on screen"));
    }

    #[test]
    fn a_detached_clients_writer_ends() {
        let shared = with_client(SkipAheadQueue::new(CLIENT_QUEUE_LIMIT));
        std::thread::scope(|scope| {
            let writer = scope
                .spawn(|| shared.write_to_client(0, ChannelWriter(std::sync::mpsc::channel().0)));
            std::thread::sleep(Duration::from_millis(50));
            shared.detach(&UnixStream::pair().expect("socket pair").0);
            writer.join().expect("the writer ended");
        });
    }

    #[test]
    fn drops_a_client_whose_write_fails() {
        let shared = with_client(SkipAheadQueue::starting_with_screen(CLIENT_QUEUE_LIMIT));
        shared.write_to_client(0, FailingWriter);
        assert!(
            shared.client.lock().is_none(),
            "a dead client must be dropped"
        );
    }

    #[test]
    fn drops_a_client_whose_flush_fails() {
        let shared = with_client(SkipAheadQueue::starting_with_screen(CLIENT_QUEUE_LIMIT));
        shared.write_to_client(0, FlushFailsWriter);
        assert!(
            shared.client.lock().is_none(),
            "a flush failure must drop the client too"
        );
    }

    #[test]
    fn a_previous_clients_writer_leaves_the_new_client_alone() {
        let shared = with_client(SkipAheadQueue::starting_with_screen(CLIENT_QUEUE_LIMIT));
        shared.write_to_client(7, FailingWriter);
        assert!(
            shared.client.lock().is_some(),
            "only the writer of the attached client may drop it"
        );
    }

    /// Shared state in an `Arc`, as `run` holds it, with a client attached
    /// over a socket pair. Returns the state, the daemon's end, the client's
    /// end and the writer thread.
    fn attached() -> (
        std::sync::Arc<Shared>,
        std::os::unix::net::UnixStream,
        std::os::unix::net::UnixStream,
        std::thread::JoinHandle<()>,
    ) {
        let shared = std::sync::Arc::new(shared());
        let (daemon_end, client_end) = std::os::unix::net::UnixStream::pair().expect("socket pair");
        let writer = shared.attach(&daemon_end).expect("writer started");
        (shared, daemon_end, client_end, writer)
    }

    fn ends_within(writer: &std::thread::JoinHandle<()>, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if writer.is_finished() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    #[test]
    fn detaching_a_client_that_never_reads_frees_its_writer() {
        let (shared, daemon_end, _client_end, writer) = attached();
        // Far more than the socket buffer holds, so the writer blocks in a
        // write the client will never read.
        for _ in 0..64 {
            shared.on_output(&[b'x'; 8192]);
        }
        shared.detach(&daemon_end);
        assert!(
            ends_within(&writer, Duration::from_secs(5)),
            "a writer blocked on a gone client must end, not leak"
        );
    }

    #[test]
    fn the_last_output_reaches_the_client_before_the_daemon_exits() {
        let (shared, _daemon_end, mut client_end, _writer) = attached();
        shared.on_output(b"last words");
        shared.finish_sending(Duration::from_secs(5));
        client_end.set_nonblocking(true).expect("nonblocking");
        let mut got = Vec::new();
        let _ = io::Read::read_to_end(&mut client_end, &mut got);
        assert!(
            String::from_utf8_lossy(&got).contains("last words"),
            "output still queued when the shell exits must be sent first"
        );
    }

    #[test]
    fn output_longer_than_one_frame_is_sent_in_frames_the_app_accepts() {
        let bytes = vec![b'x'; kriyon_core::wire::MAX_PAYLOAD_LEN + 10];
        let mut dec = kriyon_core::wire::FrameDecoder::new();
        dec.push(&super::output_frames(&bytes));
        let mut got = Vec::new();
        while let Some(frame) = dec.next_frame().expect("every frame within the limit") {
            let Frame::Output(chunk) = frame else {
                panic!("only output frames")
            };
            got.extend(chunk);
        }
        assert_eq!(got, bytes);
    }

    /// Read frames from `stream` until a `HistoryEnd`, returning the
    /// `History` bytes.
    fn read_history(stream: &mut UnixStream) -> Vec<u8> {
        read_histories(stream, 1).remove(0)
    }

    /// Read `count` history answers, each closed by its `HistoryEnd`.
    fn read_histories(stream: &mut UnixStream, count: usize) -> Vec<Vec<u8>> {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("timeout");
        let mut dec = kriyon_core::wire::FrameDecoder::new();
        let mut answers = Vec::new();
        let mut history = Vec::new();
        let mut buf = vec![0u8; 65536];
        loop {
            let n = io::Read::read(stream, &mut buf).expect("the answer arrives");
            assert_ne!(n, 0, "the connection closed before HistoryEnd");
            dec.push(&buf[..n]);
            while let Some(frame) = dec.next_frame().expect("frames within the limit") {
                match frame {
                    Frame::History(bytes) => history.extend(bytes),
                    Frame::HistoryEnd => {
                        answers.push(std::mem::take(&mut history));
                        if answers.len() == count {
                            return answers;
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    #[test]
    fn a_client_gets_the_output_history_it_asks_for() {
        let (shared, _daemon_end, mut client_end, _writer) = attached();
        shared.on_output(b"earlier line\n");
        shared.request_history();
        let history = read_history(&mut client_end);
        assert!(String::from_utf8_lossy(&history).contains("earlier line"));
    }

    #[test]
    fn output_while_detached_is_kept_in_the_history_too() {
        let shared = std::sync::Arc::new(shared());
        shared.on_output(b"nobody was watching\n");
        let (daemon_end, mut client_end) = UnixStream::pair().expect("socket pair");
        let _writer = shared.attach(&daemon_end);
        shared.request_history();
        let history = read_history(&mut client_end);
        assert!(String::from_utf8_lossy(&history).contains("nobody was watching"));
    }

    #[test]
    fn a_full_history_reaches_a_client_without_skipping_ahead() {
        let (shared, _daemon_end, mut client_end, _writer) = attached();
        // Fill the history to its limit with numbered lines.
        let line = |i: usize| format!("history line {i:08}\n");
        let count = OUTPUT_HISTORY_LIMIT / line(0).len() + 10;
        // Read concurrently, so live output never makes the client skip ahead.
        let reader = std::thread::spawn(move || {
            let mut sink = vec![0u8; 65536];
            client_end
                .set_read_timeout(Some(Duration::from_millis(500)))
                .expect("timeout");
            while matches!(io::Read::read(&mut client_end, &mut sink), Ok(n) if n > 0) {}
            client_end
        });
        for i in 0..count {
            shared.on_output(line(i).as_bytes());
        }
        let mut client_end = reader.join().expect("reader");
        shared.request_history();
        let history = read_history(&mut client_end);
        assert!(history.len() > OUTPUT_HISTORY_LIMIT - line(0).len());
        assert!(String::from_utf8_lossy(&history).ends_with(&line(count - 1)));
    }

    #[test]
    fn each_history_request_gets_its_own_answer() {
        let (shared, _daemon_end, mut client_end, _writer) = attached();
        shared.on_output(b"asked twice\n");
        shared.request_history();
        shared.request_history();
        for history in read_histories(&mut client_end, 2) {
            assert!(String::from_utf8_lossy(&history).contains("asked twice"));
        }
    }
}
