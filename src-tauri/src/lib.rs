pub mod activity_rt;
pub mod activity_store;
pub mod appkit_guard;
pub mod attachment_cmd;
pub mod bootstrap_cmd;
pub mod commands;
pub mod completion_cmd;
pub mod daemon_client;
pub mod daemon_rt;
pub mod entry_cmd;
pub mod file_cmd;
pub mod git_cmd;
pub mod git_run;
pub mod handoff_rt;
pub mod hooks;
pub mod integration;
pub mod links_cmd;
pub mod memory;
pub mod menu;
pub mod notify;
pub mod plan_limits_rt;
pub mod policy;
pub mod prompt_cmd;
pub mod quit;
pub mod sandbox;
pub mod session_registry;
pub mod settings_cmd;
pub mod sleep_rt;
pub mod status_rt;
pub mod store;
pub mod store_cmd;
pub mod structured_cmd;
pub mod tray;
pub mod tree_watch;
pub mod update_cmd;
pub mod update_rt;
pub mod watch_route;
pub mod watcher;
pub mod window_cmd;

use std::collections::HashMap;

use kriyon_core::session::SessionId;
use parking_lot::Mutex;
use tauri::Manager as _;

use crate::daemon_client::DaemonClient;
use crate::store::Store;

/// A live session: its connection to the out-of-process PTY daemon plus the
/// temporary `ZDOTDIR` (when zsh) whose `.zshrc` we generated. The `TempDir` is
/// held here so it is securely removed when the session is dropped/closed.
pub struct Session {
    /// The daemon connection, behind an `Arc` so a caller can clone the handle
    /// out from under the `sessions` lock and do the (blocking) socket write
    /// with the lock released — the [Sleeping session] wake runs on the ticker
    /// thread, and a wedged daemon must never freeze every command behind the
    /// held lock.
    pub engine: std::sync::Arc<DaemonClient>,
    pub zdotdir: Option<tempfile::TempDir>,
}

