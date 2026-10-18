//! The in-app updater: checking the chosen [Update channel]'s [Update feed],
//! holding what it offers, and installing it with a restart that is a
//! [Handover], so live sessions survive it.
//!
//! Update checks are network access and the restart is process control, so
//! both live here behind the `update_*` commands; the webview gets no updater
//! or process permission. What counts as an offer is decided by
//! `kriyon_core::update` (ADR 0047).

use std::path::{Path, PathBuf};
use std::time::Duration;

use kriyon_core::update::{offer, recheck, CheckKind, Offer, UpdateChannel, UpdatePrefs};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{Emitter as _, Manager as _};
use tauri_plugin_updater::UpdaterExt as _;

use crate::StoreState;

/// The `app_state` key the [`UpdatePrefs`] are kept under.
const PREFS_KEY: &str = "updates";
/// The first quiet check waits this long, so launch is never held up by it.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(5);
/// Quiet checks after the first.
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 3600);
/// A feed that doesn't answer in this long is treated as down.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// A download that hasn't finished in this long has stalled. The update file
/// is tens of megabytes, so this is generous even on a slow line.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// A release the feed offers, as the webview sees it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub version: String,
    /// The release notes from the feed, Markdown.
    pub notes: Option<String>,
    pub offer: Offer,
    /// Whether "Install & restart" can install it ([`Offer::installable`]).
    pub installable: bool,
}

/// Everything the Settings section, the pill and the dialog show. Sent whole
/// on every change as `update-changed`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSnapshot {
    /// Whether this build can update itself. Only release builds carry the
    /// update key (`tauri.updater.conf.json`).
    pub supported: bool,
    pub running: String,
    pub prefs: UpdatePrefs,
    pub checking: bool,
    pub available: Option<AvailableUpdate>,
    /// Why the last check failed, if it did.
    pub error: Option<String>,
    /// When the last check finished, ms since the epoch.
    pub last_checked_ms: Option<u64>,
}

/// Download progress, sent over the install command's channel.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

#[derive(Default)]
struct Inner {
    prefs: UpdatePrefs,
    checking: bool,
    installing: bool,
    available: Option<AvailableUpdate>,
    /// The plugin's handle on `available`, for the install.
    pending: Option<tauri_plugin_updater::Update>,
    error: Option<String>,
    last_checked_ms: Option<u64>,
    /// The user moved channel and no check of the new feed has finished yet.
    /// The one that does sends `update-channel-answered`, which opens the
    /// switch prompt.
    move_unanswered: bool,
}

/// What a finished feed read means for the check that made it.
#[derive(Debug, PartialEq, Eq)]
enum Landing {
    /// The prefs changed under it: read the feed again, of this kind, for these prefs.
    Again(CheckKind, UpdatePrefs),
    /// Stored. `answers_move`: it is the first result for a channel move.
    Done { answers_move: bool },
}

type FeedResult = Result<Option<(AvailableUpdate, tauri_plugin_updater::Update)>, String>;

impl Inner {
    /// Whether a check may start, and the prefs it reads. The one gate for
    /// every check. After a channel `moved`, it also records that the move
    /// waits for an answer, unless no check can give one.
    fn start(&mut self, supported: bool, moved: bool) -> Option<UpdatePrefs> {
        if !supported || self.installing {
            return None;
        }
        if moved {
            self.move_unanswered = true;
        }
        // A running check reads the new prefs itself ([`recheck`]).
        if self.checking {
            return None;
        }
        self.checking = true;
        Some(self.prefs.clone())
    }

    /// Take in a feed read made under the `started` prefs, unless the prefs
    /// changed under it ([`recheck`]).
    fn land(&mut self, started: &UpdatePrefs, result: FeedResult) -> Landing {
        if let Some(kind) = recheck(started, &self.prefs) {
            return Landing::Again(kind, self.prefs.clone());
        }
        self.checking = false;
        self.last_checked_ms = Some(now_ms());
        match result {
            Ok(found) => {
                self.error = None;
                self.available = found.as_ref().map(|(shown, _)| shown.clone());
                self.pending = found.map(|(_, update)| update);
            }
            // A failed quiet check keeps what an earlier one found.
            Err(e) => self.error = Some(e),
        }
        let answers_move = std::mem::take(&mut self.move_unanswered);
        Landing::Done { answers_move }
    }
}

/// Managed updater state.
#[derive(Default)]
pub struct UpdateState(Mutex<Inner>);

/// Whether this build carries the updater plugin's config. Debug builds and
/// unsigned local builds don't, and the plugin refuses to start without its
/// public key.
pub fn supported<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    app.config().plugins.0.contains_key("updater")
}

