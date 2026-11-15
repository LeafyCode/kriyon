//! One hook event as the [Hook spool] records it: the fields
//! `kriyon_core::hooks::HookEvent` reads, made from Claude Code's hook JSON
//! exactly as the Python hook made them (ADR-0066), so a line reads the same
//! whichever wrote it. Redacted and capped before anything is written.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

use crate::json::{py_dumps, Json};

/// What replaces a secret-named key's value.
const MARK: &str = "[REDACTED]";

/// A key whose value is a secret whatever it looks like.
static SECRET_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(password|passwd|secret|token|api[_-]?key)$").expect("a constant pattern")
});

/// Folders a command rewrites for its tools, not the user's project.
static TOOL_DIRS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"/(?:node_modules|\.git)/").expect("a constant pattern"));

/// An agent id as Claude Code names a subagent's sidecar with it.
static AGENT_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]+$").expect("a constant pattern"));

/// The summary line each test runner ends with: (failed, passed) groups.
static TEST_SUMMARIES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        // cargo test, once per test binary
        r"(?m)^test result: \w+\. (?P<passed>\d+) passed; (?P<failed>\d+) failed",
        // vitest: "Tests  2 failed | 41 passed (43)", "Tests  43 passed (43)"
        r"(?m)^\s*Tests\s+(?:(?P<failed>\d+) failed)?(?:\s*\|\s*)?(?:(?P<passed>\d+) passed)?.*\(\d+\)\s*$",
        // jest: "Tests:  2 failed, 41 passed, 43 total"
        r"(?m)^Tests:\s+(?:(?P<failed>\d+) failed,\s*)?(?:(?P<passed>\d+) passed,\s*)?(?:\d+ \w+,\s*)*\d+ total",
        // pytest: "=== 3 failed, 10 passed in 0.2s ==="
        r"(?m)^=+ (?:(?P<failed>\d+) failed)?(?:, )?(?:(?P<passed>\d+) passed)?[^=]* in [\d.]+s",
    ]
    .into_iter()
    .map(|pattern| Regex::new(pattern).expect("a constant pattern"))
    .collect()
});

/// Node's test runner: "ℹ pass 3" / "ℹ fail 0" (or "# pass 3" in TAP).
static NODE_RESULT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^(?:ℹ|#) (pass|fail) (\d+)\s*$").expect("a constant pattern")
});

/// Redact a text value; any other value is kept as it is.
fn redact(value: &Json) -> Json {
    match value {
        Json::Str(text) => Json::Str(kriyon_core::redact::redact(text)),
        other => other.clone(),
    }
}

/// Redact every string in a value; a secret-named key loses its value.
#[must_use]
pub fn scrub(value: &Json) -> Json {
    match value {
        Json::Str(text) => Json::Str(kriyon_core::redact::redact(text)),
        Json::Obj(items) => Json::Obj(
            items
                .iter()
                .map(|(key, item)| {
                    let blank =
                        SECRET_KEY.is_match(key) && !matches!(item, Json::Obj(_) | Json::Arr(_));
                    let kept = if blank {
                        Json::Str(MARK.into())
                    } else {
                        scrub(item)
                    };
                    (key.clone(), kept)
                })
                .collect(),
        ),
        Json::Arr(items) => Json::Arr(items.iter().map(scrub).collect()),
        other => other.clone(),
    }
}

/// `text` cut to `n` characters, with an ellipsis when it was longer; `None`
/// (null) for a value that isn't text.
fn cap(value: &Json, n: usize) -> Json {
    match value {
        Json::Str(text) if text.chars().count() > n => {
            Json::Str(text.chars().take(n).collect::<String>() + "…")
        }
        Json::Str(text) => Json::Str(text.clone()),
        _ => Json::Null,
    }
}

/// `text` cut to about `n` characters, keeping its start and its end: a
/// command's summary ("43 passed", an error) is usually its last lines.
fn cap_ends(text: &str, n: usize) -> String {
    let count = text.chars().count();
    if count <= n {
        return text.to_string();
    }
    let half = n / 2;
    let head: String = text.chars().take(half).collect();
    let tail: String = text.chars().skip(count - half).collect();
    format!("{head}\n…\n{tail}")
}

/// How many lines Python's `str.splitlines` finds in `text`.
fn py_line_count(text: &str) -> usize {
    let breaks = |c: char| {
        matches!(
            c,
            '\n' | '\r'
                | '\u{b}'
                | '\u{c}'
                | '\u{1c}'
                | '\u{1d}'
                | '\u{1e}'
                | '\u{85}'
                | '\u{2028}'
                | '\u{2029}'
        )
    };
    let mut lines = 0;
    let mut chars = text.chars().peekable();
    let mut open = false;
    while let Some(c) = chars.next() {
        if breaks(c) {
            lines += 1;
            open = false;
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
        } else {
            open = true;
        }
    }
    lines + usize::from(open)
}

