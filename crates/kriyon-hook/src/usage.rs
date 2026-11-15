//! The status line's capture (ADR-0066): from the JSON Claude Code feeds its
//! status line, the live [`kriyon_core::hooks::UsageSnapshot`] of a Kriyon
//! session and the account's plan limits, as the Python capture made them.

use std::sync::LazyLock;

use regex::Regex;

use crate::json::Json;

/// An id safe to name a file with.
static SAFE_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,128}$").expect("a constant pattern"));

/// Whether `id` may name a usage or limits file.
#[must_use]
pub fn safe_id(id: &str) -> bool {
    SAFE_ID.is_match(id)
}

/// Claude's own session id from the status-line JSON, or "".
#[must_use]
pub fn claude_id(data: &Json) -> String {
    data.get("session_id")
        .and_then(Json::as_str)
        .unwrap_or("")
        .to_string()
}

/// The live context reading of the session's own `claude`.
#[must_use]
pub fn snapshot(data: &Json) -> Json {
    let empty = Json::Obj(Vec::new());
    let obj = |key: &str| data.get(key).filter(|v| v.is_object()).unwrap_or(&empty);
    let (cw, model) = (obj("context_window"), obj("model"));
    let field = |from: &Json, key: &str| from.get(key).cloned().unwrap_or(Json::Null);
    Json::Obj(vec![
        ("usedPercentage".into(), field(cw, "used_percentage")),
        ("contextWindowSize".into(), field(cw, "context_window_size")),
        ("inputTokens".into(), field(cw, "total_input_tokens")),
        ("outputTokens".into(), field(cw, "total_output_tokens")),
        ("model".into(), field(model, "display_name")),
        ("sessionId".into(), Json::Str(claude_id(data))),
    ])
}

/// One plan window: its use and when it resets, both finite numbers.
fn window(raw: Option<&Json>) -> Option<Json> {
    let raw = raw.filter(|raw| raw.is_object())?;
    let used = raw.get("used_percentage")?;
    used.as_finite()?;
    let resets = raw.get("resets_at")?.as_finite()?;
    // Python's int(): toward zero. A reset time is seconds since 1970.
    #[allow(clippy::cast_possible_truncation)]
    let resets = resets.trunc() as i64;
    Some(Json::Obj(vec![
        ("used_percentage".into(), used.clone()),
        ("resets_at".into(), Json::Num(resets.into())),
    ]))
}

/// The account's 5-hour and weekly use, when Claude sent any (a Pro/Max
/// login, after the first reply). `None` when there is nothing to keep.
#[must_use]
pub fn limits(data: &Json) -> Option<Json> {
    let limits = data.get("rate_limits").filter(|l| l.is_object())?;
    let reading: Vec<(String, Json)> = ["five_hour", "seven_day"]
        .iter()
        .filter_map(|key| window(limits.get(key)).map(|w| ((*key).to_string(), w)))
        .collect();
    (!reading.is_empty()).then_some(Json::Obj(reading))
}

/// What the status line shows when the person has none of their own: the
/// model's name, else "Claude".
#[must_use]
pub fn model_name(data: Option<&Json>) -> String {
    data.and_then(|d| d.get("model"))
        .filter(|m| m.truthy())
        .and_then(|m| m.get("display_name"))
        .map_or_else(|| "Claude".to_string(), Json::py_str)
}