/// Shared application state: the live sessions keyed by their internal id.
#[derive(Default)]
pub struct AppState {
    pub sessions: Mutex<HashMap<SessionId, Session>>,
    /// Live transcript watches keyed by session id. Held here so each watch is
    /// not dropped immediately (dropping it stops the notify watch and the poll
    /// thread); removing an entry stops watching that session's transcript.
    pub watchers: Mutex<HashMap<SessionId, crate::watcher::SessionWatch>>,
    /// Every live [Working-tree watch], refcounted by repo root so several
    /// sessions in one checkout share a single recursive watch. Separate from
    /// `watchers` above because the two have different keys and lifetimes: a
    /// transcript watch is per session, a tree watch is per *repo*.
    pub tree_watches: Mutex<crate::tree_watch::TreeWatchRegistry>,
    /// Each session's live [Session runtime] — status tracker + mirrored open
    /// ask behind one interface — keyed by session id. Drives the per-session
    /// status dot, the progress summary, the menu-bar badge, and the tray
    /// snapshot rows. One map, one lock: the old parallel `status` + `asks`
    /// maps forced every consumer to re-join them under a lock-ordering rule.
    pub runtimes: Mutex<HashMap<SessionId, kriyon_core::runtime::SessionRuntime>>,
    /// The session the user is currently looking at, if any. Used to suppress
    /// OS notifications for the focused session (the user can already see it),
    /// but only while [`AppState::window_focused`] is also true — a session is
    /// only truly "on screen" when the Kriyon window itself is up front.
    pub focused: Mutex<Option<SessionId>>,
    /// Whether the main Kriyon window is currently focused (frontmost). Tracked
    /// natively from `WindowEvent::Focused` so notifications fire for the active
    /// session once the user switches to another app. Defaults to `true` (the
    /// app launches frontmost); see the `setup` hook.
    pub window_focused: Mutex<bool>,
    /// The user's cross-project OS-notification preference, gating which status
    /// transitions are allowed to notify at all (on top of focus/coalescing).
    pub notify_pref: Mutex<kriyon_core::status::NotifyPreference>,
    /// The user's chosen OS-notification sound, attached to each posted
    /// notification. Defaults to `NotifySound::Default` (the system alert).
    pub notify_sound: Mutex<kriyon_core::status::NotifySound>,
    /// Transcript summaries keyed by path, reused across history scans so a
    /// revalidation only re-parses files whose identity changed. `Arc` so the
    /// scan's blocking task can own a handle; the lock also serializes
    /// concurrent scans (deliberate — they'd contend on the same disk).
    pub history_cache: std::sync::Arc<Mutex<kriyon_core::history::SummaryCache>>,
    /// The latest [Session resources] sweep — per-session MB and CPU and the
    /// one authoritative whole-app totals. Refreshed by the resource sampler;
    /// read by the tray snapshot and the budget check, which therefore cannot
    /// disagree about the totals or re-derive them differently.
    pub memory: Mutex<kriyon_core::memory::ResourceSweep>,
    /// The previous sweep's per-pid readings: the baseline the next sweep's
    /// CPU percent is diffed against. `None` until the first sample.
    pub resource_baseline: Mutex<Option<kriyon_core::memory::ResourceSample>>,
    /// The user's [Memory budget] gating the whole-app over-budget warning.
    pub memory_budget: Mutex<kriyon_core::memory::MemoryBudget>,
    /// When the last memory warning fired, anchoring the warn cooldown.
    pub last_memory_warn: Mutex<Option<std::time::Instant>>,
    /// The user's [Sleeping session] auto-sleep policy.
    pub auto_sleep: Mutex<kriyon_core::sleep::AutoSleep>,
    /// Every session's place in the [Sleeping session] lifecycle — idle clock,
    /// stop phase, and the background-shell veto — in one map behind one lock,
    /// so each transition is indivisible and teardown is a single `forget`.
    pub sleep: Mutex<kriyon_core::sleep::SleepLedger>,
    /// How many consecutive passes have seen each [Orphan daemon], so the ticker
    /// reaper only acts on one that stays unowned.
    pub orphans: Mutex<kriyon_core::orphan::OrphanLedger>,
    /// What the app's exit should do to live sessions. Defaults to stopping
    /// them all, so an exit that never passed the quit gate (the Dock's Quit)
    /// still leaves nothing behind; `quit_app` overrides it from the gate.
    pub quit_intent: Mutex<kriyon_core::quit::QuitIntent>,
    /// The held lock that marks this instance as the owner of its [Run dir], or
    /// `None` while another running instance holds it (a dev build beside the
    /// installed app shares one). Only the owner reaps, adopts, or stops a
    /// daemon it does not provably hold. See `daemon_rt::owns_run_dir`.
    pub run_dir_lock: Mutex<Option<std::fs::File>>,
    /// Sessions whose `create_session` is in flight right now. Spawning a
    /// daemon takes a moment, and a close landing in that window is the one
    /// case where the two gestures can disagree about whether the session
    /// exists — so the close leaves a mark only while an id is in here. Keyed
    /// on the create rather than on "the close found no client", because
    /// [Daemon adoption] puts a sink-less client in `sessions` for every owned
    /// id at launch and would otherwise hide the race completely.
    pub creating: Mutex<std::collections::HashSet<SessionId>>,
    /// Sessions closed while their `create_session` was still in flight. The
    /// create consults this at the moment it would register a client, and stops
    /// the daemon instead of resurrecting a session whose row is already gone.
    pub closed_mid_create: Mutex<std::collections::HashSet<SessionId>>,
    /// The [Integration]: what the user agreed Kriyon adds to Claude Code, and
    /// where the hooks went — read at each session spawn for the companion
    /// folder's env.
    pub integration: Mutex<crate::integration::IntegrationState>,
    /// Sessions whose shell has the companion bridge socket in its env — the
    /// only ones whose mod can reach Kriyon.
    pub bridged: Mutex<std::collections::HashSet<SessionId>>,
    /// Each session's [Handoff file] detector, fed every live hook event.
    pub handoffs: Mutex<HashMap<SessionId, kriyon_core::handoff::HandoffFileWatch>>,
    /// The cached [Limit reading]s behind the account's [Plan limits].
    pub plan_limits: Mutex<crate::plan_limits_rt::LimitsReader>,
}