/// The files in a Bash `bashEditDiff` that belong to the project.
fn project_files(diff: Option<&Json>) -> Option<Vec<&Json>> {
    let files = diff?.get("files")?.as_array()?;
    Some(
        files
            .iter()
            .filter(|file| {
                file.get("filePath")
                    .and_then(Json::as_str)
                    .is_some_and(|path| !TOOL_DIRS.is_match(path))
            })
            .collect(),
    )
}

/// The lines added and removed, and whether a new file was made, from
/// Claude Code's own patch: an Edit or Write's `structuredPatch`, or the
/// files a Bash command edited (`bashEditDiff`).
fn file_change(tr: Option<&Json>) -> (Json, Json, Json) {
    let Some(tr) = tr.filter(|tr| tr.is_object()) else {
        return (Json::Null, Json::Null, Json::Null);
    };
    let created = (tr.has("type") && tr.has("content"))
        .then(|| tr.get("type").and_then(Json::as_str) == Some("create"));
    let created_json = created.map_or(Json::Null, Json::Bool);
    let hunks: Vec<&Json> = if let Some(hunks) = tr.get("structuredPatch").and_then(Json::as_array)
    {
        hunks.iter().collect()
    } else {
        let Some(files) = project_files(tr.get("bashEditDiff")) else {
            return (Json::Null, Json::Null, created_json);
        };
        files
            .into_iter()
            .flat_map(|file| file.get("hunks").and_then(Json::as_array).unwrap_or(&[]))
            .collect()
    };
    let (mut added, mut removed) = (0_usize, 0_usize);
    for hunk in hunks {
        for line in hunk.get("lines").and_then(Json::as_array).unwrap_or(&[]) {
            match line.as_str() {
                Some(text) if text.starts_with('+') => added += 1,
                Some(text) if text.starts_with('-') => removed += 1,
                _ => {}
            }
        }
    }
    if created == Some(true) {
        if let Some(content) = tr.get("content").and_then(Json::as_str) {
            added = py_line_count(content);
        }
    }
    (
        Json::Num(added.into()),
        Json::Num(removed.into()),
        created_json,
    )
}

/// A tool's result as a person reads it: a command's output, a change's
/// patch, a new file, a page's text, the files a search found. `None` when
/// it has no such shape, to fall back to its JSON.
fn readable(tr: &Json) -> Option<String> {
    let out: Vec<Option<&str>> = ["stdout", "stderr"]
        .iter()
        .map(|key| tr.get(key).and_then(Json::as_str))
        .collect();
    if out.iter().any(Option::is_some) {
        let parts: Vec<&str> = out
            .into_iter()
            .flatten()
            .filter(|t| !t.is_empty())
            .collect();
        return Some(parts.join("\n"));
    }
    if let Some(hunks) = tr.get("structuredPatch").and_then(Json::as_array) {
        if !hunks.is_empty() {
            let lines: Vec<&str> = hunks
                .iter()
                .filter(|hunk| hunk.is_object())
                .flat_map(|hunk| hunk.get("lines").and_then(Json::as_array).unwrap_or(&[]))
                .filter_map(Json::as_str)
                .collect();
            return Some(lines.join("\n"));
        }
    }
    let content = tr.get("content").and_then(Json::as_str);
    if tr.get("type").and_then(Json::as_str) == Some("create") {
        if let Some(content) = content {
            return Some(content.to_string());
        }
    }
    if let Some(text) = tr
        .get("file")
        .and_then(|f| f.get("content"))
        .and_then(Json::as_str)
    {
        return Some(text.to_string());
    }
    if let Some(text) = content.filter(|t| !t.is_empty()) {
        return Some(text.to_string());
    }
    if let Some(names) = tr.get("filenames").and_then(Json::as_array) {
        let names: Vec<String> = names.iter().map(Json::py_str).collect();
        return Some(names.join("\n"));
    }
    tr.get("result").and_then(Json::as_str).map(str::to_string)
}

/// The sidecar Claude Code writes beside a subagent's transcript, naming the
/// launch call that started it.
#[must_use]
pub fn launch_sidecar(data: &Json) -> Option<PathBuf> {
    let agent = data.get("agent_id")?.as_str()?;
    let transcript = data.get("transcript_path")?.as_str()?;
    if !AGENT_ID.is_match(agent) {
        return None;
    }
    let base = transcript.strip_suffix(".jsonl")?;
    Some(
        Path::new(base)
            .join("subagents")
            .join(format!("agent-{agent}.meta.json")),
    )
}

