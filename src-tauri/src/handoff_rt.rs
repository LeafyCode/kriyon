//! [Handoff file] runtime: feeds each session's hook events to its
//! [`HandoffFileWatch`], and when a turn ends with a handoff, validates the file
//! on disk and emits `session-handoff` so the frontend can show the
//! [Handoff card]. The detection rules, and where a handoff may live, are in
//! `kriyon_core::handoff`; this module owns the IO — the temp-dir scan and the
//! canonical, size-capped check.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use kriyon_core::handoff::{
    newest_since, start_prompt, temp_roots, HandoffFound, HandoffOrigin, HandoffPlaces,
    HandoffTurn, HANDOFF_FILE_MAX_BYTES,
};
use kriyon_core::hooks::HookEvent;
use kriyon_core::session::SessionId;
use tauri::{Emitter as _, Manager as _};

use crate::AppState;

/// Payload for the `session-handoff` event.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HandoffPayload {
    session_id: String,
    path: String,
    /// The [Handoff prompt] the new session starts with.
    prompt: String,
}

/// Where a [Handoff file] may live on this machine: the temp dirs, and the home
/// folder both as given and in its canonical form. Claude Code writes through
/// the physical path, so with a symlinked home (`/Users/me` → `/Volumes/Data/me`)
/// a `Write` names the canonical form, and the hook-time check must match it.
#[must_use]
pub fn handoff_places(tmpdir: Option<&str>, home: Option<PathBuf>) -> HandoffPlaces {
    let canonical = home
        .as_deref()
        .and_then(|home| std::fs::canonicalize(home).ok());
    HandoffPlaces::new(temp_roots(tmpdir), home.into_iter().chain(canonical))
}

/// `places` with every folder in its canonical form, so a canonical file path
/// can be compared with them (`/var/folders` is `/private/var/folders`).
fn canonical_places(places: &HandoffPlaces) -> HandoffPlaces {
    HandoffPlaces::new(
        places
            .temp()
            .iter()
            .filter_map(|root| std::fs::canonicalize(root).ok())
            .collect(),
        places
            .homes()
            .iter()
            .filter_map(|home| std::fs::canonicalize(home).ok()),
    )
}

/// `path` canonicalized, if it is a real [Handoff file] found by `origin`:
/// where [`HandoffPlaces::allows`] lets it live (in its canonical form too), a
/// regular `.md` file named for a handoff, no larger than
/// [`HANDOFF_FILE_MAX_BYTES`]. Anything else is `None` — a symlink out of the
/// allowed folders resolves outside them and fails here.
#[must_use]
pub fn validate_handoff_file(
    path: &Path,
    places: &HandoffPlaces,
    origin: HandoffOrigin,
) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(path).ok()?;
    if !canonical_places(places).allows(&canonical, origin) {
        return None;
    }
    let meta = std::fs::metadata(&canonical).ok()?;
    (meta.is_file() && meta.len() <= HANDOFF_FILE_MAX_BYTES).then_some(canonical)
}

/// The newest [Handoff file] modified since `since`, looking only at the top
/// level of each of `scan_roots` (a handoff skill writes straight into
/// `$TMPDIR`/`/tmp`) and keeping what `places` lets a found handoff be.
fn find_recent_handoff(
    scan_roots: &[PathBuf],
    places: &HandoffPlaces,
    since: SystemTime,
) -> Option<PathBuf> {
    let candidates = scan_roots
        .iter()
        .filter_map(|root| std::fs::read_dir(root).ok())
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| places.allows(path, HandoffOrigin::Named))
        .filter_map(|path| {
            let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
            Some((path, modified))
        });
    newest_since(candidates, since)
}

/// Turn what a finished turn found into a validated file path. A search scans
/// only the temp dirs named directly — `$TMPDIR`, `/tmp`, `/private/tmp` —
/// never the whole of `/var/folders`, and never the home folder.
#[must_use]
pub fn resolve(found: HandoffFound, places: &HandoffPlaces) -> Option<PathBuf> {
    let origin = found.origin();
    let (path, fresh_since) = match found {
        HandoffFound::Written(path) => (path, None),
        HandoffFound::ShellWritten { path, since } => (path, Some(since)),
        HandoffFound::AskedSince(since) => {
            let scan_roots: Vec<PathBuf> = places
                .temp()
                .iter()
                .filter(|root| !root.ends_with("var/folders"))
                .cloned()
                .collect();
            (find_recent_handoff(&scan_roots, places, since)?, None)
        }
    };
    let valid = validate_handoff_file(&path, places, origin)?;
    // A shell command may only have *read* an old handoff: offer it only if
    // it was written during the turn.
    if let Some(since) = fresh_since {
        let modified = std::fs::metadata(&valid).ok()?.modified().ok()?;
        if modified < since {
            return None;
        }
    }
    Some(valid)
}

