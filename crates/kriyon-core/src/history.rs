//! Discovery of a folder's past Claude Code sessions from `~/.claude/projects`.
//!
//! Pure, Tauri-free logic: encode a folder path to its Claude history
//! directory name, summarize a transcript's lines, and scan a directory into a
//! page of past sessions. The `src-tauri` shell only resolves `$HOME` and calls
//! these functions. Like the transcript parser, summarizing is tolerant: an
//! unparseable or unknown line is skipped, never an error.

use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::transcript::{parse_title, prompt_label_of};

/// Encode an absolute working directory to the name Claude Code uses for its
/// per-project transcript directory under `~/.claude/projects`.
///
/// Claude replaces every character that is not ASCII alphanumeric with `-`.
/// The mapping is deterministic forward (cwd → dir name) but lossy in reverse,
/// so callers must never try to reverse it; read the true `cwd` from inside a
/// transcript instead. The mapping also neutralizes path traversal: `/` and `.`
/// both become `-`, so no encoded name can contain `..` or escape the projects
/// directory.
#[must_use]
pub fn encode_project_dir(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// The fields a past session carries *in its transcript content* — everything
/// not derivable from the filesystem. The id, last-active time, and total are
/// supplied by the directory scan (see [`PastSession`]).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PastSessionSummary {
    /// The last `ai-title` seen (Claude updates it through the session).
    pub title: Option<String>,
    /// First line of the first `user` message — a title fallback / preview.
    pub preview: Option<String>,
    /// The true working directory, read from the transcript (never decoded
    /// from the directory name).
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub version: Option<String>,
    /// Count of conversation lines (`user`/`assistant`) — a rough size signal.
    pub message_count: u32,
}

/// Fold a transcript's lines into a [`PastSessionSummary`]. Tolerant: a line
/// that does not parse as JSON, or that carries no recognized field, is
/// skipped. The last `ai-title` wins; the first `user` line becomes the
/// preview; `cwd`/`gitBranch`/`version` take their first seen value.
#[must_use]
pub fn parse_session_summary<'a>(lines: impl Iterator<Item = &'a str>) -> PastSessionSummary {
    let mut summary = PastSessionSummary::default();
    for line in lines {
        if let Some(title) = parse_title(line) {
            summary.title = Some(title);
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if summary.cwd.is_none() {
            if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
                summary.cwd = Some(cwd.to_string());
            }
        }
        if summary.git_branch.is_none() {
            if let Some(branch) = value.get("gitBranch").and_then(Value::as_str) {
                summary.git_branch = Some(branch.to_string());
            }
        }
        if summary.version.is_none() {
            if let Some(version) = value.get("version").and_then(Value::as_str) {
                summary.version = Some(version.to_string());
            }
        }
        match value.get("type").and_then(Value::as_str) {
            Some("user") => {
                summary.message_count += 1;
                if summary.preview.is_none() {
                    summary.preview = prompt_label_of(&value);
                }
            }
            Some("assistant") => summary.message_count += 1,
            _ => {}
        }
    }
    summary
}

/// One discovered [Past session]: filesystem-derived identity plus the
/// transcript-derived [`PastSessionSummary`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PastSession {
    /// Claude Code's own session id — the transcript file's name stem, and the
    /// argument to `claude --resume`.
    pub claude_session_id: String,
    /// File mtime in epoch milliseconds — when the session was last active.
    pub last_active_ms: i64,
    #[serde(flatten)]
    pub summary: PastSessionSummary,
}

/// A page of past sessions plus the total available, so the UI can offer
/// "Show more".
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PastSessionPage {
    pub items: Vec<PastSession>,
    pub total: usize,
}

/// One transcript's cached summary, valid while the file identity
/// (mtime + byte length) that produced it is unchanged.
#[derive(Clone, Debug)]
pub struct CachedSummary {
    len: u64,
    mtime: std::time::SystemTime,
    summary: PastSessionSummary,
}

/// Path-keyed summaries reused across scans. Parsing is the expensive part
/// (whole-file JSON per transcript); the identity check is one `stat` that the
/// scan already performs, so a revalidation over an unchanged directory
/// re-parses nothing.
pub type SummaryCache = std::collections::HashMap<std::path::PathBuf, CachedSummary>;

