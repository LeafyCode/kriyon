//! [CLI dialog] detection in Rust, and its [Dialog generation] (ADR-0040).
//!
//! The same rule as the desktop's `src/structured/cliDialog.ts`
//! (`dialogOnScreen`); both are held to `scripts/dialog-screens.json`. The
//! [PTY daemon] runs it on its own screen, so the host knows about a dialog
//! without the window.

use crate::ask::{AskKind, PendingAsk};

use std::sync::LazyLock;

use regex::Regex;

/// The hint's Esc, at its start or after a `·`. The working line's own
/// "esc to interrupt" is lower case.
static ESC_HINT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|·\s*)Esc to [a-z]").expect("valid regex"));

/// How many of the last non-blank rows the hint may be in (it wraps).
pub const HINT_ROWS: usize = 2;

/// The glyph a slash command's pane draws its top rule with.
pub const RULE_GLYPH: char = '▔';

/// How many rule glyphs must open the row for it to be a pane's rule.
const RULE_START: usize = 8;

/// A slash command's pane opens with a rule of `▔` drawn from the terminal's
/// first column; the input box's rules are `─`, and Claude's replies and tool
/// output are indented under `⏺` and `⎿`, so a rule quoted there never starts
/// the row. Most of the row is the rule: the CLI may draw a short label over
/// its right end ("◐ medium · /effort").
fn is_pane_rule(row: &str) -> bool {
    if !row
        .chars()
        .take(RULE_START)
        .eq(std::iter::repeat_n(RULE_GLYPH, RULE_START))
    {
        return false;
    }
    let glyphs = row.chars().filter(|c| *c == RULE_GLYPH).count();
    glyphs * 2 >= row.trim_end().chars().count()
}

/// Whether `rows` (a screen, top to bottom) show a [CLI dialog]: they end in
/// its key hint ("… · Esc to cancel"), or hold a pane's top rule.
///
/// Only two kinds of row can decide it: rows that start with [`RULE_GLYPH`],
/// and the last [`HINT_ROWS`] non-blank rows. A caller with a large screen may
/// pass just those, in screen order, and get the same answer.
#[must_use]
pub fn dialog_on_screen<S: AsRef<str>>(rows: &[S]) -> bool {
    let hint = rows
        .iter()
        .map(|row| row.as_ref().trim())
        .filter(|row| !row.is_empty())
        .rev()
        .take(HINT_ROWS)
        .any(|row| ESC_HINT.is_match(row));
    hint || rows.iter().any(|row| is_pane_rule(row.as_ref()))
}

/// Whether a [CLI dialog] is showing: on the screen, or known from a
/// question's or plan's open [Pending ask] (a plan's screen has no hint). A
/// permission's ask isn't used: it stays open while the approved tool runs,
/// long after the prompt is gone, so only its screen says whether it shows.
#[must_use]
pub fn dialog_showing(on_screen: bool, ask: Option<&PendingAsk>) -> bool {
    on_screen || ask.is_some_and(|ask| ask.kind != AskKind::Permission)
}

/// How long a stream of full reads may go between looks at the screen.
pub const LOOK_EVERY: std::time::Duration = std::time::Duration::from_millis(50);

/// Whether the screen is due a look for a [CLI dialog], the last look having
/// been `since_last` ago (`None`: never). At most one look per [`LOOK_EVERY`],
/// whatever the size of the reads; the caller looks again once output stops,
/// so a dialog drawn between looks is still seen, at most that late.
#[must_use]
pub fn look_due(since_last: Option<std::time::Duration>) -> bool {
    since_last.is_none_or(|since| since >= LOOK_EVERY)
}

/// What a [`DialogWatch`] says after a look at the screen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DialogState {
    /// A dialog shows now.
    pub open: bool,
    /// The [Dialog generation]: moves each time a dialog appears, closes, or
    /// changes while it shows.
    pub generation: u64,
}

