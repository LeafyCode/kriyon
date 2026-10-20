//! Opening and revealing files that Claude references in its output. The single
//! `open_path` command is the trust boundary: the frontend sends the session
//! `cwd` and a raw path token, and this module re-validates both before any OS
//! call — the raw string never reaches the opener unchecked.

use std::path::{Path, PathBuf};

use kriyon_core::completion::path_within_roots;
use tauri_plugin_opener::OpenerExt as _;

use crate::commands::resolve_home;
use crate::completion_cmd::{known_roots, validate_cwd};
use crate::StoreState;

/// Resolve a frontend-supplied `(cwd, path)` to a real, existing entry that
/// lies within a known project/session root — the shared trust-boundary check
/// behind every "act on this file" command here ([`open_path`],
/// [`open_in_editor`]). `cwd` must itself be a known root; `path` is resolved
/// lexically against it (and `home`), then canonicalized so symlink escapes
/// can't dodge the `path_within_roots` fence. `allow_dir` widens the target
/// check to directories — reveal selects the entry in Finder, which is as
/// meaningful for a folder as for a file; open/edit stay file-only.
fn resolve_target(
    app: &tauri::AppHandle,
    store: &tauri::State<'_, StoreState>,
    cwd: &str,
    path: &str,
    allow_dir: bool,
    allow_outside: bool,
) -> Result<PathBuf, String> {
    let base = validate_cwd(store, Path::new(cwd))?;
    let home = resolve_home(app)?;
    let lexical = kriyon_core::links::resolve_lexical(&base, &home, path);
    let target = lexical
        .canonicalize()
        .map_err(|_| "path does not exist".to_string())?;
    if !(target.is_file() || (allow_dir && target.is_dir())) {
        return Err("not a file".to_string());
    }
    if allow_outside || path_within_roots(&target, &known_roots(store)) {
        Ok(target)
    } else {
        // Tagged: the frontend asks the user before opening it anyway.
        Err(kriyon_core::failure::tagged_failure(
            "outside-roots",
            "path outside a known project or session root",
        ))
    }
}

/// Open (or reveal) a file referenced in Claude's output. `cwd` is the session's
/// working directory — validated against the known session/project roots — and
/// `path` is resolved against it. `reveal` selects the file in Finder instead of
/// opening it in the default app. `allow_outside` is the user's confirmed
/// "open it anyway" for a file outside every project — it must still exist.
///
/// # Errors
/// Returns an error string when `cwd` is not a known root, when `path` does not
/// resolve to an existing file (reveal accepts a directory too), when the
/// resolved target falls outside every known project/session root, or (for
/// open, not reveal) when the file's extension is not on the viewable
/// allowlist. The frontend shows the error in a toast.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn open_path(
    app: tauri::AppHandle,
    store: tauri::State<'_, StoreState>,
    cwd: String,
    path: String,
    reveal: bool,
    allow_outside: Option<bool>,
) -> Result<(), String> {
    let target = resolve_target(
        &app,
        &store,
        &cwd,
        &path,
        reveal,
        allow_outside == Some(true),
    )?;
    if reveal {
        return app
            .opener()
            .reveal_item_in_dir(&target)
            .map_err(|e| e.to_string());
    }
    if !kriyon_core::links::is_openable_extension(&target) {
        return Err("file type not openable".to_string());
    }
    app.opener()
        .open_path(target.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Open a file in the user's code editor rather than the default app for its
/// type. The Changes view's in-app editor offers this for the text file it has
/// open, so a click must land the file in a real editor — opening an `.html`
/// through the type-default app launches a browser, and `.md` a Markdown
/// previewer, neither of which is what "Open in editor" should do.
///
/// macOS has no single "default code editor" setting, so this hands the file to
/// the first installed editor from [`EDITOR_APPS`] (the same detect-and-launch
/// approach git GUIs use for their "external editor"), falling back to the OS
/// default text editor only when none of them is present — so the file still
/// lands in *an* editor rather than a browser.
///
/// # Errors
/// Same resolution/validation failures as [`open_path`] (unknown `cwd`, missing
/// path, non-file, or a target outside every known root), plus a spawn failure
/// when not even a text editor can be launched. The frontend treats any error
/// as a silent no-op.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn open_in_editor(
    app: tauri::AppHandle,
    store: tauri::State<'_, StoreState>,
    cwd: String,
    path: String,
) -> Result<(), String> {
    let target = resolve_target(&app, &store, &cwd, &path, false, false)?;
    open_in_code_editor(&target)
}

/// Developer editors tried, in priority order, before the plain-text-editor
/// fallback. Matched by macOS application display name via `open -a`, which
/// resolves through Launch Services (so the app is found wherever it is
/// installed, not just `/Applications`). A user with a single editor installed
/// gets exactly it; the order only decides among several.
#[cfg(target_os = "macos")]
const EDITOR_APPS: &[&str] = &[
    "Cursor",
    "Visual Studio Code",
    "Visual Studio Code - Insiders",
    "Windsurf",
    "Zed",
    "WebStorm",
    "IntelliJ IDEA",
    "PyCharm",
    "PhpStorm",
    "GoLand",
    "RubyMine",
    "CLion",
    "Rider",
    "Sublime Text",
    "Nova",
    "BBEdit",
    "TextMate",
];

/// Launch `target` in the first installed [`EDITOR_APPS`] entry, else the OS
/// default text editor. Split out so the command body stays a thin
/// resolve-then-open, and so the platform branch is the one thing to revisit if
/// Kriyon ever ships beyond macOS.
#[cfg(target_os = "macos")]
fn open_in_code_editor(target: &Path) -> Result<(), String> {
    for app in EDITOR_APPS {
        // `open -a <app>` exits non-zero (without opening anything) when the
        // app is not installed, so iterating is a safe detect-and-launch: the
        // first success is the only side effect.
        if launch_via_open(&["-a", app], target) {
            return Ok(());
        }
    }
    // No code editor found — the default text editor (`open -t`) still beats a
    // browser for an .html/.md, so fall back to it.
    if launch_via_open(&["-t"], target) {
        Ok(())
    } else {
        Err("no editor available to open the file".to_string())
    }
}

/// `true` when `open <flags> <target>` spawned and exited zero. A spawn failure
/// or non-zero exit (e.g. the named app is not installed) is reported as
/// `false` so the caller can try the next candidate.
#[cfg(target_os = "macos")]
fn launch_via_open(flags: &[&str], target: &Path) -> bool {
    std::process::Command::new("/usr/bin/open")
        .args(flags)
        .arg(target)
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(not(target_os = "macos"))]
fn open_in_code_editor(_target: &Path) -> Result<(), String> {
    Err("opening in a code editor is only supported on macOS".to_string())
}
