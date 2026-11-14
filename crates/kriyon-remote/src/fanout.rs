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

/// A fresh requester id from `counter`, never 0 or `u32::MAX` (the host's
/// own window's).
fn next_requester(counter: &mut u32) -> RequesterId {
    let id = *counter;
    *counter = match id.wrapping_add(1) {
        0 | u32::MAX => 1,
        next => next,
    };
    id
}

/// One device's place in the stream.
struct DeviceStream {
    queue: SessionQueue,
    resync: ResyncGate,
    /// Asked the daemon for a snapshot for this device and not had it yet:
    /// until then it gets no updates, which the snapshot will show.
    awaiting: Option<Awaiting>,
    /// Its snapshot came and is being packed elsewhere: updates made since
    /// wait here, to follow it in order.
    held: Option<Held>,
    /// Its queue was dropped since [`SessionFanout::dropped`] last said so:
    /// what else was queued for it (readable-view entries) is gone too.
    dropped: bool,
    /// It wants the screen. Off (reading entries only), it gets no
    /// snapshot and no updates, but still has the session open.
    screen: bool,
}

/// Updates waiting for the snapshot of `requester` to be packed.
#[derive(Debug)]
struct Held {
    requester: RequesterId,
    frames: Vec<Vec<u8>>,
    bytes: usize,
}

/// A device's snapshot, to be compressed and framed (off the daemon's
/// reader thread: compressing a big screen takes a while), then handed back
/// with [`SessionFanout::snapshot_packed`].
#[derive(Debug)]
pub struct SnapshotToPack {
    pub device: EndpointId,
    /// The ask it answers: a pack for an ask since replaced is dropped.
    pub requester: RequesterId,
    pub head: SnapshotHead,
    pub bytes: Vec<u8>,
}

