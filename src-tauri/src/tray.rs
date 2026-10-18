//! macOS menu-bar quick view: a tray icon that toggles a frosted popover window
//! (`tray.html`) anchored under the icon. The panel is a separate borderless,
//! transparent, always-on-top webview that subscribes to the same session
//! streams the main window uses. Left-click toggles it; it hides on blur.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter as _, Manager as _, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_positioner::{Position, WindowExt as _};

use crate::window_cmd;

/// Ignore a left-click that lands within this window of a blur-driven hide, so
/// clicking the icon while the popover is open toggles it closed once (the click
/// first blurs+hides the panel, then reaches the icon handler) instead of twice.
const REOPEN_GUARD: Duration = Duration::from_millis(250);

/// Wall-clock time the panel was last hidden by a blur event. Process-lifetime
/// state shared between the panel's blur handler and the tray click handler;
/// `std::sync::Mutex::new` is `const`, so this needs no lazy init or leak.
static LAST_HIDDEN: Mutex<Option<Instant>> = Mutex::new(None);

/// Build the panel window (hidden) and the tray icon, wiring click/positioning
/// and blur-to-hide.
///
/// # Errors
///
/// Returns an error if the panel window or the tray icon fails to build.
///
/// # Panics
///
/// Panics if the [`LAST_HIDDEN`] mutex is poisoned, which only happens if a
/// prior lock holder panicked while holding it.
pub fn build(app: &tauri::App) -> tauri::Result<()> {
    // The menu-bar icon is the "fi" gem mark as a monochrome *template* image:
    // macOS tints it to match the bar (dark on light, light on dark), so one
    // image serves both appearances. The colourful app icon would render as a
    // solid black squircle blob here, so we ship a dedicated silhouette
    // (`scripts/make-tray-icon.mjs`) embedded at compile time.
    let icon = match tauri::image::Image::from_bytes(include_bytes!("../icons/menubar-icon.png")) {
        Ok(img) => img,
        Err(e) => {
            // Best-effort: a decode failure loses only the menu-bar extra. Log
            // and skip rather than panicking the whole app — the caller already
            // treats a tray failure as non-fatal.
            eprintln!("kriyon: failed to decode menu-bar icon; tray not built: {e}");
            return Ok(());
        }
    };

    let panel = WebviewWindowBuilder::new(app, "tray", WebviewUrl::App("tray.html".into()))
        .title("Kriyon Sessions")
        .inner_size(400.0, 540.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .visible(false)
        .skip_taskbar(true)
        .build()?;

    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        let _ = apply_vibrancy(
            &panel,
            NSVisualEffectMaterial::HudWindow,
            Some(NSVisualEffectState::Active),
            Some(14.0),
        );
    }

    // Drive the popover off the *native* focus event, which — unlike the
    // webview's JS `onFocusChanged` — fires reliably for this borderless panel
    // (the same reason the notification focus-gate is tracked in Rust). On focus
    // we broadcast `tray-visibility(true)` so the webview polls fresh session
    // state exactly when it comes on screen; on blur we hide (standard menu-bar
    // dismissal) and broadcast `false` so it stops polling. Recording the hide
    // time keeps the icon click that caused the blur from immediately reopening.
    let panel_for_event = panel.clone();
    panel.on_window_event(move |event| {
        if let WindowEvent::Focused(focused) = event {
            let _ = panel_for_event.emit("tray-visibility", *focused);
            if !*focused {
                *LAST_HIDDEN.lock().unwrap() = Some(Instant::now());
                let _ = panel_for_event.hide();
            }
        }
    });

    let menu = build_menu(app)?;

    let _tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Kriyon")
        .show_menu_on_left_click(false)
        .menu(&menu)
        .on_menu_event(|app, event| on_menu_event(app, &event))
        .on_tray_icon_event(move |tray, event| {
            // Required for tray-relative positioning.
            tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let Some(win) = app.get_webview_window("tray") else {
                    return;
                };
                let visible = win.is_visible().unwrap_or(false);
                // Take (and clear) the last-hidden mark: the guard fires at most
                // once per hide. Clearing it here means the *next* icon click
                // after this one is a clean toggle — a stale mark can never
                // suppress a later open. (Residual edge: a blur from clicking
                // another app also sets the mark, so an icon click within
                // REOPEN_GUARD of that unrelated blur still reads as a close;
                // macOS gives us no way to tell the two blurs apart.)
                let recently_hidden = LAST_HIDDEN
                    .lock()
                    .unwrap()
                    .take()
                    .is_some_and(|t| t.elapsed() < REOPEN_GUARD);
                if visible || recently_hidden {
                    let _ = win.hide();
                } else {
                    let _ = win.move_window(Position::TrayCenter);
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

/// Build the right-click menu: Open Kriyon · New session (⌘N) · Sleep Idle
/// Sessions · Preferences · Quit Kriyon.
///
/// # Errors
///
/// Returns an error if any menu item or the menu itself fails to build.
fn build_menu(app: &tauri::App) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let open_i = MenuItemBuilder::with_id("open", "Open Kriyon").build(app)?;
    let new_i = MenuItemBuilder::with_id("new", "New session")
        .accelerator("Cmd+N")
        .build(app)?;
    let sleep_i = MenuItemBuilder::with_id("sleep-idle", "Sleep Idle Sessions").build(app)?;
    let prefs_i = MenuItemBuilder::with_id("prefs", "Preferences").build(app)?;
    let quit_i = MenuItemBuilder::with_id("quit", "Quit Kriyon")
        .accelerator("Cmd+Q")
        .build(app)?;
    MenuBuilder::new(app)
        .items(&[&open_i, &new_i])
        .separator()
        .items(&[&sleep_i, &prefs_i])
        .separator()
        .items(&[&quit_i])
        .build()
}

/// Handle a right-click menu selection. Each item runs the same function as
/// its popover button (see `window_cmd`), so the two cannot drift apart.
fn on_menu_event(app: &tauri::AppHandle, event: &tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        "open" => window_cmd::reveal_main_and_hide_tray(app),
        "new" => window_cmd::request_new_session(app),
        // Memory back without opening the window or quitting: exactly when the
        // menu bar is where the user is. Never touches a session that is busy.
        "sleep-idle" => {
            // Menu events arrive on the main thread, and the pass reads the
            // process table and the store; doing that here freezes the window
            // and the menu itself.
            let app = app.clone();
            std::thread::spawn(move || {
                let slept = crate::sleep_rt::sleep_idle_now(&app);
                eprintln!("kriyon: tray asked to sleep idle sessions; stopped {slept}");
            });
        }
        "prefs" => window_cmd::request_preferences(app),
        // Reveal first: the close gate may need to show a confirmation, and a
        // dialog behind a hidden window would strand the quit.
        "quit" => {
            window_cmd::reveal_main_and_hide_tray(app);
            crate::quit::request_quit(app);
        }
        _ => {}
    }
}