/// Register the updater plugin when this build can use it, load the saved
/// [`UpdatePrefs`] and start the quiet checks. Best-effort: an updater that
/// can't start leaves the app running without updates.
pub fn init(app: &tauri::App) {
    app.manage(UpdateState::default());
    let prefs = load_prefs(app.handle());
    app.state::<UpdateState>().0.lock().prefs = prefs;
    if !supported(app.handle()) {
        return;
    }
    if let Err(e) = app
        .handle()
        .plugin(tauri_plugin_updater::Builder::new().build())
    {
        eprintln!("kriyon: updater plugin failed to start: {e}");
        return;
    }
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_DELAY);
        loop {
            let auto = handle.state::<UpdateState>().0.lock().prefs.auto_check;
            if auto {
                let _ = tauri::async_runtime::block_on(check(&handle, CheckKind::Quiet));
            }
            std::thread::sleep(CHECK_INTERVAL);
        }
    });
}

fn load_prefs<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> UpdatePrefs {
    let saved = app
        .state::<StoreState>()
        .0
        .lock()
        .load_layout(PREFS_KEY)
        .ok()
        .flatten();
    // Unreadable prefs fall back to the defaults rather than stopping updates.
    saved
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn save_prefs<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    prefs: &UpdatePrefs,
) -> Result<(), String> {
    let json = serde_json::to_string(prefs).map_err(|e| e.to_string())?;
    app.state::<StoreState>()
        .0
        .lock()
        .save_layout(PREFS_KEY, &json)
        .map_err(|e| e.to_string())
}

/// The current snapshot.
#[must_use]
pub fn snapshot<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> UpdateSnapshot {
    let inner = app.state::<UpdateState>();
    let inner = inner.0.lock();
    UpdateSnapshot {
        supported: supported(app),
        running: app.package_info().version.to_string(),
        prefs: inner.prefs.clone(),
        checking: inner.checking,
        available: inner.available.clone(),
        error: inner.error.clone(),
        last_checked_ms: inner.last_checked_ms,
    }
}

fn changed<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> UpdateSnapshot {
    let snap = snapshot(app);
    let _ = app.emit("update-changed", snap.clone());
    snap
}

/// The feed to read for `channel`. A build made with the `local-feed`
/// feature (never a shipped one) reads `KRIYON_UPDATE_FEED` instead, to test
/// the update loop against a feed served on this machine.
fn feed_url(channel: UpdateChannel) -> Result<tauri::Url, String> {
    #[cfg(feature = "local-feed")]
    if let Ok(url) = std::env::var("KRIYON_UPDATE_FEED") {
        return url.parse().map_err(|e| format!("KRIYON_UPDATE_FEED: {e}"));
    }
    channel.feed_url().parse().map_err(|e| format!("{e}"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Check the chosen channel's feed. A check already running answers with the
/// current snapshot instead of starting another; it reads the feed again
/// itself if the prefs change under it ([`recheck`]).
pub async fn check<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    kind: CheckKind,
) -> UpdateSnapshot {
    run_check(app, kind, false).await
}

async fn run_check<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    kind: CheckKind,
    moved: bool,
) -> UpdateSnapshot {
    let mut kind = kind;
    let started = app
        .state::<UpdateState>()
        .0
        .lock()
        .start(supported(app), moved);
    let Some(mut prefs) = started else {
        return snapshot(app);
    };
    changed(app);

    loop {
        let result = fetch(app, &prefs, kind).await;
        let landing = app.state::<UpdateState>().0.lock().land(&prefs, result);
        match landing {
            Landing::Again(next_kind, next_prefs) => {
                kind = next_kind;
                prefs = next_prefs;
            }
            Landing::Done { answers_move } => return finish(app, answers_move),
        }
    }
}

/// Tell the webview a check is done. The first result after a channel move
/// also goes out as `update-channel-answered`, which opens the switch prompt.
fn finish<R: tauri::Runtime>(app: &tauri::AppHandle<R>, answers_move: bool) -> UpdateSnapshot {
    let snap = changed(app);
    if answers_move {
        let _ = app.emit("update-channel-answered", snap.clone());
    }
    snap
}

async fn fetch<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    prefs: &UpdatePrefs,
    kind: CheckKind,
) -> Result<Option<(AvailableUpdate, tauri_plugin_updater::Update)>, String> {
    let running = app.package_info().version.clone();
    let rules = prefs.clone();
    let update = app
        .updater_builder()
        .endpoints(vec![feed_url(prefs.channel)?])
        .map_err(|e| e.to_string())?
        .timeout(CHECK_TIMEOUT)
        .version_comparator(move |current, release| {
            offer(&current, &release.version, &rules, kind).is_some()
        })
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let Some(update) = update else {
        return Ok(None);
    };
    let remote = semver::Version::parse(&update.version).map_err(|e| e.to_string())?;
    let offer = offer(&running, &remote, prefs, kind);
    let shown = AvailableUpdate {
        version: update.version.clone(),
        notes: update.body.clone(),
        offer,
        installable: offer.installable(),
    };
    Ok(Some((shown, update)))
}

