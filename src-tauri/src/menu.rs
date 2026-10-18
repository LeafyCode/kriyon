//! The application menu bar.
//!
//! On macOS, Tauri installs a default app menu whose "About Kriyon" item opens
//! the system about panel. We build an equivalent menu here but route the About
//! item to the frontend (via the `show-about` event) so the app's own About
//! overlay — with the Leafy Code attribution — is what opens, matching the ⓘ
//! button in the title bar. Quit is custom for the same kind of reason: the
//! predefined item terminates the app outright, past the frontend's close gate,
//! so ⌘Q would quit without ever asking about live work (see
//! [`crate::quit::request_quit`]). File → New Session is ours too: it gives ⌘N,
//! which the tray menu and the popover advertise, something to fire (a tray
//! menu's accelerator is a label only). Everything else (Services, Hide, and the
//! Edit and Window submenus) mirrors the platform default so the standard
//! shortcuts keep working.
//!
//! Off macOS there is no app-menu bar to reshape, so we fall back to Tauri's
//! default menu.

/// The menu id of the custom "About Kriyon" item. [`on_event`] emits
/// `show-about` when this is chosen.
pub const ABOUT_ID: &str = "about";

/// The menu id of the custom "Quit Kriyon" item. [`on_event`] routes this
/// through the close gate rather than exiting (see the module docs).
pub const QUIT_ID: &str = "quit-app";

/// The menu id of the File → "New Session" item (⌘N). [`on_event`] runs the
/// same new-session request as the tray (see
/// [`crate::window_cmd::request_new_session`]).
pub const NEW_SESSION_ID: &str = "new-session";

/// Build the application menu (see the module docs). Custom on macOS, the Tauri
/// default elsewhere.
///
/// # Errors
///
/// Returns an error if any menu item or submenu fails to build.
pub fn build(handle: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    #[cfg(target_os = "macos")]
    {
        use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

        let about_i = MenuItemBuilder::with_id(ABOUT_ID, "About Kriyon").build(handle)?;
        let quit_i = MenuItemBuilder::with_id(QUIT_ID, "Quit Kriyon")
            .accelerator("CmdOrCtrl+Q")
            .build(handle)?;

        let new_session_i = MenuItemBuilder::with_id(NEW_SESSION_ID, "New Session")
            .accelerator("CmdOrCtrl+N")
            .build(handle)?;

        let app_menu = SubmenuBuilder::new(handle, "Kriyon")
            .item(&about_i)
            .item(&PredefinedMenuItem::separator(handle)?)
            .item(&PredefinedMenuItem::services(handle, None)?)
            .item(&PredefinedMenuItem::separator(handle)?)
            .item(&PredefinedMenuItem::hide(handle, None)?)
            .item(&PredefinedMenuItem::hide_others(handle, None)?)
            .item(&PredefinedMenuItem::show_all(handle, None)?)
            .item(&PredefinedMenuItem::separator(handle)?)
            .item(&quit_i)
            .build()?;

        let file_menu = SubmenuBuilder::new(handle, "File")
            .item(&new_session_i)
            .build()?;

        let edit_menu = SubmenuBuilder::new(handle, "Edit")
            .item(&PredefinedMenuItem::undo(handle, None)?)
            .item(&PredefinedMenuItem::redo(handle, None)?)
            .item(&PredefinedMenuItem::separator(handle)?)
            .item(&PredefinedMenuItem::cut(handle, None)?)
            .item(&PredefinedMenuItem::copy(handle, None)?)
            .item(&PredefinedMenuItem::paste(handle, None)?)
            .item(&PredefinedMenuItem::select_all(handle, None)?)
            .build()?;

        let window_menu = SubmenuBuilder::new(handle, "Window")
            .item(&PredefinedMenuItem::minimize(handle, None)?)
            .item(&PredefinedMenuItem::maximize(handle, None)?)
            .item(&PredefinedMenuItem::separator(handle)?)
            .item(&PredefinedMenuItem::fullscreen(handle, None)?)
            .item(&PredefinedMenuItem::separator(handle)?)
            .item(&PredefinedMenuItem::close_window(handle, None)?)
            .build()?;

        MenuBuilder::new(handle)
            .items(&[&app_menu, &file_menu, &edit_menu, &window_menu])
            .build()
    }
    #[cfg(not(target_os = "macos"))]
    {
        tauri::menu::Menu::default(handle)
    }
}

/// Handle an application-menu selection. Reveals the About overlay by asking the
/// frontend to open it, starts a new session, and routes Quit through the close
/// gate. Tray-menu ids
/// are handled by the tray's own handler and are ignored here.
pub fn on_event(app: &tauri::AppHandle, event: &tauri::menu::MenuEvent) {
    use tauri::Emitter as _;

    match event.id().as_ref() {
        ABOUT_ID => {
            let _ = app.emit("show-about", ());
        }
        NEW_SESSION_ID => crate::window_cmd::request_new_session(app),
        QUIT_ID => crate::quit::request_quit(app),
        _ => {}
    }
}