/// The launch call named in a subagent's sidecar text.
fn launched_by(sidecar: Option<&str>) -> Json {
    sidecar
        .and_then(|text| serde_json::from_str::<Json>(text).ok())
        .and_then(|meta| {
            meta.get("toolUseId")
                .and_then(Json::as_str)
                .map(str::to_string)
        })
        .map_or(Json::Null, Json::Str)
}

/// The files a Bash command changed, as Claude Code reports them.
fn changed_files(tr: Option<&Json>) -> Json {
    let files = tr
        .filter(|tr| tr.is_object())
        .and_then(|tr| project_files(tr.get("bashEditDiff")))
        .unwrap_or_default();
    let paths: Vec<Json> = files
        .iter()
        .filter_map(|file| file.get("filePath").and_then(Json::as_str))
        .take(20)
        .map(|path| Json::Str(kriyon_core::redact::redact(path)))
        .collect();
    if paths.is_empty() {
        Json::Null
    } else {
        Json::Arr(paths)
    }
}

/// What came of a call in a few words: a test run's "43 passed" or
/// "2 failed" from every runner's summary, a search's "6 files".
fn outcome_of(tool: Option<&Json>, tr: Option<&Json>) -> Json {
    let Some(tr) = tr.filter(|tr| tr.is_object()) else {
        return Json::Null;
    };
    let tool = tool.and_then(Json::as_str);
    if matches!(tool, Some("Grep" | "Glob")) {
        if let Some(n) = tr.get("numFiles").and_then(Json::as_int) {
            return Json::Str(if n == 1 {
                format!("{n} file")
            } else {
                format!("{n} files")
            });
        }
    }
    if tool != Some("Bash") {
        return Json::Null;
    }
    let out: Vec<&str> = ["stdout", "stderr"]
        .iter()
        .filter_map(|key| tr.get(key).and_then(Json::as_str))
        .collect();
    let out = out.join("\n");
    let (mut passed, mut failed, mut found) = (0_u64, 0_u64, false);
    let number = |m: Option<regex::Match<'_>>| m.and_then(|m| m.as_str().parse::<u64>().ok());
    for summary in TEST_SUMMARIES.iter() {
        for caps in summary.captures_iter(&out) {
            let (p, f) = (number(caps.name("passed")), number(caps.name("failed")));
            if p.is_some() || f.is_some() {
                found = true;
                passed += p.unwrap_or(0);
                failed += f.unwrap_or(0);
            }
        }
    }
    for caps in NODE_RESULT.captures_iter(&out) {
        found = true;
        let n = caps[2].parse::<u64>().unwrap_or(0);
        if &caps[1] == "pass" {
            passed += n;
        } else {
            failed += n;
        }
    }
    if !found {
        return Json::Null;
    }
    Json::Str(if failed > 0 {
        format!("{failed} failed")
    } else {
        format!("{passed} passed")
    })
}

/// A tool's result as the spool keeps it: as a person reads it, redacted,
/// its start and end kept within 4000 characters.
fn result_text(tr: Option<&Json>) -> Json {
    let text = match tr {
        None => return Json::Null,
        Some(tr @ Json::Obj(_)) => match tr.get("content").and_then(Json::as_array) {
            Some(blocks) => {
                let parts: Vec<&str> = blocks
                    .iter()
                    .filter(|b| b.get("type").and_then(Json::as_str) == Some("text"))
                    .filter_map(|b| b.get("text").and_then(Json::as_str))
                    .filter(|t| !t.is_empty())
                    .collect();
                let joined = parts.join("\n");
                if joined.is_empty() {
                    py_dumps(tr)
                } else {
                    joined
                }
            }
            None => readable(tr).unwrap_or_else(|| py_dumps(tr)),
        },
        Some(Json::Str(text)) => text.clone(),
        Some(other) => py_dumps(other),
    };
    Json::Str(cap_ends(&kriyon_core::redact::redact(&text), 4000))
}

/// An `AskUserQuestion`'s questions as JSON text, redacted; dropped when
/// over 2000 characters, so it never arrives cut and unreadable.
fn questions(qs: Option<&Json>) -> Json {
    match qs {
        Some(qs @ Json::Arr(_)) => {
            let text = py_dumps(&scrub(qs));
            if text.chars().count() > 2000 {
                Json::Null
            } else {
                Json::Str(text)
            }
        }
        _ => Json::Null,
    }
}

