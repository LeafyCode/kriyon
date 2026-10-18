//! [Plan limits] IO: read every session's [Limit reading] from
//! `~/.claude/kriyon/limits/`, merge them ([`kriyon_core::plan_limits::merge`]),
//! and tell the frontend (`plan-limits`). Driven by the background ticker: a
//! file is re-parsed only when its `(mtime, len)` changed, but the merge reruns
//! each tick so a window drops the moment it resets.
//!
//! The answer is emitted when it changes and re-sent every
//! [`RESEND_EVERY_N_TICKS`], so a window that subscribed late still gets it,
//! from one ordered source, with no separate start-up read to race the events.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use kriyon_core::plan_limits::{merge, parse_reading, PlanLimits};
use tauri::{Emitter as _, Manager as _};

use crate::AppState;

/// How many ticks between re-sends of an unchanged answer (10s).
const RESEND_EVERY_N_TICKS: u64 = 5;

/// A file's `(mtime, len)`: changes on any rewrite.
type Stamp = (SystemTime, u64);

fn stamp(path: &Path) -> Option<Stamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

fn stamps(dir: &Path) -> HashMap<PathBuf, Stamp> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return HashMap::new();
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter_map(|p| Some((p.clone(), stamp(&p)?)))
        .collect()
}

/// Delete a spent reading without losing a fresh one a session writes at the
/// same moment. The file is first renamed aside, which is atomic: a session
/// writing after that creates a new file at the path. Then the moved file is
/// read again. If it is still spent it is deleted; if it is not, a fresh write
/// landed before the rename, and it goes back unless a newer one is already
/// there.
fn retire(path: &Path, now: i64) {
    let aside = path.with_extension("json.spent");
    if std::fs::rename(path, &aside).is_err() {
        return;
    }
    let still_spent = std::fs::read_to_string(&aside)
        .ok()
        .and_then(|text| parse_reading(&text))
        .is_none_or(|r| r.is_spent(now));
    if still_spent || path.exists() {
        let _ = std::fs::remove_file(&aside);
    } else {
        let _ = std::fs::rename(&aside, path);
    }
}

/// The cached readings (an unreadable file is kept as `None`, so it is not
/// re-parsed every tick) and the last answer sent.
#[derive(Default)]
pub struct LimitsReader {
    readings: HashMap<PathBuf, (Stamp, Option<PlanLimits>)>,
    last: Option<PlanLimits>,
}

impl LimitsReader {
    /// The merged [Plan limits] at `now` (Unix seconds). Only files whose stamp
    /// changed are re-parsed. A reading whose every window has reset is
    /// deleted ([`retire`]): it can never count again, and one is left per
    /// `claude` run.
    pub fn read(&mut self, dir: &Path, now: i64) -> PlanLimits {
        let current = stamps(dir);
        self.readings.retain(|path, _| current.contains_key(path));
        for (path, stamp) in current {
            if self.readings.get(&path).map(|(s, _)| *s) == Some(stamp) {
                continue;
            }
            let reading = std::fs::read_to_string(&path)
                .ok()
                .and_then(|text| parse_reading(&text));
            self.readings.insert(path, (stamp, reading));
        }
        let spent: Vec<PathBuf> = self
            .readings
            .iter()
            .filter(|(_, (_, r))| r.is_some_and(|r| r.is_spent(now)))
            .map(|(path, _)| path.clone())
            .collect();
        for path in spent {
            self.readings.remove(&path);
            retire(&path, now);
        }
        let readings: Vec<PlanLimits> = self.readings.values().filter_map(|(_, r)| *r).collect();
        merge(&readings, now)
    }

    /// The answer to send this tick: when it changed, or when `resend` asks.
    /// With `enabled` off ("Live usage" off) the answer is no limits, so bars
    /// from an old reading never outlive the switch.
    fn answer(&mut self, dir: &Path, now: i64, enabled: bool, resend: bool) -> Option<PlanLimits> {
        let limits = if enabled {
            self.read(dir, now)
        } else {
            self.readings.clear();
            PlanLimits::default()
        };
        if self.last == Some(limits) && !resend {
            return None;
        }
        self.last = Some(limits);
        Some(limits)
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_secs()).ok())
        .unwrap_or(0)
}

