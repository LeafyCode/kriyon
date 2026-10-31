//! Tauri commands for the session lifecycle: create, write, resize, close,
//! plus the transcript watch, worktree bootstrap, and past-session history
//! that ride along with a session's identity. The persistence, prompt,
//! settings, and window/tray command families that used to live in this file
//! now have their own homes — `store_cmd`, `prompt_cmd`, `settings_cmd`, and
//! `window_cmd` — split out purely by placement (same commands, same
//! behavior). `resolve_home` stays here rather than moving with any one
//! family because `completion_cmd`, `git_cmd`, and `links_cmd` all depend on
//! it too.

use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use kriyon_core::session::{SessionEngine, SessionId, SpawnSpec};

use crate::bootstrap_cmd::{bootstrap_worktree as run_bootstrap, BootstrapReport};
use crate::daemon_client::DaemonClient;
use crate::session_registry::{self, CreateInFlight};
use crate::{AppState, Session, StoreState};

const INITIAL_COLS: u16 = 80;
const INITIAL_ROWS: u16 = 24;
/// How long to wait for a freshly-spawned daemon's socket to become connectable.
const DAEMON_READY_TIMEOUT: Duration = Duration::from_secs(5);

/// Resolve the `kriyon-ptyd` binary: `$KRIYON_PTYD_BIN`, else a sibling of the
/// app executable (where the bundler and the dev build both place it).
fn ptyd_binary() -> PathBuf {
    if let Ok(path) = std::env::var("KRIYON_PTYD_BIN") {
        return PathBuf::from(path);
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("kriyon-ptyd")))
        .unwrap_or_else(|| PathBuf::from("kriyon-ptyd"))
}

/// This app's daemon run directory under `~/.claude/kriyon/` — `run` for the
/// released app, `run-<identifier>` for any other build, so two builds with
/// separate stores never see (and reap) each other's daemons. See
/// [`kriyon_core::daemon::run_dir_name`].
///
/// # Errors
/// Returns an error string if the configured bundle identifier is not a plain
/// identifier (it would otherwise be interpolated into a path).
pub(crate) fn run_dir<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    home: &Path,
) -> Result<PathBuf, String> {
    let name = kriyon_core::daemon::run_dir_name(&app.config().identifier)
        .ok_or_else(|| "invalid bundle identifier".to_string())?;
    Ok(kriyon_core::paths::kriyon_dir(home).join(name))
}

/// The path of a session's seed-prompt file, `<run>/<id>.prompt`, or `None` if
/// `id` is not a valid session id. Reuses `session_socket_path`'s validation
/// (which enforces path containment) and swaps the extension, so the prompt file
/// is guaranteed to sit beside the socket inside the run dir.
fn seed_prompt_path(run: &Path, id: &str) -> Option<PathBuf> {
    kriyon_core::daemon::session_socket_path(run, id).map(|s| s.with_extension("prompt"))
}