/// Scan a Claude project directory for past-session transcripts: list `*.jsonl`
/// files, sort by mtime descending, take `limit`, and summarize each. `total`
/// is the count of all `*.jsonl` files in the directory.
///
/// A missing directory yields an empty page (the folder was never used with
/// `claude`), not an error.
///
/// # Errors
/// Returns the underlying [`std::io::Error`] only for a directory that exists
/// but cannot be read.
pub fn list_past_sessions_in_dir(dir: &Path, limit: usize) -> std::io::Result<PastSessionPage> {
    list_past_sessions_in_dir_cached(dir, limit, &mut SummaryCache::new())
}

/// [`list_past_sessions_in_dir`] with a caller-owned [`SummaryCache`]: only
/// transcripts whose (mtime, length) identity changed since the cached entry
/// are re-read and re-parsed. Entries under `dir` whose files no longer exist
/// are pruned; entries for other directories are untouched (the cache is
/// shared across projects).
///
/// # Errors
/// Returns the underlying [`std::io::Error`] only for a directory that exists
/// but cannot be read.
pub fn list_past_sessions_in_dir_cached(
    dir: &Path,
    limit: usize,
    cache: &mut SummaryCache,
) -> std::io::Result<PastSessionPage> {
    let read_dir = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PastSessionPage {
                items: Vec::new(),
                total: 0,
            });
        }
        Err(e) => return Err(e),
    };

    // (mtime, len, path, stem) for every .jsonl file.
    let mut files: Vec<(std::time::SystemTime, u64, std::path::PathBuf, String)> = Vec::new();
    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(stem) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        let (mtime, len) = entry.metadata().map_or((UNIX_EPOCH, 0), |m| {
            (m.modified().unwrap_or(UNIX_EPOCH), m.len())
        });
        files.push((mtime, len, path, stem));
    }

    // Prune summaries for files this directory no longer contains, so deleted
    // transcripts don't accumulate in a long-lived cache.
    let live: std::collections::HashSet<&std::path::PathBuf> =
        files.iter().map(|(_, _, path, _)| path).collect();
    cache.retain(|path, _| !path.starts_with(dir) || live.contains(path));

    let total = files.len();
    // Newest first.
    files.sort_by_key(|b| std::cmp::Reverse(b.0));
    files.truncate(limit);

    let items = files
        .into_iter()
        .map(|(mtime, len, path, stem)| {
            let summary = match cache.get(&path) {
                Some(cached) if cached.mtime == mtime && cached.len == len => {
                    cached.summary.clone()
                }
                _ => {
                    let contents = std::fs::read_to_string(&path).unwrap_or_default();
                    let parsed = parse_session_summary(contents.lines());
                    cache.insert(
                        path,
                        CachedSummary {
                            len,
                            mtime,
                            summary: parsed.clone(),
                        },
                    );
                    parsed
                }
            };
            PastSession {
                claude_session_id: stem,
                last_active_ms: system_time_to_millis(mtime),
                summary,
            }
        })
        .collect();

    Ok(PastSessionPage { items, total })
}

