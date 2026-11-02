//! [Claude CLI check] — whether the `claude` command a new session would run
//! is installed, so the app can show how to install it instead of a session
//! that ends in "command not found".
//!
//! It looks where a new session's shell looks: the person's [Shell PATH] read
//! fresh on macOS, and on Windows the PATH from their environment settings,
//! which is what each new session's shell gets. Fresh, so "Check again" sees a
//! `claude` installed a minute ago without restarting Kriyon.

use std::ffi::OsString;

use serde::Serialize;

/// What the [Claude CLI check] found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum ClaudeCli {
    /// `claude` is on the PATH, at `path`.
    Found { path: String },
    /// Nothing named `claude` is on the PATH.
    Missing,
    /// The PATH couldn't be read (a broken shell config). Not reported as
    /// missing: telling someone to install what they have would mislead them.
    Unknown,
}

/// The check against `path`, the PATH a new session gets (`None` when it
/// couldn't be read).
#[must_use]
pub fn check(path: Option<&OsString>) -> ClaudeCli {
    let Some(path) = path else {
        return ClaudeCli::Unknown;
    };
    match crate::spawn::on_path("claude", Some(path)).next() {
        Some(found) => ClaudeCli::Found {
            path: found.to_string_lossy().into_owned(),
        },
        None => ClaudeCli::Missing,
    }
}

/// Run the [Claude CLI check]. Reading the shell PATH starts the person's
/// shell, so it runs off the async runtime's threads.
#[tauri::command]
pub async fn find_claude_cli() -> ClaudeCli {
    tauri::async_runtime::spawn_blocking(|| check(crate::shell_path::session_path().as_ref()))
        .await
        .unwrap_or(ClaudeCli::Unknown)
}

#[cfg(test)]
mod tests {
    use super::{check, ClaudeCli};

    #[test]
    fn claude_on_the_path_is_found_where_it_is() {
        let dir = tempfile::tempdir().expect("dir");
        let name = if cfg!(windows) {
            "claude.exe"
        } else {
            "claude"
        };
        let claude = dir.path().join(name);
        std::fs::write(&claude, "").expect("claude");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755))
                .expect("chmod");
        }
        assert_eq!(
            check(Some(&dir.path().as_os_str().to_os_string())),
            ClaudeCli::Found {
                path: claude.to_string_lossy().into_owned()
            }
        );
    }

    #[test]
    fn no_claude_on_the_path_is_missing() {
        let dir = tempfile::tempdir().expect("dir");
        assert_eq!(
            check(Some(&dir.path().as_os_str().to_os_string())),
            ClaudeCli::Missing
        );
    }

    #[test]
    fn an_unreadable_path_is_unknown_not_missing() {
        assert_eq!(check(None), ClaudeCli::Unknown);
    }
}