/// Compress and frame a snapshot: what [`SessionFanout::snapshot_packed`]
/// queues. `None` when it can't be.
#[must_use]
pub fn pack_snapshot(packer: &mut Packer, snapshot: &SnapshotToPack) -> Option<Vec<Vec<u8>>> {
    let compressed = packer.pack(Kind::Snapshot, &snapshot.bytes).ok()?;
    snapshot_messages(snapshot.head, &compressed)
        .iter()
        .map(|message| encode(message).ok())
        .collect()
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

    /// Start `device` over from a snapshot: the requester id to ask for.
    fn ask(&mut self, device: &EndpointId, skipped: bool) -> Option<RequesterId> {
        let stream = self.devices.get_mut(device)?;
        if !stream.screen {
            return None;
        }
        let requester = next_requester(&mut self.next_requester);
        // A snapshot being packed for it is no longer wanted.
        stream.held = None;
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
        // Another daemon counts its dialogs afresh.
        self.dialog_generation = None;
        // A screen names the run in its snapshot; one off is told it.
        let off: Vec<EndpointId> = self
            .devices
            .iter()
            .filter(|(_, stream)| !stream.screen)
            .map(|(device, _)| *device)
            .collect();
        self.tell_run(&off, run);
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
        let following = self
            .devices
            .values()
            .any(|d| d.screen && d.awaiting.is_none());
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
            if !stream.screen || stream.awaiting.is_some() {
                continue;
            }
            if let Some(held) = stream.held.as_mut() {
                // Waits for its snapshot; too much of it, and the device
                // starts over from a fresh one instead.
                held.bytes += frame.len();
                held.frames.push(frame.clone());
                if held.bytes > self.limit {
                    overflowed.push(*device);
                }
                continue;
            }
            stream.queue.push(frame.clone());
            if stream.queue.is_skipping() {
                overflowed.push(*device);
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
                    stream.dropped = true;
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
    /// `size` (columns, rows): to be packed, after which its device follows.
    /// Updates made meanwhile wait for it ([`Self::snapshot_packed`]).
    pub fn snapshot_end(&mut self, id: RequesterId, size: (u16, u16)) -> Option<SnapshotToPack> {
        let seq = self.seq.as_ref()?;
        let (run, at) = (seq.run(), seq.snapshot_seq());
        let (device, awaiting) = self.devices.iter_mut().find_map(|(device, stream)| {
            let awaiting = stream
                .awaiting
                .take_if(|awaiting| awaiting.requester == id)?;
            stream.held = Some(Held {
                requester: id,
                frames: Vec::new(),
                bytes: 0,
            });
            Some((*device, awaiting))
        })?;
        Some(SnapshotToPack {
            device,
            requester: id,
            head: SnapshotHead {
                run,
                seq: at,
                cols: size.0,
                rows: size.1,
                skipped: awaiting.skipped,
            },
            bytes: awaiting.bytes,
        })
    }

    /// `snapshot`, packed (`None`: it couldn't be): queued for its device,
    /// then the updates made while it was packed. One for a run, or a wait,
    /// that has since been replaced is dropped. An unusable one is asked for
    /// again: the requester id.
    pub fn snapshot_packed(
        &mut self,
        snapshot: &SnapshotToPack,
        frames: Option<Vec<Vec<u8>>>,
    ) -> Option<RequesterId> {
        let current = self.seq.as_ref().map(ScreenSeq::run);
        let stream = self.devices.get_mut(&snapshot.device)?;
        if current != Some(snapshot.head.run) {
            return None;
        }
        let held = stream
            .held
            .take_if(|held| held.requester == snapshot.requester)?;
        let Some(frames) = frames else {
            return self.ask(&snapshot.device, true);
        };
        for frame in frames.into_iter().chain(held.frames) {
            stream.queue.push(frame);
        }
        None
    }

    /// A device opened this session: the requester id to ask for its
    /// snapshot; `None` before the daemon named its run (it can't answer).
    pub fn open(&mut self, device: EndpointId) -> Option<RequesterId> {
        self.seq.as_ref()?;
        self.insert(device, true);
        self.ask(&device, false)
    }

    /// A device opened this session to read its entries only: open (an
    /// onlooker), with no screen until it turns it on.
    pub fn open_without_screen(&mut self, device: EndpointId) {
        self.insert(device, false);
        if let Some(run) = self.seq.as_ref().map(ScreenSeq::run) {
            self.tell_run(&[device], run);
        }
    }

    /// Tell `devices` (their screens off) the session's run, so they can
    /// write to Claude from its entries (spec §6). Best effort: a queue that
    /// can't take it starts over, and the next run or reopen tells it again.
    fn tell_run(&mut self, devices: &[EndpointId], run: u64) {
        let Ok(frame) = encode(&ToDevice::Run { run }) else {
            return;
        };
        for device in devices {
            let Some(stream) = self.devices.get_mut(device) else {
                continue;
            };
            stream.queue.push(frame.clone());
            if stream.queue.is_skipping() {
                self.start_queue_over(device);
            }
        }
    }

    /// `device`'s queue overflowed: a fresh one, its entries start over
    /// ([`Self::dropped`]), and with its screen off it is told the run again
    /// first, since that went with the queue.
    fn start_queue_over(&mut self, device: &EndpointId) {
        let run = self.seq.as_ref().map(ScreenSeq::run);
        let Some(stream) = self.devices.get_mut(device) else {
            return;
        };
        stream.queue = SessionQueue::new(self.limit);
        stream.dropped = true;
        if let (false, Some(run)) = (stream.screen, run) {
            if let Ok(frame) = encode(&ToDevice::Run { run }) {
                stream.queue.push(frame);
            }
        }
    }

    /// Turn `device`'s screen on: the requester id to ask for its snapshot,
    /// asked again if it was on (a new screen needs the whole of it); `None`
    /// before the daemon named its run, whose hello then asks for it. Or
    /// off: no more updates, what was queued dropped (its entries start over
    /// if any went, [`Self::dropped`]) and a snapshot under way with it.
    pub fn set_screen(&mut self, device: &EndpointId, on: bool) -> Option<RequesterId> {
        self.set_screen_at(device, on, Instant::now())
    }

    /// [`Self::set_screen`] at `now`. Turned on (again, or anew), its
    /// snapshot is asked for through the same gate as a `Resync`: a device
    /// flipping its screen gets at most one a second, and one it was denied
    /// comes when it asks again (its screen re-asks on a timer).
    pub fn set_screen_at(
        &mut self,
        device: &EndpointId,
        on: bool,
        now: Instant,
    ) -> Option<RequesterId> {
        let stream = self.devices.get_mut(device)?;
        let was = std::mem::replace(&mut stream.screen, on);
        if on {
            self.seq.as_ref()?;
            let stream = self.devices.get_mut(device)?;
            if !stream.resync.allow(now) {
                return None;
            }
            return self.ask(device, false);
        }
        if was {
            stream.awaiting = None;
            stream.held = None;
            // Its entries start over only if some went with the queue.
            if !stream.queue.is_empty() {
                stream.queue = SessionQueue::new(self.limit);
                stream.dropped = true;
            }
            // The snapshot that names the run may be what just went: told
            // the run, it can still write from its entries.
            if let Some(run) = self.seq.as_ref().map(ScreenSeq::run) {
                self.tell_run(&[*device], run);
            }
        }
        None
    }

    fn insert(&mut self, device: EndpointId, screen: bool) {
        self.devices.insert(
            device,
            DeviceStream {
                queue: SessionQueue::new(self.limit),
                resync: ResyncGate::default(),
                awaiting: None,
                held: None,
                dropped: false,
                screen,
            },
        );
    }

    /// A device asked to resync: a requester id to ask for, at most once a
    /// second per device ([`ResyncGate`]).
    pub fn resync(&mut self, device: &EndpointId, now: Instant) -> Option<RequesterId> {
        let stream = self.devices.get_mut(device)?;
        // Screen off: nothing to ask for, and the gate is kept for later.
        if !stream.screen {
            return None;
        }
        let allowed = stream.resync.allow(now);
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

    /// Whether `device` has this session open.
    #[must_use]
    pub fn is_open(&self, device: &EndpointId) -> bool {
        self.devices.contains_key(device)
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
            Next::SkipAhead => {
                stream.dropped = true;
                self.ask(device, true).map_or(Pop::Empty, Pop::Ask)
            }
        }
    }

    /// Queue `frame`, an encoded message for `device` alone (readable-view
    /// entries), behind what is queued for it.
    ///
    /// # Errors
    /// Too much for its queue: the queue is dropped, and the device starts
    /// over, from a fresh snapshot when its screen is on (the requester id to
    /// ask for it).
    pub fn send(&mut self, device: &EndpointId, frame: Vec<u8>) -> Result<(), Option<RequesterId>> {
        let Some(stream) = self.devices.get_mut(device) else {
            return Ok(());
        };
        stream.queue.push(frame);
        if !stream.queue.is_skipping() {
            return Ok(());
        }
        self.start_queue_over(device);
        Err(self.ask(device, true))
    }

    /// Whether `device`'s queue was dropped since this last said so.
    pub fn dropped(&mut self, device: &EndpointId) -> bool {
        self.devices
            .get_mut(device)
            .is_some_and(|stream| std::mem::take(&mut stream.dropped))
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

    fn pack(snapshot: &SnapshotToPack) -> Option<Vec<Vec<u8>>> {
        pack_snapshot(&mut Packer::new().expect("packer"), snapshot)
    }

    /// The end of snapshot `id`, packed and queued as the host does it.
    fn finish(fanout: &mut SessionFanout, id: RequesterId) -> Option<RequesterId> {
        let to_pack = fanout.snapshot_end(id, SIZE)?;
        let frames = pack(&to_pack);
        fanout.snapshot_packed(&to_pack, frames)
    }

    /// A device opened and given its snapshot showing `screen`.
    fn following(fanout: &mut SessionFanout, device: EndpointId, screen: &[u8]) {
        let id = fanout.open(device).expect("asks");
        fanout.snapshot_part(id, screen);
        finish(fanout, id);
    }

    #[test]
    fn updates_made_while_a_snapshot_is_packed_follow_it_in_order() {
        let mut fanout = SessionFanout::new(1 << 20).expect("fanout");
        fanout.hello(7);
        let id = fanout.open(A).expect("asks");
        fanout.snapshot_part(id, b"screen");
        let Some(to_pack) = fanout.snapshot_end(id, SIZE) else {
            panic!("a snapshot to pack");
        };
        // Packed elsewhere, meanwhile output goes on.
        fanout.output(b"during");
        let frames = pack(&to_pack);
        assert_eq!(fanout.snapshot_packed(&to_pack, frames), None);
        fanout.output(b"after");
        let (messages, _) = drain(&mut fanout, &A);
        assert!(
            matches!(messages[0], ToDevice::Snapshot { .. }),
            "{messages:?}"
        );
        let updates: Vec<String> = messages
            .iter()
            .filter_map(update_text)
            .map(|(_, text)| text)
            .collect();
        assert_eq!(updates, vec!["during".to_string(), "after".to_string()]);
    }

    #[test]
    fn a_snapshot_that_couldnt_be_packed_or_came_too_late_is_asked_again_or_dropped() {
        let mut fanout = SessionFanout::new(1 << 20).expect("fanout");
        fanout.hello(7);
        let id = fanout.open(A).expect("asks");
        let Some(to_pack) = fanout.snapshot_end(id, SIZE) else {
            panic!("a snapshot to pack");
        };
        assert!(
            fanout.snapshot_packed(&to_pack, None).is_some(),
            "asked again"
        );
        // A new run meanwhile: a pack for the old one is dropped.
        let id = fanout.open(B).expect("asks");
        let Some(old) = fanout.snapshot_end(id, SIZE) else {
            panic!("a snapshot to pack");
        };
        fanout.hello(8);
        let frames = pack(&old);
        assert_eq!(fanout.snapshot_packed(&old, frames), None);
        let (messages, _) = drain(&mut fanout, &B);
        assert!(messages.is_empty(), "{messages:?}");
    }

    #[test]
    fn a_slow_pack_of_a_snapshot_since_asked_again_never_takes_the_new_ones_place() {
        let mut fanout = SessionFanout::new(1 << 20).expect("fanout");
        fanout.hello(7);
        let first = fanout.open(A).expect("asks");
        let old = fanout.snapshot_end(first, SIZE).expect("to pack");
        let again = fanout.resync(&A, Instant::now()).expect("asks again");
        let new = fanout.snapshot_end(again, SIZE).expect("to pack");
        fanout.output(b"after");
        // The old pack finishes first: dropped, the new one still waits.
        let frames = pack(&old);
        assert_eq!(fanout.snapshot_packed(&old, frames), None);
        assert_eq!(drain(&mut fanout, &A).0, Vec::new());
        let frames = pack(&new);
        assert_eq!(fanout.snapshot_packed(&new, frames), None);
        let (messages, _) = drain(&mut fanout, &A);
        let snapshots = messages
            .iter()
            .filter(|message| matches!(message, ToDevice::Snapshot { .. }))
            .count();
        assert_eq!(snapshots, 1, "{messages:?}");
        let updates: Vec<String> = messages
            .iter()
            .filter_map(update_text)
            .map(|(_, t)| t)
            .collect();
        assert_eq!(updates, vec!["after".to_string()]);
    }

    #[test]
    fn a_message_for_one_device_goes_in_its_queue_and_a_dropped_queue_is_told() {
        let mut fanout = SessionFanout::new(1024).expect("fanout");
        fanout.hello(7);
        following(&mut fanout, A, b"x");
        following(&mut fanout, B, b"x");
        drain(&mut fanout, &A);
        drain(&mut fanout, &B);
        let note = encode(&ToDevice::Refused {
            reason: crate::message::RefuseReason::Stale,
        })
        .expect("encodes");
        assert_eq!(fanout.send(&A, note.clone()), Ok(()));
        assert!(!fanout.dropped(&A));
        let (messages, _) = drain(&mut fanout, &A);
        assert_eq!(messages.len(), 1);
        assert_eq!(drain(&mut fanout, &B).0, Vec::new(), "only A's");
        // Too much for its queue: it starts over from a snapshot, and the
        // caller hears that what it queued was dropped, once.
        let big = vec![0; 4096];
        assert!(
            matches!(fanout.send(&A, big), Err(Some(_))),
            "a fresh snapshot is asked for"
        );
        assert!(fanout.dropped(&A));
        assert!(!fanout.dropped(&A));
        // Output overflowing its queue drops what was queued too.
        let noise: Vec<u8> = (0..16_384_u32)
            .map(|n| (n.wrapping_mul(2_654_435_761) >> 24).to_le_bytes()[0])
            .collect();
        fanout.output(&noise);
        assert!(fanout.dropped(&B));
    }

    #[test]
    fn a_device_with_its_screen_off_gets_no_screen_until_it_turns_it_on() {
        let mut fanout = SessionFanout::new(1 << 20).expect("fanout");
        fanout.hello(7);
        fanout.open_without_screen(A);
        assert!(fanout.is_open(&A), "still open: an onlooker");
        fanout.output(b"unseen");
        // No screen, but its run, for writing to Claude from its entries.
        assert_eq!(drain(&mut fanout, &A).0, vec![ToDevice::Run { run: 7 }]);
        // A new run asks every device for a screen, but not this one: it is
        // told the new run.
        assert_eq!(fanout.hello(8), Vec::<RequesterId>::new());
        assert_eq!(drain(&mut fanout, &A).0, vec![ToDevice::Run { run: 8 }]);
        // On: a snapshot, then updates.
        let id = fanout.set_screen(&A, true).expect("asks");
        fanout.snapshot_part(id, b"screen");
        finish(&mut fanout, id);
        fanout.output(b"seen");
        let (messages, _) = drain(&mut fanout, &A);
        assert!(
            matches!(messages[0], ToDevice::Snapshot { .. }),
            "{messages:?}"
        );
        assert_eq!(messages.len(), 2);
        // Off again: updates stop, and a snapshot asked for is dropped; the
        // run is told again.
        fanout.set_screen(&A, false);
        fanout.output(b"unseen again");
        assert_eq!(drain(&mut fanout, &A).0, vec![ToDevice::Run { run: 8 }]);
        assert_eq!(fanout.resync(&A, Instant::now()), None);
    }

    #[test]
    fn a_screen_off_stream_opened_before_the_run_is_named_hears_it_once_it_is() {
        let mut fanout = SessionFanout::new(1 << 20).expect("fanout");
        fanout.open_without_screen(A);
        assert_eq!(drain(&mut fanout, &A).0, Vec::new());
        fanout.hello(3);
        assert_eq!(drain(&mut fanout, &A).0, vec![ToDevice::Run { run: 3 }]);
        // The same run said again: nothing new.
        fanout.hello(3);
        assert_eq!(drain(&mut fanout, &A).0, Vec::new());
    }

    #[test]
    fn turning_the_screen_off_drops_what_was_queued_and_on_again_asks_afresh() {
        let mut fanout = SessionFanout::new(1 << 20).expect("fanout");
        fanout.hello(7);
        following(&mut fanout, A, b"x");
        fanout.output(b"queued");
        fanout.set_screen(&A, false);
        // Nothing stale, but the run: the snapshot that would have named it
        // may be what was dropped, and the device writes from its entries.
        assert_eq!(drain(&mut fanout, &A).0, vec![ToDevice::Run { run: 7 }]);
        assert!(fanout.dropped(&A), "its entries start over too");
        // Off and on again with nothing queued: entries are left alone.
        assert!(fanout.set_screen(&A, true).is_some());
        fanout.set_screen(&A, false);
        assert!(!fanout.dropped(&A));
        // A resync while off doesn't use up the gate.
        assert_eq!(fanout.resync(&A, Instant::now()), None);
    }

    /// A screen turned on asks for a snapshot through the resync gate: a
    /// device flipping it on and off, or on and on, asks once a second.
    #[test]
    fn turning_the_screen_on_again_and_again_asks_once_a_second() {
        let mut fanout = SessionFanout::new(1 << 20).expect("fanout");
        fanout.hello(7);
        fanout.open_without_screen(A);
        let t = Instant::now();
        assert!(fanout.set_screen_at(&A, true, t).is_some(), "the first");
        let mut asked = 0;
        for _ in 0..20 {
            fanout.set_screen_at(&A, false, t);
            asked += usize::from(fanout.set_screen_at(&A, true, t).is_some());
            asked += usize::from(fanout.set_screen_at(&A, true, t).is_some());
        }
        assert_eq!(asked, 0, "no more within the second");
        let later = t + std::time::Duration::from_secs(1);
        assert!(
            fanout.set_screen_at(&A, true, later).is_some(),
            "a new screen, a second on"
        );
    }

    #[test]
    fn a_screen_turned_on_before_the_daemon_names_its_run_comes_with_its_hello() {
        let mut fanout = SessionFanout::new(1024).expect("fanout");
        fanout.open_without_screen(A);
        assert_eq!(fanout.set_screen(&A, true), None);
        assert_eq!(fanout.hello(7).len(), 1, "its snapshot asked for then");
    }

    #[test]
    fn a_message_too_big_for_a_screen_off_queue_is_told_as_dropped() {
        let mut fanout = SessionFanout::new(1024).expect("fanout");
        fanout.hello(7);
        fanout.open_without_screen(A);
        assert_eq!(drain(&mut fanout, &A).0, vec![ToDevice::Run { run: 7 }]);
        assert_eq!(fanout.send(&A, vec![0; 16]), Ok(()));
        assert_eq!(
            fanout.send(&A, vec![0; 4096]),
            Err(None),
            "dropped, no snapshot"
        );
        // The run it was told went with the queue: told again, first.
        assert_eq!(drain(&mut fanout, &A).0, vec![ToDevice::Run { run: 7 }]);
    }

    #[test]
    fn too_much_output_while_a_snapshot_is_packed_starts_the_device_over() {
        let mut fanout = SessionFanout::new(64).expect("fanout");
        fanout.hello(7);
        let id = fanout.open(A).expect("asks");
        let Some(_) = fanout.snapshot_end(id, SIZE) else {
            panic!("a snapshot to pack");
        };
        let noise: Vec<u8> = (0..4096_u32)
            .map(|n| (n.wrapping_mul(2_654_435_761) >> 24).to_le_bytes()[0])
            .collect();
        assert_eq!(
            fanout.output(&noise).len(),
            1,
            "a fresh snapshot is asked for"
        );
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
        finish(&mut fanout, id);
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
        finish(&mut fanout, asks[0]);
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
        finish(&mut fanout, asks[0]);
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
        finish(&mut fanout, asks[0]);
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
        finish(&mut fanout, old);
        assert!(
            drain(&mut fanout, &A).0.is_empty(),
            "still waiting for the newer one"
        );
        fanout.snapshot_part(new, b"new");
        finish(&mut fanout, new);
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
        finish(&mut fanout, asks[0]);
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

    #[test]
    fn a_new_run_counts_its_first_dialog_even_at_a_generation_seen_before() {
        let mut fanout = SessionFanout::new(1 << 20).expect("fanout");
        fanout.hello(1);
        fanout.output(b"x");
        assert_eq!(fanout.dialog(1), Some(1));
        fanout.hello(2);
        fanout.output(b"y");
        assert_eq!(fanout.dialog(1), Some(1), "another daemon, another count");
    }

    #[test]
    fn a_device_has_a_session_open_once() {
        let mut fanout = SessionFanout::new(1 << 20).expect("fanout");
        fanout.hello(1);
        assert!(!fanout.is_open(&A));
        following(&mut fanout, A, b"a");
        assert!(fanout.is_open(&A));
    }
}
