//! [Session fan-out]: one session's screen stream, served to every [Remote
//! device] that has it open (spec §6).
//!
//! The host numbers the session's output once ([`ScreenSeq`]), compresses each
//! update once, and queues it for every device that is following. A device
//! starts, and restarts after a [Skip ahead], a resync or a new [Session run],
//! from a [Screen snapshot] the [PTY daemon] makes for it alone
//! (`RequestSnapshot { id }`). Until that snapshot arrives the device gets no
//! updates: the snapshot already shows them. Each ask uses a fresh requester
//! id, so an answer to an older ask is ignored.
//!
//! Pure: the caller feeds it the daemon's events in order, sends the asks to
//! the daemon, and drains each device's queue onto its stream.

use std::collections::HashMap;
use std::time::Instant;

use crate::codec::encode;
use crate::compress::{snapshot_messages, CompressError, Kind, Packer, SnapshotHead};
use crate::message::{EndpointId, ToDevice};
use crate::queue::{Next, SessionQueue};
use crate::screen::{ResyncGate, ScreenSeq};

/// A snapshot requester's id on the daemon socket.
pub type RequesterId = u32;

/// What popping a device's queue gave.
#[derive(Debug, PartialEq, Eq)]
pub enum Pop {
    /// An encoded message to write to the device's stream.
    Frame(Vec<u8>),
    /// The device's queue skipped ahead: ask the daemon for a snapshot for it
    /// under this requester id.
    Ask(RequesterId),
    /// Nothing to send.
    Empty,
}

/// One device's place in the stream.
struct DeviceStream {
    queue: SessionQueue,
    resync: ResyncGate,
    /// Asked the daemon for a snapshot for this device and not had it yet:
    /// until then it gets no updates, which the snapshot will show.
    awaiting: Option<Awaiting>,
}

/// A snapshot asked for, and the parts of it received so far.
struct Awaiting {
    requester: RequesterId,
    skipped: bool,
    bytes: Vec<u8>,
}

/// One session's screen stream for every device that has it open.
pub struct SessionFanout {
    limit: usize,
    /// `None` until the daemon names its run: an older daemon never does, and
    /// can't answer a snapshot request either.
    seq: Option<ScreenSeq>,
    dialog_generation: Option<u64>,
    devices: HashMap<EndpointId, DeviceStream>,
    next_requester: RequesterId,
    packer: Packer,
}

impl SessionFanout {
    /// A fan-out whose per-device queues hold up to `limit` bytes.
    ///
    /// # Errors
    /// When zstd can't make a compression context.
    pub fn new(limit: usize) -> Result<Self, CompressError> {
        Ok(Self {
            limit,
            seq: None,
            dialog_generation: None,
            devices: HashMap::new(),
            next_requester: 1,
            packer: Packer::new()?,
        })
    }

    /// A fresh requester id, never `u32::MAX` (the host's own window's).
    fn requester(&mut self) -> RequesterId {
        let id = self.next_requester;
        self.next_requester = match id.wrapping_add(1) {
            0 | u32::MAX => 1,
            next => next,
        };
        id
    }

    /// Start `device` over from a snapshot: the requester id to ask for.
    fn ask(&mut self, device: &EndpointId, skipped: bool) -> Option<RequesterId> {
        let requester = self.requester();
        let stream = self.devices.get_mut(device)?;
        stream.awaiting = Some(Awaiting {
            requester,
            skipped,
            bytes: Vec::new(),
        });
        Some(requester)
    }

    /// Start every device over: the requester ids to ask for.
    fn ask_all(&mut self, skipped: bool) -> Vec<RequesterId> {
        let devices: Vec<EndpointId> = self.devices.keys().copied().collect();
        devices
            .iter()
            .filter_map(|device| self.ask(device, skipped))
            .collect()
    }

    /// The daemon's [Session run]. A new run numbers from 0 again, so every
    /// device starts over from a snapshot: the requester ids to ask for.
    pub fn hello(&mut self, run: u64) -> Vec<RequesterId> {
        if self.seq.as_ref().is_some_and(|seq| seq.run() == run) {
            return Vec::new();
        }
        self.seq = Some(ScreenSeq::new(run));
        self.ask_all(false)
    }

