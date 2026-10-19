//! Tolerant parser for Claude Code JSONL transcript lines.
//!
//! The terminal is always the source of truth; what is parsed here is a
//! best-effort reconstruction. This parser must NEVER panic and NEVER
//! return a hard error on unrecognized input: any line it cannot map
//! degrades to [`StructuredEvent::Unknown`].

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A single line within a structured diff.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffKind,
    pub text: String,
}

/// Classification of a [`DiffLine`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffKind {
    Added,
    Removed,
    Context,
}

/// A reconstructed event derived from one transcript content block.
///
/// One JSONL line can hold multiple content blocks, so parsing a line yields
/// a `Vec<StructuredEvent>`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StructuredEvent {
    /// A human prompt.
    Prompt { text: String },
    /// Assistant prose.
    Assistant { text: String },
    /// A tool invocation that is neither Bash nor a file edit/write.
    Tool {
        name: String,
        target: Option<String>,
        meta: Option<String>,
    },
    /// A Bash command. Output and exit arrive in a later, uncorrelated line.
    Bash {
        cmd: String,
        output: Vec<String>,
        exit: Option<i32>,
    },
    /// A structured file diff derived from an `Edit` tool call.
    Diff {
        file: String,
        additions: u32,
        deletions: u32,
        hunk: String,
        lines: Vec<DiffLine>,
    },
    /// File contents written by a `Write` tool call.
    Code {
        lang: String,
        file: Option<String>,
        lines: Vec<String>,
    },
    /// One or more multiple-choice questions from an `AskUserQuestion` tool call.
    Question { questions: Vec<QuestionItem> },
    /// Any line or block the parser could not recognize.
    Unknown { raw: String },
}

/// One question within a [`StructuredEvent::Question`] (an `AskUserQuestion`
/// entry). `multi_select` distinguishes checkbox questions from radio ones.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionItem {
    pub header: String,
    pub question: String,
    pub multi_select: bool,
    pub options: Vec<QuestionOption>,
}

/// A selectable answer for a [`QuestionItem`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}

/// A [`StructuredEvent`] tagged with a stable `id` for idempotent delivery to
/// the frontend store. The id is `"<transcript-line-uuid>:<block-index>"`, so
/// re-tailing the same transcript from the start (as `claude --resume` causes)
/// replays identical ids and the store can dedupe by them.
///
/// `event` is flattened, so the wire shape is `{ "id": "…", "kind": "…", … }`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StudioEvent {
    pub id: String,
    #[serde(flatten)]
    pub event: StructuredEvent,
}

/// Parse a single JSONL transcript line into [`StudioEvent`]s — the same events
/// as [`parse_line`], each tagged with a stable `id`. The id derives from the
/// line's `uuid` field (falling back to a hash of the line when absent) plus the
/// block index, so the same line always yields the same ids across replays.
#[must_use]
pub fn parse_studio_events(line: &str) -> Vec<StudioEvent> {
    let key = line_id_key(line);
    parse_line(line)
        .into_iter()
        .enumerate()
        .map(|(index, event)| StudioEvent {
            id: format!("{key}:{index}"),
            event,
        })
        .collect()
}

/// The version of Claude Code's JSONL transcript format this parser is written
/// against. Bumped deliberately when the mapping is updated for a new format, so
/// drift past a known-good baseline is visible in logs rather than silent.
pub const SUPPORTED_TRANSCRIPT_SCHEMA: u32 = 1;

/// The smallest number of parsed events before [`DriftReport::is_degraded`] will
/// conclude the format drifted. Below this, too few events have been seen to tell
/// real drift from an ordinary surprising line.
const DRIFT_MIN_SAMPLE: u32 = 20;

/// The fraction of parsed events that must be `Unknown` (over [`DRIFT_MIN_SAMPLE`])
/// for [`DriftReport::is_degraded`] to flag drift. Normal sessions sit near zero;
/// a majority-unknown sample means the transcript format moved.
const DRIFT_WARN_RATIO: f64 = 0.5;

/// How many parsed [`StudioEvent`]s degraded to [`StructuredEvent::Unknown`]
/// versus the total parsed. A high [`Self::unknown_ratio`] over a meaningful
/// sample means Claude Code's transcript drifted past [`SUPPORTED_TRANSCRIPT_SCHEMA`].
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftReport {
    pub unknown_lines: u32,
    pub total_lines: u32,
}

impl DriftReport {
    /// Fold another report's counts into this one. Used to accumulate a
    /// session-wide picture from the per-line reports the guard returns.
    pub fn merge(&mut self, other: &Self) {
        self.unknown_lines = self.unknown_lines.saturating_add(other.unknown_lines);
        self.total_lines = self.total_lines.saturating_add(other.total_lines);
    }