/// On `Stop`: the background work still running, as id and type.
fn background(tasks: Option<&Json>) -> Json {
    let Some(Json::Arr(tasks)) = tasks else {
        return Json::Null;
    };
    Json::Arr(
        tasks
            .iter()
            .filter(|task| task.is_object())
            .map(|task| {
                let field =
                    |key: &str| Json::Str(task.get(key).map_or_else(String::new, Json::py_str));
                Json::Obj(vec![
                    ("id".into(), field("id")),
                    ("type".into(), field("type")),
                ])
            })
            .collect(),
    )
}

/// A plan's first line, redacted and cut to 200 characters.
fn plan(plan: Option<&Json>) -> Json {
    let Some(Json::Str(plan)) = plan else {
        return Json::Null;
    };
    let first = plan
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim();
    let cut: String = kriyon_core::redact::redact(first)
        .chars()
        .take(200)
        .collect();
    if cut.is_empty() {
        Json::Null
    } else {
        Json::Str(cut)
    }
}

/// The hook JSON `data`'s line for the spool, stamped `ts`; `sidecar` is the
/// text of [`launch_sidecar`]'s file, when there is one. `None` for input
/// that isn't a JSON object, which is skipped.
#[must_use]
pub fn event_record(data: &Json, ts: &str, sidecar: Option<&str>) -> Option<Json> {
    if !data.is_object() {
        return None;
    }
    let get = |key: &str| data.get(key).cloned().unwrap_or(Json::Null);
    let empty = Json::Obj(Vec::new());
    let ti = data
        .get("tool_input")
        .filter(|ti| ti.is_object())
        .unwrap_or(&empty);
    let ti_get = |key: &str| ti.get(key).cloned().unwrap_or(Json::Null);
    let raw_tr = data
        .get("tool_response")
        .filter(|tr| !matches!(tr, Json::Null));

    // Facts the activity log shows beside a step, from the call's own result.
    let (lines_added, lines_removed, created) = file_change(raw_tr);
    let outcome = outcome_of(data.get("tool_name"), raw_tr);
    let edited = changed_files(raw_tr);
    let launcher = launched_by(sidecar);

    // A background Agent returns at once with a launch receipt, not its
    // answer: keep the launched agent's id, drop the rest.
    let receipt =
        raw_tr.filter(|tr| tr.get("status").and_then(Json::as_str) == Some("async_launched"));
    let launched_agent = receipt.map_or(Json::Null, |receipt| {
        Json::Str(
            receipt
                .get("agentId")
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_string(),
        )
    });
    let result = result_text(if receipt.is_some() { None } else { raw_tr });

    // A short human target for the tool: a file path, else a command.
    let file_path = ti_get("file_path");
    let target_from = if file_path.truthy() {
        file_path
    } else {
        ti_get("command")
    };
    let target = cap(&redact(&target_from), 200);
    let message = cap(&redact(&get("message")), 300);
    let questions = questions(ti.get("questions"));
    let background = background(data.get("background_tasks"));
    let plan = plan(ti.get("plan"));
    let input = if ti.truthy() {
        cap(&Json::Str(py_dumps(&scrub(ti))), 2000)
    } else {
        Json::Null
    };
    let source = data
        .get("source")
        .filter(|s| s.as_str().is_some())
        .cloned()
        .unwrap_or(Json::Null);
    let event = data
        .get("hook_event_name")
        .cloned()
        .unwrap_or(Json::Str(String::new()));

    let fields: Vec<(&str, Json)> = vec![
        ("event", event),
        ("session_id", get("session_id")),
        ("transcript_path", get("transcript_path")),
        ("tool_name", get("tool_name")),
        ("tool_use_id", get("tool_use_id")),
        ("subagent_type", ti_get("subagent_type")),
        ("description", cap(&redact(&ti_get("description")), 300)),
        ("run_in_background", ti_get("run_in_background")),
        ("command", cap(&redact(&ti_get("command")), 2000)),
        ("input", input),
        ("prompt", cap(&redact(&get("prompt")), 1000)),
        ("prompt_source", source),
        ("cwd", get("cwd")),
        ("prompt_id", get("prompt_id")),
        ("permission_mode", get("permission_mode")),
        ("result", result),
        ("launched_agent_id", launched_agent),
        ("agent_id", get("agent_id")),
        ("agent_type", get("agent_type")),
        ("duration_ms", get("duration_ms")),
        ("target", target),
        ("message", message),
        ("notification_type", get("notification_type")),
        ("error", get("error")),
        ("questions", questions),
        ("plan", plan),
        ("lines_added", lines_added),
        ("lines_removed", lines_removed),
        ("created", created),
        ("outcome", outcome),
        ("changed_files", edited),
        ("launched_by", launcher),
        ("stop_hook_active", get("stop_hook_active")),
        ("background_tasks", background),
        ("ts", Json::Str(ts.to_string())),
    ];
    Some(Json::Obj(
        fields
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
    ))
}