/// The [Handoff prompt] for the validated file at `path` (already size-capped).
fn prompt_for(path: &Path, focus: Option<&str>) -> String {
    let content = std::fs::read(path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();
    start_prompt(path, &content, focus)
}

/// Observe one live hook event for `session_id`; on the turn's end with a
/// handoff, emit `session-handoff` with the validated path.
pub fn note_hook_event<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    session_id: &SessionId,
    event: &HookEvent,
) {
    let tmpdir = std::env::var("TMPDIR").ok();
    let places = handoff_places(tmpdir.as_deref(), app.path().home_dir().ok());
    let turn = {
        let state = app.state::<AppState>();
        let mut handoffs = state.handoffs.lock();
        handoffs.entry(session_id.clone()).or_default().observe(
            event,
            &places,
            tmpdir.as_deref(),
            SystemTime::now(),
        )
    };
    let Some(HandoffTurn { found, focus }) = turn else {
        return;
    };
    let Some(path) = resolve(found, &places) else {
        return;
    };
    let _ = app.emit(
        "session-handoff",
        HandoffPayload {
            session_id: session_id.0.clone(),
            prompt: prompt_for(&path, focus.as_deref()),
            path: path.to_string_lossy().into_owned(),
        },
    );
}

/// Drop `id`'s detector when the session closes.
pub fn forget(state: &AppState, id: &SessionId) {
    state.handoffs.lock().remove(id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// `dir` as the only temp dir, with no home folder.
    fn places_for(dir: &Path) -> HandoffPlaces {
        HandoffPlaces::new(vec![dir.to_path_buf()], [])
    }

    #[test]
    fn a_small_handoff_md_in_a_temp_dir_validates_to_its_canonical_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("handoff-1.md");
        std::fs::write(&file, "# Handoff").expect("write");
        let got = validate_handoff_file(&file, &places_for(dir.path()), HandoffOrigin::Written);
        assert_eq!(got, Some(std::fs::canonicalize(&file).expect("canon")));
    }

    #[test]
    fn files_outside_the_roots_too_big_or_not_files_are_rejected() {
        let dir = tempfile::tempdir().expect("tempdir");
        let other = tempfile::tempdir().expect("tempdir");
        let places = places_for(dir.path());

        let outside = other.path().join("handoff.md");
        std::fs::write(&outside, "x").expect("write");
        assert_eq!(
            validate_handoff_file(&outside, &places, HandoffOrigin::Written),
            None
        );

        // A symlink inside the root pointing out of it resolves outside.
        let link = dir.path().join("link-handoff.md");
        std::os::unix::fs::symlink(&outside, &link).expect("symlink");
        assert_eq!(
            validate_handoff_file(&link, &places, HandoffOrigin::Written),
            None
        );

        let big = dir.path().join("big-handoff.md");
        let cap = usize::try_from(HANDOFF_FILE_MAX_BYTES).expect("fits") + 1;
        std::fs::write(&big, vec![b'x'; cap]).expect("write");
        assert_eq!(
            validate_handoff_file(&big, &places, HandoffOrigin::Written),
            None
        );

        let folder = dir.path().join("dir-handoff.md");
        std::fs::create_dir(&folder).expect("mkdir");
        assert_eq!(
            validate_handoff_file(&folder, &places, HandoffOrigin::Written),
            None
        );

        assert_eq!(
            validate_handoff_file(
                &dir.path().join("missing-handoff.md"),
                &places,
                HandoffOrigin::Written
            ),
            None
        );
    }

    #[test]
    fn a_shell_named_handoff_counts_only_if_written_during_the_turn() {
        let dir = tempfile::tempdir().expect("tempdir");
        let places = places_for(dir.path());
        let file = dir.path().join("test-handoff.md");
        std::fs::write(&file, "x").expect("write");
        let before = SystemTime::now() - Duration::from_secs(60);
        let shell = |since| HandoffFound::ShellWritten {
            path: file.clone(),
            since,
        };
        assert_eq!(
            resolve(shell(before), &places),
            Some(std::fs::canonicalize(&file).expect("canon"))
        );
        let later = SystemTime::now() + Duration::from_secs(60);
        assert_eq!(resolve(shell(later), &places), None, "an old file");
    }

    /// A home folder and a separate temp dir, both real.
    fn home_and_temp() -> (tempfile::TempDir, tempfile::TempDir, HandoffPlaces) {
        let home = tempfile::tempdir().expect("home");
        let temp = tempfile::tempdir().expect("temp");
        let places =
            HandoffPlaces::new(vec![temp.path().to_path_buf()], [home.path().to_path_buf()]);
        (home, temp, places)
    }

    #[test]
    fn a_handoff_the_session_wrote_in_home_resolves_to_its_canonical_path() {
        let (home, _temp, places) = home_and_temp();
        let dir = home.path().join("Projects/kriyon-handoffs/phase6");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let file = dir.join("HANDOFF.md");
        std::fs::write(&file, "# Handoff").expect("write");
        assert_eq!(
            resolve(HandoffFound::Written(file.clone()), &places),
            Some(std::fs::canonicalize(&file).expect("canon"))
        );
    }

    #[test]
    fn a_symlinked_home_is_matched_in_its_real_form_too() {
        // Test dirs live under the temp roots, so asking `allows` would pass
        // through the temp rule; check the home forms the rule is given.
        let real = tempfile::tempdir().expect("real home");
        let links = tempfile::tempdir().expect("links");
        let home = links.path().join("me");
        std::os::unix::fs::symlink(real.path(), &home).expect("symlink");
        let places = handoff_places(None, Some(home.clone()));
        let physical = std::fs::canonicalize(real.path()).expect("canon");
        assert_eq!(places.homes(), [home, physical]);
    }

    #[test]
    fn a_home_handoff_in_a_hidden_folder_or_linked_out_of_home_is_rejected() {
        let (home, _temp, places) = home_and_temp();
        let elsewhere = tempfile::tempdir().expect("elsewhere");

        let hidden = home.path().join(".claude");
        std::fs::create_dir_all(&hidden).expect("mkdir");
        let file = hidden.join("handoff.md");
        std::fs::write(&file, "x").expect("write");
        assert_eq!(resolve(HandoffFound::Written(file), &places), None);

        let outside = elsewhere.path().join("handoff.md");
        std::fs::write(&outside, "x").expect("write");
        let link = home.path().join("link-handoff.md");
        std::os::unix::fs::symlink(&outside, &link).expect("symlink");
        assert_eq!(resolve(HandoffFound::Written(link), &places), None);
    }

    #[test]
    fn a_home_handoff_a_shell_command_named_is_not_offered() {
        let (home, _temp, places) = home_and_temp();
        let file = home.path().join("handoff.md");
        std::fs::write(&file, "x").expect("write");
        let since = SystemTime::now() - Duration::from_secs(60);
        assert_eq!(
            resolve(HandoffFound::ShellWritten { path: file, since }, &places),
            None
        );
    }

    #[test]
    fn the_prompt_is_read_from_the_handoff_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("p-handoff.md");
        std::fs::write(&file, "# H\n## Next prompt\nFix the chip, see the file.").expect("write");
        let prompt = prompt_for(&file, Some("ignored"));
        assert!(
            prompt.starts_with("Fix the chip, see the file."),
            "{prompt}"
        );
        assert!(prompt.ends_with(&format!("(Handoff: {})", file.display())));
    }

    #[test]
    fn an_asked_handoff_resolves_to_the_newest_file_since_the_prompt() {
        let dir = tempfile::tempdir().expect("tempdir");
        let places = places_for(dir.path());
        let before = SystemTime::now() - Duration::from_secs(60);
        std::fs::write(dir.path().join("notes.md"), "x").expect("write");
        let file = dir.path().join("handoff-x.md");
        std::fs::write(&file, "x").expect("write");
        let got = resolve(HandoffFound::AskedSince(before), &places);
        assert_eq!(got, Some(std::fs::canonicalize(&file).expect("canon")));

        let later = SystemTime::now() + Duration::from_secs(60);
        assert_eq!(resolve(HandoffFound::AskedSince(later), &places), None);
    }
}