/// Managed handle to the [`Store`]. The connection is not `Sync`, so it is
/// guarded by a mutex.
pub struct StoreState(pub Mutex<Store>);

/// Payload for the `session-heartbeat` event: a session id plus the wall-clock
/// time (ms since epoch) of its watch's most recent pump. A stalling value lets
/// the frontend detect a watch whose pump thread has died.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatPayload {
    session_id: String,
    last_seen_ms: u64,
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! You've been greeted from Rust!")
}

/// Refresh the menu-bar attention badge: how many sessions currently need the
/// user. Each [Session runtime] owns its own `needs_you()` (Waiting status OR
/// an open ask — the same flag the popover rows carry), so the count is a
/// single pass over the one runtimes map; no cross-map union, no dedup.
///
/// Called both on the 2s ticker (as a backstop) and event-driven — on every
/// committed status change, ask change, and on `close_session` — so the count
/// never lags a real transition by up to a tick. `tray.set_title` marshals to
/// the main thread internally (Tauri wraps it in `run_item_main_thread!`), so
/// calling this from the ticker thread or a command thread is safe.
pub(crate) fn refresh_needs_you_badge<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) {
    let state = handle.state::<AppState>();
    let (needs_you, running) = {
        let runtimes = state.runtimes.lock();
        runtimes.values().fold((0_usize, 0_usize), |(n, r), rt| {
            (
                n + usize::from(rt.needs_you()),
                r + usize::from(rt.is_running()),
            )
        })
    };
    if let Some(tray) = handle.tray_by_id("main") {
        let _ = tray.set_title(kriyon_core::tray_badge::tray_title(needs_you, running).as_deref());
    }
}

/// How often the background ticker runs. Everything slower is expressed as a
/// multiple of this, in [`SAMPLE_EVERY_N_TICKS`].
const TICK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

/// How many ticks between [Session footprint] samples and [Sleeping session]
/// passes — 6s: fresh enough for a sidebar chip, cheap enough to never matter
/// itself. They share the tick so they also share one cached `ps` sweep.
const SAMPLE_EVERY_N_TICKS: u64 = 3;

/// How many ticks between [Orphan daemon] passes — a minute. An orphan is only
/// asked to stop on its second consecutive sighting, so a close whose `Shutdown`
/// never arrived is cleaned up within two minutes instead of at the next launch,
/// which for an app left open for weeks is never.
const REAP_EVERY_N_TICKS: u64 = 30;

/// One pass of the background ticker: the periodic work that has no event to
/// trigger it. `tick` counts from 1 and selects the slower cadences.
///
/// Extracted from `run`'s setup closure so the schedule is readable as a
/// schedule — which work runs at which cadence — instead of a modulus buried
/// mid-loop, and so adding a pass does not re-indent the whole block.
fn background_tick<R: tauri::Runtime>(app: &tauri::AppHandle<R>, tick: u64) {
    // Idle -> Waiting/Done transitions, for sessions whose transcript is quiet.
    let ids: Vec<SessionId> = {
        let state = app.state::<AppState>();
        let runtimes = state.runtimes.lock();
        runtimes.keys().cloned().collect()
    };
    for id in &ids {
        crate::status_rt::recompute_and_emit(app, id);
    }

    refresh_needs_you_badge(app);
    crate::plan_limits_rt::poll_and_emit(app, tick);

    if tick.is_multiple_of(SAMPLE_EVERY_N_TICKS) {
        crate::memory::sample_and_emit(app);
        crate::sleep_rt::sleep_pass(app);
    }

    if tick.is_multiple_of(REAP_EVERY_N_TICKS) {
        crate::daemon_rt::lifecycle_pass(app, false);
    }

    emit_watch_heartbeats(app);
}