    /// The fraction of parsed events that were `Unknown`, in `0.0..=1.0`. An
    /// empty report is `0.0` (never a divide-by-zero).
    #[must_use]
    pub fn unknown_ratio(&self) -> f64 {
        if self.total_lines == 0 {
            return 0.0;
        }
        f64::from(self.unknown_lines) / f64::from(self.total_lines)
    }

    /// Whether the parse should be considered degraded by drift:
    /// enough events have been seen ([`DRIFT_MIN_SAMPLE`]) and too many of them
    /// are `Unknown` ([`DRIFT_WARN_RATIO`]). Below the sample floor it is always
    /// `false` so a couple of surprising lines never raise a false alarm.
    #[must_use]
    pub fn is_degraded(&self) -> bool {
        self.total_lines >= DRIFT_MIN_SAMPLE && self.unknown_ratio() > DRIFT_WARN_RATIO
    }
}

/// Parse a transcript line like [`parse_studio_events`], but also return a
/// [`DriftReport`] counting how many of the produced events degraded to
/// [`StructuredEvent::Unknown`]. The events are unchanged — this only observes
/// them — so the parser stays tolerant and never hard-errors on format drift.
#[must_use]
pub fn parse_studio_events_guarded(line: &str) -> (Vec<StudioEvent>, DriftReport) {
    let events = parse_studio_events(line);
    let unknown = events
        .iter()
        .filter(|e| matches!(e.event, StructuredEvent::Unknown { .. }))
        .count();
    let report = DriftReport {
        unknown_lines: u32::try_from(unknown).unwrap_or(u32::MAX),
        total_lines: u32::try_from(events.len()).unwrap_or(u32::MAX),
    };
    (events, report)
}

/// The stable per-line id key: the transcript line's `uuid` if present,
/// otherwise a hash of the raw line so distinct lines never collide.
fn line_id_key(line: &str) -> String {
    use std::hash::{Hash as _, Hasher as _};

    if let Some(uuid) = serde_json::from_str::<Value>(line)
        .ok()
        .as_ref()
        .and_then(|v| v.get("uuid"))
        .and_then(Value::as_str)
    {
        return uuid.to_string();
    }
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    line.hash(&mut hasher);
    format!("h{:016x}", hasher.finish())
}

/// Extract the session title from an `ai-title` transcript line, or `None` for
/// any other (or malformed) line. Claude Code writes/updates this line as the
/// session evolves; it is the source for the [Session title].
#[must_use]
pub fn parse_title(line: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("ai-title") {
        return None;
    }
    let title = value.get("aiTitle").and_then(Value::as_str)?;
    if title.is_empty() {
        return None;
    }
    Some(title.to_string())
}

/// Wrapper tags Claude Code wraps around a prompt that carry no user intent.
/// A line opening with one of these is skipped when labelling a prompt.
const WRAPPER_TAGS: [&str; 3] = [
    "<command-message>",
    "<local-command-caveat>",
    "<system-reminder>",
];

/// The longest label a prompt may become, in characters. Claude's own
/// `ai-title` runs well under this. The cap stops a long first prompt (a pasted
/// trace, an unbroken paragraph) becoming the session's name everywhere it is
/// carried: the sidebar row, the persisted store, and a notification subtitle.
const MAX_LABEL_CHARS: usize = 80;

/// Render a user prompt's text as a one-line human label.
///
/// A slash-command invocation collapses to how the user typed it
/// (`/pr-review 115`); anything else is its first line that carries real
/// content, capped at [`MAX_LABEL_CHARS`]. `None` when the prompt is only
/// wrappers or whitespace.
#[must_use]
pub fn prompt_label(text: &str) -> Option<String> {
    if let Some(label) = command_label(text) {
        return Some(clamp(&label));
    }
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !WRAPPER_TAGS.iter().any(|tag| line.starts_with(tag)))
        .map(clamp)
}

/// `/pr-review 115` for a slash-command prompt, `None` for anything else.
///
/// The wrapper block is only recognized where Claude writes it — at the very
/// start of the prompt. Prose that merely mentions `<command-name>` is prose,
/// not an invocation, and must keep its own text as the label.
pub(crate) fn command_label(text: &str) -> Option<String> {
    let trimmed = text.trim_start();
    if !(trimmed.starts_with("<command-message>") || trimmed.starts_with("<command-name>")) {
        return None;
    }
    let name = between(trimmed, "<command-name>", "</command-name>")?;
    let args = between(trimmed, "<command-args>", "</command-args>").unwrap_or_default();
    let label = format!("{name} {args}");
    let label = label.trim();
    (!label.is_empty()).then(|| label.to_string())
}

/// `label` shortened to [`MAX_LABEL_CHARS`] with an ellipsis. Counts characters,
/// never bytes — slicing a multi-byte prompt mid-character would panic.
fn clamp(label: &str) -> String {
    if label.chars().count() <= MAX_LABEL_CHARS {
        return label.to_string();
    }
    let head: String = label.chars().take(MAX_LABEL_CHARS - 1).collect();
    format!("{}\u{2026}", head.trim_end())
}

