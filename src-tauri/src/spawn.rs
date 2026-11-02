//! How the app starts a helper program.

/// The Windows process-creation flag that starts a console program without a
/// console window.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Keep a console program the app starts from opening a console window.
///
/// A Windows GUI app has no console, so every console program it starts —
/// git on each status refresh, an install, a setup command — would flash a new
/// console window on screen. Nothing to do elsewhere.
pub fn no_console(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// The extensions Windows tries when `PATHEXT` is unset.
const WINDOWS_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// Every program file `name` resolves to on `path` (the app's own PATH when
/// `None`), in search order — the one rule for finding a program.
///
/// On Windows a bare name (`pnpm`, `code`) is tried with each `PATHEXT`
/// extension, as `cmd` does: a folder can hold an extensionless shell script
/// beside the `.cmd` that Windows can actually start. A name with an extension
/// (`python.exe`) is tried as written. Elsewhere a name is the file itself,
/// and only one the person may run counts, as their shell would see it.
/// Callers take the first match, or skip one they cannot use.
pub fn on_path<'a>(
    name: &'a str,
    path: Option<&std::ffi::OsStr>,
) -> impl Iterator<Item = std::path::PathBuf> + 'a {
    let search_path = path.map_or_else(
        || std::env::var_os("PATH").unwrap_or_default(),
        std::ffi::OsStr::to_os_string,
    );
    let pathext = cfg!(windows)
        .then(|| std::env::var("PATHEXT").unwrap_or_else(|_| WINDOWS_PATHEXT.to_string()));
    search(name, &search_path, pathext.as_deref())
}

/// [`on_path`] with the platform rule passed in: `pathext` is Windows'
/// extension list, `None` off Windows.
fn search<'a>(
    name: &'a str,
    path: &std::ffi::OsStr,
    pathext: Option<&str>,
) -> impl Iterator<Item = std::path::PathBuf> + 'a {
    let names: Vec<String> = match pathext {
        Some(exts) if std::path::Path::new(name).extension().is_none() => exts
            .split(';')
            .filter(|ext| !ext.is_empty())
            .map(|ext| format!("{name}{ext}"))
            .collect(),
        _ => vec![name.to_string()],
    };
    let windows = pathext.is_some();
    std::env::split_paths(path)
        .collect::<Vec<_>>()
        .into_iter()
        .flat_map(move |dir| names.clone().into_iter().map(move |file| dir.join(file)))
        .filter(move |candidate| candidate.is_file() && (windows || runnable(candidate)))
}

/// Whether the person may run `file`: any execute bit set. Windows decides by
/// extension instead, so every file counts there.
fn runnable(file: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        file.metadata()
            .is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        let _ = file;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::{on_path, search, WINDOWS_PATHEXT};

    #[test]
    fn a_bare_name_finds_its_launcher_not_the_extensionless_script_beside_it() {
        let dir = tempfile::tempdir().expect("dir");
        std::fs::write(dir.path().join("code"), "#!/bin/sh").expect("script");
        // Upper case, as PATHEXT spells it: a case-sensitive Linux disk only
        // finds it written the same way.
        std::fs::write(dir.path().join("code.CMD"), "@echo off").expect("launcher");
        let found: Vec<_> = search("code", dir.path().as_os_str(), Some(WINDOWS_PATHEXT))
            .map(|p| p.file_name().unwrap().to_string_lossy().to_lowercase())
            .collect();
        assert_eq!(found, ["code.cmd"]);
    }

    /// macOS has no PATHEXT: `claude` is the file `claude`, and only one the
    /// person may run counts, as the shell would see it.
    #[test]
    #[cfg(unix)]
    fn on_unix_a_bare_name_is_the_executable_file_itself() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = tempfile::tempdir().expect("dir");
        let claude = dir.path().join("claude");
        std::fs::write(&claude, "#!/bin/sh").expect("claude");
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        std::fs::write(dir.path().join("notes"), "").expect("plain file");
        assert_eq!(
            on_path("claude", Some(dir.path().as_os_str())).collect::<Vec<_>>(),
            [claude]
        );
        assert_eq!(on_path("notes", Some(dir.path().as_os_str())).count(), 0);
    }

    #[test]
    fn a_name_with_an_extension_is_found_as_written_in_path_order() {
        let first = tempfile::tempdir().expect("first");
        let second = tempfile::tempdir().expect("second");
        std::fs::write(second.path().join("python.exe"), "").expect("exe");
        let path = std::env::join_paths([first.path(), second.path()]).expect("path");
        let windows = Some(WINDOWS_PATHEXT);
        assert_eq!(
            search("python.exe", &path, windows).collect::<Vec<_>>(),
            [second.path().join("python.exe")]
        );
        assert_eq!(search("missing", &path, windows).count(), 0);
    }
}