/// Convert a [`SystemTime`] to epoch milliseconds, clamping pre-epoch times to 0.
fn system_time_to_millis(time: std::time::SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_paths_like_claude_code() {
        let cases = [
            ("/Users/dev/Projects/kriyon", "-Users-dev-Projects-kriyon"),
            (
                "/Users/dev/Projects/acme-web",
                "-Users-dev-Projects-acme-web",
            ),
            (
                "/Users/dev/Projects/Acme/app-1/Acme_iOS",
                "-Users-dev-Projects-Acme-app-1-Acme-iOS",
            ),
            (
                "/Users/dev/Projects/BisBig/bisbig/.claude/worktrees/condescending-cohen-7f05c8",
                "-Users-dev-Projects-BisBig-bisbig--claude-worktrees-condescending-cohen-7f05c8",
            ),
            (
                "/private/var/folders/__/xx0000000000000000000000000gn/T",
                "-private-var-folders----xx0000000000000000000000000gn-T",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(encode_project_dir(input), expected, "input: {input}");
        }
    }

    #[test]
    fn encoding_cannot_traverse_outward() {
        // Dots become dashes, so a `..`-bearing cwd can never produce `..`.
        assert!(!encode_project_dir("/a/../b").contains(".."));
    }

    #[test]
    fn summarizes_a_transcript() {
        let lines = [
            r#"{"type":"user","cwd":"/work/repo","gitBranch":"main","version":"2.1.181","message":{"role":"user","content":"first prompt\nsecond line"}}"#,
            r#"{"type":"ai-title","aiTitle":"An early title","sessionId":"x"}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}"#,
            r#"{"type":"ai-title","aiTitle":"The latest title","sessionId":"x"}"#,
            "not json at all",
            r#"{"type":"user","message":{"role":"user","content":"a later prompt"}}"#,
        ];
        let s = parse_session_summary(lines.into_iter());
        assert_eq!(
            s.title.as_deref(),
            Some("The latest title"),
            "last ai-title wins"
        );
        assert_eq!(
            s.preview.as_deref(),
            Some("first prompt"),
            "first user line only"
        );
        assert_eq!(s.cwd.as_deref(), Some("/work/repo"));
        assert_eq!(s.git_branch.as_deref(), Some("main"));
        assert_eq!(s.version.as_deref(), Some("2.1.181"));
        assert_eq!(
            s.message_count, 3,
            "user + assistant + user; meta/junk excluded"
        );
    }

    #[test]
    fn preview_reads_a_slash_command_the_way_it_was_typed() {
        // Claude wraps a slash command in `<command-*>` tags, so the raw first
        // line is markup, not something a human can read in the History list.
        let lines = [
            r#"{"type":"user","message":{"role":"user","content":"<command-message>pr-review</command-message>\n<command-name>/pr-review</command-name>\n<command-args>115</command-args>"}}"#,
        ];
        let s = parse_session_summary(lines.into_iter());
        assert_eq!(s.preview.as_deref(), Some("/pr-review 115"));
    }

    #[test]
    fn summary_tolerates_empty_and_missing_fields() {
        let s = parse_session_summary(std::iter::empty());
        assert_eq!(s.title, None);
        assert_eq!(s.preview, None);
        assert_eq!(s.cwd, None);
        assert_eq!(s.message_count, 0);
    }

    use std::fs;

    fn write_transcript(dir: &std::path::Path, name: &str, body: &str) {
        fs::write(dir.join(name), body).expect("write transcript");
    }

    #[test]
    fn lists_past_sessions_newest_first_respecting_limit() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Three transcripts plus a non-jsonl file that must be ignored.
        write_transcript(
            dir.path(),
            "aaaa.jsonl",
            "{\"type\":\"user\",\"cwd\":\"/w\",\"message\":{\"content\":\"oldest\"}}\n",
        );
        write_transcript(
            dir.path(),
            "bbbb.jsonl",
            "{\"type\":\"user\",\"cwd\":\"/w\",\"message\":{\"content\":\"middle\"}}\n{\"type\":\"ai-title\",\"aiTitle\":\"Middle\"}\n",
        );
        write_transcript(
            dir.path(),
            "cccc.jsonl",
            "{\"type\":\"user\",\"cwd\":\"/w\",\"message\":{\"content\":\"newest\"}}\n",
        );
        write_transcript(dir.path(), "notes.txt", "ignore me");

        // Force a strict mtime ordering: aaaa < bbbb < cccc.
        let base = std::time::SystemTime::now();
        set_mtime(
            dir.path(),
            "aaaa.jsonl",
            base - std::time::Duration::from_secs(30),
        );
        set_mtime(
            dir.path(),
            "bbbb.jsonl",
            base - std::time::Duration::from_secs(20),
        );
        set_mtime(
            dir.path(),
            "cccc.jsonl",
            base - std::time::Duration::from_secs(10),
        );

        let page = list_past_sessions_in_dir(dir.path(), 2).expect("scan");
        assert_eq!(
            page.total, 3,
            "total counts all .jsonl files, ignoring notes.txt"
        );
        assert_eq!(page.items.len(), 2, "limit honored");
        assert_eq!(page.items[0].claude_session_id, "cccc", "newest first");
        assert_eq!(page.items[0].summary.preview.as_deref(), Some("newest"));
        assert_eq!(page.items[1].claude_session_id, "bbbb");
        assert_eq!(page.items[1].summary.title.as_deref(), Some("Middle"));
    }

    #[test]
    fn cached_scan_reuses_unchanged_files_and_reparses_changed_ones() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_transcript(
            dir.path(),
            "aaaa.jsonl",
            "{\"type\":\"user\",\"cwd\":\"/w\",\"message\":{\"content\":\"alpha\"}}\n",
        );
        write_transcript(
            dir.path(),
            "bbbb.jsonl",
            "{\"type\":\"user\",\"cwd\":\"/w\",\"message\":{\"content\":\"beta\"}}\n",
        );

        let mut cache = SummaryCache::new();
        let first =
            list_past_sessions_in_dir_cached(dir.path(), 10, &mut cache).expect("first scan");
        assert_eq!(first.total, 2);
        assert_eq!(cache.len(), 2, "both parsed summaries are cached");

        // A rescan with no file changes serves from the cache and matches.
        let second =
            list_past_sessions_in_dir_cached(dir.path(), 10, &mut cache).expect("second scan");
        assert_eq!(second, first);

        // A rewritten transcript (new identity: content + mtime) re-parses.
        write_transcript(
            dir.path(),
            "bbbb.jsonl",
            "{\"type\":\"user\",\"cwd\":\"/w\",\"message\":{\"content\":\"beta, revised now\"}}\n",
        );
        set_mtime(
            dir.path(),
            "bbbb.jsonl",
            std::time::SystemTime::now() + std::time::Duration::from_secs(5),
        );
        let third =
            list_past_sessions_in_dir_cached(dir.path(), 10, &mut cache).expect("third scan");
        let revised = third
            .items
            .iter()
            .find(|i| i.claude_session_id == "bbbb")
            .expect("bbbb present");
        assert_eq!(
            revised.summary.preview.as_deref(),
            Some("beta, revised now")
        );

        // A deleted transcript's entry is pruned from the cache.
        fs::remove_file(dir.path().join("aaaa.jsonl")).expect("remove");
        let fourth =
            list_past_sessions_in_dir_cached(dir.path(), 10, &mut cache).expect("fourth scan");
        assert_eq!(fourth.total, 1);
        assert_eq!(cache.len(), 1, "stale cache entry pruned");
    }

    #[test]
    fn cache_prune_is_scoped_to_the_scanned_directory() {
        let dir_a = tempfile::tempdir().expect("tempdir a");
        let dir_b = tempfile::tempdir().expect("tempdir b");
        write_transcript(
            dir_a.path(),
            "aaaa.jsonl",
            "{\"type\":\"user\",\"cwd\":\"/w\",\"message\":{\"content\":\"a\"}}\n",
        );
        write_transcript(
            dir_b.path(),
            "bbbb.jsonl",
            "{\"type\":\"user\",\"cwd\":\"/w\",\"message\":{\"content\":\"b\"}}\n",
        );

        // One shared cache across projects: scanning A must not evict B.
        let mut cache = SummaryCache::new();
        list_past_sessions_in_dir_cached(dir_a.path(), 10, &mut cache).expect("scan a");
        list_past_sessions_in_dir_cached(dir_b.path(), 10, &mut cache).expect("scan b");
        assert_eq!(cache.len(), 2);
        list_past_sessions_in_dir_cached(dir_a.path(), 10, &mut cache).expect("rescan a");
        assert_eq!(cache.len(), 2, "b's entry survives a's rescan");
    }

    #[test]
    fn missing_dir_is_an_empty_page_not_an_error() {
        let page = list_past_sessions_in_dir(std::path::Path::new("/no/such/dir"), 10)
            .expect("missing dir must not error");
        assert_eq!(page.total, 0);
        assert_eq!(page.items, [] as [crate::history::PastSession; 0]);
    }

    /// Set a file's mtime via the `filetime`-free `fs::File::set_modified` API.
    fn set_mtime(dir: &std::path::Path, name: &str, when: std::time::SystemTime) {
        let file = fs::File::options()
            .write(true)
            .open(dir.join(name))
            .expect("open for mtime");
        file.set_modified(when).expect("set mtime");
    }
}