/// `text` with Claude Code's paste markers taken out, shown the way Claude
/// Code shows it.
///
/// Claude Code records a paste inside the prompt as
/// `\n\n<pasted_content id="1a2b">\n…\n</pasted_content id="1a2b">\n`, so the
/// model knows which part the user pasted. The markers are for the model, not
/// the person. Like Claude Code, this takes only a four-hex-digit id followed by
/// a newline, and drops up to two newlines on each side of a paste.
#[must_use]
pub fn unwrap_pastes(text: &str) -> String {
    const OPEN: &str = "<pasted_content id=\"";
    const ID_LEN: usize = 4;
    let is_id = |id: &[u8]| {
        id.len() == ID_LEN
            && id
                .iter()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
    };
    let mut out = String::with_capacity(text.len());
    // `kept` is where the text not yet copied starts; `from` where to look next.
    let (mut kept, mut from) = (0, 0);
    while let Some(found) = text[from..].find(OPEN) {
        let open = from + found;
        let id_at = open + OPEN.len();
        let id = text
            .as_bytes()
            .get(id_at..id_at + ID_LEN)
            .unwrap_or_default();
        if !is_id(id) || !text[id_at + ID_LEN..].starts_with("\">\n") {
            from = id_at;
            continue;
        }
        let id = &text[id_at..id_at + ID_LEN];
        let body_at = id_at + ID_LEN + 3;
        let close = format!("\n</pasted_content id=\"{id}\">");
        let Some(found) = text[body_at - 1..].find(close.as_str()) else {
            break;
        };
        let body_end = body_at - 1 + found;
        let mut typed_end = open;
        for _ in 0..2 {
            if typed_end > kept && text.as_bytes()[typed_end - 1] == b'\n' {
                typed_end -= 1;
            }
        }
        out.push_str(&text[kept..typed_end]);
        out.push_str(text.get(body_at..body_end).unwrap_or_default());
        kept = body_end + close.len();
        for _ in 0..2 {
            if text[kept..].starts_with('\n') {
                kept += 1;
            }
        }
        from = kept;
    }
    out.push_str(&text[kept..]);
    out
}

/// The trimmed text between the first `open`/`close` pair, if both are present.
pub(crate) fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let rest = text.split_once(open)?.1;
    Some(rest.split_once(close)?.0.trim())
}

/// A provisional [Session title] derived from a `user` transcript line, for
/// sessions Claude Code never titles.
///
/// Claude only writes an `ai-title` once the user types free text — a session
/// driven purely by slash commands never gets one, so the sidebar would keep
/// its placeholder forever. Labelling the prompt gives those sessions a
/// distinguishable name until (and only until) a real `ai-title` arrives.
/// Sidechain (subagent) prompts are ignored: they are not the user's.
#[must_use]
pub fn parse_provisional_title(line: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("user") {
        return None;
    }
    if value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    prompt_label_of(&value)
}

/// [`prompt_label`] for an already-parsed `user` line — the shared path for the
/// live [Session title] fallback and the [Past session] preview, so both read a
/// slash command the way it was typed.
#[must_use]
pub fn prompt_label_of(value: &Value) -> Option<String> {
    prompt_label(&user_prompt_text(value)?)
}

/// The prompt text of a `user` line: a bare string, else its first `text`
/// block. `None` for a tool-result-only line, which carries no prompt.
fn user_prompt_text(value: &Value) -> Option<String> {
    let text = match value.get("message")?.get("content")? {
        Value::String(text) => Some(text.as_str()),
        Value::Array(blocks) => blocks
            .iter()
            .find(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .and_then(|b| b.get("text").and_then(Value::as_str)),
        _ => None,
    };
    text.map(unwrap_pastes)
}

/// Parse a single JSONL transcript line into zero or more [`StructuredEvent`]s.
///
/// This function is total and tolerant: it never panics and never returns an
/// error. Blank lines yield an empty `Vec`; anything unrecognized yields an
/// [`StructuredEvent::Unknown`] preserving the raw line.
#[must_use]
pub fn parse_line(line: &str) -> Vec<StructuredEvent> {
    if line.trim().is_empty() {
        return Vec::new();
    }

    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return vec![unknown(line)];
    };

    match value.get("type").and_then(Value::as_str) {
        Some("user") => parse_user(line, &value),
        Some("assistant") => parse_assistant(line, &value),
        // Control/UI/meta lines Claude Code writes into the transcript that
        // carry no conversation — intentionally ignored (not Unknown), so they
        // neither pollute the derived data nor evict real events from the cap.
        Some(t) if is_control_meta(t) => Vec::new(),
        _ => vec![unknown(line)],
    }
}

