//! Where Kriyon keeps its files under the user's home — one spelling, shared by
//! the app and the [PTY daemon], so the two can never look in different
//! places. Ids are validated by the caller before they reach a path.

use std::path::{Path, PathBuf};

/// `~/.claude/kriyon`
#[must_use]
pub fn kriyon_dir(home: &Path) -> PathBuf {
    home.join(".claude").join("kriyon")
}

/// `~/.claude/kriyon/events` — the [Hook spool]s.
#[must_use]
pub fn events_dir(home: &Path) -> PathBuf {
    kriyon_dir(home).join("events")
}

/// One session's [Hook spool].
#[must_use]
pub fn events_file(home: &Path, session_id: &str) -> PathBuf {
    events_dir(home).join(format!("{session_id}.jsonl"))
}

/// `~/.claude/kriyon/usage` — the live usage snapshots.
#[must_use]
pub fn usage_dir(home: &Path) -> PathBuf {
    kriyon_dir(home).join("usage")
}

/// One session's live usage snapshot.
#[must_use]
pub fn usage_file(home: &Path, session_id: &str) -> PathBuf {
    usage_dir(home).join(format!("{session_id}.json"))
}

/// `~/.claude/kriyon/limits` — each `claude` session's latest [Limit reading].
#[must_use]
pub fn limits_dir(home: &Path) -> PathBuf {
    kriyon_dir(home).join("limits")
}

/// `~/.claude/kriyon/bridge` — the [Bridge spool]s.
#[must_use]
pub fn bridge_dir(home: &Path) -> PathBuf {
    kriyon_dir(home).join("bridge")
}

/// One session's [Bridge spool].
#[must_use]
pub fn bridge_spool(home: &Path, session_id: &str) -> PathBuf {
    bridge_dir(home).join(format!("{session_id}.jsonl"))
}

/// One session's newest [Partial reply], beside its [Bridge spool].
#[must_use]
pub fn bridge_partial(home: &Path, session_id: &str) -> PathBuf {
    bridge_dir(home).join(format!("{session_id}.partial.json"))
}

/// `~/.claude/kriyon/companion` — every version's [Companion folder].
#[must_use]
pub fn companion_root(home: &Path) -> PathBuf {
    kriyon_dir(home).join("companion")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_path_sits_under_the_kriyon_folder() {
        let home = Path::new("/Users/x");
        assert_eq!(
            events_file(home, "s1"),
            Path::new("/Users/x/.claude/kriyon/events/s1.jsonl")
        );
        assert_eq!(
            usage_file(home, "s1"),
            Path::new("/Users/x/.claude/kriyon/usage/s1.json")
        );
        assert_eq!(
            bridge_spool(home, "s1"),
            Path::new("/Users/x/.claude/kriyon/bridge/s1.jsonl")
        );
        assert_eq!(
            companion_root(home),
            Path::new("/Users/x/.claude/kriyon/companion")
        );
    }
}