/// Spawn a detached daemon for `id` and wait for its socket to appear. The
/// daemon runs in its own process group so it outlives the app — the basis of
/// crash-survival. Its stderr goes to a per-session log for diagnosis; stdout is
/// discarded. The caller does the single real connect once the socket exists.
///
/// We deliberately do NOT probe the socket with a throwaway `connect` here: the
/// daemon accepts any connection as a client and replays-then-clears its
/// scrollback ring, so a probe would drain the boot output before the real
/// client connects. We wait on the socket *file* instead (`bind` == `listen` for
/// a `UnixListener`).
fn spawn_daemon(socket: &Path, run: &Path, id: &str, spec: &SpawnSpec) -> Result<(), String> {
    // A leftover socket file from an unclean prior exit must go before the new
    // daemon binds (the daemon also removes it) so we detect its re-creation.
    let _ = std::fs::remove_file(socket);
    // And its companion bridge's, so a stale one is never taken for live.
    if let Some(bridge) = crate::integration::bridge_socket(socket) {
        let _ = std::fs::remove_file(bridge);
    }

    let mut cmd = std::process::Command::new(ptyd_binary());
    cmd.arg("--socket")
        .arg(socket)
        .args(["--id", id, "--cwd", &spec.cwd, "--shell", &spec.shell]);
    for (key, value) in &spec.env {
        cmd.env(key, value);
    }
    // Detach into its own process group so the daemon outlives the app, with no
    // inherited stdio pipe tying it to the parent.
    cmd.process_group(0)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null());
    // Keep the daemon's stderr for field diagnosis rather than discarding it.
    match std::fs::File::create(run.join(format!("{id}.log"))) {
        Ok(log) => {
            cmd.stderr(std::process::Stdio::from(log));
        }
        Err(_) => {
            cmd.stderr(std::process::Stdio::null());
        }
    }
    cmd.spawn().map_err(|e| format!("spawn daemon: {e}"))?;

    let deadline = Instant::now() + DAEMON_READY_TIMEOUT;
    loop {
        if socket.exists() {
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err("daemon socket never appeared".to_string());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Write `<dir>/<name>` with owner-only permissions (`0600` on unix).
///
/// The file is created fresh inside the freshly-`mkdir`'d (0700) temp dir, so
/// no other user can read or tamper with the rc we are about to source.
fn write_private_rc(dir: &Path, name: &str, contents: &str) -> std::io::Result<()> {
    use std::io::Write as _;

    let path = dir.join(name);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(contents.as_bytes())
}

/// Payload for the `session-hooks-off` event: the settings scope that turns
/// Kriyon's hooks off for a session, or `None` when they run.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HooksOffUpdate {
    session_id: String,
    scope: Option<kriyon_core::hooks::HooksOff>,
}

/// Record [Hooks off] on the session's runtime — so a stale status can't light
/// the menu-bar badge or count as running — and tell the frontend.
fn note_hooks_off(
    app: &tauri::AppHandle,
    state: &AppState,
    id: &str,
    scope: Option<kriyon_core::hooks::HooksOff>,
) {
    state
        .runtimes
        .lock()
        .entry(SessionId(id.to_string()))
        .or_default()
        .note_hooks_off(scope.is_some());
    crate::refresh_needs_you_badge(app);
    let _ = tauri::Emitter::emit(
        app,
        "session-hooks-off",
        HooksOffUpdate {
            session_id: id.to_string(),
            scope,
        },
    );
}

/// Create a new pty-backed session in `cwd`, streaming its output to
/// `on_output`.
///
/// The `id` is supplied by the frontend (the store's session UUID) and is used
/// verbatim as the `SessionId`, so the pty, the transcript watcher, the status
/// tracker, and the pending-ask cache all key on the same id and
/// `close_session(id)` tears them all down together.
///
/// Returns `true` if it reattached to a daemon that survived a previous app run
/// (its shell — and the `claude` already launched into it — are still live), and
/// `false` if it spawned a fresh daemon. The frontend uses this to avoid
/// re-launching `claude` into a session that already has it running.
///
/// # Errors
/// Returns an error string if writing the temporary `ZDOTDIR` fails, the daemon
/// cannot be spawned, or the session id is invalid.
// The reattach fast-path, the fresh-daemon path, and the full callback wiring
// are one cohesive lifecycle; splitting them across helpers would scatter the
// session-creation story rather than clarify it.
#[allow(clippy::too_many_lines)]
#[tauri::command]
pub async fn create_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    cwd: String,
    // Channel<Vec<u8>> rather than Channel<&[u8]>: the reader callback is
    // `'static`, so it cannot capture a borrowed-lifetime channel. The reader
    // reads each chunk straight into an owned `Vec`, so the callback moves that
    // buffer into the channel with no extra copy.
    on_output: tauri::ipc::Channel<Vec<u8>>,
    // Foreground-busy transitions (a command starts/stops in the shell), pushed
    // by the daemon and forwarded to the frontend so a Project terminal can show
    // and confirm running processes.
    on_busy: tauri::ipc::Channel<bool>,
    // Fired once if the session dies underneath the app (the shell exited or
    // the daemon crashed), so the UI can surface it instead of leaving a
    // silently wedged pane. Never fired for an app-initiated close/handover.
    on_exit: tauri::ipc::Channel<bool>,
) -> Result<bool, String> {
    // Every byte the session's pty produces passes here, which makes it the one
    // place that knows whether the terminal has actually stopped painting. The
    // notification path reads that to confirm a turn really settled before it
    // pings — a hook alone cannot tell "done" from "mid-sentence", because hook
    // events and pty bytes arrive on separate channels with no ordering between
    // them. See `SessionRuntime::notify_ready`.
    let output_app = app.clone();
    let output_id = SessionId(id.clone());
    // `claude` exits at startup when the org forbids the companion folder; the
    // message is the only sign, so the output is watched for it.
    let refusal = parking_lot::Mutex::new(kriyon_core::integration::RefusalWatch::default());
    let callback = move |bytes: Vec<u8>| {
        {
            use tauri::Manager as _;
            let state = output_app.state::<AppState>();
            let mut runtimes = state.runtimes.lock();
            if let Some(runtime) = runtimes.get_mut(&output_id) {
                runtime.note_pty_output(Instant::now());
            }
        }
        if refusal.lock().feed(&bytes) {
            let app = output_app.clone();
            std::thread::spawn(move || crate::integration::note_sideload_refused(&app));
        }
        let _ = on_output.send(bytes);
    };
    let busy_callback = move |busy: bool| {
        let _ = on_busy.send(busy);
    };
    // The session died underneath the app. Record it on the [Session runtime]
    // *first*: nothing else can retire the tracker's last word (a killed
    // `claude` fires no closing hook), so until this lands the menu bar counts
    // a dead tree as running and its tray row still asks for attention. The
    // frontend then learns through its own channel as before — the pane wants
    // it immediately, and its store's copy is a mirror, not the only one.
    let exit_app = app.clone();
    let exit_id = SessionId(id.clone());
    let exit_callback = move || {
        {
            use tauri::Manager as _;
            let state = exit_app.state::<AppState>();
            let mut runtimes = state.runtimes.lock();
            if let Some(runtime) = runtimes.get_mut(&exit_id) {
                runtime.note_exited();
            }
        }
        crate::refresh_needs_you_badge(&exit_app);
        if let Ok(home) = crate::commands::resolve_home(&exit_app) {
            crate::activity_rt::note_session_exited(&exit_app, &home, &exit_id.0);
        }
        let _ = on_exit.send(true);
    };

    // Resolve the per-session daemon socket under ~/.claude/kriyon/run. The id
    // is validated before it is interpolated into the path (trust boundary).
    let home = {
        use tauri::Manager as _;
        app.path()
            .home_dir()
            .ok()
            .or_else(|| std::env::var("HOME").ok().map(PathBuf::from))
            .ok_or_else(|| "cannot resolve HOME".to_string())?
    };
    let run = run_dir(&app, &home)?;
    std::fs::create_dir_all(&run).map_err(|e| e.to_string())?;
    let socket = kriyon_core::daemon::session_socket_path(&run, &id)
        .ok_or_else(|| "invalid session id".to_string())?;

    // Say up front whether this session's status can be known at all: with
    // Kriyon's hooks turned off in settings, no status or usage ever arrives,
    // and the UI must show "unavailable" rather than a confident idle
    // (ADR-0029). Only a scope name crosses back, never file contents. Read
    // from the folder the shell will really start in (an empty `cwd` means
    // HOME), and only once the id is known to be valid.
    let shell_cwd = kriyon_core::shellinit::SpawnPlan::new(&cwd, &home, None).cwd;
    let kriyon_off = {
        let integration = state.integration.lock();
        integration.prefs.consented
            && integration.applied.route == kriyon_core::integration::HookRoute::Off
    };
    note_hooks_off(
        &app,
        &state,
        &id,
        if kriyon_off {
            Some(kriyon_core::hooks::HooksOff::Kriyon)
        } else {
            crate::hooks::hooks_off_for(&home, Path::new(&shell_cwd))
        },
    );

    // Crash-survival fast path: if a daemon is already live for this id, reattach
    // to it with that very connection (no throwaway probe, no second shell, no
    // ZDOTDIR work — the running shell already has its own). A failed connect is
    // not yet proof the daemon is gone: `recover_unreachable_daemon` retries one
    // that is demonstrably alive, and retires it if it can never be reached, so
    // the spawn below never unlinks a live daemon's socket out from under it.
    //
    // A create supersedes any earlier close of the same id (un-archiving reuses
    // it), so the mark is cleared up front; a close that lands *during* this
    // create sets it again, and is honoured where the client is registered.
    state
        .closed_mid_create
        .lock()
        .remove(&SessionId(id.clone()));
    // Open the window a close can mark. Cleared however this returns.
    let _in_flight = CreateInFlight::begin(&state, &SessionId(id.clone()));
    let live = if let Ok(stream) = UnixStream::connect(&socket) {
        Some(stream)
    } else {
        // Off the async worker: recovery polls the process table and can wait
        // seconds for a wedged daemon to go.
        let may_retire = crate::daemon_rt::owns_run_dir(&app);
        let (recover_id, recover_socket) = (id.clone(), socket.clone());
        // A live daemon this instance may not retire is an error, not a clear
        // path: `spawn_daemon` below unlinks the socket before binding, which
        // would strand it. Refusing leaves it reachable by its real client.
        tauri::async_runtime::spawn_blocking(move || {
            crate::daemon_rt::recover_unreachable_daemon(&recover_id, &recover_socket, may_retire)
        })
        .await
        .map_err(|e| e.to_string())??
    };
    if let Some(stream) = live {
        // A daemon that survived an app restart serves its bridge, if it was
        // started with one.
        if crate::integration::bridge_socket(&socket)
            .is_some_and(|b| UnixStream::connect(b).is_ok())
        {
            state.bridged.lock().insert(SessionId(id.clone()));
        }
        let engine = DaemonClient::from_stream(
            stream,
            SessionId(id.clone()),
            callback,
            busy_callback,
            exit_callback,
        )
        .map_err(|e| e.to_string())?;
        engine
            .attach(INITIAL_COLS, INITIAL_ROWS)
            .map_err(|e| e.to_string())?;
        register_session(&app, &state, SessionId(id), engine, None)?;
        return Ok(true);
    }

    // Fresh session: the pure launch policy (cwd, shell, zsh-ness) lives in
    // kriyon-core::shellinit, unit-tested without a Tauri runtime; the IO
    // (private ZDOTDIR tempdir, daemon spawn, connect) stays here.
    let plan =
        kriyon_core::shellinit::SpawnPlan::new(&cwd, &home, std::env::var("SHELL").ok().as_deref());

    // zsh OSC 133 injection: point ZDOTDIR at a private temp dir whose .zshrc
    // sources the user's real config and adds shell-integration hooks. Because
    // that .zshrc is then sourced into the user's shell, the path must NOT be
    // predictable or shared — a local attacker who could pre-create it (symlink
    // or malicious rc) would gain code execution. We use `tempfile` (random
    // suffix, O_EXCL `mkdir`, 0700 dir) and write the rc with mode 0600. The
    // `TempDir` handle is owned by the `Session` so it is removed on close.
    // Resolve the user's *real* ZDOTDIR, seeing through any Kriyon wrapper we
    // may have inherited (nested session, or a dev build launched from a Kriyon
    // terminal). Without this, a nested Kriyon chains onto the parent wrapper —
    // sourcing the wrong .zshrc and pinning history to a throwaway temp dir.
    let user_zdotdir = if plan.needs_zdotdir {
        kriyon_core::shellinit::resolve_user_zdotdir(
            std::env::var("KRIYON_USER_ZDOTDIR").ok().as_deref(),
            std::env::var("ZDOTDIR").ok().as_deref(),
        )
    } else {
        None
    };

    let zdotdir = if plan.needs_zdotdir {
        let zplan = kriyon_core::shellinit::build_zdotdir(user_zdotdir.as_deref());
        let dir = tempfile::Builder::new()
            .prefix("kriyon-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        // Write all four wrapper startup files, not just .zshrc: with ZDOTDIR
        // redirected here, zsh reads .zshenv/.zprofile/.zshrc/.zlogin from this
        // dir, so each must re-source the user's real counterpart or it never
        // loads (e.g. ~/.zshenv's cargo PATH addition). See `build_zdotdir`.
        write_private_rc(dir.path(), ".zshenv", &zplan.zshenv).map_err(|e| e.to_string())?;
        write_private_rc(dir.path(), ".zprofile", &zplan.zprofile).map_err(|e| e.to_string())?;
        write_private_rc(dir.path(), ".zshrc", &zplan.zshrc).map_err(|e| e.to_string())?;
        write_private_rc(dir.path(), ".zlogin", &zplan.zlogin).map_err(|e| e.to_string())?;
        Some(dir)
    } else {
        None
    };

    // Gate Kriyon's Claude Code hook on this session (KRIYON_SESSION), plus the
    // private ZDOTDIR when one was created. Setting them in the daemon's spawn
    // env means every `claude` launched in this shell — by launchClaudeOnce, by
    // hand, or after a reattach — inherits them.
    let env = kriyon_core::shellinit::spawn_env(
        &id,
        zdotdir
            .as_ref()
            .map(|d| d.path().to_string_lossy())
            .as_deref(),
        user_zdotdir.as_deref(),
        &home.to_string_lossy(),
    );

    // The companion folder, loaded only in Kriyon's sessions (the [Integration]'s
    // plugin route): every `claude` this shell starts picks up Kriyon's hooks
    // without any entry in the user's settings.
    // What the [Integration] adds to this shell: the companion folder, and
    // the bridge socket when the companion is on.
    let launch = crate::integration::prepare_launch(&app, &home, &socket);
    let mut env = env;
    env.extend(launch.env);
    if launch.bridged {
        state.bridged.lock().insert(SessionId(id.clone()));
    } else {
        state.bridged.lock().remove(&SessionId(id.clone()));
    }

    let spec = SpawnSpec {
        cwd: plan.cwd,
        shell: plan.shell,
        env,
    };

    spawn_daemon(&socket, &run, &id, &spec)?;
    let engine = DaemonClient::connect(
        &socket,
        SessionId(id.clone()),
        callback,
        busy_callback,
        exit_callback,
    )
    .map_err(|e| e.to_string())?;
    engine
        .attach(INITIAL_COLS, INITIAL_ROWS)
        .map_err(|e| e.to_string())?;
    register_session(&app, &state, SessionId(id), engine, zdotdir)?;

    Ok(false)
}

/// Register a freshly connected client as `id`'s session — unless the session
/// was closed while this create was still in flight. Spawning a daemon takes a
/// moment, and a close in that window finds no client to stop; registering one
/// afterwards would resurrect a session whose row is already gone, owned by
/// nothing but this map and so never reaped. Stop the daemon instead.
fn register_session(
    app: &tauri::AppHandle,
    state: &AppState,
    id: SessionId,
    engine: DaemonClient,
    zdotdir: Option<tempfile::TempDir>,
) -> Result<(), String> {
    if state.closed_mid_create.lock().remove(&id) {
        crate::daemon_rt::stop_held(crate::daemon_rt::owns_run_dir(app), &engine);
        return Err("session was closed while it was starting".to_string());
    }
    let engine = std::sync::Arc::new(engine);
    state
        .sessions
        .lock()
        .insert(id, Session { engine, zdotdir });
    Ok(())
}

/// Write a [Handoff prompt] to the session's path-contained prompt file and
/// return its absolute path, so the launcher can seed it via
/// `claude "$(cat <path>)"`. The id is validated before it touches the path.
///
/// # Errors
/// Returns an error string if HOME cannot be resolved, the id is invalid, or the
/// write fails.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn seed_prompt(app: tauri::AppHandle, id: String, text: String) -> Result<String, String> {
    let home = {
        use tauri::Manager as _;
        app.path()
            .home_dir()
            .ok()
            .or_else(|| std::env::var("HOME").ok().map(PathBuf::from))
            .ok_or_else(|| "cannot resolve HOME".to_string())?
    };
    let run = run_dir(&app, &home)?;
    std::fs::create_dir_all(&run).map_err(|e| e.to_string())?;
    let path = seed_prompt_path(&run, &id).ok_or_else(|| "invalid session id".to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Write the raw request body to the session's stdin.
///
/// The frontend sends terminal input as a raw byte payload (not a JSON number
/// array) with the session id in the `x-session-id` header — see
/// `writeStdin` in `src/ipc/bridge.ts`. Both inputs cross the trust boundary,
/// so both are validated here.
///
/// # Errors
/// Returns an error string if the body is not raw bytes, the `x-session-id`
/// header is missing/invalid, the session is unknown, or the write fails.
// Signature is dictated by Tauri's command macro (State + by-value args).
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn write_stdin(
    state: tauri::State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("write_stdin body must be raw bytes".to_string());
    };
    let id = request
        .headers()
        .get("x-session-id")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "missing x-session-id header".to_string())?;
    let sessions = state.sessions.lock();
    let session = sessions
        .get(&SessionId(id.to_owned()))
        .ok_or_else(|| "session not found".to_string())?;
    session.engine.write_stdin(data).map_err(|e| e.to_string())
}

