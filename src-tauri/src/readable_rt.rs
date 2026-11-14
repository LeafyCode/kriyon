//! A session's [Readable view] entries for remote devices, built from what
//! the desktop's [Structured view] shows (spec §6). The folding is
//! `kriyon_core::readable`; this reads the app's state and files for it.

use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::Path;

use kriyon_core::integration::CompanionState;
use kriyon_core::readable::AskShown;
use kriyon_remote::message::EntriesUnavailable;

use kriyon_core::structured::StructuredTurn;
use parking_lot::Mutex;

use kriyon_remote_link::host_runtime::EntriesBuilt;

/// The sessions whose turns are kept between builds: the newest read.
const TURNS_KEPT: usize = 4;

/// The turns of the sessions read lately, by session, with the stamp of the
/// files they came from: a reply streaming changes only the partial file,
/// and need not read the transcript again. Kept in [`crate::AppState`].
#[derive(Debug, Default)]
pub struct TurnsCache(Mutex<Vec<(String, u64, Vec<StructuredTurn>)>>);

impl TurnsCache {
    /// Session `id`'s turns, from the cache while `files_stamp` is the same.
    fn turns(
        &self,
        id: &str,
        files_stamp: u64,
        load: impl FnOnce() -> Vec<StructuredTurn>,
    ) -> Vec<StructuredTurn> {
        {
            let cache = self.0.lock();
            if let Some((_, _, turns)) = cache
                .iter()
                .find(|(session, stamp, _)| session == id && *stamp == files_stamp)
            {
                return turns.clone();
            }
        }
        let turns = load();
        let mut cache = self.0.lock();
        cache.retain(|(session, _, _)| session != id);
        cache.push((id.to_string(), files_stamp, turns.clone()));
        let extra = cache.len().saturating_sub(TURNS_KEPT);
        cache.drain(..extra);
        turns
    }
}

/// What the entries come from, as cheap to look at as can be: the files'
/// sizes and times and the question showing. Equal stamps, nothing to build.
fn stamp(files: &[&Path], asking: Option<&AskShown>) -> u64 {
    let mut hasher = DefaultHasher::new();
    for file in files {
        let meta = std::fs::metadata(file).ok();
        meta.as_ref().map(std::fs::Metadata::len).hash(&mut hasher);
        meta.and_then(|meta| meta.modified().ok()).hash(&mut hasher);
    }
    asking
        .map(|ask| (&ask.header, &ask.question, &ask.options, &ask.asked_at))
        .hash(&mut hasher);
    hasher.finish()
}

/// A build's stamp: the turns' files, the partial reply as it stands (gone
/// once stale) and the question showing.
fn build_stamp(
    turns_stamp: u64,
    partial: Option<&kriyon_core::structured::PartialReply>,
    asking: Option<&AskShown>,
) -> u64 {
    let mut hasher = DefaultHasher::new();
    turns_stamp.hash(&mut hasher);
    partial
        .map(|p| (&p.turn_id, p.step, p.block, &p.text, p.done, p.received_ms))
        .hash(&mut hasher);
    stamp(&[], asking).hash(&mut hasher);
    hasher.finish()
}

/// Session `id`'s entries, unless nothing changed since the build `last`
/// names. Exact or off (ADR 0035): only with the companion on. Blocking.
#[must_use]
pub fn entries(app: &tauri::AppHandle, id: &str, last: Option<u64>) -> EntriesBuilt {
    use tauri::Manager as _;
    if kriyon_core::daemon::check_session_id(id).is_err() {
        return EntriesBuilt::Unavailable(EntriesUnavailable::NoTranscript);
    }
    match crate::integration::session_companion(app, id.to_string()).map(|status| status.state) {
        Ok(CompanionState::On) => {}
        Ok(CompanionState::Starting) => return EntriesBuilt::Waiting,
        _ => return EntriesBuilt::Unavailable(EntriesUnavailable::CompanionOff),
    }
    let Ok(home) = crate::commands::resolve_home(app) else {
        return EntriesBuilt::Unavailable(EntriesUnavailable::NoTranscript);
    };
    let Ok(Some(row)) = app.state::<crate::StoreState>().0.lock().session_row(id) else {
        return EntriesBuilt::Unavailable(EntriesUnavailable::NoTranscript);
    };
    let state = app.state::<crate::AppState>();
    let session = kriyon_core::session::SessionId(id.to_string());
    let ask = state
        .runtimes
        .lock()
        .get(&session)
        .and_then(|runtime| runtime.ask().cloned());
    let showing = state
        .writers
        .facts(&session)
        .is_some_and(|facts| facts.dialog.showing);
    let asking = kriyon_core::readable::asking_now(ask.as_ref(), showing);
    let spool = kriyon_core::paths::bridge_spool(&home, id);
    let transcript = crate::structured_cmd::session_transcript(&home, &row);
    let mut turn_files = vec![spool.as_path()];
    turn_files.extend(transcript.as_deref());
    let turns_stamp = stamp(&turn_files, None);
    // The partial is read every time (a small file): it goes stale with
    // time, which its file's size and time don't show.
    let partial = crate::structured_cmd::load_partial(&home, id, row.claude_session_id.as_deref());
    let now = build_stamp(turns_stamp, partial.as_ref(), asking.as_ref());
    if last == Some(now) {
        return EntriesBuilt::Unchanged;
    }
    let turns = state.readable_turns.turns(id, turns_stamp, || {
        crate::structured_cmd::load_turns(app, &home, id, Some(&row))
    });
    EntriesBuilt::Built {
        stamp: now,
        entries: kriyon_core::readable::entries(&turns, partial.as_ref(), asking.as_ref()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_partial_reply_going_stale_moves_the_stamp() {
        let partial = kriyon_core::structured::PartialReply {
            turn_id: "t".into(),
            step: 0,
            block: 0,
            text: "Half".into(),
            done: false,
            received_ms: 1,
        };
        assert_ne!(
            build_stamp(7, Some(&partial), None),
            build_stamp(7, None, None)
        );
        assert_eq!(build_stamp(7, None, None), build_stamp(7, None, None));
    }

    #[test]
    fn turns_are_read_again_only_when_their_files_changed() {
        let loads = std::cell::Cell::new(0);
        let load = || {
            loads.set(loads.get() + 1);
            Vec::new()
        };
        let cache = TurnsCache::default();
        cache.turns("cache-test", 1, load);
        cache.turns("cache-test", 1, load);
        assert_eq!(loads.get(), 1, "kept");
        cache.turns("cache-test", 2, load);
        assert_eq!(loads.get(), 2, "the files changed");
    }

    #[test]
    fn the_stamp_moves_when_a_file_grows_or_the_question_changes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("spool");
        std::fs::write(&file, b"a").expect("written");
        let before = stamp(&[&file], None);
        assert_eq!(stamp(&[&file], None), before, "nothing changed");
        std::fs::write(&file, b"ab").expect("written");
        let grown = stamp(&[&file], None);
        assert_ne!(grown, before);
        let ask = AskShown {
            header: String::new(),
            question: "Which db?".into(),
            options: vec!["A".into()],
            asked_at: None,
        };
        assert_ne!(stamp(&[&file], Some(&ask)), grown);
        // A file that isn't there yet stamps too.
        assert_eq!(
            stamp(&[&dir.path().join("none")], None),
            stamp(&[&dir.path().join("none")], None)
        );
    }
}