/// Whether a top-level transcript `type` is a non-conversational control/UI/meta
/// line (session title, mode, attachments, history snapshots, …) that the event
/// view should ignore. Unrecognized types are NOT control — they fall through to
/// [`StructuredEvent::Unknown`] so genuine surprises are preserved.
fn is_control_meta(ty: &str) -> bool {
    matches!(
        ty,
        "attachment"
            | "last-prompt"
            | "mode"
            | "permission-mode"
            | "ai-title"
            | "file-history-snapshot"
            | "queue-operation"
            | "system"
            | "summary"
    )
}

fn parse_user(line: &str, value: &Value) -> Vec<StructuredEvent> {
    let content = value.get("message").and_then(|m| m.get("content"));
    match content {
        Some(Value::String(text)) => vec![StructuredEvent::Prompt {
            text: unwrap_pastes(text),
        }],
        Some(Value::Array(blocks)) => map_blocks(line, blocks, Role::User),
        _ => vec![unknown(line)],
    }
}

fn parse_assistant(line: &str, value: &Value) -> Vec<StructuredEvent> {
    let message = value.get("message");
    // Per-message `usage` is not surfaced: a per-line sum double-counts split
    // messages, and no transcript count is exact (ADR-0038).
    match message.and_then(|m| m.get("content")) {
        Some(Value::Array(blocks)) => map_blocks(line, blocks, Role::Assistant),
        _ => vec![unknown(line)],
    }
}

#[derive(Clone, Copy)]
enum Role {
    User,
    Assistant,
}

fn map_blocks(line: &str, blocks: &[Value], role: Role) -> Vec<StructuredEvent> {
    blocks
        .iter()
        .filter_map(|block| map_block(line, block, role))
        .collect()
}

fn map_block(line: &str, block: &Value, role: Role) -> Option<StructuredEvent> {
    match block.get("type").and_then(Value::as_str) {
        Some("text") => {
            let text = block
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            Some(match role {
                Role::Assistant => StructuredEvent::Assistant { text },
                Role::User => StructuredEvent::Prompt {
                    text: unwrap_pastes(&text),
                },
            })
        }
        Some("tool_use") => Some(map_tool_use(block)),
        // Internal reasoning, tool output (verbose JSON), and images (binary)
        // carry no reader-facing text — drop them rather
        // than dump the raw line.
        Some("thinking" | "tool_result" | "image") => None,
        // A genuinely unrecognized block type is preserved as Unknown.
        _ => Some(unknown(line)),
    }
}

fn map_tool_use(block: &Value) -> StructuredEvent {
    let name = block
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let input = block.get("input");

    match name {
        "Bash" => StructuredEvent::Bash {
            cmd: input_str(input, "command"),
            output: Vec::new(),
            exit: None,
        },
        "Edit" => {
            let old = input_str(input, "old_string");
            let new = input_str(input, "new_string");
            let mut lines = Vec::new();
            let deletions = count_lines(&old);
            let additions = count_lines(&new);
            for text in old.lines() {
                lines.push(DiffLine {
                    kind: DiffKind::Removed,
                    text: text.to_string(),
                });
            }
            for text in new.lines() {
                lines.push(DiffLine {
                    kind: DiffKind::Added,
                    text: text.to_string(),
                });
            }
            StructuredEvent::Diff {
                file: input_str(input, "file_path"),
                additions,
                deletions,
                hunk: String::new(),
                lines,
            }
        }
        "Write" => {
            let file = input_str(input, "file_path");
            let content = input_str(input, "content");
            StructuredEvent::Code {
                lang: lang_from_path(&file),
                file: Some(file),
                lines: content.lines().map(str::to_string).collect(),
            }
        }
        "AskUserQuestion" => {
            map_ask_user_question(input).unwrap_or_else(|| generic_tool(name, input))
        }
        _ => generic_tool(name, input),
    }
}

/// The fallback tool mapping: name plus a best-effort `file_path`/`command`
/// target. Used for any tool without a richer structured form.
fn generic_tool(name: &str, input: Option<&Value>) -> StructuredEvent {
    let target = opt_input_str(input, "file_path").or_else(|| opt_input_str(input, "command"));
    StructuredEvent::Tool {
        name: name.to_string(),
        target,
        meta: None,
    }
}

