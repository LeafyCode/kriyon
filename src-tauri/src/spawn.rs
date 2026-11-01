//! How the app starts a helper program.

/// Keep a console program the app starts from opening a console window.
///
/// A Windows GUI app has no console, so every console program it starts —
/// git on each status refresh, an install, a setup command — would flash a new
/// console window on screen. Nothing to do elsewhere.
pub fn no_console(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
