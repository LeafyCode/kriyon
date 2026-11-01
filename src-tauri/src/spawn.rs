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

/// Every program file `name` resolves to on `path` (the app's own PATH when
/// `None`), in search order — the one rule for finding a program on Windows.
///
/// A bare name (`pnpm`, `code`) is tried with each `PATHEXT` extension, as
/// `cmd` does: a folder can hold an extensionless shell script beside the
/// `.cmd` that Windows can actually start. A name with an extension
/// (`python.exe`) is tried as written. Callers take the first match, or skip
/// one they cannot use.
pub fn on_path<'a>(
    name: &'a str,
    path: Option<&std::ffi::OsStr>,
) -> impl Iterator<Item = std::path::PathBuf> + 'a {
    let search = path.map_or_else(
        || std::env::var_os("PATH").unwrap_or_default(),
        std::ffi::OsStr::to_os_string,
    );
    let names: Vec<String> = if std::path::Path::new(name).extension().is_some() {
        vec![name.to_string()]
    } else {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .filter(|ext| !ext.is_empty())
            .map(|ext| format!("{name}{ext}"))
            .collect()
    };
    std::env::split_paths(&search)
        .collect::<Vec<_>>()
        .into_iter()
        .flat_map(move |dir| names.clone().into_iter().map(move |file| dir.join(file)))
        .filter(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::on_path;

    #[test]
    fn a_bare_name_finds_its_launcher_not_the_extensionless_script_beside_it() {
        let dir = tempfile::tempdir().expect("dir");
        std::fs::write(dir.path().join("code"), "#!/bin/sh").expect("script");
        // Upper case, as PATHEXT spells it: a case-sensitive Linux disk only
        // finds it written the same way.
        std::fs::write(dir.path().join("code.CMD"), "@echo off").expect("launcher");
        let found: Vec<_> = on_path("code", Some(dir.path().as_os_str()))
            .map(|p| p.file_name().unwrap().to_string_lossy().to_lowercase())
            .collect();
        assert_eq!(found, ["code.cmd"]);
    }

    #[test]
    fn a_name_with_an_extension_is_found_as_written_in_path_order() {
        let first = tempfile::tempdir().expect("first");
        let second = tempfile::tempdir().expect("second");
        std::fs::write(second.path().join("python.exe"), "").expect("exe");
        let path = std::env::join_paths([first.path(), second.path()]).expect("path");
        assert_eq!(
            on_path("python.exe", Some(&path)).collect::<Vec<_>>(),
            [second.path().join("python.exe")]
        );
        assert_eq!(on_path("missing", Some(&path)).count(), 0);
    }
}