/// The user stopped the session's turn with Esc (the frontend saw the proof:
/// an interrupt row, or a prompt the CLI took back). Claude Code fires no hook
/// for an interrupt, so this is what ends the `Running` status.
///
/// # Errors
/// Returns an error string if the id is invalid or the session is unknown.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn note_interrupted(app: tauri::AppHandle, id: String) -> Result<(), String> {
    note_turn_over(
        &app,
        id,
        kriyon_core::runtime::SessionRuntime::note_user_interrupt,
    )
}

/// The transcript recorded the session's turn ending, at `ended_ms`, while
/// its status still says `Running` (the frontend saw the `turn_duration`
/// row, or an interrupt row when `interrupted`). Settled as the missed `Stop`
/// or Esc would have — if that end came after the newest prompt; the runtime
/// decides.
///
/// # Errors
/// Returns an error string if the id is invalid or the session is unknown.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn note_turn_ended(
    app: tauri::AppHandle,
    id: String,
    ended_ms: i64,
    interrupted: bool,
) -> Result<(), String> {
    note_turn_over(&app, id, move |runtime| {
        runtime.note_turn_ended(ended_ms, interrupted);
    })
}

fn note_turn_over(
    app: &tauri::AppHandle,
    id: String,
    settle: impl FnOnce(&mut kriyon_core::runtime::SessionRuntime),
) -> Result<(), String> {
    use tauri::Manager as _;
    kriyon_core::daemon::check_session_id(&id)?;
    let id = SessionId(id);
    {
        let state = app.state::<AppState>();
        if !state.sessions.lock().contains_key(&id) {
            return Err("session not found".to_string());
        }
        session_registry::with_runtime(&state, &id, settle);
    }
    crate::status_rt::recompute_and_emit(app, &id);
    Ok(())
}

