//! The user-configurable settings command family: cross-project
//! OS-notification preference and sound, the [Memory budget] warning, the
//! [Sleeping session] auto-sleep policy, and previewing a notification sound.
//! Each setter just writes its field on `AppState` under its own mutex — no
//! command here reads another's state — and every numeric input is
//! re-validated at this IPC boundary (a zero memory budget or a sub-10-minute
//! auto-sleep threshold is rejected) even though the frontend already clamps.

use crate::AppState;

/// Set the user's cross-project OS-notification preference. Gates which status
/// transitions are allowed to notify at all (on top of focus/coalescing).
///
/// # Errors
/// Infallible today; returns `Result` for command-signature uniformity.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn set_notify_preference(
    state: tauri::State<'_, AppState>,
    pref: kriyon_core::status::NotifyPreference,
) -> Result<(), String> {
    *state.notify_pref.lock() = pref;
    Ok(())
}

/// Set the user's chosen OS-notification sound. Attached to notifications
/// posted after this call; does not affect already-delivered ones.
///
/// # Errors
/// Infallible today; returns `Result` for command-signature uniformity.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn set_notify_sound(
    state: tauri::State<'_, AppState>,
    sound: kriyon_core::status::NotifySound,
) -> Result<(), String> {
    *state.notify_sound.lock() = sound;
    Ok(())
}

/// Set the user's [Memory budget]: the whole-app footprint (MB) above which
/// Kriyon warns, and whether the warning fires at all. Pushed from Settings on
/// boot and on change, mirroring the notify-preference pattern.
///
/// # Errors
/// Rejects a zero budget — the frontend clamps, but the IPC boundary
/// re-validates every input.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn set_memory_budget(
    state: tauri::State<'_, AppState>,
    budget_mb: u64,
    warn_enabled: bool,
) -> Result<(), String> {
    if budget_mb == 0 {
        return Err("memory budget must be at least 1 MB".to_string());
    }
    *state.memory_budget.lock() = kriyon_core::memory::MemoryBudget {
        budget_mb,
        warn_enabled,
    };
    Ok(())
}

/// Set the user's [Sleeping session] auto-sleep policy. `after_secs` is
/// clamped at the boundary to at least 10 minutes — anything shorter would
/// fight the user's own working rhythm.
///
/// # Errors
/// Rejects a sub-10-minute threshold.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn set_auto_sleep(
    state: tauri::State<'_, AppState>,
    enabled: bool,
    after_secs: u64,
) -> Result<(), String> {
    if enabled && after_secs < 600 {
        return Err("auto-sleep threshold must be at least 10 minutes".to_string());
    }
    *state.auto_sleep.lock() = kriyon_core::sleep::AutoSleep {
        enabled,
        after_secs,
    };
    Ok(())
}

/// Play the given notification sound once, for previewing in Settings.
/// Bundled sounds play their `.wav`; `Default` plays the system beep; `Silent`
/// does nothing. macOS-only; a no-op elsewhere.
///
/// # Errors
/// Returns an error string if the bundled resource path cannot be resolved.
/// Sound initialization and playback happen asynchronously on the main
/// thread and are best-effort: `run_on_main_thread` cannot return a value
/// to the caller, so failures there are logged to stderr, not returned.
#[cfg(target_os = "macos")]
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn preview_notify_sound(
    app: tauri::AppHandle,
    sound: kriyon_core::status::NotifySound,
) -> Result<(), String> {
    use std::cell::RefCell;

    use kriyon_core::status::NotifySoundKind;
    use objc2::rc::Retained;
    use objc2::AnyThread as _;
    use objc2_app_kit::{NSBeep, NSSound};
    use objc2_foundation::NSString;
    use tauri::Manager as _;

    // `NSSound::play()` is asynchronous, so a locally-owned `NSSound` would be
    // released — and stop playing — the instant this command's main-thread
    // closure returns. Hold the currently-playing preview in main-thread-local
    // storage so it survives playback; the next preview replaces it (cutting the
    // prior clip, which is the intended "one preview at a time" behavior). The
    // closure always runs on the one Tauri main thread, so keeping a non-`Send`
    // `Retained<NSSound>` in a `thread_local!` is sound.
    thread_local! {
        static PREVIEW_SOUND: RefCell<Option<Retained<NSSound>>> = const { RefCell::new(None) };
    }

    let filename = match sound.kind() {
        NotifySoundKind::Silent => return Ok(()),
        NotifySoundKind::System => {
            // Default: no bundled file — approximate the system alert.
            app.run_on_main_thread(|| NSBeep())
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
        NotifySoundKind::Bundled(name) => name,
    };

    let path = app
        .path()
        .resolve(filename, tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("resolve {filename}: {e}"))?;
    let path_str = path.to_string_lossy().into_owned();

    app.run_on_main_thread(move || {
        let ns_path = NSString::from_str(&path_str);
        match NSSound::initWithContentsOfFile_byReference(NSSound::alloc(), &ns_path, true) {
            Some(sound) => {
                if !sound.play() {
                    eprintln!("kriyon: preview_notify_sound play() returned false for {path_str}");
                }
                // Retain past this closure so async playback isn't cut short.
                PREVIEW_SOUND.with(|slot| slot.replace(Some(sound)));
            }
            None => eprintln!("kriyon: preview_notify_sound could not load {path_str}"),
        }
    })
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Off-macOS the preview is a no-op (no notification-sound feature there).
///
/// # Errors
///
/// Never returns an error; the `Result` matches the macOS signature.
#[cfg(not(target_os = "macos"))]
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn preview_notify_sound(
    _app: tauri::AppHandle,
    _sound: kriyon_core::status::NotifySound,
) -> Result<(), String> {
    Ok(())
}
