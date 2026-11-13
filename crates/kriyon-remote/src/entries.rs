//! Sending [Readable view] entries (spec §6, "Sending"): one [`EntryBook`]
//! per session numbers the entries, one [`EntryReader`] per reading device
//! sends it only what is new or changed.
//!
//! The book keeps the window in `seq` order, which is the order a device
//! shows: a new entry gets the next `seq`, and when one would not come last
//! (an entry gone from the middle, or the "older" note appearing at the
//! start) the book numbers the whole window again and every reader starts
//! over from a reset.

use std::collections::{HashMap, HashSet};
use std::hash::{DefaultHasher, Hash, Hasher};

use kriyon_core::readable::{EntryKind, Keyed, OLDER_KEY};

use crate::message::{Entry, ToDevice};

/// What an answered question's entry becomes.
pub const ANSWERED: &str = "Answered in the terminal";

/// The most bytes of one `Entries` message, framing included (spec §6).
pub const ENTRIES_MESSAGE_MAX: usize = 64 * 1024;

/// Room kept in a message for its tag, length and `reset`.
const MESSAGE_ROOM: usize = 32;

/// A session's entries, numbered.
#[derive(Debug)]
pub struct EntryBook {
    next_seq: u64,
    /// The first `seq` of the current numbering: a reader that knows an
    /// older one starts over.
    numbering: u64,
    /// The `seq` each key has in this numbering.
    seqs: HashMap<String, u64>,
    /// Answered questions' keys, kept as notes until they fall off.
    answered: HashSet<String>,
    /// The window, in `seq` order, with each entry's key.
    window: Vec<(String, Entry)>,
}

impl Default for EntryBook {
    fn default() -> Self {
        Self {
            next_seq: 1,
            numbering: 1,
            seqs: HashMap::new(),
            answered: HashSet::new(),
            window: Vec::new(),
        }
    }
}

impl EntryBook {
    /// The entries as built now ([`kriyon_core::readable::entries`]).
    pub fn update(&mut self, built: Vec<Keyed>) {
        let now: HashSet<&str> = built.iter().map(|entry| entry.key.as_str()).collect();
        // A question showing again (its dialog flickered) is no longer
        // answered.
        self.answered.retain(|key| !now.contains(key.as_str()));
        // A question no longer showing was answered: it stays, as a note.
        for (key, entry) in &self.window {
            if matches!(entry.kind, EntryKind::Asking { .. }) && !now.contains(key.as_str()) {
                self.answered.insert(key.clone());
            }
        }
        // Gone from the middle (not off the old end, not answered): the
        // device would keep it, so number everything again. Off the old end
        // means before every entry still kept; the "older" note at the
        // start doesn't count.
        let mut kept_seen = false;
        let mut gone_from_middle = false;
        for (key, _) in &self.window {
            if key == OLDER_KEY || self.answered.contains(key) {
                continue;
            }
            if now.contains(key.as_str()) {
                kept_seen = true;
            } else if kept_seen {
                gone_from_middle = true;
            }
        }
        if gone_from_middle || !self.in_order(&built) {
            self.number_again();
        }
        let mut window: Vec<(String, Entry)> = Vec::with_capacity(built.len());
        for Keyed { key, kind } in built {
            // The "older" note is always first: seq 0, never numbered.
            let seq = if key == OLDER_KEY {
                0
            } else if let Some(seq) = self.seqs.get(&key) {
                *seq
            } else {
                let seq = self.next_seq;
                self.next_seq += 1;
                self.seqs.insert(key.clone(), seq);
                seq
            };
            window.push((key, Entry { seq, kind }));
        }
        // Answered notes fall off the old end like the rest.
        let first = window
            .iter()
            .filter(|(key, _)| key != OLDER_KEY)
            .map(|(_, entry)| entry.seq)
            .min();
        let seqs = &self.seqs;
        self.answered.retain(|key| {
            seqs.get(key)
                .is_some_and(|seq| first.is_some_and(|first| *seq > first))
        });
        for key in &self.answered {
            if let Some(seq) = self.seqs.get(key) {
                window.push((
                    key.clone(),
                    Entry {
                        seq: *seq,
                        kind: EntryKind::Note {
                            text: ANSWERED.into(),
                        },
                    },
                ));
            }
        }
        window.sort_by_key(|(_, entry)| entry.seq);
        let keep: HashSet<&str> = window.iter().map(|(key, _)| key.as_str()).collect();
        self.seqs.retain(|key, _| keep.contains(key.as_str()));
        self.window = window;
    }