/// Ask the session's daemon to resend its screen snapshot. Called when a
/// terminal component (re)attaches to an already-live session: the fresh xterm
/// is blank and the socket-level attach repaint happened before it existed.
/// Looking the session up by `id` IS the validation (trust boundary).
///
/// # Errors
/// Returns an error string if the session is unknown or the write fails.
// Signature is dictated by Tauri's command macro (State + by-value args).
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn request_repaint(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let sessions = state.sessions.lock();
    let session = sessions
        .get(&SessionId(id))
        .ok_or_else(|| "session not found".to_string())?;
    session.engine.request_repaint().map_err(|e| e.to_string())
}

/// Resize the session's pty to `cols` x `rows`.
///
/// # Errors
/// Returns an error string if the session is unknown or the resize fails.
// Signature is dictated by Tauri's command macro (State + by-value args).
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn resize_pty(
    state: tauri::State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock();
    let session = sessions
        .get(&SessionId(id))
        .ok_or_else(|| "session not found".to_string())?;
    session.engine.resize(cols, rows).map_err(|e| e.to_string())
}

/// Close the session, removing it from state and [Tree stop]ping its daemon —
/// whether or not this run ever attached to it.
///
/// `async` so the stopping half never runs on the main thread. Releasing the
/// state and clearing the row is immediate — that is what the UI is waiting
/// for — but taking the [Run dir] lock, connecting to a socket and (for a
/// session this run never attached to) forking `ps` are unbounded, and a
/// synchronous Tauri command runs on the main thread, where they freeze the
/// window for as long as they take.
///
/// # Errors
/// Returns an error string if the id is invalid, HOME cannot be resolved, or the
/// close fails. An id with no live daemon is already closed, not an error.
#[tauri::command]
pub async fn close_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    use tauri::Manager as _;

    let session_id = SessionId(id);
    let session = session_registry::forget(&state, &session_id);
    // Clear the persisted sleep mark too, so a closed session is never restored
    // asleep on the next launch. Best-effort: the launch-time reconcile also
    // drops a mark whose daemon is gone, so a missed write self-heals.
    if let Err(e) = app
        .state::<StoreState>()
        .0
        .lock()
        .set_sleep_state(&session_id.0, None)
    {
        eprintln!(
            "kriyon: failed to clear sleep mark on close session={} ({e})",
            session_id.0
        );
    }
    // Closing a waiting/asking session drops the menu-bar count; refresh it now
    // rather than leaving a stale badge until the next ticker pass.
    crate::refresh_needs_you_badge(&app);

    // The id is about to name a socket; prove it safe first (trust boundary).
    kriyon_core::daemon::check_session_id(&session_id.0)?;
    let run = run_dir(&app, &resolve_home(&app)?)?;
    // The session's run files stay: the daemon is still stopping, and once it is
    // gone the housekeeping pass sweeps them and, with them, every other file
    // the session left (`daemon_rt::forget_closed`).

    // Everything from here is unbounded IO: the run-dir lock, a socket connect,
    // possibly a `ps`. Off the main thread.
    let stop_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let owns_run_dir = crate::daemon_rt::owns_run_dir(&stop_app);
        let Some(session) = session else {
            // Never attached this run — a session restored from the store whose
            // pane never mounted — or one whose `create_session` is still in
            // flight (already marked above).
            //
            // No client holds it, but its daemon may well be alive, so "not
            // found" must still mean "stop it", never "nothing to do". Only the
            // run dir's owner may: a frame sent to a daemon another instance is
            // using would be obeyed later, when that instance next let go.
            if owns_run_dir {
                crate::daemon_rt::stop_unattached(&run, &session_id.0);
            }
            return;
        };
        // Dropping `session` afterwards removes the temporary ZDOTDIR.
        crate::daemon_rt::stop_held(owns_run_dir, &session.engine);
    })
    .await
    .map_err(|e| e.to_string())
}

