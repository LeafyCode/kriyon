//! [Plan limits] — how much of the Claude plan's 5-hour and weekly windows the
//! account has used, as Claude Code reports them to its status line
//! (`rate_limits.five_hour` / `rate_limits.seven_day`).
//!
//! The windows belong to the account, not to a session, so every `claude` that
//! runs Kriyon's [Status-line] wrapper — inside Kriyon or not — leaves its
//! latest [Limit reading]. Each reading is only as fresh as that session's last
//! API response, so an idle session keeps repeating an old one. [`merge`]
//! picks the newest without timestamps: within one window usage only grows, and
//! a later window has a later reset time.

use serde::{Deserialize, Serialize};

/// Two readings whose reset times are this close (seconds) are the same
/// window. Reset times are server-reported, so they should match exactly; the
/// slack absorbs rounding, and windows are hours apart.
const SAME_WINDOW_SECS: i64 = 600;

/// One window's use.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitWindow {
    /// 0–100.
    #[serde(alias = "used_percentage")]
    pub used_percentage: f64,
    /// When the window resets, in Unix epoch seconds.
    #[serde(alias = "resets_at")]
    pub resets_at: i64,
}

/// The plan's windows, each absent when nothing has reported it (an API-key
/// login has none) or its reset time has passed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanLimits {
    #[serde(default, alias = "five_hour")]
    pub five_hour: Option<LimitWindow>,
    #[serde(default, alias = "seven_day")]
    pub seven_day: Option<LimitWindow>,
}

impl PlanLimits {
    /// Whether no window is left to show at `now`.
    #[must_use]
    pub fn is_spent(&self, now: i64) -> bool {
        live(self.five_hour, now).is_none() && live(self.seven_day, now).is_none()
    }
}

/// Parse a [Limit reading] the wrapper wrote: Claude's own `rate_limits`
/// object. Out-of-range or malformed windows are dropped, never trusted.
#[must_use]
pub fn parse_reading(text: &str) -> Option<PlanLimits> {
    let raw: PlanLimits = serde_json::from_str(text.trim()).ok()?;
    Some(PlanLimits {
        five_hour: raw.five_hour.filter(valid),
        seven_day: raw.seven_day.filter(valid),
    })
}

fn valid(w: &LimitWindow) -> bool {
    w.used_percentage.is_finite() && w.resets_at > 0
}

fn live(w: Option<LimitWindow>, now: i64) -> Option<LimitWindow> {
    w.filter(|w| w.resets_at > now)
}

/// The newest window among `windows`: the latest reset time wins, and among
/// the readings of that same window (resets within [`SAME_WINDOW_SECS`] of
/// it) the highest use. Anchoring on the latest reset keeps the answer the
/// same whatever order the readings come in.
fn pick(windows: impl Iterator<Item = Option<LimitWindow>>, now: i64) -> Option<LimitWindow> {
    let live: Vec<LimitWindow> = windows.filter_map(|w| live(w, now)).collect();
    let latest = live.iter().map(|w| w.resets_at).max()?;
    live.into_iter()
        .filter(|w| latest - w.resets_at <= SAME_WINDOW_SECS)
        .max_by(|a, b| a.used_percentage.total_cmp(&b.used_percentage))
        .map(|w| LimitWindow {
            used_percentage: w.used_percentage.clamp(0.0, 100.0),
            resets_at: latest,
        })
}

/// The newest live reading of each window across every session's reading.
#[must_use]
pub fn merge(readings: &[PlanLimits], now: i64) -> PlanLimits {
    PlanLimits {
        five_hour: pick(readings.iter().map(|r| r.five_hour), now),
        seven_day: pick(readings.iter().map(|r| r.seven_day), now),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_000_000;

    #[allow(clippy::unnecessary_wraps)] // every reading slot is an Option
    fn w(used: f64, resets_at: i64) -> Option<LimitWindow> {
        Some(LimitWindow {
            used_percentage: used,
            resets_at,
        })
    }

    fn reading(five: Option<LimitWindow>, seven: Option<LimitWindow>) -> PlanLimits {
        PlanLimits {
            five_hour: five,
            seven_day: seven,
        }
    }

    #[test]
    fn parses_claudes_rate_limits_object() {
        let text = r#"{"five_hour":{"used_percentage":23.5,"resets_at":1738425600},"seven_day":{"used_percentage":41.2,"resets_at":1738857600}}"#;
        assert_eq!(
            parse_reading(text),
            Some(reading(w(23.5, 1_738_425_600), w(41.2, 1_738_857_600)))
        );
    }

    #[test]
    fn a_missing_or_malformed_window_is_absent() {
        let r = parse_reading(r#"{"seven_day":{"used_percentage":5,"resets_at":0}}"#).unwrap();
        assert_eq!(r, PlanLimits::default());
        assert_eq!(parse_reading("nope"), None);
        let partial = parse_reading(r#"{"five_hour":{"used_percentage":5}}"#);
        assert_eq!(
            partial, None,
            "a window missing its reset time is malformed"
        );
    }

    #[test]
    fn same_window_keeps_the_highest_use() {
        // An idle session repeats an older, lower reading of the same window.
        let merged = merge(
            &[
                reading(w(10.0, NOW + 3600), None),
                reading(w(30.0, NOW + 3601), None),
                reading(w(20.0, NOW + 3600), None),
            ],
            NOW,
        );
        assert_eq!(merged.five_hour.unwrap().used_percentage, 30.0);
    }

    #[test]
    fn a_later_window_wins_even_with_lower_use() {
        // The old window reset; a fresh session reports the new one at 2%.
        let merged = merge(
            &[
                reading(None, w(90.0, NOW + 100)),
                reading(None, w(2.0, NOW + 7 * 86_400)),
            ],
            NOW,
        );
        assert_eq!(merged.seven_day, w(2.0, NOW + 7 * 86_400));
    }

    #[test]
    fn the_answer_does_not_depend_on_reading_order() {
        // Resets 500s apart chain across the slack: A~B and B~C, but not A~C.
        let a = reading(w(50.0, NOW + 10_000), None);
        let b = reading(w(10.0, NOW + 10_500), None);
        let c = reading(w(5.0, NOW + 11_000), None);
        let orders = [[a, b, c], [b, c, a], [c, a, b], [a, c, b]];
        let answers: Vec<_> = orders.iter().map(|o| merge(o, NOW).five_hour).collect();
        assert!(answers.windows(2).all(|p| p[0] == p[1]), "{answers:?}");
        assert_eq!(answers[0], w(10.0, NOW + 11_000));
    }

    #[test]
    fn a_window_past_its_reset_is_dropped() {
        let merged = merge(&[reading(w(80.0, NOW - 1), w(40.0, NOW + 10))], NOW);
        assert_eq!(merged, reading(None, w(40.0, NOW + 10)));
        assert!(!merged.is_spent(NOW));
        assert!(merged.is_spent(NOW + 10));
    }

    #[test]
    fn use_is_clamped_to_0_100() {
        let merged = merge(&[reading(w(140.0, NOW + 5), w(-3.0, NOW + 5))], NOW);
        assert_eq!(merged.five_hour.unwrap().used_percentage, 100.0);
        assert_eq!(merged.seven_day.unwrap().used_percentage, 0.0);
    }

    #[test]
    fn serializes_camel_case_for_the_frontend() {
        let json = serde_json::to_string(&reading(w(1.0, 2), None)).unwrap();
        assert_eq!(
            json,
            r#"{"fiveHour":{"usedPercentage":1.0,"resetsAt":2},"sevenDay":null}"#
        );
    }
}
