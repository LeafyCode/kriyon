//! Read every macOS [Managed source] from disk and resolve the [Managed
//! policy] with [`kriyon_core::policy`]. The one reader behind both the
//! hooks-off check and the side-loading answer (ADR-0031).
//!
//! Never fails: a source that is missing (or that the OS won't let this user
//! read, which Claude Code also skips) is absent; one that exists but can't be
//! read or parsed is unreadable, which makes the policy unknown.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use kriyon_core::policy::{
    merge_file_documents, resolve, ManagedSource, ManagedSources, PolicyRead, SideloadPolicy,
};
use serde_json::Value;

/// Where Claude Code looks for each managed source. Injectable so tests use
/// temp files; [`ManagedLocations::for_home`] gives the real macOS paths.
#[derive(Debug, Clone)]
pub struct ManagedLocations {
    /// Holds `managed-settings.json` and `managed-settings.d/`.
    pub system_dir: PathBuf,
    /// The MDM profile plists, highest first; the first one present is used.
    pub mdm_plists: Vec<PathBuf>,
    /// The server-managed cache.
    pub remote: PathBuf,
}

/// The MDM managed-preferences domain.
const MDM_DOMAIN: &str = "com.anthropic.claudecode";

impl ManagedLocations {
    /// The macOS locations Claude Code reads (code.claude.com/docs/en/managed-settings):
    /// the per-user managed-preferences plist before the device-level one.
    #[must_use]
    pub fn for_home(home: &Path) -> Self {
        let preferences = Path::new("/Library/Managed Preferences");
        let plist = format!("{MDM_DOMAIN}.plist");
        // Claude Code names the per-user folder by the login name.
        let user = std::env::var("USER")
            .ok()
            .filter(|name| !name.is_empty() && !name.contains('/'));
        Self {
            system_dir: PathBuf::from("/Library/Application Support/ClaudeCode"),
            mdm_plists: user
                .map(|name| preferences.join(name).join(&plist))
                .into_iter()
                .chain([preferences.join(&plist)])
                .collect(),
            remote: home.join(".claude").join("remote-settings.json"),
        }
    }
}

/// Read and resolve the managed policy at `locations`.
#[must_use]
pub fn managed_policy(locations: &ManagedLocations) -> PolicyRead {
    resolve(&ManagedSources {
        remote: read_source(&locations.remote, parse_json),
        mdm: read_mdm(&locations.mdm_plists),
        file: read_file_source(&locations.system_dir),
    })
}

/// Read one source file and parse it with `parse`, which must yield a JSON
/// object. Missing or OS-denied is absent; anything else that fails is
/// unreadable.
fn read_source(path: &Path, parse: fn(&[u8]) -> Option<Value>) -> ManagedSource {
    match std::fs::read(path) {
        Ok(bytes) => match parse(&bytes) {
            Some(value) if value.is_object() => ManagedSource::Present(value),
            _ => ManagedSource::Unreadable,
        },
        Err(e) if skipped(e.kind()) => ManagedSource::Absent,
        Err(_) => ManagedSource::Unreadable,
    }
}

/// Errors Claude Code treats as "no such source": missing, or the OS denied
/// this user the read (Kriyon runs as the same user as `claude`).
fn skipped(kind: ErrorKind) -> bool {
    matches!(
        kind,
        ErrorKind::NotFound | ErrorKind::NotADirectory | ErrorKind::PermissionDenied
    )
}

/// JSON, with an empty file counting as `{}`, as Claude Code reads it.
fn parse_json(bytes: &[u8]) -> Option<Value> {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Some(Value::Object(serde_json::Map::new()));
    }
    serde_json::from_slice(bytes).ok()
}

/// An XML or binary plist. A value JSON can't hold (date, data) fails, as it
/// does for Claude Code's `plutil -convert json`.
fn parse_plist(bytes: &[u8]) -> Option<Value> {
    plist::from_bytes(bytes).ok()
}

/// The first MDM plist present is the source; an unreadable one before it
/// makes the source unreadable.
fn read_mdm(plists: &[PathBuf]) -> ManagedSource {
    plists
        .iter()
        .map(|path| read_source(path, parse_plist))
        .find(|source| *source != ManagedSource::Absent)
        .unwrap_or_default()
}

/// `managed-settings.json` first, then every visible `*.json` drop-in in
/// `managed-settings.d/` in name order, merged into one source.
fn read_file_source(system_dir: &Path) -> ManagedSource {
    let mut paths = vec![system_dir.join("managed-settings.json")];
    match std::fs::read_dir(system_dir.join("managed-settings.d")) {
        Ok(entries) => {
            let mut drop_ins: Vec<PathBuf> = entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| is_drop_in(path))
                .collect();
            drop_ins.sort();
            paths.extend(drop_ins);
        }
        Err(e) if skipped(e.kind()) => {}
        Err(_) => return ManagedSource::Unreadable,
    }
    let mut documents = Vec::new();
    for path in &paths {
        match read_source(path, parse_json) {
            ManagedSource::Absent => {}
            ManagedSource::Unreadable => return ManagedSource::Unreadable,
            ManagedSource::Present(value) => documents.push(value),
        }
    }
    if documents.is_empty() {
        return ManagedSource::Absent;
    }
    ManagedSource::Present(merge_file_documents(documents))
}