/// Map an `AskUserQuestion` tool input into a [`StructuredEvent::Question`].
/// Returns `None` on any missing/malformed field so the caller can fall back to
/// the generic tool mapping — the parser never hard-errors.
fn map_ask_user_question(input: Option<&Value>) -> Option<StructuredEvent> {
    let questions = input?.get("questions")?.as_array()?;
    let mut items = Vec::new();
    for q in questions {
        let question = q.get("question")?.as_str()?.to_string();
        let header = q
            .get("header")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let multi_select = q
            .get("multiSelect")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let options = q
            .get("options")
            .and_then(Value::as_array)
            .map(|opts| {
                opts.iter()
                    .map(|o| QuestionOption {
                        label: opt_input_str(Some(o), "label").unwrap_or_default(),
                        description: opt_input_str(Some(o), "description").unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        items.push(QuestionItem {
            header,
            question,
            multi_select,
            options,
        });
    }
    if items.is_empty() {
        return None;
    }
    Some(StructuredEvent::Question { questions: items })
}

fn unknown(line: &str) -> StructuredEvent {
    StructuredEvent::Unknown {
        raw: line.to_string(),
    }
}

fn input_str(input: Option<&Value>, key: &str) -> String {
    opt_input_str(input, key).unwrap_or_default()
}

fn opt_input_str(input: Option<&Value>, key: &str) -> Option<String> {
    input
        .and_then(|i| i.get(key))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Count the lines in a string the way a diff would: a trailing newline does
/// not introduce an extra empty line, and an empty string is zero lines.
fn count_lines(s: &str) -> u32 {
    u32::try_from(s.lines().count()).unwrap_or(u32::MAX)
}

/// Map a file extension to a language identifier for syntax highlighting.
#[must_use]
fn lang_from_path(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or_default();
    match ext {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" => "javascript",
        "py" => "python",
        "md" => "markdown",
        "json" => "json",
        "toml" => "toml",
        _ => "text",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_string_content_is_prompt() {
        let line = r#"{"type":"user","message":{"role":"user","content":"hello there"}}"#;
        let events = parse_line(line);
        assert_eq!(
            events,
            vec![StructuredEvent::Prompt {
                text: "hello there".to_string()
            }]
        );
    }

    #[test]
    fn assistant_thinking_is_skipped_text_kept() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm","signature":"sig"},{"type":"text","text":"hi"}]}}"#;
        let events = parse_line(line);
        assert_eq!(
            events,
            vec![StructuredEvent::Assistant {
                text: "hi".to_string()
            }]
        );
    }

    #[test]
    fn assistant_bash_tool_use() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls -la","description":"list"}}]}}"#;
        let events = parse_line(line);
        assert_eq!(
            events,
            vec![StructuredEvent::Bash {
                cmd: "ls -la".to_string(),
                output: vec![],
                exit: None,
            }]
        );
    }

    #[test]
    fn assistant_ask_user_question_produces_question() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"AskUserQuestion","input":{"questions":[{"question":"Pick one?","header":"Choice","multiSelect":false,"options":[{"label":"A","description":"first"},{"label":"B","description":"second"}]}]}}]}}"#;
        assert_eq!(
            parse_line(line),
            vec![StructuredEvent::Question {
                questions: vec![QuestionItem {
                    header: "Choice".to_string(),
                    question: "Pick one?".to_string(),
                    multi_select: false,
                    options: vec![
                        QuestionOption {
                            label: "A".to_string(),
                            description: "first".to_string(),
                        },
                        QuestionOption {
                            label: "B".to_string(),
                            description: "second".to_string(),
                        },
                    ],
                }],
            }]
        );
    }

    #[test]
    fn malformed_ask_user_question_falls_back_to_tool() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"AskUserQuestion","input":{"foo":"bar"}}]}}"#;
        assert_eq!(
            parse_line(line),
            vec![StructuredEvent::Tool {
                name: "AskUserQuestion".to_string(),
                target: None,
                meta: None,
            }]
        );
    }

    #[test]
    fn assistant_read_tool_use_targets_file_path() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/tmp/x.txt"}}]}}"#;
        let events = parse_line(line);
        assert_eq!(
            events,
            vec![StructuredEvent::Tool {
                name: "Read".to_string(),
                target: Some("/tmp/x.txt".to_string()),
                meta: None,
            }]
        );
    }

    #[test]
    fn assistant_edit_tool_use_produces_diff() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"/a/b.rs","old_string":"foo\nbar","new_string":"baz","replace_all":false}}]}}"#;
        let events = parse_line(line);
        assert_eq!(
            events,
            vec![StructuredEvent::Diff {
                file: "/a/b.rs".to_string(),
                additions: 1,
                deletions: 2,
                hunk: String::new(),
                lines: vec![
                    DiffLine {
                        kind: DiffKind::Removed,
                        text: "foo".to_string()
                    },
                    DiffLine {
                        kind: DiffKind::Removed,
                        text: "bar".to_string()
                    },
                    DiffLine {
                        kind: DiffKind::Added,
                        text: "baz".to_string()
                    },
                ],
            }]
        );
    }

    #[test]
    fn assistant_write_tool_use_produces_code() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"/a/main.rs","content":"fn main() {}\n"}}]}}"#;
        let events = parse_line(line);
        assert_eq!(
            events,
            vec![StructuredEvent::Code {
                lang: "rust".to_string(),
                file: Some("/a/main.rs".to_string()),
                lines: vec!["fn main() {}".to_string()],
            }]
        );
    }

    #[test]
    fn assistant_usage_yields_no_event_of_its_own() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"done"}],"usage":{"input_tokens":12,"output_tokens":34,"cache_read_input_tokens":5}}}"#;
        assert_eq!(
            parse_line(line),
            vec![StructuredEvent::Assistant {
                text: "done".to_string()
            }]
        );
    }

    #[test]
    fn tool_result_block_is_dropped() {
        // Tool output is verbose JSON with no clean text to derive from;
        // drop it rather than dumping the raw line.
        let line = r#"{"type":"user","message":{"content":[{"tool_use_id":"t1","type":"tool_result","content":"output text"}]}}"#;
        assert_eq!(
            parse_line(line),
            [] as [crate::transcript::StructuredEvent; 0]
        );
    }

    #[test]
    fn image_block_is_dropped() {
        let line = r#"{"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","data":"AAAA"}}]}}"#;
        assert_eq!(
            parse_line(line),
            [] as [crate::transcript::StructuredEvent; 0]
        );
    }

    #[test]
    fn control_meta_lines_are_dropped() {
        // Claude Code writes these UI/control lines into the transcript; they
        // carry no conversation and must not clutter the event stream (nor
        // evict real events from the capped buffer).
        for ty in [
            "attachment",
            "last-prompt",
            "mode",
            "permission-mode",
            "ai-title",
            "file-history-snapshot",
            "queue-operation",
            "system",
            "summary",
        ] {
            let line = format!(r#"{{"type":"{ty}","foo":"bar"}}"#);
            assert!(
                parse_line(&line).is_empty(),
                "control line `{ty}` should be dropped, not shown"
            );
        }
    }

    #[test]
    fn genuinely_unknown_top_level_type_is_unknown() {
        // Resilience: a type we have never seen is preserved as Unknown rather
        // than silently dropped, so nothing is lost on a Claude Code change.
        let line = r#"{"type":"some-brand-new-thing","x":1}"#;
        assert_eq!(parse_line(line), vec![unknown(line)]);
    }

    #[test]
    fn malformed_json_is_unknown() {
        let line = "this is not json {";
        let events = parse_line(line);
        assert_eq!(events, vec![unknown(line)]);
    }

    #[test]
    fn blank_line_is_empty() {
        assert_eq!(
            parse_line(""),
            [] as [crate::transcript::StructuredEvent; 0]
        );
        assert_eq!(
            parse_line("   \t  "),
            [] as [crate::transcript::StructuredEvent; 0]
        );
    }

    #[test]
    fn diff_round_trips() {
        let event = StructuredEvent::Diff {
            file: "/a/b.rs".to_string(),
            additions: 1,
            deletions: 2,
            hunk: String::new(),
            lines: vec![
                DiffLine {
                    kind: DiffKind::Removed,
                    text: "old".to_string(),
                },
                DiffLine {
                    kind: DiffKind::Added,
                    text: "new".to_string(),
                },
            ],
        };
        let json = serde_json::to_string(&event).expect("serialize");
        let back: StructuredEvent = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(event, back);
    }

    // --- session title (ai-title) ---

    #[test]
    fn parse_title_extracts_ai_title() {
        let line = r#"{"type":"ai-title","aiTitle":"Fix session persistence","sessionId":"c1"}"#;
        assert_eq!(
            parse_title(line),
            Some("Fix session persistence".to_string())
        );
    }

    #[test]
    fn parse_title_ignores_non_title_lines() {
        assert_eq!(
            parse_title(r#"{"type":"user","message":{"content":"hi"}}"#),
            None
        );
        assert_eq!(
            parse_title(r#"{"type":"ai-title"}"#),
            None,
            "no aiTitle field"
        );
        assert_eq!(parse_title(""), None);
        assert_eq!(parse_title("not json {"), None);
    }

    // --- provisional title (first user prompt) ---

    #[test]
    fn prompt_label_collapses_a_slash_command() {
        let text = "<command-message>pr-review</command-message>\n<command-name>/pr-review</command-name>\n<command-args>115</command-args>";
        assert_eq!(prompt_label(text), Some("/pr-review 115".to_string()));
    }

    #[test]
    fn prompt_label_keeps_a_bare_slash_command() {
        let text = "<command-message>ship</command-message>\n<command-name>/ship</command-name>\n<command-args></command-args>";
        assert_eq!(prompt_label(text), Some("/ship".to_string()));
    }

    #[test]
    fn prompt_label_takes_the_first_real_line_of_prose() {
        assert_eq!(
            prompt_label("  Resolve the merge conflicts.\nThen push.  "),
            Some("Resolve the merge conflicts.".to_string())
        );
    }

    #[test]
    fn prompt_label_ignores_a_command_tag_inside_prose() {
        // Prose that merely mentions the wrapper is not an invocation. Claude
        // writes the block at the very start of the prompt or not at all.
        let text = "Explain how Claude wraps prompts in <command-name>/foo</command-name> tags";
        assert_eq!(prompt_label(text), Some(text.to_string()));
    }

    #[test]
    fn prompt_label_caps_a_very_long_prompt() {
        let label = prompt_label(&"x".repeat(5000)).expect("label");
        assert_eq!(label.chars().count(), MAX_LABEL_CHARS);
        assert!(label.ends_with('\u{2026}'), "got: {label}");
    }

    #[test]
    fn prompt_label_caps_on_characters_not_bytes() {
        // Byte slicing a multi-byte prompt would panic; count characters.
        let label = prompt_label(&"\u{3042}".repeat(200)).expect("label");
        assert_eq!(label.chars().count(), MAX_LABEL_CHARS);
    }

    #[test]
    fn prompt_label_skips_wrapper_only_lines() {
        let text =
            "<local-command-caveat>Caveat: replayed</local-command-caveat>\nPush this branch";
        assert_eq!(prompt_label(text), Some("Push this branch".to_string()));
        assert_eq!(prompt_label("   \n  "), None);
        assert_eq!(
            prompt_label("<system-reminder>noise</system-reminder>"),
            None
        );
    }

    #[test]
    fn unwrap_pastes_shows_a_paste_the_way_claude_code_does() {
        // Claude Code puts two newlines before a paste and drops them, and the
        // ones after it, when it shows the prompt.
        let mixed = "Send this to \n\n<pasted_content id=\"2d96\">\nColonel A,\nCamp B\n</pasted_content id=\"2d96\">\n";
        assert_eq!(unwrap_pastes(mixed), "Send this to Colonel A,\nCamp B");
        let whole =
            "\n\n<pasted_content id=\"e951\">\nrun the tests\n</pasted_content id=\"e951\">\n";
        assert_eq!(unwrap_pastes(whole), "run the tests");
    }

    #[test]
    fn unwrap_pastes_leaves_text_that_only_looks_like_a_marker() {
        let open_only = "Why does <pasted_content id=\"8239\"> show up?";
        assert_eq!(unwrap_pastes(open_only), open_only);
        // Claude Code's ids are four lowercase hex digits, then a newline.
        let quoted = "What do <pasted_content id=\"x\">a</pasted_content id=\"x\"> mean?";
        assert_eq!(unwrap_pastes(quoted), quoted);
        let inline = "See <pasted_content id=\"abcd\">a\n</pasted_content id=\"abcd\"> here";
        assert_eq!(unwrap_pastes(inline), inline);
    }

    #[test]
    fn a_pasted_prompt_reads_as_its_text_everywhere() {
        let pasted =
            "\n\n<pasted_content id=\"aae1\">\nRead the handoff\n</pasted_content id=\"aae1\">\n";
        let as_string =
            serde_json::json!({"type": "user", "message": {"role": "user", "content": pasted}});
        let as_block = serde_json::json!({"type": "user", "message": {"role": "user",
            "content": [{"type": "text", "text": pasted}]}});
        for line in [as_string.to_string(), as_block.to_string()] {
            assert_eq!(
                parse_line(&line),
                vec![StructuredEvent::Prompt {
                    text: "Read the handoff".into()
                }]
            );
            assert_eq!(
                parse_provisional_title(&line),
                Some("Read the handoff".to_string())
            );
        }
    }

    #[test]
    fn parse_provisional_title_reads_the_first_user_prompt() {
        let line = r#"{"type":"user","message":{"role":"user","content":"<command-message>pr-review</command-message>\n<command-name>/pr-review</command-name>\n<command-args>97</command-args>"}}"#;
        assert_eq!(
            parse_provisional_title(line),
            Some("/pr-review 97".to_string())
        );
    }

    #[test]
    fn parse_provisional_title_reads_a_text_block_prompt() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Review PR 12"}]}}"#;
        assert_eq!(
            parse_provisional_title(line),
            Some("Review PR 12".to_string())
        );
    }

    #[test]
    fn parse_provisional_title_ignores_non_prompt_lines() {
        assert_eq!(
            parse_provisional_title(r#"{"type":"assistant","message":{"content":"hi"}}"#),
            None
        );
        assert_eq!(
            parse_provisional_title(
                r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#
            ),
            None,
            "a tool result is not a prompt"
        );
        assert_eq!(
            parse_provisional_title(
                r#"{"type":"user","isSidechain":true,"message":{"content":"subagent work"}}"#
            ),
            None,
            "a subagent's prompt must not title the session"
        );
        assert_eq!(parse_provisional_title("not json {"), None);
    }

    // --- StudioEvent ids ---

    #[test]
    fn studio_events_id_from_uuid_and_block_index() {
        // One assistant line with two text blocks yields index 0 and index 1;
        // each id is `<uuid>:<index>`.
        let line = r#"{"type":"assistant","uuid":"abc","message":{"content":[{"type":"text","text":"hi"},{"type":"text","text":"there"}]}}"#;
        let events = parse_studio_events(line);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].id, "abc:0");
        assert_eq!(
            events[0].event,
            StructuredEvent::Assistant {
                text: "hi".to_string()
            }
        );
        assert_eq!(events[1].id, "abc:1");
    }

    #[test]
    fn studio_events_ids_are_stable_across_calls() {
        let line = r#"{"type":"user","uuid":"u9","message":{"role":"user","content":"hello"}}"#;
        let first = parse_studio_events(line);
        let second = parse_studio_events(line);
        assert_eq!(
            first, second,
            "same line must yield identical ids (idempotent replay)"
        );
        assert_eq!(first[0].id, "u9:0");
    }

    #[test]
    fn studio_event_serializes_flat_with_id() {
        let line = r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"yo"}}"#;
        let event = &parse_studio_events(line)[0];
        let json = serde_json::to_string(event).expect("serialize");
        assert!(json.contains("\"id\":\"u1:0\""), "got: {json}");
        assert!(
            json.contains("\"kind\":\"prompt\""),
            "flattened event, got: {json}"
        );
        assert!(json.contains("\"text\":\"yo\""), "got: {json}");
    }

    #[test]
    fn studio_events_uuidless_line_still_gets_distinct_ids() {
        // A line with no uuid (defensive) must still produce unique, stable ids
        // so dedupe never collapses distinct events.
        let line = r#"{"type":"user","message":{"role":"user","content":"a"}}"#;
        let events = parse_studio_events(line);
        assert_eq!(events.len(), 1);
        assert_eq!(
            parse_studio_events(line),
            events,
            "stable without a uuid too"
        );
    }

    // --- drift guard (Workstream B) ---

    #[test]
    fn supported_transcript_schema_is_pinned() {
        // A deliberately-bumped pin; surfaces in logs when Claude's format moves.
        assert_eq!(SUPPORTED_TRANSCRIPT_SCHEMA, 1);
    }

    #[test]
    fn guarded_parse_reports_no_drift_for_known_line() {
        // A recognized line yields its events and a clean report.
        let line = r#"{"type":"user","message":{"role":"user","content":"hi"}}"#;
        let (events, report) = parse_studio_events_guarded(line);
        assert_eq!(events.len(), 1);
        assert_eq!(report.unknown_lines, 0);
        assert_eq!(report.total_lines, 1);
        assert!(!report.is_degraded(), "a clean line is not drift");
    }

    #[test]
    fn guarded_parse_counts_unknown_events() {
        // A genuinely-unrecognized top-level type degrades to Unknown and is
        // counted in the report — never a hard error.
        let line = r#"{"type":"some-brand-new-thing","x":1}"#;
        let (events, report) = parse_studio_events_guarded(line);
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0].event, StructuredEvent::Unknown { .. }));
        assert_eq!(report.unknown_lines, 1);
        assert_eq!(report.total_lines, 1);
    }

    #[test]
    fn guarded_parse_malformed_json_degrades_not_errors() {
        // Malformed JSON must degrade to Unknown + a report, never panic/error.
        let line = "this is not json {";
        let (events, report) = parse_studio_events_guarded(line);
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0].event, StructuredEvent::Unknown { .. }));
        assert_eq!(report.unknown_lines, 1);
        assert_eq!(report.total_lines, 1);
    }

    #[test]
    fn guarded_parse_blank_line_is_empty_with_zero_report() {
        let (events, report) = parse_studio_events_guarded("   ");
        assert_eq!(events, [] as [crate::transcript::StudioEvent; 0]);
        assert_eq!(report.unknown_lines, 0);
        assert_eq!(report.total_lines, 0);
    }

    #[test]
    fn drift_report_unknown_ratio() {
        let report = DriftReport {
            unknown_lines: 3,
            total_lines: 12,
        };
        assert!((report.unknown_ratio() - 0.25).abs() < f64::EPSILON);
        // An empty report is 0.0, never a divide-by-zero / NaN.
        assert!(DriftReport::default().unknown_ratio().abs() < f64::EPSILON);
    }

    #[test]
    fn drift_report_merge_accumulates() {
        let mut total = DriftReport::default();
        total.merge(&DriftReport {
            unknown_lines: 1,
            total_lines: 4,
        });
        total.merge(&DriftReport {
            unknown_lines: 2,
            total_lines: 6,
        });
        assert_eq!(total.unknown_lines, 3);
        assert_eq!(total.total_lines, 10);
    }

    #[test]
    fn drift_report_is_degraded_needs_sample_and_high_ratio() {
        // A tiny all-unknown sample is NOT degraded — too little signal to alarm.
        let tiny = DriftReport {
            unknown_lines: 3,
            total_lines: 3,
        };
        assert!(!tiny.is_degraded(), "too few events to conclude drift");

        // A healthy session with plenty of events is not degraded.
        let healthy = DriftReport {
            unknown_lines: 1,
            total_lines: 100,
        };
        assert!(!healthy.is_degraded(), "the odd Unknown is normal");

        // A large sample that is mostly Unknown is drift.
        let drifted = DriftReport {
            unknown_lines: 80,
            total_lines: 100,
        };
        assert!(drifted.is_degraded(), "format moved out from under us");
    }
}