/// Save new prefs. A channel change checks the new feed straight away, as an
/// asked check, so a [Channel step-down] is offered while the user is there.
///
/// # Errors
/// When the prefs can't be saved.
pub async fn set_prefs<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    channel: UpdateChannel,
    auto_check: bool,
) -> Result<UpdateSnapshot, String> {
    let current = app.state::<UpdateState>().0.lock().prefs.clone();
    let prefs = UpdatePrefs {
        channel,
        auto_check,
        ..current.clone()
    };
    // Saved first, so a failed save changes nothing anywhere.
    save_prefs(app, &prefs)?;
    let moved = current.channel != channel;
    {
        let state = app.state::<UpdateState>();
        let mut inner = state.0.lock();
        inner.prefs = prefs;
        if moved {
            inner.available = None;
            inner.pending = None;
            inner.error = None;
        }
    }
    if moved {
        Ok(run_check(app, CheckKind::Asked, true).await)
    } else {
        Ok(changed(app))
    }
}

/// Mark `version` as the [Skipped version]. It must be the one on offer.
///
/// # Errors
/// When `version` is not the one on offer, or the prefs can't be saved.
pub fn skip<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    version: &str,
) -> Result<UpdateSnapshot, String> {
    let prefs = {
        let inner = app.state::<UpdateState>();
        let inner = inner.0.lock();
        let on_offer = inner
            .available
            .as_ref()
            .is_some_and(|shown| shown.version == version);
        if !on_offer {
            return Err(format!("{version} is not the version on offer"));
        }
        UpdatePrefs {
            skipped: Some(version.to_string()),
            ..inner.prefs.clone()
        }
    };
    // Saved first, so a failed save changes nothing anywhere.
    save_prefs(app, &prefs)?;
    {
        let state = app.state::<UpdateState>();
        let mut inner = state.0.lock();
        inner.prefs = prefs;
        inner.available = None;
        inner.pending = None;
    }
    Ok(changed(app))
}

/// Download and install the update on offer, then restart into it.
///
/// A [Channel step-down] backs up the data folder first. The restart is a
/// [Handover]: sessions keep running under their daemons and the new build
/// reattaches to them.
///
/// # Errors
/// When nothing installable is on offer, or the backup, download or install
/// fails. On success the app restarts.
pub async fn install<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    on_progress: tauri::ipc::Channel<DownloadProgress>,
) -> Result<(), String> {
    let (shown, update) = {
        let state = app.state::<UpdateState>();
        let mut inner = state.0.lock();
        if inner.installing {
            return Err("an update is already installing".to_string());
        }
        let Some(shown) = inner.available.clone() else {
            return Err("no update is on offer".to_string());
        };
        if !shown.installable {
            return Err(format!(
                "{} can't be installed over this build",
                shown.version
            ));
        }
        let Some(mut update) = inner.pending.clone() else {
            return Err("no update is on offer".to_string());
        };
        inner.installing = true;
        // The builder's timeout covers only the check; without its own the
        // download waits forever on a stalled line.
        update.timeout = Some(DOWNLOAD_TIMEOUT);
        (shown, update)
    };
    let result = download_and_install(app, &shown, &update, &on_progress).await;
    if let Err(e) = result {
        app.state::<UpdateState>().0.lock().installing = false;
        changed(app);
        return Err(e);
    }
    *app.state::<crate::AppState>().quit_intent.lock() = kriyon_core::quit::QuitIntent::Handover;
    app.request_restart();
    Ok(())
}