    /// Output the session made: one update for every device that follows. A
    /// device whose queue overflows, or whose update can't be made, starts
    /// over from a snapshot: the requester ids to ask for.
    pub fn output(&mut self, bytes: &[u8]) -> Vec<RequesterId> {
        let Some(seq) = self.seq.as_mut() else {
            return Vec::new();
        };
        let number = seq.next_update();
        let run = seq.run();
        let following = self.devices.values().any(|d| d.awaiting.is_none());
        if !following {
            return Vec::new();
        }
        let frame = self
            .packer
            .pack(Kind::Update, bytes)
            .ok()
            .and_then(|packed| {
                encode(&ToDevice::Update {
                    run,
                    seq: number,
                    bytes: packed,
                })
                .ok()
            });
        let Some(frame) = frame else {
            return self.ask_all(true);
        };
        let mut overflowed = Vec::new();
        for (device, stream) in &mut self.devices {
            if stream.awaiting.is_none() {
                stream.queue.push(frame.clone());
                if stream.queue.is_skipping() {
                    overflowed.push(*device);
                }
            }
        }
        // Asked for now, not when the device's writer pops the skip: a slow
        // device's writer is stuck in a network write. A fresh queue, so the
        // snapshot isn't dropped behind a skip the writer hasn't seen.
        overflowed
            .iter()
            .filter_map(|device| {
                if let Some(stream) = self.devices.get_mut(device) {
                    stream.queue = SessionQueue::new(self.limit);
                }
                self.ask(device, true)
            })
            .collect()
    }

    /// The daemon skipped ahead for the window, dropping output every device
    /// would have seen: each starts over from a snapshot, marked skipped.
    pub fn screen(&mut self) -> Vec<RequesterId> {
        self.ask_all(true)
    }

    /// The daemon's [Dialog generation] moved: the `seq` a dialog appeared or
    /// changed at, for the input check; `None` when it didn't move. The dialog
    /// frame follows the output that drew it, so that is the last update.
    pub fn dialog(&mut self, generation: u64) -> Option<u64> {
        if self.dialog_generation == Some(generation) {
            return None;
        }
        self.dialog_generation = Some(generation);
        let seq = self.seq.as_mut()?;
        seq.dialog_changed();
        seq.dialog_changed_at()
    }

    /// Part of the daemon's snapshot for requester `id`.
    pub fn snapshot_part(&mut self, id: RequesterId, bytes: &[u8]) {
        if let Some(awaiting) = self.awaiting_mut(id) {
            awaiting.bytes.extend_from_slice(bytes);
        }
    }

    fn awaiting_mut(&mut self, id: RequesterId) -> Option<&mut Awaiting> {
        self.devices
            .values_mut()
            .filter_map(|stream| stream.awaiting.as_mut())
            .find(|awaiting| awaiting.requester == id)
    }

    /// The end of the snapshot for requester `id`, taken at the session's
    /// `size` (columns, rows): queued for its device, which follows from now.
    /// One that can't be made is asked for again.
    pub fn snapshot_end(&mut self, id: RequesterId, size: (u16, u16)) -> Option<RequesterId> {
        let seq = self.seq.as_ref()?;
        let (run, at) = (seq.run(), seq.snapshot_seq());
        let (device, awaiting) = self.devices.iter_mut().find_map(|(device, stream)| {
            stream
                .awaiting
                .take_if(|awaiting| awaiting.requester == id)
                .map(|awaiting| (*device, awaiting))
        })?;
        let head = SnapshotHead {
            run,
            seq: at,
            cols: size.0,
            rows: size.1,
            skipped: awaiting.skipped,
        };
        let frames: Option<Vec<Vec<u8>>> = self
            .packer
            .pack(Kind::Snapshot, &awaiting.bytes)
            .ok()
            .and_then(|packed| {
                snapshot_messages(head, &packed)
                    .iter()
                    .map(|message| encode(message).ok())
                    .collect()
            });
        let Some(frames) = frames else {
            return self.ask(&device, true);
        };
        let stream = self.devices.get_mut(&device)?;
        for frame in frames {
            stream.queue.push(frame);
        }
        None
    }

    /// A device opened this session: the requester id to ask for its
    /// snapshot; `None` before the daemon named its run (it can't answer).
    pub fn open(&mut self, device: EndpointId) -> Option<RequesterId> {
        self.seq.as_ref()?;
        self.devices.insert(
            device,
            DeviceStream {
                queue: SessionQueue::new(self.limit),
                resync: ResyncGate::default(),
                awaiting: None,
            },
        );
        self.ask(&device, false)
    }

    /// A device asked to resync: a requester id to ask for, at most once a
    /// second per device ([`ResyncGate`]).
    pub fn resync(&mut self, device: &EndpointId, now: Instant) -> Option<RequesterId> {
        let allowed = self.devices.get_mut(device)?.resync.allow(now);
        if allowed {
            self.ask(device, false)
        } else {
            None
        }
    }

    /// The device closed the session, or went away.
    pub fn close(&mut self, device: &EndpointId) {
        self.devices.remove(device);
    }

    /// How many devices have the session open.
    #[must_use]
    pub fn open_count(&self) -> usize {
        self.devices.len()
    }