/// Emit a liveness heartbeat per live watch, so the frontend can detect a watch
/// whose pump thread has died. The (id, last-pump) pairs are snapshotted under
/// the watchers lock and it is dropped before emitting, so no two state locks
/// are ever held at once.
fn emit_watch_heartbeats<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Emitter as _;

    let beats: Vec<(SessionId, u64)> = {
        let state = app.state::<AppState>();
        let watchers = state.watchers.lock();
        watchers
            .iter()
            .map(|(id, watch)| (id.clone(), watch.last_pump_millis()))
            .collect()
    };
    for (id, last_seen_ms) in beats {
        let _ = app.emit(
            "session-heartbeat",
            HeartbeatPayload {
                session_id: id.0,
                last_seen_ms,
            },
        );
    }
}

/// Builds and runs the Tauri application.
///
/// # Panics
///
/// Panics if the Tauri application fails to start.
// A Tauri builder chain plus setup + the full command-handler list is
// inherently long; keeping it as one linear function is clearer than splitting
// the builder across helpers.
#[allow(clippy::too_many_lines)]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .menu(crate::menu::build)
        .on_menu_event(|app, event| crate::menu::on_event(app, &event))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_positioner::init())
        .manage(AppState::default())
        .manage(attachment_cmd::AttachmentRegistry::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(drag) = event {
                if window.label() == "main" {
                    attachment_cmd::on_drag_drop(window, drag);
                }
            }
            // Track the main window's focus so the notification gate knows
            // whether the active session is actually on screen. The tray
            // popover is a separate window; ignore its focus changes.
            if let tauri::WindowEvent::Focused(focused) = event {
                if window.label() == "main" {
                    *window.state::<AppState>().window_focused.lock() = *focused;
                    eprintln!("kriyon: window 'main' focused={focused}");
                }
            }
        })
        .setup(|app| {
            // Put AppKit's missing `@catch` back under tao's `sendEvent:`
            // overrides before the first event is dispatched, so an AppKit
            // assertion failure costs one event instead of the whole app.
            crate::appkit_guard::install();

            // The app launches with the main window frontmost; seed the flag so
            // the very first notification decision is correct even before any
            // `Focused` event arrives.
            *app.state::<AppState>().window_focused.lock() = true;

            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let store = Store::open(&data_dir.join("kriyon.db"))
                .map_err(|e| -> Box<dyn std::error::Error> { Box::new(e) })?;
            app.manage(StoreState(Mutex::new(store)));
            crate::activity_rt::open(&data_dir);
            crate::attachment_cmd::init(app.handle());

            // Request notification authorization and install the click-routing
            // delegate for the macOS UserNotifications framework (see
            // `notify::init`); a no-op off macOS.
            crate::notify::init(app.handle());

            // Install Claude Code hooks so Kriyon receives live session status.
            // Best-effort: a failure here (e.g. unreadable settings.json) must
            // not stop the app from launching — status simply won't update.
            if let Ok(home) = app.path().home_dir() {
                crate::integration::startup(app.handle(), &home);
                // Logged commands and tool output: owner-only, including the
                // files older builds wrote world-readable.
                if let Err(e) =
                    kriyon_core::private_fs::lock_down(&kriyon_core::paths::kriyon_dir(&home))
                {
                    eprintln!("kriyon: failed to lock down ~/.claude/kriyon: {e}");
                }
            }
            if let Ok(home) = app.path().home_dir() {
                crate::activity_rt::spawn_ingester(app.handle().clone(), home.clone());
            }
            if let Err(e) = kriyon_core::private_fs::lock_down(&data_dir) {
                eprintln!("kriyon: failed to lock down the app data folder: {e}");
            }

            // Before any UI exists: stop the daemons nothing owns any more, then
            // attach to the ones that survived a [Handover] so memory, auto-sleep
            // and close all see them even if the user never opens them. Off the
            // main thread — both do blocking socket and process-table IO, and
            // neither is allowed to delay launch.
            let lifecycle = app.handle().clone();
            std::thread::spawn(move || {
                crate::daemon_rt::lifecycle_pass(&lifecycle, true);
            });

            // One background ticker drives idle -> Waiting/Done transitions
            // when no new transcript events arrive to trigger a recompute.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut tick: u64 = 0;
                loop {
                    std::thread::sleep(TICK_INTERVAL);
                    tick += 1;
                    background_tick(&handle, tick);
                }
            });

            // The menu-bar quick view (macOS). Best-effort: a tray failure must
            // not stop the app from launching.
            if let Err(e) = crate::tray::build(app) {
                eprintln!("kriyon: failed to build tray: {e}");
            }

            // The in-app updater, in release builds: a quiet check 5 seconds
            // after launch, then every 6 hours. Never installs without asking.
            crate::update_rt::init(app);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            activity_rt::activity_turns,
            activity_rt::activity_step,
            activity_rt::activity_stats,
            activity_rt::activity_delete_session,
            activity_rt::take_session_requests,
            activity_rt::nested_outcome,
            activity_rt::activity_delete_all,
            integration::integration_status,
            integration::integration_set,
            integration::companion_status,
            structured_cmd::structured_turns,
            commands::create_session,
            commands::write_stdin,
            commands::resize_pty,
            commands::request_repaint,
            commands::close_session,
            commands::sleep_idle_sessions,
            commands::report_drained,
            commands::watch_transcript,
            git_cmd::repo_status,
            git_cmd::create_worktree,
            git_cmd::remove_worktree,
            git_cmd::default_branch,
            git_cmd::unmerged_commits,
            git_cmd::diff_worktree,
            git_cmd::diff_working_tree,
            git_cmd::merge_worktree,
            git_cmd::capture_baseline,
            git_cmd::diff_session_changes,
            git_cmd::repo_toplevel,
            git_cmd::read_baseline,
            git_cmd::discard_file_changes,
            entry_cmd::create_file,
            entry_cmd::create_dir,
            entry_cmd::rename_entry,
            entry_cmd::delete_entry,
            git_cmd::watch_working_tree,
            git_cmd::unwatch_working_tree,
            commands::worktree_path,
            commands::bootstrap_worktree,
            commands::seed_prompt,
            store_cmd::save_layout,
            store_cmd::load_layout,
            store_cmd::upsert_project,
            store_cmd::list_projects,
            store_cmd::upsert_session,
            store_cmd::list_sessions,
            store_cmd::delete_session,
            prompt_cmd::upsert_prompt,
            prompt_cmd::list_prompts,
            prompt_cmd::delete_prompt,
            prompt_cmd::record_prompt_use,
            prompt_cmd::promote_prompt_to_command,
            prompt_cmd::import_commands,
            completion_cmd::list_slash_commands,
            completion_cmd::list_files,
            completion_cmd::prompt_history,
            file_cmd::read_file,
            file_cmd::list_dir,
            file_cmd::write_file,
            commands::set_focused_session,
            settings_cmd::set_notify_preference,
            settings_cmd::set_notify_sound,
            settings_cmd::set_memory_budget,
            settings_cmd::set_auto_sleep,
            settings_cmd::preview_notify_sound,
            commands::home_dir,
            commands::list_past_sessions,
            window_cmd::read_clipboard,
            window_cmd::reveal_session,
            window_cmd::show_main_window,
            window_cmd::new_session,
            window_cmd::open_preferences,
            window_cmd::quit_app,
            window_cmd::session_snapshots,
            links_cmd::open_path,
            attachment_cmd::pick_attachments,
            attachment_cmd::clipboard_attachments,
            attachment_cmd::save_pasted_image,
            attachment_cmd::attachment_preview,
            attachment_cmd::submit_prompt,
            commands::note_interrupted,
            commands::note_turn_ended,
            structured_cmd::structured_partial,
            links_cmd::open_in_editor,
            update_cmd::update_status,
            update_cmd::check_for_update,
            update_cmd::set_update_prefs,
            update_cmd::skip_update,
            update_cmd::install_update
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // The one event every orderly exit reaches on macOS — ⌘Q, the Dock's
            // Quit and a logout all skip `ExitRequested`. Managed state is never
            // dropped on exit, so this is the only place sessions can be stopped.
            if matches!(event, tauri::RunEvent::Exit) {
                crate::quit::stop_sessions_on_exit(app);
            }
        });
}