/// "Sleep idle sessions now": put every quiescent session to sleep at once,
/// whatever the auto-sleep setting — the user asking for memory back without
/// quitting. A session mid-turn, on screen, or running a subagent or background
/// shell is never touched; each slept session wakes with `claude --resume` the
/// moment it is opened. Returns how many were told to stop.
///
/// `async` for the same reason as [`close_session`]: the pass reads the process
/// table (a `ps` fork on a cache miss) and the store, which a synchronous
/// command would do on the main thread.
///
/// # Errors
/// Returns an error string only if the blocking task itself fails to join.
#[tauri::command]
pub async fn sleep_idle_sessions(app: tauri::AppHandle) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || crate::sleep_rt::sleep_idle_now(&app))
        .await
        .map_err(|e| e.to_string())
}

/// Acknowledge that `bytes` of a session's output have drained from the
/// frontend's terminal sink.
///
/// The pty reader pauses when too much output is sent-but-not-drained (so a
/// fast-printing child cannot outrun the UI); the frontend calls this as it
/// flushes bytes into xterm, resuming the reader once enough has drained.
/// Looking the session up by `id` IS the validation — an unknown id returns an
/// error and is never trusted further.
///
/// # Errors
/// Returns an error string if the session is unknown.
// Signature is dictated by Tauri's command macro (State + by-value args).
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn report_drained(
    state: tauri::State<'_, AppState>,
    id: String,
    bytes: usize,
) -> Result<(), String> {
    let sessions = state.sessions.lock();
    let session = sessions
        .get(&SessionId(id))
        .ok_or_else(|| "session not found".to_string())?;
    session.engine.report_drained(bytes);
    Ok(())
}