    /// The next thing to write to `device`'s stream. A queue that skipped
    /// ahead starts its device over from a snapshot, marked skipped.
    pub fn pop(&mut self, device: &EndpointId) -> Pop {
        let Some(stream) = self.devices.get_mut(device) else {
            return Pop::Empty;
        };
        match stream.queue.pop() {
            Next::Frame(bytes) => Pop::Frame(bytes),
            Next::Empty => Pop::Empty,
            Next::SkipAhead => self.ask(device, true).map_or(Pop::Empty, Pop::Ask),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::{Decoded, Decoder};
    use crate::compress::decompress;

    const A: EndpointId = [1; 32];
    const B: EndpointId = [2; 32];
    const SIZE: (u16, u16) = (80, 24);

    /// Every message waiting for `device`, the asks it would make included.
    fn drain(fanout: &mut SessionFanout, device: &EndpointId) -> (Vec<ToDevice>, Vec<RequesterId>) {
        let mut decoder = Decoder::<ToDevice>::new();
        let mut asks = Vec::new();
        loop {
            match fanout.pop(device) {
                Pop::Frame(bytes) => decoder.push(&bytes),
                Pop::Ask(id) => asks.push(id),
                Pop::Empty => break,
            }
        }
        let mut messages = Vec::new();
        while let Ok(Some(Decoded::Message(message))) = decoder.next_message() {
            messages.push(message);
        }
        (messages, asks)
    }

    fn update_text(message: &ToDevice) -> Option<(u64, String)> {
        match message {
            ToDevice::Update { seq, bytes, .. } => Some((
                *seq,
                String::from_utf8(decompress(Kind::Update, bytes).expect("update")).expect("utf8"),
            )),
            _ => None,
        }
    }

    /// A device opened and given its snapshot showing `screen`.
    fn following(fanout: &mut SessionFanout, device: EndpointId, screen: &[u8]) {
        let id = fanout.open(device).expect("asks");
        fanout.snapshot_part(id, screen);
        fanout.snapshot_end(id, SIZE);
    }

    #[test]
    fn an_opened_session_starts_from_its_snapshot_then_follows_updates() {
        let mut fanout = SessionFanout::new(1 << 20).expect("fanout");
        assert_eq!(
            fanout.open(A),
            None,
            "no run named yet: the daemon can't answer"
        );
        fanout.hello(7);
        fanout.output(b"before anyone looked");
        let id = fanout.open(A).expect("asks");
        fanout.output(b"while the snapshot is made");
        fanout.snapshot_part(id, b"the ");
        fanout.snapshot_part(id, b"screen");
        fanout.snapshot_end(id, SIZE);
        fanout.output(b"after");
        let (messages, asks) = drain(&mut fanout, &A);
        assert_eq!(asks, Vec::<RequesterId>::new());
        let ToDevice::Snapshot {
            run,
            seq,
            cols,
            rows,
            bytes,
            skipped,
        } = &messages[0]
        else {
            panic!("a snapshot first: {messages:?}")
        };
        assert_eq!((*run, *seq, *cols, *rows, *skipped), (7, 2, 80, 24, false));
        assert_eq!(
            decompress(Kind::Snapshot, bytes).expect("snapshot"),
            b"the screen"
        );
        assert_eq!(
            messages[1..]
                .iter()
                .filter_map(update_text)
                .collect::<Vec<_>>(),
            [(3, "after".to_string())],
            "only what the snapshot doesn't show"
        );
    }

    #[test]
    fn a_slow_device_skips_ahead_alone() {
        let mut fanout = SessionFanout::new(4096).expect("fanout");
        fanout.hello(1);
        following(&mut fanout, A, b"a");
        following(&mut fanout, B, b"b");
        let (_, _) = drain(&mut fanout, &A);
        let mut fast_got = 0;
        let mut asks = Vec::new();
        for i in 0..200 {
            asks.extend(fanout.output(format!("chunk {i:03} {}", "x".repeat(64)).as_bytes()));
            // A keeps up; B is never read.
            fast_got += drain(&mut fanout, &A)
                .0
                .iter()
                .filter_map(update_text)
                .count();
        }
        assert_eq!(fast_got, 200, "the fast device gets every update");
        assert_eq!(asks.len(), 1, "the slow one is asked a fresh snapshot for");
        fanout.snapshot_part(asks[0], b"now");
        fanout.snapshot_end(asks[0], SIZE);
        let (messages, _) = drain(&mut fanout, &B);
        assert!(
            matches!(
                messages.last(),
                Some(ToDevice::Snapshot {
                    skipped: true,
                    seq: 200,
                    ..
                })
            ),
            "{messages:?}"
        );
    }

    #[test]
    fn a_new_run_starts_every_device_over() {
        let mut fanout = SessionFanout::new(1 << 20).expect("fanout");
        fanout.hello(1);
        following(&mut fanout, A, b"a");
        fanout.output(b"x");
        let asks = fanout.hello(2);
        assert_eq!(asks.len(), 1);
        fanout.output(b"dropped: the snapshot will show it");
        fanout.snapshot_part(asks[0], b"new");
        fanout.snapshot_end(asks[0], SIZE);
        fanout.output(b"first of run 2");
        let (messages, _) = drain(&mut fanout, &A);
        let last_snapshot = messages
            .iter()
            .rposition(|m| matches!(m, ToDevice::Snapshot { run: 2, seq: 1, .. }))
            .expect("a run-2 snapshot");
        assert!(matches!(
            messages[last_snapshot + 1],
            ToDevice::Update { run: 2, seq: 2, .. }
        ));
        assert!(
            fanout.hello(2).is_empty(),
            "the same run again changes nothing"
        );
    }

    #[test]
    fn a_skip_the_daemon_made_for_the_window_restarts_every_device() {
        let mut fanout = SessionFanout::new(1 << 20).expect("fanout");
        fanout.hello(1);
        following(&mut fanout, A, b"a");
        let asks = fanout.screen();
        assert_eq!(asks.len(), 1);
        fanout.output(b"dropped");
        fanout.snapshot_part(asks[0], b"after the skip");
        fanout.snapshot_end(asks[0], SIZE);
        let (messages, _) = drain(&mut fanout, &A);
        assert!(matches!(
            messages.last(),
            Some(ToDevice::Snapshot { skipped: true, .. })
        ));
    }

    #[test]
    fn an_answer_to_an_older_ask_is_ignored() {
        let mut fanout = SessionFanout::new(1 << 20).expect("fanout");
        fanout.hello(1);
        let old = fanout.open(A).expect("asks");
        let new = fanout.screen()[0];
        assert_ne!(old, new);
        fanout.snapshot_part(old, b"old");
        fanout.snapshot_end(old, SIZE);
        assert!(
            drain(&mut fanout, &A).0.is_empty(),
            "still waiting for the newer one"
        );
        fanout.snapshot_part(new, b"new");
        fanout.snapshot_end(new, SIZE);
        assert_eq!(drain(&mut fanout, &A).0.len(), 1);
    }

    #[test]
    fn a_device_resyncs_at_most_once_a_second() {
        let mut fanout = SessionFanout::new(1 << 20).expect("fanout");
        fanout.hello(1);
        following(&mut fanout, A, b"a");
        let now = Instant::now();
        assert!(fanout.resync(&A, now).is_some());
        assert!(fanout.resync(&A, now).is_none());
        assert!(fanout
            .resync(&A, now + crate::screen::RESYNC_EVERY)
            .is_some());
        assert!(
            fanout.resync(&B, now).is_none(),
            "a device that never opened it"
        );
    }

    #[test]
    fn a_dialog_change_is_stamped_with_the_update_that_drew_it() {
        let mut fanout = SessionFanout::new(1 << 20).expect("fanout");
        fanout.hello(1);
        fanout.output(b"one");
        fanout.output(b"the dialog");
        assert_eq!(fanout.dialog(40), Some(2));
        assert_eq!(fanout.dialog(40), None, "the same generation is no change");
        fanout.output(b"three");
        assert_eq!(fanout.dialog(41), Some(3));
    }

    #[test]
    fn closing_stops_the_stream_and_counts_the_onlookers() {
        let mut fanout = SessionFanout::new(1 << 20).expect("fanout");
        fanout.hello(1);
        following(&mut fanout, A, b"a");
        following(&mut fanout, B, b"b");
        assert_eq!(fanout.open_count(), 2);
        fanout.close(&A);
        assert_eq!(fanout.open_count(), 1);
        fanout.output(b"x");
        assert_eq!(fanout.pop(&A), Pop::Empty);
    }

    #[test]
    fn an_overflowing_device_is_asked_for_at_once_not_when_its_writer_comes_back() {
        // The writer of a slow device is stuck in a network write, so it
        // can't pop the skip; the snapshot is asked for as the queue skips.
        let mut fanout = SessionFanout::new(4096).expect("fanout");
        fanout.hello(1);
        following(&mut fanout, A, b"a");
        let mut asks = Vec::new();
        for i in 0..200 {
            asks.extend(fanout.output(format!("chunk {i:03} {}", "x".repeat(64)).as_bytes()));
        }
        assert_eq!(asks.len(), 1, "asked once, as it skipped");
        fanout.snapshot_part(asks[0], b"now");
        fanout.snapshot_end(asks[0], SIZE);
        let (messages, more) = drain(&mut fanout, &A);
        assert_eq!(
            more,
            Vec::<RequesterId>::new(),
            "no second ask when the writer pops"
        );
        assert!(messages
            .iter()
            .any(|m| matches!(m, ToDevice::Snapshot { skipped: true, .. })));
    }
}