/// Follows one screen's [CLI dialog] across looks, moving the
/// [Dialog generation] when it appears, closes, or changes while showing.
#[derive(Debug)]
pub struct DialogWatch {
    state: DialogState,
    fingerprint: u64,
}

impl DialogWatch {
    /// A watch whose generations start at `base`.
    #[must_use]
    pub fn new(base: u64) -> Self {
        Self {
            state: DialogState {
                open: false,
                generation: base,
            },
            fingerprint: 0,
        }
    }

    /// The state after the last look.
    #[must_use]
    pub fn state(&self) -> DialogState {
        self.state
    }

    /// Record one look: whether a dialog shows, and a fingerprint of the
    /// screen while it does (ignored when it doesn't). `Some` when the
    /// generation moved.
    pub fn observe(&mut self, open: bool, fingerprint: u64) -> Option<DialogState> {
        let fingerprint = if open { fingerprint } else { 0 };
        if open == self.state.open && fingerprint == self.fingerprint {
            return None;
        }
        self.fingerprint = fingerprint;
        self.state = DialogState {
            open,
            generation: self.state.generation.wrapping_add(1),
        };
        Some(self.state)
    }
}

/// How many rows, ending at its key hint, a dialog's fingerprint covers when
/// no pane rule marks where it starts.
pub const DIALOG_ROWS: u16 = 15;

/// A terminal screen, as [`dialog_look`] reads it: the daemon's emulator
/// implements it.
pub trait ScreenRows {
    /// Rows, then columns.
    fn size(&self) -> (u16, u16);
    /// Whether `row`'s first cell is `glyph`.
    fn starts_with(&self, row: u16, glyph: char) -> bool;
    /// Whether `row` has a cell that isn't blank.
    fn filled(&self, row: u16) -> bool;
    /// `row`'s text, as the desktop's terminal reads it.
    fn text(&self, row: u16) -> String;
    /// `count` rows from `first`, with their colours and attributes, as the
    /// terminal would draw them.
    fn formatted(&self, first: u16, count: u16) -> Vec<Vec<u8>>;
}