    /// The lowest `seq` in the window past the "older" note: a device drops
    /// what it has below it, other than that note (seq 0).
    #[must_use]
    pub fn from(&self) -> u64 {
        self.window
            .iter()
            .map(|(_, entry)| entry.seq)
            .find(|seq| *seq > 0)
            .unwrap_or(self.next_seq)
    }

    /// The window, in `seq` order.
    #[must_use]
    pub fn window(&self) -> Vec<&Entry> {
        self.window.iter().map(|(_, entry)| entry).collect()
    }

    /// Whether the keys this numbering knows come in `built` in `seq` order,
    /// and every new one after them: so new entries can be numbered on.
    fn in_order(&self, built: &[Keyed]) -> bool {
        let mut last = 0;
        let mut new_seen = false;
        for entry in built.iter().filter(|entry| entry.key != OLDER_KEY) {
            match self.seqs.get(&entry.key) {
                Some(seq) if new_seen || *seq <= last => return false,
                Some(seq) => last = *seq,
                None => new_seen = true,
            }
        }
        true
    }

    fn number_again(&mut self) {
        self.numbering = self.next_seq;
        self.seqs.clear();
        self.answered.clear();
    }
}

/// One reading device: what it was sent.
#[derive(Debug)]
pub struct EntryReader {
    /// The numbering it knows; `None` before its first batch.
    numbering: Option<u64>,
    /// A hash of each entry it has, by `seq`.
    sent: HashMap<u64, u64>,
}

impl EntryReader {
    /// A device asked with `RequestEntries`. What it says it has (`since`)
    /// isn't trusted: an entry may have changed while it was away, or the
    /// host numbered afresh since, and it couldn't tell. It gets the window,
    /// with a reset.
    #[must_use]
    pub fn new() -> Self {
        Self {
            numbering: None,
            sent: HashMap::new(),
        }
    }

    /// Its queue overflowed: the next batch starts it over.
    pub fn start_over(&mut self) {
        self.numbering = None;
        self.sent.clear();
    }

    /// The messages that bring it up to `book`: none when it is.
    pub fn next(&mut self, book: &EntryBook) -> Vec<ToDevice> {
        let reset = self.numbering != Some(book.numbering);
        if reset {
            self.sent.clear();
            self.numbering = Some(book.numbering);
        }
        // What fell off the window is the device's to drop (`from`).
        let window: HashSet<u64> = book.window.iter().map(|(_, entry)| entry.seq).collect();
        self.sent.retain(|seq, _| window.contains(seq));
        let changed: Vec<Entry> = book
            .window
            .iter()
            .map(|(_, entry)| entry)
            .filter(|entry| self.sent.get(&entry.seq) != Some(&hash(&entry.kind)))
            .cloned()
            .collect();
        if changed.is_empty() && !reset {
            return Vec::new();
        }
        for entry in &changed {
            self.sent.insert(entry.seq, hash(&entry.kind));
        }
        batches(changed, reset, book.from())
    }
}

impl Default for EntryReader {
    fn default() -> Self {
        Self::new()
    }
}

fn hash(kind: &EntryKind) -> u64 {
    let mut hasher = DefaultHasher::new();
    kind.hash(&mut hasher);
    hasher.finish()
}