/// Begin streaming a session's live status and Claude Code transcript.
///
/// Status comes from Claude Code hook events (reliable for interactive
/// sessions), which Kriyon records to `~/.claude/kriyon/events/<session_id>.jsonl`
/// keyed by Kriyon's own launch id. This tails that exact file: each hook event
/// updates the session's status, and the `transcript_path` the hook reports is
/// tailed through `on_event`. Nothing renders those transcript events (ADR
/// 0019); they feed token/cost usage totals, the sidebar's unseen-output badges
/// (via the frontend's append counter), the Needs-you snippet, and the
/// follow-up session's handoff prompt. The same
/// stream also surfaces the session title (`ai-title`) and Claude's own session
/// id (for `claude --resume`), each emitted as a Tauri event (see ADR 0003).
///
/// # Errors
/// Returns an error string if `HOME` cannot be resolved or the watcher cannot
/// be established.
// Signature is dictated by Tauri's command macro (State + by-value args); the
// body is a flat wiring of one watch's many per-signal callbacks.
#[allow(clippy::needless_pass_by_value, clippy::too_many_lines)]
// `(async)` because the activity seed inside `spawn_session_watch` replays the
// tail of the events file (up to `SEED_TAIL_MAX_BYTES`, parsing every line)
// inline on the command path. A non-async command runs on the main thread, and
// every restored session re-subscribes at launch — so that read stacked up on
// the run loop N times over, which is exactly the shape of a slow start. The
// sibling *status* seed was already moved onto its own thread for this reason;
// this one was left behind on the command path.
#[tauri::command(async)]
pub fn watch_transcript(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    session_id: String,
    on_event: tauri::ipc::Channel<kriyon_core::transcript::StudioEvent>,
) -> Result<(), String> {
    use tauri::Manager as _;

    let home = app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())
        .or_else(|_| {
            std::env::var("HOME")
                .map_err(|_| "cannot resolve HOME".to_string())
                .map(Into::into)
        })?;
    // The id names on-disk paths (events/usage files, and the watch's tail
    // seed) — the IPC boundary rule: validate before any path interpolation.
    if !kriyon_core::daemon::is_valid_session_id(&session_id) {
        return Err("invalid session id".to_string());
    }

    let events_dir = crate::hooks::events_dir(&home);
    let usage_dir = crate::hooks::usage_dir(&home);
    let tasks_dir = crate::hooks::tasks_dir(&home);

    let id = SessionId(session_id);

    // Register a runtime so the session shows an Idle dot immediately, before
    // the first hook fires.
    session_registry::ensure_runtime(&state, &id);

    // One sink for every WatchSignal the watch produces: the named
    // [Watch route] (see `watch_route.rs`, where the routing table is unit
    // tested under the mock runtime). A cloned `app` and id ride into the
    // closure; the originals stay for the spawn, registration, and seed below.
    let cb_id = id.clone();
    let cb_app = app.clone();
    let on_signal = move |signal: crate::watcher::WatchSignal| {
        crate::watch_route::route(
            &cb_app,
            &cb_id,
            &|event| {
                let _ = on_event.send(event);
            },
            signal,
        );
    };

    let dirs = crate::watcher::WatchDirs {
        events: &events_dir,
        usage: &usage_dir,
        tasks: &tasks_dir,
    };
    // What this session's process tree is running right now, for the watch's
    // [Background shell] retraction. The cached table is the right one here:
    // this decides only whether to warn, never what to signal (ADR 0022).
    let sweep_id = id.0.clone();
    let live_shells = Box::new(move || {
        crate::status_rt::process_table().map(|survey| {
            let tree = survey.tree();
            tree.tree_pids(&sweep_id)
                .into_iter()
                .filter_map(|pid| tree.row(pid).map(|row| row.cmd.clone()))
                .collect::<Vec<_>>()
        })
    });

    if let Some(watcher) = crate::watcher::spawn_session_watch(&dirs, &id, live_shells, on_signal)?
    {
        state.watchers.lock().insert(id.clone(), watcher);
    }

    // The watch above tails from EOF, so on its own a (re)subscribed session
    // sits Idle until the next live hook — after an app restart a genuinely
    // blocked session would be missing from the menu-bar badge, and a missed
    // `Stop` could wedge a phantom Waiting onto it. Seed status + ask from the
    // events file's tail so the tracker reflects the recorded history. Runs
    // after the spawn so the overlap window is double-folded (idempotent)
    // rather than lost; if a live event already drove the tracker, the seed
    // yields to it. On its own thread: the read + replay must not stack up on
    // the command path when every session re-subscribes at once on launch.
    let seed_app = app.clone();
    let events_path = crate::hooks::events_file(&home, &id.0);
    let usage_path = crate::hooks::usage_file(&home, &id.0);
    std::thread::spawn(move || {
        crate::status_rt::seed_from_history(&seed_app, &id, &events_path, &usage_path);
        // Same per-attach hook: restore a [Sleeping session] Kriyon stopped
        // before the app (or just the webview) restarted, so its moon and
        // wake-on-focus come back instead of the row looking awake. Runs after
        // the status seed and reads its own gate (the process table), so the two
        // are independent.
        crate::sleep_rt::reconcile_persisted_sleep(&seed_app, &id.0);
    });
    Ok(())
}