async fn download_and_install<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    shown: &AvailableUpdate,
    update: &tauri_plugin_updater::Update,
    on_progress: &tauri::ipc::Channel<DownloadProgress>,
) -> Result<(), String> {
    if shown.offer == Offer::StepDown {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let running = app.package_info().version.to_string();
        let backup = back_up_data(&data_dir, &running, now_ms())
            .map_err(|e| format!("couldn't back up the data folder: {e}"))?;
        eprintln!("kriyon: backed up the data folder to {}", backup.display());
    }
    let mut downloaded: u64 = 0;
    let mut last_sent: u64 = 0;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                // About every 256 KB, so a fast download doesn't flood the channel.
                if downloaded - last_sent >= 256 * 1024 || Some(downloaded) == total {
                    last_sent = downloaded;
                    let _ = on_progress.send(DownloadProgress { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    update.install(bytes).map_err(|e| e.to_string())
}

/// Copy every `SQLite` database in `data_dir` into
/// `backups/<running>-<now_ms>/`, as a consistent snapshot even while the app
/// has it open. Attachments are plain files no build changes the format of,
/// so they stay where they are.
///
/// # Errors
/// When the backup folder can't be made or a database can't be copied.
pub fn back_up_data(data_dir: &Path, running: &str, now_ms: u64) -> Result<PathBuf, String> {
    let target = data_dir.join("backups").join(format!("{running}-{now_ms}"));
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    let entries = std::fs::read_dir(data_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().is_none_or(|ext| ext != "db") {
            continue;
        }
        let into = target.join(entry.file_name());
        let conn = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| format!("{}: {e}", path.display()))?;
        conn.execute("VACUUM INTO ?1", [into.to_string_lossy()])
            .map_err(|e| format!("{}: {e}", path.display()))?;
    }
    let _ = kriyon_core::private_fs::lock_down(&target);
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    /// An app with no updater config, as debug builds have: no check ever
    /// reaches the network.
    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(UpdateState::default());
        app.manage(crate::AppState::default());
        app.manage(StoreState(parking_lot::Mutex::new(
            Store::open_in_memory().expect("in-memory store"),
        )));
        app
    }

    /// A mock app whose config carries the updater, as a release build's
    /// does. The plugin itself isn't registered: these tests never reach
    /// the network.
    fn release_app() -> tauri::App<tauri::test::MockRuntime> {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".to_string(),
            serde_json::json!({ "pubkey": "test" }),
        );
        let app = tauri::test::mock_builder()
            .build(context)
            .expect("mock app");
        app.manage(UpdateState::default());
        app.manage(crate::AppState::default());
        app.manage(StoreState(parking_lot::Mutex::new(
            Store::open_in_memory().expect("in-memory store"),
        )));
        app
    }

    fn move_to_beta(app: &tauri::App<tauri::test::MockRuntime>) -> bool {
        tauri::async_runtime::block_on(set_prefs(app.handle(), UpdateChannel::Beta, true))
            .expect("prefs");
        app.state::<UpdateState>().0.lock().move_unanswered
    }

    #[test]
    fn a_move_during_a_running_check_waits_for_that_check() {
        let app = release_app();
        app.state::<UpdateState>().0.lock().checking = true;
        assert!(move_to_beta(&app), "the running check reads Beta next");
    }

    #[test]
    fn a_move_no_check_can_answer_owes_nothing() {
        let installing = release_app();
        installing.state::<UpdateState>().0.lock().installing = true;
        assert!(!move_to_beta(&installing), "no check runs while installing");
        assert!(!move_to_beta(&mock_app()), "a build with no updater");
    }

    #[test]
    fn the_answer_to_a_move_is_sent_once_as_its_own_event() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tauri::Listener as _;
        let app = release_app();
        let heard = std::sync::Arc::new(AtomicUsize::new(0));
        let count = std::sync::Arc::clone(&heard);
        app.listen("update-channel-answered", move |_| {
            count.fetch_add(1, Ordering::SeqCst);
        });

        finish(app.handle(), true);
        finish(app.handle(), false);

        assert_eq!(heard.load(Ordering::SeqCst), 1);
    }

    fn offering(app: &tauri::App<tauri::test::MockRuntime>, version: &str, offer: Offer) {
        app.state::<UpdateState>().0.lock().available = Some(AvailableUpdate {
            version: version.to_string(),
            notes: None,
            offer,
            installable: offer.installable(),
        });
    }

    fn no_progress() -> tauri::ipc::Channel<DownloadProgress> {
        tauri::ipc::Channel::new(|_| Ok(()))
    }

    fn on(channel: UpdateChannel) -> UpdatePrefs {
        UpdatePrefs {
            channel,
            ..UpdatePrefs::default()
        }
    }

    #[test]
    fn the_check_that_ends_after_a_move_answers_it_once() {
        let mut inner = Inner {
            prefs: on(UpdateChannel::Beta),
            checking: true,
            move_unanswered: true,
            ..Inner::default()
        };

        let first = inner.land(&on(UpdateChannel::Beta), Ok(None));
        assert_eq!(first, Landing::Done { answers_move: true });
        assert!(!inner.checking);

        inner.checking = true;
        let later = inner.land(&on(UpdateChannel::Beta), Ok(None));
        assert_eq!(
            later,
            Landing::Done {
                answers_move: false
            }
        );
    }

    #[test]
    fn a_check_of_the_old_channel_never_answers_the_move() {
        // A check of the nightly feed was running when the user picked Beta.
        let mut inner = Inner {
            prefs: on(UpdateChannel::Beta),
            checking: true,
            move_unanswered: true,
            ..Inner::default()
        };

        let landing = inner.land(&on(UpdateChannel::Nightly), Ok(None));

        assert_eq!(
            landing,
            Landing::Again(CheckKind::Asked, on(UpdateChannel::Beta))
        );
        assert!(inner.checking, "still checking: the new feed is next");
        assert!(inner.move_unanswered);
    }

    #[test]
    fn a_failed_check_still_answers_the_move() {
        let mut inner = Inner {
            prefs: on(UpdateChannel::Beta),
            checking: true,
            move_unanswered: true,
            ..Inner::default()
        };
        let landing = inner.land(&on(UpdateChannel::Beta), Err("offline".to_string()));
        assert_eq!(landing, Landing::Done { answers_move: true });
        assert_eq!(inner.error.as_deref(), Some("offline"));
    }

    #[test]
    fn skip_takes_only_the_version_on_offer_and_saves_it() {
        let app = mock_app();
        offering(&app, "0.13.0", Offer::Upgrade);

        assert!(skip(app.handle(), "0.99.0").is_err());
        let snap = skip(app.handle(), "0.13.0").expect("skip");

        assert!(snap.available.is_none());
        assert_eq!(snap.prefs.skipped.as_deref(), Some("0.13.0"));
        assert_eq!(load_prefs(app.handle()).skipped.as_deref(), Some("0.13.0"));
    }

    #[test]
    fn install_refuses_what_it_cannot_install() {
        let app = mock_app();
        let install_now = || tauri::async_runtime::block_on(install(app.handle(), no_progress()));
        assert!(install_now().is_err(), "nothing on offer");

        offering(&app, "0.12.4", Offer::WaitForChannel);
        assert_eq!(
            install_now().expect_err("a step-down that must wait"),
            "0.12.4 can't be installed over this build"
        );

        app.state::<UpdateState>().0.lock().installing = true;
        offering(&app, "0.13.0", Offer::Upgrade);
        assert_eq!(
            install_now().expect_err("already installing"),
            "an update is already installing"
        );
        assert!(app.state::<UpdateState>().0.lock().installing);
    }

    #[test]
    fn a_channel_move_drops_the_offer_and_other_changes_keep_it() {
        let app = mock_app();
        offering(&app, "0.13.0", Offer::Upgrade);

        let same =
            tauri::async_runtime::block_on(set_prefs(app.handle(), UpdateChannel::Stable, false))
                .expect("prefs");
        assert!(same.available.is_some(), "auto-check alone keeps the offer");
        assert!(!same.prefs.auto_check);

        let moved =
            tauri::async_runtime::block_on(set_prefs(app.handle(), UpdateChannel::Beta, false))
                .expect("prefs");
        assert!(moved.available.is_none(), "another feed's offer is dropped");
        assert_eq!(load_prefs(app.handle()).channel, UpdateChannel::Beta);
    }

    #[test]
    fn a_backup_copies_every_database_and_nothing_else() {
        let dir = tempfile::tempdir().expect("tmp dir");
        for name in ["kriyon.db", "activity.db"] {
            let conn = rusqlite::Connection::open(dir.path().join(name)).expect("open");
            conn.execute_batch(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept');",
            )
            .expect("seed");
            // Held open, as the running app holds its stores.
            std::mem::forget(conn);
        }
        std::fs::create_dir(dir.path().join("attachments")).expect("attachments");
        std::fs::write(dir.path().join("notes.txt"), "x").expect("file");

        let backup = back_up_data(dir.path(), "0.13.0-beta.2", 42).expect("backup");

        assert_eq!(backup, dir.path().join("backups/0.13.0-beta.2-42"));
        let mut names: Vec<String> = std::fs::read_dir(&backup)
            .expect("read")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["activity.db", "kriyon.db"]);
        let copy = rusqlite::Connection::open(backup.join("kriyon.db")).expect("copy");
        let v: String = copy
            .query_row("SELECT v FROM t", [], |row| row.get(0))
            .expect("row");
        assert_eq!(v, "kept");
    }
}
