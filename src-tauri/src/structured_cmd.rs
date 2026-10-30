//! The [Structured view]'s command: the session's turns, built from its
//! [Bridge spool] (live, exact) and its transcript (history from before the
//! companion connected). What the rows mean is `kriyon_core::structured`.

use std::path::{Path, PathBuf};

use kriyon_core::structured::{build_turns, parse_partial, PartialReply, StructuredTurn};

/// How much of each file is read: the newest part is what the view shows.
const TRANSCRIPT_TAIL: u64 = 12 * 1024 * 1024;

/// The most turns returned, newest kept.
const MAX_TURNS: usize = 200;

/// The transcript of Claude conversation `claude_id`: Claude names the file
/// after the conversation, `~/.claude/projects/<folder>/<id>.jsonl`. The
/// session's own folder is tried first; any other project folder (a `claude`
/// started elsewhere, a symlinked path) after.
fn transcript_path(home: &Path, folder: &str, claude_id: &str) -> Option<PathBuf> {
    if !kriyon_core::daemon::is_valid_session_id(claude_id) {
        return None;
    }
    let file = format!("{claude_id}.jsonl");
    let projects = crate::hooks::projects_dir(home);
    let expected = projects
        .join(kriyon_core::history::encode_project_dir(folder))
        .join(&file);
    if expected.is_file() {
        return Some(expected);
    }
    std::fs::read_dir(&projects)
        .ok()?
        .flatten()
        .map(|dir| dir.path().join(&file))
        .find(|path| path.is_file())
}

/// The session's turns for the Structured view, oldest first.
///
/// # Errors
/// On an invalid id, a missing HOME or a store error.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn structured_turns(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<Vec<StructuredTurn>, String> {
    use tauri::Manager as _;
    kriyon_core::daemon::check_session_id(&session_id)?;
    let home = crate::commands::resolve_home(&app)?;
    let row = app
        .state::<crate::StoreState>()
        .0
        .lock()
        .session_row(&session_id)
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::activity_rt::ingest_bridge_now(&app, &home, &session_id);
        let bridge_lines = crate::activity_rt::bridge_rows(&session_id);
        let b: Vec<&str> = bridge_lines.iter().map(String::as_str).collect();
        // The conversation the view is for, as Kriyon recorded it.
        let conversation = row.as_ref().and_then(|r| r.claude_session_id.clone());
        let transcript_lines = conversation
            .as_deref()
            .zip(row.as_ref())
            .and_then(|(id, r)| {
                transcript_path(&home, r.worktree_path.as_deref().unwrap_or(&r.cwd), id)
            })
            .map(|p| crate::status_rt::read_tail_lines(&p, TRANSCRIPT_TAIL))
            .unwrap_or_default();
        let t: Vec<&str> = transcript_lines.iter().map(String::as_str).collect();
        let mut turns = build_turns(&b, &t, conversation.as_deref());
        if turns.len() > MAX_TURNS {
            turns.drain(..turns.len() - MAX_TURNS);
        }
        // The images Claude Code recorded become previewable attachments;
        // one that is gone, or isn't an image any more, is left out.
        let registry = app.state::<crate::attachment_cmd::AttachmentRegistry>();
        for turn in &mut turns {
            turn.images = turn
                .images
                .iter()
                .filter_map(|path| registry.admit_recorded(path).ok())
                .filter(|a| a.kind == kriyon_core::attachment::AttachmentKind::Image)
                .map(|a| a.path)
                .collect();
        }
        turns
    })
    .await
    .map_err(|e| e.to_string())
}

/// A [Partial reply] older than this is a stream that never finished (the
/// session died mid-reply): not shown.
const PARTIAL_FRESH_MS: i64 = 10 * 60 * 1000;

/// The session's reply as it streams, or `None` when nothing is streaming.
///
/// # Errors
/// On an invalid id, a missing HOME or a store error.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn structured_partial(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<Option<PartialReply>, String> {
    use tauri::Manager as _;
    kriyon_core::daemon::check_session_id(&session_id)?;
    let home = crate::commands::resolve_home(&app)?;
    let conversation = app
        .state::<crate::StoreState>()
        .0
        .lock()
        .session_row(&session_id)
        .map_err(|e| e.to_string())?
        .and_then(|r| r.claude_session_id);
    let path = kriyon_core::paths::bridge_partial(&home, &session_id);
    let Ok(line) = std::fs::read_to_string(path) else {
        return Ok(None);
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
    Ok(parse_partial(&line, conversation.as_deref())
        .filter(|p| now - p.received_ms < PARTIAL_FRESH_MS))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_transcript_is_found_by_conversation_id_in_any_project_folder() {
        let home = tempfile::tempdir().expect("tempdir");
        let projects = crate::hooks::projects_dir(home.path());
        let own = projects.join("-w-app");
        let other = projects.join("-elsewhere");
        std::fs::create_dir_all(&own).expect("dir");
        std::fs::create_dir_all(&other).expect("dir");
        std::fs::write(own.join("abc-1.jsonl"), "").expect("write");
        std::fs::write(other.join("def-2.jsonl"), "").expect("write");

        assert_eq!(
            transcript_path(home.path(), "/w/app", "abc-1"),
            Some(own.join("abc-1.jsonl"))
        );
        assert_eq!(
            transcript_path(home.path(), "/w/app", "def-2"),
            Some(other.join("def-2.jsonl")),
            "started from another folder"
        );
        assert_eq!(transcript_path(home.path(), "/w/app", "none"), None);
        assert_eq!(
            transcript_path(home.path(), "/w/app", "../x"),
            None,
            "validated"
        );
    }
}