/// Compute the canonical sibling worktree path for `branch` under `repo_path`.
///
/// # Errors
/// Infallible today; returns `Result` for command-signature uniformity.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn worktree_path(repo_path: String, branch: String) -> Result<String, String> {
    Ok(kriyon_core::bootstrap::worktree_path_for(
        &repo_path, &branch,
    ))
}

/// Bootstrap a freshly-created worktree: copy `.env*`, install deps, run the
/// project's optional setup command. Best-effort — a non-`ok` report is returned
/// (not an `Err`) so the caller can offer "Open anyway". Runs on a blocking
/// thread since installs (e.g. `pnpm install`) can take minutes and must not
/// occupy a Tokio worker.
///
/// # Errors
/// Returns `Err` only if the blocking task itself fails to join (e.g. panics);
/// the bootstrap steps are otherwise always reported via `BootstrapReport`.
#[tauri::command]
pub async fn bootstrap_worktree(
    repo_path: String,
    worktree_path: String,
    setup_cmd: Option<String>,
) -> Result<BootstrapReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shell = kriyon_core::shellinit::user_shell(std::env::var("SHELL").ok().as_deref());
        run_bootstrap(&repo_path, &worktree_path, setup_cmd.as_deref(), &shell)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Resolve HOME via Tauri, mirroring `seed_prompt`.