/// One ticker pass: emit `plan-limits` when the answer changed, and re-send it
/// every [`RESEND_EVERY_N_TICKS`].
pub fn poll_and_emit<R: tauri::Runtime>(app: &tauri::AppHandle<R>, tick: u64) {
    let Ok(home) = app.path().home_dir() else {
        return;
    };
    let state = app.state::<AppState>();
    let enabled = {
        let integration = state.integration.lock();
        integration.prefs.consented && integration.prefs.live_usage
    };
    let answer = state.plan_limits.lock().answer(
        &kriyon_core::paths::limits_dir(&home),
        now_secs(),
        enabled,
        tick.is_multiple_of(RESEND_EVERY_N_TICKS),
    );
    if let Some(limits) = answer {
        let _ = app.emit("plan-limits", limits);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_000_000;

    fn write(dir: &Path, name: &str, five: f64, resets_at: i64) {
        std::fs::write(
            dir.join(format!("{name}.json")),
            format!(r#"{{"five_hour":{{"used_percentage":{five},"resets_at":{resets_at}}}}}"#),
        )
        .expect("write");
    }

    fn five(limits: PlanLimits) -> Option<f64> {
        limits.five_hour.map(|w| w.used_percentage)
    }

    #[test]
    fn merges_every_sessions_reading() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), "a", 10.0, NOW + 60);
        write(dir.path(), "b", 25.0, NOW + 60);
        let mut reader = LimitsReader::default();
        assert_eq!(five(reader.read(dir.path(), NOW)), Some(25.0));
    }

    #[test]
    fn rereads_a_changed_reading_and_forgets_a_removed_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), "a", 10.0, NOW + 60);
        write(dir.path(), "b", 30.0, NOW + 60);
        let mut reader = LimitsReader::default();
        assert_eq!(five(reader.read(dir.path(), NOW)), Some(30.0));
        std::fs::remove_file(dir.path().join("b.json")).expect("rm");
        write(dir.path(), "a", 12.5, NOW + 60);
        assert_eq!(five(reader.read(dir.path(), NOW)), Some(12.5));
    }

    #[test]
    fn sends_on_change_and_on_resend_only() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), "a", 10.0, NOW + 60);
        let mut reader = LimitsReader::default();
        assert!(reader.answer(dir.path(), NOW, true, false).is_some());
        assert!(reader.answer(dir.path(), NOW, true, false).is_none());
        assert!(reader.answer(dir.path(), NOW, true, true).is_some());
    }

    #[test]
    fn live_usage_off_answers_no_limits() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), "a", 10.0, NOW + 60);
        let mut reader = LimitsReader::default();
        assert!(reader.answer(dir.path(), NOW, true, false).is_some());
        assert_eq!(
            reader.answer(dir.path(), NOW, false, false),
            Some(PlanLimits::default()),
            "switching off clears the bars"
        );
    }

    #[test]
    fn deletes_a_reading_once_every_window_reset() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), "old", 90.0, NOW - 1);
        write(dir.path(), "new", 5.0, NOW + 60);
        let mut reader = LimitsReader::default();
        assert_eq!(five(reader.read(dir.path(), NOW)), Some(5.0));
        assert!(!dir.path().join("old.json").exists());
        assert!(dir.path().join("new.json").exists());
    }

    #[test]
    fn a_reading_rewritten_with_a_new_window_is_kept() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), "x", 90.0, NOW + 10);
        let mut reader = LimitsReader::default();
        reader.read(dir.path(), NOW);
        // The window resets and the session writes its new one: the changed
        // stamp is re-parsed before the spent check, so the file survives.
        std::thread::sleep(std::time::Duration::from_millis(10));
        write(dir.path(), "x", 1.0, NOW + 20_000);
        let limits = reader.read(dir.path(), NOW + 11);
        assert!(
            dir.path().join("x.json").exists(),
            "the new window survives"
        );
        assert_eq!(five(limits), Some(1.0));
    }

    #[test]
    fn retiring_keeps_a_fresh_reading_that_landed_first() {
        let dir = tempfile::tempdir().expect("tempdir");
        // The cache thinks x is spent, but a session already rewrote it.
        write(dir.path(), "x", 1.0, NOW + 20_000);
        retire(&dir.path().join("x.json"), NOW);
        assert!(dir.path().join("x.json").exists());
        assert!(!dir.path().join("x.json.spent").exists());
        // A truly spent one goes.
        write(dir.path(), "y", 90.0, NOW - 1);
        retire(&dir.path().join("y.json"), NOW);
        assert!(!dir.path().join("y.json").exists());
        assert!(!dir.path().join("y.json.spent").exists());
    }

    #[test]
    fn a_missing_folder_reads_as_no_limits() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut reader = LimitsReader::default();
        assert_eq!(
            reader.read(&dir.path().join("absent"), NOW),
            PlanLimits::default()
        );
    }
}