/// A visible file ending in `.json` (matched exactly, as Claude Code does).
fn is_drop_in(path: &Path) -> bool {
    let visible = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| !name.starts_with('.'));
    visible && path.extension().is_some_and(|ext| ext == "json")
}

/// Whether Kriyon may side-load its companion folder into `claude`
/// ([Side-loading]). Treat `Unknown` like `Blocked`: don't set
/// `CLAUDE_CODE_PLUGIN_DIRS`.
#[must_use]
pub fn sideload_policy(home: &Path) -> SideloadPolicy {
    managed_policy(&ManagedLocations::for_home(home)).sideload()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kriyon_core::policy::ManagedPolicy;

    struct Fixture {
        _dir: tempfile::TempDir,
        locations: ManagedLocations,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let locations = ManagedLocations {
            system_dir: dir.path().join("ClaudeCode"),
            mdm_plists: vec![
                dir.path().join("user.plist"),
                dir.path().join("device.plist"),
            ],
            remote: dir.path().join("remote-settings.json"),
        };
        std::fs::create_dir_all(locations.system_dir.join("managed-settings.d")).unwrap();
        Fixture {
            _dir: dir,
            locations,
        }
    }

    fn write(path: &Path, body: &str) {
        std::fs::write(path, body).unwrap();
    }

    fn plist(dict_body: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>{dict_body}</dict></plist>"#
        )
    }

    #[test]
    fn real_locations_are_the_macos_paths() {
        let locations = ManagedLocations::for_home(Path::new("/Users/x"));
        assert_eq!(
            locations.system_dir,
            Path::new("/Library/Application Support/ClaudeCode")
        );
        assert_eq!(
            locations.remote,
            Path::new("/Users/x/.claude/remote-settings.json")
        );
        assert_eq!(
            locations.mdm_plists.last().unwrap(),
            Path::new("/Library/Managed Preferences/com.anthropic.claudecode.plist")
        );
    }

    #[test]
    fn no_sources_allow_side_loading() {
        let f = fixture();
        assert_eq!(
            managed_policy(&f.locations),
            PolicyRead::Known(ManagedPolicy::default())
        );
    }

    #[test]
    fn a_drop_in_merges_over_the_managed_settings_file() {
        let f = fixture();
        let dir = &f.locations.system_dir;
        write(&dir.join("managed-settings.json"), r#"{"model":"opus"}"#);
        write(
            &dir.join("managed-settings.d").join("20-plugins.json"),
            r#"{"disableSideloadFlags":true}"#,
        );
        // Hidden and non-JSON files are ignored, even when malformed.
        write(&dir.join("managed-settings.d").join(".hidden.json"), "{");
        write(&dir.join("managed-settings.d").join("notes.txt"), "{");
        assert_eq!(
            managed_policy(&f.locations).sideload(),
            SideloadPolicy::Blocked
        );

        // A later drop-in (alphabetically) replaces an earlier single value.
        write(
            &dir.join("managed-settings.d").join("30-undo.json"),
            r#"{"disableSideloadFlags":false}"#,
        );
        assert_eq!(
            managed_policy(&f.locations).sideload(),
            SideloadPolicy::Allowed
        );
    }

    #[test]
    fn a_malformed_drop_in_makes_the_policy_unknown() {
        let f = fixture();
        write(
            &f.locations
                .system_dir
                .join("managed-settings.d")
                .join("10.json"),
            "{not json",
        );
        assert_eq!(managed_policy(&f.locations), PolicyRead::Unknown);
    }

    #[test]
    fn reads_the_first_mdm_plist_present() {
        let f = fixture();
        write(
            &f.locations.mdm_plists[1],
            &plist("<key>disableSideloadFlags</key><true/>"),
        );
        assert_eq!(
            managed_policy(&f.locations).sideload(),
            SideloadPolicy::Blocked
        );

        // The per-user profile wins over the device-level one.
        write(
            &f.locations.mdm_plists[0],
            &plist("<key>model</key><string>opus</string>"),
        );
        assert_eq!(
            managed_policy(&f.locations).sideload(),
            SideloadPolicy::Allowed
        );

        write(&f.locations.mdm_plists[0], "not a plist");
        assert_eq!(managed_policy(&f.locations), PolicyRead::Unknown);
    }

    #[test]
    fn the_remote_cache_outranks_the_file() {
        let f = fixture();
        write(
            &f.locations.system_dir.join("managed-settings.json"),
            r#"{"disableSideloadFlags":true}"#,
        );
        write(&f.locations.remote, r#"{"model":"opus"}"#);
        assert_eq!(
            managed_policy(&f.locations).sideload(),
            SideloadPolicy::Allowed
        );

        write(&f.locations.remote, "[]");
        assert_eq!(managed_policy(&f.locations), PolicyRead::Unknown);
    }

    #[test]
    fn an_empty_managed_file_counts_as_an_empty_object() {
        let f = fixture();
        write(&f.locations.system_dir.join("managed-settings.json"), "");
        assert_eq!(
            managed_policy(&f.locations),
            PolicyRead::Known(ManagedPolicy::default())
        );
    }
}