/// Whether `screen` shows a [CLI dialog], and a fingerprint of it while it
/// does.
///
/// It reads only the rows that can decide (see [`dialog_on_screen`]): those
/// that start with the pane rule's glyph, and the last few non-blank rows, as
/// the daemon runs it with its client lock held. While a dialog shows, the
/// fingerprint covers only the dialog (from its pane rule, or the
/// [`DIALOG_ROWS`] rows ending at its hint), colours included, so a timer
/// above it doesn't count as a change and a selection shown only by colour
/// does.
pub fn dialog_look(screen: &impl ScreenRows) -> (bool, u64) {
    let (rows, _) = screen.size();
    let rule_rows: Vec<u16> = (0..rows)
        .filter(|row| screen.starts_with(*row, RULE_GLYPH))
        .collect();
    let mut bottom: Vec<u16> = (0..rows)
        .rev()
        .filter(|row| screen.filled(*row))
        .take(HINT_ROWS)
        .collect();
    bottom.reverse();
    let deciding: Vec<String> = rule_rows
        .iter()
        .chain(&bottom)
        .map(|row| screen.text(*row))
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
    for row in screen.formatted(first, last.max(first) - first + 1) {
        std::hash::Hash::hash(&row, &mut hasher);
    }
    (true, std::hash::Hasher::finish(&hasher))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A screen as plain rows, its "colours" a per-row mark.
    struct Plain(Vec<String>, Vec<u8>);

    impl ScreenRows for Plain {
        fn size(&self) -> (u16, u16) {
            (u16::try_from(self.0.len()).expect("small"), 80)
        }
        fn starts_with(&self, row: u16, glyph: char) -> bool {
            self.0[usize::from(row)].starts_with(glyph)
        }
        fn filled(&self, row: u16) -> bool {
            !self.0[usize::from(row)].trim().is_empty()
        }
        fn text(&self, row: u16) -> String {
            self.0[usize::from(row)].clone()
        }
        fn formatted(&self, first: u16, count: u16) -> Vec<Vec<u8>> {
            (first..first + count)
                .map(|row| {
                    let mut bytes = self.0[usize::from(row)].clone().into_bytes();
                    bytes.push(self.1[usize::from(row)]);
                    bytes
                })
                .collect()
        }
    }

    fn plain(rows: &[&str]) -> Plain {
        Plain(
            rows.iter().map(|row| (*row).to_string()).collect(),
            vec![0; rows.len()],
        )
    }

    #[test]
    fn a_dialog_is_seen_and_fingerprinted_without_what_is_above_it() {
        let mut rows = vec!["\u{273b} Working 1s"];
        rows.extend(std::iter::repeat_n("", 20));
        rows.extend([
            "Pick one",
            "> Yes",
            "  No",
            "Enter to confirm · Esc to cancel",
        ]);
        let (open, first) = dialog_look(&plain(&rows));
        assert!(open);
        rows[0] = "\u{273b} Working 2s";
        assert_eq!(
            dialog_look(&plain(&rows)).1,
            first,
            "a timer above doesn't count"
        );
        let mut coloured = plain(&rows);
        coloured.1[22] = 1;
        assert_ne!(
            dialog_look(&coloured).1,
            first,
            "a selection shown by colour does"
        );
        assert_eq!(dialog_look(&plain(&["$ ls", "file"])), (false, 0));
    }

    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        dialog: bool,
        rows: Vec<String>,
    }

    fn cases() -> Vec<Case> {
        serde_json::from_str(include_str!("../scripts/dialog-screens.json")).expect("cases")
    }

    #[test]
    fn every_shared_screen_reads_as_the_desktop_reads_it() {
        let cases = cases();
        assert!(cases.len() > 10, "the shared cases are there");
        for case in cases {
            assert_eq!(dialog_on_screen(&case.rows), case.dialog, "{}", case.name);
        }
    }

    fn ask(kind: AskKind) -> PendingAsk {
        PendingAsk {
            kind,
            text: "?".into(),
            asked_at: None,
            question: None,
        }
    }

    #[test]
    fn a_question_or_plan_ask_is_a_dialog_but_a_permission_ask_is_not() {
        // A permission's ask stays open while the approved tool runs, long
        // after its prompt is gone; only its screen says it still shows.
        assert!(dialog_showing(false, Some(&ask(AskKind::Question))));
        assert!(dialog_showing(false, Some(&ask(AskKind::PlanApproval))));
        assert!(!dialog_showing(false, Some(&ask(AskKind::Permission))));
        assert!(dialog_showing(true, Some(&ask(AskKind::Permission))));
        assert!(!dialog_showing(false, None));
    }

    #[test]
    fn the_generation_moves_when_a_dialog_appears_changes_and_closes() {
        let mut watch = DialogWatch::new(100);
        assert_eq!(watch.observe(false, 0), None, "no dialog, nothing moves");
        assert_eq!(
            watch.observe(true, 7),
            Some(DialogState {
                open: true,
                generation: 101
            })
        );
        assert_eq!(watch.observe(true, 7), None, "same dialog, same screen");
        assert_eq!(
            watch.observe(true, 8),
            Some(DialogState {
                open: true,
                generation: 102
            }),
            "another option selected"
        );
        assert_eq!(
            watch.observe(false, 0),
            Some(DialogState {
                open: false,
                generation: 103
            })
        );
        assert_eq!(
            watch.observe(false, 9),
            None,
            "a closed screen's fingerprint is ignored"
        );
        assert_eq!(
            watch.state(),
            DialogState {
                open: false,
                generation: 103
            }
        );
    }

    #[test]
    fn the_screen_is_looked_at_once_per_interval() {
        assert!(look_due(None), "the first read is looked at");
        assert!(!look_due(Some(LOOK_EVERY / 2)));
        assert!(look_due(Some(LOOK_EVERY)));
    }
}