pub(crate) fn resolve_home(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager as _;
    app.path()
        .home_dir()
        .ok()
        .or_else(|| std::env::var("HOME").ok().map(PathBuf::from))
        .ok_or_else(|| "cannot resolve HOME".to_string())
}

/// Record which session the user is currently focused on (or `None` when the
/// window is blurred / nothing is active). Drives OS-notification suppression
/// for the focused session, and marks the focused session's finished output as
/// seen — dropping it from the menu-bar count (see
/// [`kriyon_core::runtime::SessionRuntime::mark_seen`]).
///
/// # Errors
/// Infallible today; returns `Result` for command-signature uniformity.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn set_focused_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: Option<String>,
) -> Result<(), String> {
    let focused = id.map(SessionId);
    if let Some(session_id) = &focused {
        if let Some(runtime) = state.runtimes.lock().get_mut(session_id) {
            runtime.mark_seen();
        }
    }
    state.focused.lock().clone_from(&focused);
    crate::refresh_needs_you_badge(&app);
    // Focusing a [Sleeping session] wakes it. Best-effort here (the shell may
    // not be at its prompt for a beat); the sleep pass retries while the
    // session stays focused, so a failed first attempt self-heals.
    if let Some(session_id) = &focused {
        if state.sleep.lock().is_sleeping(&session_id.0) {
            crate::sleep_rt::attempt_wake(&app, &session_id.0);
        }
    }
    Ok(())
}

/// List the folder's past Claude Code sessions, newest first, up to `limit`.
///
/// Resolves `~/.claude/projects/<encoded-cwd>/` (the encoding replaces every
/// non-alphanumeric character with `-`, which also prevents the frontend-
/// supplied `cwd` from traversing outside the projects directory) and scans it.
/// A folder Claude has never run in yields an empty page, not an error.
///
/// The most transcripts one scan may read: each is parsed in full (potentially
/// many MB), and `limit` crosses the IPC trust boundary — an unclamped value
/// would let a buggy frontend demand an unbounded disk/memory pass.
const PAST_SESSIONS_LIMIT_MAX: usize = 200;

/// Async with the scan on a blocking thread: it reads and parses up to `limit`
/// whole transcripts (potentially many MB), which must never stall the main
/// thread — a click on "History" has to paint its loading state immediately.
///
/// # Errors
/// Returns an error string if `HOME` cannot be resolved, the existing history
/// directory cannot be read, or the blocking task fails to join.
#[tauri::command]
pub async fn list_past_sessions(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    cwd: String,
    limit: usize,
) -> Result<kriyon_core::history::PastSessionPage, String> {
    use tauri::Manager as _;

    let limit = limit.min(PAST_SESSIONS_LIMIT_MAX);

    let home = app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())
        .or_else(|_| {
            std::env::var("HOME")
                .map_err(|_| "cannot resolve HOME".to_string())
                .map(Into::into)
        })?;
    let dir =
        crate::hooks::projects_dir(&home).join(kriyon_core::history::encode_project_dir(&cwd));
    let cache = state.history_cache.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cache = cache.lock();
        kriyon_core::history::list_past_sessions_in_dir_cached(&dir, limit, &mut cache)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Resolve the user's home directory as an absolute path string.
///
/// Used by the frontend to give the default "Home" session a concrete cwd so
/// the pty and the transcript watcher resolve the same real path.
///
/// # Errors
/// Returns an error string if the home directory cannot be resolved.
// Signature is dictated by Tauri's command macro (by-value AppHandle).
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn home_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager as _;

    let home = app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())
        .or_else(|_| {
            std::env::var("HOME")
                .map_err(|_| "cannot resolve HOME".to_string())
                .map(Into::into)
        })?;
    Ok(home.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_prompt_path_is_contained_and_typed() {
        let run = tempfile::tempdir().expect("run dir");
        // A valid id yields <run>/<id>.prompt.
        let path = seed_prompt_path(run.path(), "abc-123").expect("valid id");
        assert_eq!(
            path.file_name().unwrap().to_str().unwrap(),
            "abc-123.prompt"
        );
        assert!(path.starts_with(run.path()), "stays inside the run dir");
        // A traversal id is rejected (same guard as the session socket).
        assert!(seed_prompt_path(run.path(), "../evil").is_none());
        assert!(seed_prompt_path(run.path(), "a/b").is_none());
    }
}
