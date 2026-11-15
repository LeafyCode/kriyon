//! `kriyon-hook`: what Claude Code runs on every hook event and status-line
//! refresh in a Kriyon session (ADR-0066).
//!
//! - `kriyon-hook event`: the hook JSON on stdin, recorded as one line of the
//!   session's [Hook spool].
//! - `kriyon-hook usage <kriyon-session>`: the status-line JSON on stdin; the
//!   session's live usage and the account's plan limits.
//! - `kriyon-hook model`: the status-line JSON on stdin; prints the model's
//!   name, for a status line the person has none of their own for.
//!
//! It never fails or slows Claude: it reads nothing but stdin and its own
//! environment, writes only under `~/.claude/kriyon`, prints nothing except in
//! `model`, and always exits 0.

use std::io::Read as _;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

use kriyon_hook::json::{py_dumps, Json};
use kriyon_hook::{record, usage};

/// The most stdin read: a payload larger than this is skipped, never held.
const MAX_INPUT: u64 = 64 * 1024 * 1024;

/// How long the terminal check may take before it gives up (and records).
const PS_TIMEOUT: Duration = Duration::from_secs(2);

fn main() {
    // Whatever happens, Claude sees success and nothing on stdout.
    let mode = std::env::args().nth(1).unwrap_or_default();
    match mode.as_str() {
        "event" => event(),
        "usage" => usage_capture(std::env::args().nth(2)),
        "model" => println!("{}", usage::model_name(read_stdin().as_ref())),
        _ => {}
    }
}

/// Stdin as JSON, or `None` for anything unreadable or too large.
fn read_stdin() -> Option<Json> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(MAX_INPUT + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_INPUT {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

/// `~/.claude/kriyon`: the folder Kriyon reads.
fn kriyon_dir() -> Option<PathBuf> {
    let home = if cfg!(windows) {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
    } else {
        std::env::var_os("HOME")
    }?;
    Some(PathBuf::from(home).join(".claude").join("kriyon"))
}

/// Record one hook event for the Kriyon session that fired it.
fn event() {
    let sid = std::env::var("KRIYON_SESSION").unwrap_or_default();
    if !usage::safe_id(&sid) || !owns_session_terminal() {
        return;
    }
    let (Some(data), Some(dir)) = (read_stdin(), kriyon_dir()) else {
        return;
    };
    let sidecar = record::launch_sidecar(&data).and_then(|path| std::fs::read_to_string(path).ok());
    let Some(line) = record::event_record(&data, &utc_now_iso(), sidecar.as_deref()) else {
        return;
    };
    let events = dir.join("events");
    if kriyon_core::private_fs::create_private_dir(&events).is_err() {
        return;
    }
    // Owner-only, like Claude Code's own transcripts; one O_APPEND write per
    // line stays whole.
    let _ = kriyon_core::private_fs::append_private(
        &events.join(format!("{sid}.jsonl")),
        format!("{}\n", py_dumps(&line)).as_bytes(),
    );
}

/// Keep the session's live usage (its own `claude` only) and the account's
/// plan limits (from any `claude`: they are the account's).
fn usage_capture(sid: Option<String>) {
    let Some(data) = read_stdin().filter(Json::is_object) else {
        return;
    };
    let Some(dir) = kriyon_dir() else {
        return;
    };
    let sid = sid.unwrap_or_else(|| std::env::var("KRIYON_SESSION").unwrap_or_default());
    if usage::safe_id(&sid) && owns_session_terminal() {
        let _ = write_atomic(&dir.join("usage"), &sid, &usage::snapshot(&data));
    }
    let claude_id = usage::claude_id(&data);
    if usage::safe_id(&claude_id) {
        if let Some(reading) = usage::limits(&data) {
            let _ = write_atomic(&dir.join("limits"), &claude_id, &reading);
        }
    }
}

/// Write `<dir>/<name>.json` owner-only and whole: a temp file, then renamed.
fn write_atomic(dir: &std::path::Path, name: &str, value: &Json) -> std::io::Result<()> {
    kriyon_core::private_fs::create_private_dir(dir)?;
    let tmp = dir.join(format!("{name}.json.tmp"));
    kriyon_core::private_fs::write_private(&tmp, py_dumps(value).as_bytes())?;
    std::fs::rename(&tmp, dir.join(format!("{name}.json")))
}

/// Whether the `claude` running this is the session's own: the one holding
/// the foreground of the session's terminal (`KRIYON_TTY`, set by Kriyon's
/// daemon). A `claude` started from a Bash command inherits
/// `KRIYON_SESSION` too, and must not speak for the session. Mirrors
/// `kriyon_core::proc::TerminalSeat::owns_session`. Fails open when it can't
/// tell: no `KRIYON_TTY` (Windows, an older session) or no `CLAUDE_PID`.
fn owns_session_terminal() -> bool {
    let tty = std::env::var("KRIYON_TTY").unwrap_or_default();
    let pid = std::env::var("CLAUDE_PID").unwrap_or_default();
    let Some(term) = tty.strip_prefix("/dev/") else {
        return true;
    };
    if pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) {
        return true;
    }
    let Some(row) = ps_row(&pid) else {
        return true;
    };
    let fields: Vec<&str> = row.split_whitespace().collect();
    let (Some(Ok(group)), Some(Ok(foreground))) = (
        fields.first().map(|f| f.parse::<i64>()),
        fields.get(1).map(|f| f.parse::<i64>()),
    ) else {
        return true;
    };
    let tty_name = fields.get(2).copied().unwrap_or("");
    tty_name == term && foreground > 0 && group == foreground
}

/// `ps -o pgid=,tpgid=,tty= -p <pid>`'s line, within [`PS_TIMEOUT`].
fn ps_row(pid: &str) -> Option<String> {
    let mut child = std::process::Command::new("ps")
        .args(["-o", "pgid=,tpgid=,tty=", "-p", pid])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + PS_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    Some(out)
}

/// Now in UTC as Python's `datetime.now(timezone.utc).isoformat()` writes it:
/// microseconds when there are any, then `+00:00`.
fn utc_now_iso() -> String {
    let since = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    kriyon_hook::time::iso_utc(since.as_secs(), since.subsec_micros())
}