/// `entries` as `Entries` messages within [`ENTRIES_MESSAGE_MAX`]; only the
/// first carries `reset`.
fn batches(entries: Vec<Entry>, reset: bool, from: u64) -> Vec<ToDevice> {
    let mut out = Vec::new();
    let mut batch = Vec::new();
    let mut size = MESSAGE_ROOM;
    for entry in entries {
        let len = postcard::to_allocvec(&entry).map_or(ENTRIES_MESSAGE_MAX, |bytes| bytes.len());
        if !batch.is_empty() && size + len > ENTRIES_MESSAGE_MAX {
            out.push(ToDevice::Entries {
                entries: std::mem::take(&mut batch),
                reset: reset && out.is_empty(),
                from,
            });
            size = MESSAGE_ROOM;
        }
        size += len;
        batch.push(entry);
    }
    if !batch.is_empty() || out.is_empty() {
        out.push(ToDevice::Entries {
            entries: batch,
            reset: reset && out.is_empty(),
            from,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use kriyon_core::readable::{EntryKind, Keyed};

    fn keyed(key: &str, text: &str) -> Keyed {
        Keyed {
            key: key.into(),
            kind: EntryKind::Note { text: text.into() },
        }
    }

    fn claude(key: &str, text: &str, done: bool) -> Keyed {
        Keyed {
            key: key.into(),
            kind: EntryKind::Claude {
                text: text.into(),
                done,
            },
        }
    }

    fn sent(messages: &[ToDevice]) -> (Vec<(u64, EntryKind)>, bool) {
        let mut out = Vec::new();
        let mut reset = false;
        for message in messages {
            let ToDevice::Entries {
                entries,
                reset: this,
                ..
            } = message
            else {
                panic!("entries: {message:?}");
            };
            reset |= *this;
            out.extend(entries.iter().map(|entry| (entry.seq, entry.kind.clone())));
        }
        (out, reset)
    }

    #[test]
    fn a_reader_gets_the_window_then_only_what_is_new_or_changed() {
        let mut book = EntryBook::default();
        book.update(vec![keyed("a", "A"), claude("b", "Hal", false)]);
        let mut reader = EntryReader::new();
        let (first, reset) = sent(&reader.next(&book));
        assert!(reset);
        assert_eq!(first.len(), 2);
        assert_eq!(reader.next(&book), Vec::new(), "nothing changed");
        book.update(vec![
            keyed("a", "A"),
            claude("b", "Half done.", true),
            keyed("c", "C"),
        ]);
        let (then, reset) = sent(&reader.next(&book));
        assert!(!reset);
        assert_eq!(
            then,
            vec![
                (
                    first[1].0,
                    EntryKind::Claude {
                        text: "Half done.".into(),
                        done: true
                    }
                ),
                (first[1].0 + 1, EntryKind::Note { text: "C".into() }),
            ]
        );
    }

    #[test]
    fn an_answered_question_becomes_a_note_in_its_place() {
        let mut book = EntryBook::default();
        let ask = Keyed {
            key: "ask:t".into(),
            kind: EntryKind::Asking {
                header: "H".into(),
                question: "Q?".into(),
                options: vec![],
            },
        };
        book.update(vec![keyed("a", "A"), ask]);
        let mut reader = EntryReader::new();
        let (first, _) = sent(&reader.next(&book));
        book.update(vec![keyed("a", "A"), keyed("b", "B")]);
        let (then, reset) = sent(&reader.next(&book));
        assert!(!reset);
        assert_eq!(
            then,
            vec![
                (
                    first[1].0,
                    EntryKind::Note {
                        text: ANSWERED.into()
                    }
                ),
                (first[1].0 + 1, EntryKind::Note { text: "B".into() }),
            ]
        );
    }

    #[test]
    fn an_entry_gone_from_the_middle_or_one_out_of_order_starts_readers_over() {
        let mut book = EntryBook::default();
        book.update(vec![keyed("a", "A"), keyed("b", "B"), keyed("c", "C")]);
        let mut reader = EntryReader::new();
        let (first, _) = sent(&reader.next(&book));
        // A rewind: "b" went.
        book.update(vec![keyed("a", "A"), keyed("c", "C")]);
        let (then, reset) = sent(&reader.next(&book));
        assert!(reset);
        assert_eq!(then.len(), 2);
        assert!(then[0].0 > first[2].0, "numbered again, never reused");
        // The older note appears at the start: always seq 0, so no reason
        // to start over.
        book.update(vec![keyed(OLDER_KEY, "Older"), keyed("c", "C")]);
        let (older, reset) = sent(&reader.next(&book));
        assert!(!reset);
        assert_eq!(
            older,
            vec![(
                0,
                EntryKind::Note {
                    text: "Older".into()
                }
            )]
        );
        // Falling off the old end is no reason to start over.
        book.update(vec![
            keyed(OLDER_KEY, "Older"),
            keyed("c", "C"),
            keyed("d", "D"),
        ]);
        reader.next(&book);
        book.update(vec![keyed(OLDER_KEY, "Older"), keyed("d", "D")]);
        assert_eq!(reader.next(&book), Vec::new(), "nothing new, no reset");
    }

    #[test]
    fn a_reader_coming_back_gets_the_whole_window_again() {
        // What it had may have changed while it was away (a reply finished,
        // a question answered), or the host started over: it can't tell.
        let mut book = EntryBook::default();
        book.update(vec![keyed("a", "A"), claude("b", "Hal", false)]);
        let mut reader = EntryReader::new();
        book.update(vec![keyed("a", "A"), claude("b", "Half.", true)]);
        let (got, reset) = sent(&reader.next(&book));
        assert!(reset);
        assert_eq!(got.len(), 2);
    }

    #[test]
    fn each_batch_says_where_the_window_starts_past_the_older_note() {
        let mut book = EntryBook::default();
        book.update(vec![keyed("a", "A"), keyed("b", "B"), keyed("c", "C")]);
        let mut reader = EntryReader::new();
        reader.next(&book);
        book.update(vec![
            keyed(OLDER_KEY, "Older"),
            keyed("c", "C"),
            keyed("d", "D"),
        ]);
        let messages = reader.next(&book);
        let ToDevice::Entries { from, .. } = &messages[0] else {
            panic!("entries");
        };
        assert_eq!(*from, 3, "c's seq: a and b fell off");
    }

    #[test]
    fn an_answered_question_falls_off_like_any_entry_and_can_show_again() {
        let ask = || Keyed {
            key: "ask:t".into(),
            kind: EntryKind::Asking {
                header: String::new(),
                question: "Q?".into(),
                options: vec![],
            },
        };
        let mut book = EntryBook::default();
        book.update(vec![keyed("a", "A"), ask()]);
        book.update(vec![keyed("a", "A")]);
        // Shown again (a dialog flickered): one entry, the question.
        book.update(vec![keyed("a", "A"), ask()]);
        let window = book.window();
        assert_eq!(window.len(), 2, "{window:?}");
        assert!(matches!(window[1].kind, EntryKind::Asking { .. }));
        // Answered, then off the old end behind the older note.
        book.update(vec![keyed("a", "A"), keyed("b", "B")]);
        book.update(vec![
            keyed(OLDER_KEY, "Older"),
            keyed("b", "B"),
            keyed("c", "C"),
        ]);
        let texts: Vec<String> = book
            .window()
            .iter()
            .map(|entry| format!("{:?}", entry.kind))
            .collect();
        assert!(
            !texts.iter().any(|text| text.contains(ANSWERED)),
            "{texts:?}"
        );
    }

    #[test]
    fn a_big_window_goes_in_several_messages_each_within_the_limit() {
        let mut book = EntryBook::default();
        let big = "x".repeat(4000);
        book.update(
            (0..60)
                .map(|n| claude(&format!("k{n}"), &big, true))
                .collect(),
        );
        let mut reader = EntryReader::new();
        let messages = reader.next(&book);
        assert!(messages.len() > 1);
        for message in &messages {
            assert!(crate::codec::encode(message).expect("encodes").len() <= ENTRIES_MESSAGE_MAX);
        }
        let ToDevice::Entries { reset, .. } = &messages[1] else {
            panic!("entries");
        };
        assert!(!reset, "only the first resets");
        assert_eq!(sent(&messages).0.len(), 60);
    }
}
