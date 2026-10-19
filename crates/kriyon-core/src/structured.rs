//! The [Structured view]'s pure half: the conversation as turns — a prompt,
//! what Claude did, its reply — built from two sources.
//!
//! - **Live** rows: what the [Kriyon Companion] forwarded from `session.append`,
//!   exact and in the order the mod numbered them.
//! - **Transcript** rows: Claude Code's own JSONL, for history from before the
//!   companion connected. The transcript is a tree (a rewind leaves the old
//!   branch in the file), so the conversation is the chain from the newest
//!   main row back through `parentUuid` — never file order.
//!
//! A row in both is the same row (same uuid) and counts as live. Raw thinking
//! is never available; a thinking block becomes "thought for N s" when the
//! transcript recorded how long. Every parse is tolerant: an unreadable line is
//! skipped, never an error.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::Value;

use crate::work_report::WorkReport;

/// The longest tool input or result preview kept per step.
const PREVIEW: usize = 2000;

/// One content block, reduced to what the view shows.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Block {
    Text(String),
    Thinking,
    ToolUse {
        id: String,
        name: String,
        input: String,
        target: Option<String>,
        description: Option<String>,
    },
    ToolResult {
        id: String,
        is_error: bool,
        content: String,
    },
    Other,
}

/// One conversation row from either source.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Row {
    uuid: String,
    parent: Option<String>,
    role: String,
    name: Option<String>,
    is_meta: bool,
    /// The summary Claude Code writes after a compaction: a user row nobody
    /// typed, written when the compaction ran.
    compact_summary: bool,
    /// Who wrote a `user` row (`origin.kind`): `human`, or Claude Code
    /// itself (a [Work report]'s `task-notification`).
    origin: Option<String>,
    /// A subagent's row (shown folded under its tool call, not inline).
    sidechain: bool,
    blocks: Vec<Block>,
    thinking_ms: Option<u64>,
    /// When the row was written: the transcript's `timestamp`, or when the
    /// daemon received a live row.
    at_ms: Option<i64>,
}

/// What Claude Code writes in place of a reply when the user presses Esc:
/// `[Request interrupted by user]`, or `… for tool use]` mid-tool.
const INTERRUPT_MARK: &str = "[Request interrupted by user";

/// The meta row Claude Code adds after a prompt for each image it was given
/// as a file: `[Image: source: /path/to/shot.png]`.
const IMAGE_SOURCE: &str = "[Image: source: ";

impl Row {
    fn texts(&self) -> impl Iterator<Item = &str> {
        self.blocks.iter().filter_map(|b| match b {
            Block::Text(t) => Some(t.as_str()),
            _ => None,
        })
    }

    fn is_interrupt(&self) -> bool {
        self.role == "user"
            && self
                .texts()
                .any(|t| t.trim_start().starts_with(INTERRUPT_MARK))
    }

    /// The [Work report]s the row carries, when it is one: a `user` row
    /// Claude Code wrote, not a person (whose prompt may quote one).
    fn work_reports(&self) -> Option<Vec<WorkReport>> {
        let by_claude_code = self
            .origin
            .as_deref()
            .is_none_or(|kind| kind == crate::work_report::ORIGIN);
        if self.role != "user" || self.is_meta || !by_claude_code {
            return None;
        }
        crate::work_report::parse(&self.texts().collect::<Vec<_>>().join("\n"))
    }

    /// The image paths an `[Image: source: …]` meta row names.
    fn image_sources(&self) -> Vec<String> {
        self.texts()
            .filter_map(|t| {
                t.trim()
                    .strip_prefix(IMAGE_SOURCE)?
                    .strip_suffix(']')
                    .map(str::to_string)
            })
            .collect()
    }
}

fn cap(text: &str) -> String {
    if text.chars().count() <= PREVIEW {
        return text.to_string();
    }
    let cut: String = text.chars().take(PREVIEW).collect();
    format!("{cut}…")
}

/// A tool input's non-blank text field, trimmed and capped.
fn input_field(input: &Value, key: &str) -> Option<String> {
    let text = input.get(key)?.as_str()?.trim();
    (!text.is_empty()).then(|| cap(text))
}

/// What a step acts on, read from its whole input before that is capped (a
/// capped input no longer parses): a file's name, a search's pattern or
/// query, a URL, or a command's first line.
fn step_target(input: &Value) -> Option<String> {
    if let Some(path) =
        input_field(input, "file_path").or_else(|| input_field(input, "notebook_path"))
    {
        let name = path.rsplit('/').next().filter(|n| !n.is_empty());
        return Some(name.map_or(path.clone(), str::to_string));
    }
    ["pattern", "query", "url"]
        .iter()
        .find_map(|key| input_field(input, key))
        .or_else(|| {
            input_field(input, "command").and_then(|c| c.lines().next().map(str::to_string))
        })
}

fn text_of(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn block(value: &Value) -> Block {
    let field = |k: &str| value.get(k).and_then(Value::as_str).unwrap_or_default();
    match field("type") {
        "text" => Block::Text(field("text").to_string()),
        "thinking" | "redacted_thinking" => Block::Thinking,
        "tool_use" => {
            let input = value.get("input");
            Block::ToolUse {
                id: field("id").to_string(),
                name: field("name").to_string(),
                target: input.and_then(step_target),
                description: input.and_then(|i| input_field(i, "description")),
                input: cap(&match input {
                    Some(Value::String(s)) => s.clone(),
                    Some(other) => other.to_string(),
                    None => String::new(),
                }),
            }
        }
        "tool_result" => Block::ToolResult {
            id: field("tool_use_id").to_string(),
            is_error: value.get("is_error").and_then(Value::as_bool) == Some(true),
            content: cap(&value.get("content").map(text_of).unwrap_or_default()),
        },
        _ => Block::Other,
    }
}

fn blocks(content: Option<&Value>) -> Vec<Block> {
    match content {
        Some(Value::String(s)) => vec![Block::Text(s.clone())],
        Some(Value::Array(items)) => items.iter().map(block).collect(),
        _ => Vec::new(),
    }
}

/// One live row from a [Bridge spool] line, with its (run, seq) for ordering.
fn bridge_row(line: &str, conversation: Option<&str>) -> Option<((String, u64), Row)> {
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("kind")?.as_str()? != "row" {
        return None;
    }
    // A nested `claude -p` in the same terminal posts its own conversation's
    // rows; only the session's own are kept.
    if let (Some(want), Some(got)) = (conversation, value.get("sessionId").and_then(Value::as_str))
    {
        if want != got {
            return None;
        }
    }
    let message = value.get("message")?;
    let order = (
        value
            .get("run")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        value.get("seq").and_then(Value::as_u64).unwrap_or_default(),
    );
    Some((
        order,
        Row {
            uuid: value.get("uuid")?.as_str()?.to_string(),
            parent: None,
            role: message
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            name: message
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string),
            is_meta: message.get("isMeta").and_then(Value::as_bool) == Some(true),
            compact_summary: false,
            origin: value
                .get("origin")
                .and_then(Value::as_str)
                .map(str::to_string),
            sidechain: value.get("agentId").is_some_and(|a| !a.is_null()),
            blocks: blocks(message.get("content")),
            thinking_ms: None,
            at_ms: value.get("receivedMs").and_then(Value::as_i64),
        },
    ))
}

/// One transcript row, or `None` for a line that isn't one (a title, a
/// mode change — lines with no uuid). Rows of every type are kept, attachments
/// included: the conversation's parent chain runs through them, and only
/// user, assistant and system rows are shown.
fn transcript_row(line: &str) -> Option<Row> {
    let value: Value = serde_json::from_str(line).ok()?;
    let role = value.get("type")?.as_str()?;
    let message = value.get("message");
    Some(Row {
        uuid: value.get("uuid")?.as_str()?.to_string(),
        // A compaction starts a new chain: its boundary row has no parent and
        // names the row before it in `logicalParentUuid`.
        parent: value
            .get("parentUuid")
            .and_then(Value::as_str)
            .or_else(|| value.get("logicalParentUuid").and_then(Value::as_str))
            .map(str::to_string),
        role: role.to_string(),
        name: value
            .get("subtype")
            .and_then(Value::as_str)
            .map(str::to_string),
        is_meta: value.get("isMeta").and_then(Value::as_bool) == Some(true),
        compact_summary: value.get("isCompactSummary").and_then(Value::as_bool) == Some(true),
        origin: value
            .get("origin")
            .and_then(|o| o.get("kind"))
            .and_then(Value::as_str)
            .map(str::to_string),
        sidechain: value.get("isSidechain").and_then(Value::as_bool) == Some(true),
        // A system row (a slash command and its output) keeps its text at the
        // top level.
        blocks: blocks(
            message
                .and_then(|m| m.get("content"))
                .or_else(|| value.get("content")),
        ),
        thinking_ms: value.get("thinkingDurationMs").and_then(Value::as_u64),
        at_ms: value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(crate::activity_log::parse_iso_ms),
    })
}

/// The live conversation in a transcript: from the newest main row back to the
/// root through `parentUuid` (across a compaction, `logicalParentUuid`), oldest
/// first. A rewound branch, left in the file, is not on the chain.
fn main_chain(rows: Vec<Row>) -> Vec<Row> {
    let Some(leaf) = rows
        .iter()
        .rev()
        .find(|r| !r.sidechain)
        .map(|r| r.uuid.clone())
    else {
        return Vec::new();
    };
    let mut by_uuid: HashMap<String, Row> = rows.into_iter().map(|r| (r.uuid.clone(), r)).collect();
    let mut chain = Vec::new();
    let mut next = Some(leaf);
    while let Some(row) = next.take().and_then(|uuid| by_uuid.remove(&uuid)) {
        next.clone_from(&row.parent);
        chain.push(row);
    }
    chain.reverse();
    chain
}

/// Where a turn's rows came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnSource {
    /// Every row came from the companion.
    Live,
    /// Some rows came only from the transcript (before the companion connected).
    Transcript,
}

/// One thing Claude did inside a turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TurnItem {
    /// Text Claude wrote between tool calls.
    Text { text: String },
    /// A tool call and, once it finished, its result preview.
    Step {
        id: String,
        name: String,
        /// The same kind the [Activity log] gives the tool.
        #[serde(rename = "stepKind")]
        kind: crate::activity_log::StepKind,
        /// The input, capped: a long one is cut short and no longer parses.
        input: String,
        /// What the step acts on (a file's name, a pattern, a command's first
        /// line), read from the whole input.
        target: Option<String>,
        /// What Claude said the step is for, when the tool carries it (a
        /// command's or a subagent's `description`).
        description: Option<String>,
        result: Option<String>,
        #[serde(rename = "isError")]
        is_error: bool,
    },
    /// Claude thought (its text is never available); for how long, if known.
    Thought {
        #[serde(rename = "durationMs")]
        duration_ms: Option<u64>,
    },
    /// Claude Code compacted the conversation here.
    Compacted,
}

/// One turn of the [Structured view].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredTurn {
    /// The prompt that opened the turn; `None` for rows before the first one,
    /// and for a turn [Work report]s opened.
    pub prompt: Option<String>,
    /// The [Work report]s that woke Claude for this turn, in place of a prompt.
    pub reports: Vec<WorkReport>,
    /// What Claude did, in order, without the reply.
    pub did: Vec<TurnItem>,
    /// Claude's final text of the turn.
    pub reply: Option<String>,
    pub source: TurnSource,
    /// The user pressed Esc during the turn.
    pub interrupted: bool,
    /// Claude Code recorded the turn's end (its `turn_duration` row): the
    /// turn is over, whatever a status that missed its `Stop` still says.
    pub ended: bool,
    /// The files the prompt's images came from, as Claude Code recorded them.
    pub images: Vec<String>,
    /// When the prompt was sent (ms since the epoch), if known.
    pub started_ms: Option<i64>,
    /// When the turn's newest row was written, if known.
    pub ended_ms: Option<i64>,
}

impl StructuredTurn {
    fn open(prompt: Option<String>, source: TurnSource, at_ms: Option<i64>) -> Self {
        Self {
            prompt,
            reports: Vec::new(),
            did: Vec::new(),
            reply: None,
            source,
            interrupted: false,
            ended: false,
            images: Vec::new(),
            started_ms: at_ms,
            ended_ms: at_ms,
        }
    }

    /// Something opened the turn for Claude to work on: a prompt, or
    /// [Work report]s. Rows before the first prompt have neither.
    fn is_opened(&self) -> bool {
        self.prompt.is_some() || !self.reports.is_empty()
    }
}

/// Claude's reply as it streams ([Partial reply]): the newest snapshot of one
/// text block of the main agent's current model response, from the
/// companion. Stands in for the reply until the block's row is kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialReply {
    /// Claude Code's id for the turn.
    pub turn_id: String,
    /// The model request within the turn, and the content block within it.
    pub step: u64,
    pub block: u64,
    pub text: String,
    /// The block finished streaming.
    pub done: bool,
    /// When the daemon received it (ms since the epoch).
    pub received_ms: i64,
}

/// Read a [Partial reply] file. `conversation` is the Claude session id the
/// view is for; a partial from any other (a nested `claude -p`) is left out.
#[must_use]
pub fn parse_partial(line: &str, conversation: Option<&str>) -> Option<PartialReply> {
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("kind")?.as_str()? != "partial" {
        return None;
    }
    if let (Some(want), Some(got)) = (conversation, value.get("sessionId").and_then(Value::as_str))
    {
        if want != got {
            return None;
        }
    }
    Some(PartialReply {
        turn_id: value.get("turnId")?.as_str()?.to_string(),
        step: value
            .get("step")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        block: value
            .get("block")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        text: value.get("text")?.as_str()?.to_string(),
        done: value.get("final").and_then(Value::as_bool) == Some(true),
        received_ms: value.get("receivedMs").and_then(Value::as_i64)?,
    })
}

/// Build the turns from the [Bridge spool]'s lines and the transcript's lines
/// (all of them, or only its newest part). `conversation` is the Claude
/// session id the view is for; live rows from any other conversation (a
/// nested `claude -p`) are left out.
#[must_use]
pub fn build_turns(
    bridge_lines: &[&str],
    transcript_lines: &[&str],
    conversation: Option<&str>,
) -> Vec<StructuredTurn> {
    let mut live: Vec<((String, u64), Row)> = bridge_lines
        .iter()
        .filter_map(|l| bridge_row(l, conversation))
        .collect();
    // Runs in the order each first appeared; within a run, by the mod's number.
    let mut run_order: Vec<String> = Vec::new();
    for ((run, _), _) in &live {
        if !run_order.contains(run) {
            run_order.push(run.clone());
        }
    }
    live.sort_by_key(|((run, seq), _)| (run_order.iter().position(|r| r == run), *seq));
    let live_ids: HashSet<String> = live.iter().map(|(_, r)| r.uuid.clone()).collect();

    let rows: Vec<Row> = transcript_lines
        .iter()
        .filter_map(|l| transcript_row(l))
        .collect();
    // Every row the transcript holds, on any branch: a live row it has on a
    // branch the user rewound away from is discarded, not "not written yet".
    let in_transcript: HashSet<String> = rows.iter().map(|r| r.uuid.clone()).collect();
    let oldest_read = rows.iter().filter_map(|r| r.at_ms).min();
    let chain = main_chain(rows);

    // The transcript's order where it has the row; live rows it hasn't written
    // yet (it lags) follow in the mod's order. It lags only at its end, so a
    // row is still to be written only after the last live row it holds. A
    // live row older than all of what was read was cut off with the
    // transcript's start, not still to come.
    let last_written = live
        .iter()
        .rposition(|(_, r)| in_transcript.contains(&r.uuid));
    let mut merged: Vec<(Row, bool)> = chain
        .into_iter()
        .map(|r| {
            let is_live = live_ids.contains(&r.uuid);
            (r, is_live)
        })
        .collect();
    merged.extend(
        live.into_iter()
            .skip(last_written.map_or(0, |at| at + 1))
            .filter(|(_, r)| {
                r.at_ms
                    .zip(oldest_read)
                    .is_none_or(|(at, oldest)| at >= oldest)
            })
            .map(|(_, r)| (r, true)),
    );
    fold(merged)
}

/// Where the slash command whose output is still to come sits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Awaiting {
    /// No command is waiting for its output.
    Nothing,
    /// The current turn is the command.
    Current,
    /// The command was run while Claude worked: it sits in `turns`, at this
    /// index, before Claude's turn.
    At(usize),
}

fn fold(rows: Vec<(Row, bool)>) -> Vec<StructuredTurn> {
    let mut turns: Vec<StructuredTurn> = Vec::new();
    let mut current: Option<StructuredTurn> = None;
    let mut awaiting = Awaiting::Nothing;
    for (row, is_live) in rows {
        if row.sidechain {
            continue;
        }
        if row.role == "system" {
            match (row.name.as_deref(), current.as_mut()) {
                (Some("compact_boundary"), Some(turn)) => turn.did.push(TurnItem::Compacted),
                (Some("turn_duration"), Some(turn)) => turn.ended = true,
                (Some("local_command"), _) => {
                    awaiting = local_command(&mut turns, &mut current, awaiting, &row, is_live);
                }
                _ => {}
            }
            continue;
        }
        // Attachments, other engine rows and a compaction's summary carry the
        // chain, not the view.
        if (row.role != "user" && row.role != "assistant") || row.compact_summary {
            continue;
        }
        if let Some(reports) = row.work_reports() {
            awaiting = Awaiting::Nothing;
            report_turn(&mut turns, &mut current, reports, &row, is_live);
            continue;
        }
        if row.role == "user" && row.origin.as_deref() == Some(crate::work_report::PEER_ORIGIN) {
            let text = row.texts().collect::<Vec<_>>().join("\n");
            let agent = crate::work_report::peer_sender(&text)
                .and_then(|id| launched_as(&turns, current.as_ref(), id));
            let report = crate::work_report::from_peer(&text, agent);
            awaiting = Awaiting::Nothing;
            report_turn(&mut turns, &mut current, vec![report], &row, is_live);
            continue;
        }
        let opens_turn = row.role == "user"
            && !row.is_meta
            && !row.is_interrupt()
            && row
                .blocks
                .iter()
                .any(|b| matches!(b, Block::Text(t) if !t.trim().is_empty()))
            && !row
                .blocks
                .iter()
                .any(|b| matches!(b, Block::ToolResult { .. }));
        if opens_turn {
            if let Some(done) = current.take() {
                turns.push(finish(done));
            }
            let text = row.texts().collect::<Vec<_>>().join("\n");
            // A slash command kept as a prompt row reads as typed. One the CLI
            // runs itself (`/output-style`) then writes its output as a
            // `local_command` row; a skill's (`/review`) runs as Claude's turn.
            let command = crate::transcript::command_label(&text);
            awaiting = if command.is_some() {
                Awaiting::Current
            } else {
                Awaiting::Nothing
            };
            current = Some(StructuredTurn::open(
                Some(command.unwrap_or(text)),
                if is_live {
                    TurnSource::Live
                } else {
                    TurnSource::Transcript
                },
                row.at_ms,
            ));
            continue;
        }
        // Claude answering means the prompt was Claude's to run (a skill's
        // `/review`), not a command the CLI ran itself: output from here on
        // belongs to a command run alongside, never to this turn.
        if row.role == "assistant" && awaiting == Awaiting::Current {
            awaiting = Awaiting::Nothing;
        }
        let turn =
            current.get_or_insert_with(|| StructuredTurn::open(None, TurnSource::Live, row.at_ms));
        if !is_live {
            turn.source = TurnSource::Transcript;
        }
        // Claude writing after the turn's recorded end means something woke it
        // that no row above opened a turn for: the turn is not over.
        if row.role == "assistant" {
            turn.ended = false;
        }
        if row.at_ms.is_some() {
            turn.ended_ms = turn.ended_ms.max(row.at_ms);
        }
        if row.is_meta {
            turn.images.extend(row.image_sources());
            continue;
        }
        if row.is_interrupt() {
            turn.interrupted = true;
        }
        for block in row.blocks {
            add_block(turn, block, row.role == "assistant", row.thinking_ms);
        }
    }
    if let Some(done) = current {
        turns.push(finish(done));
    }
    turns
}

/// What Claude called the [Subagent] `agent_id` when it launched it: the
/// `description` of the `Agent` step whose launch receipt names that id.
fn launched_as<'a>(
    turns: &'a [StructuredTurn],
    current: Option<&'a StructuredTurn>,
    agent_id: &str,
) -> Option<&'a str> {
    let receipt = format!("agentId: {agent_id}");
    turns
        .iter()
        .chain(current)
        .flat_map(|turn| &turn.did)
        .rev()
        .find_map(|item| match item {
            TurnItem::Step {
                result: Some(result),
                description,
                ..
            } if result.contains(&receipt) => description.as_deref(),
            _ => None,
        })
}

/// Open the turn [Work report]s woke Claude for. Reports that arrive before
/// Claude has done anything about the last ones join that turn: one wake-up,
/// one turn.
fn report_turn(
    turns: &mut Vec<StructuredTurn>,
    current: &mut Option<StructuredTurn>,
    reports: Vec<WorkReport>,
    row: &Row,
    is_live: bool,
) {
    let joins = current.as_ref().is_some_and(|turn| {
        !turn.reports.is_empty()
            && turn.did.is_empty()
            && turn.reply.is_none()
            && !turn.interrupted
            && !turn.ended
    });
    if !joins {
        if let Some(done) = current.take() {
            turns.push(finish(done));
        }
    }
    let turn = current.get_or_insert_with(|| {
        StructuredTurn::open(
            None,
            if is_live {
                TurnSource::Live
            } else {
                TurnSource::Transcript
            },
            row.at_ms,
        )
    });
    turn.reports.extend(reports);
    crate::work_report::drop_echoed_handbacks(&mut turn.reports);
    turn.ended_ms = turn.ended_ms.max(row.at_ms);
}

/// What a slash command the CLI runs itself (`/mcp`, `/model`) wrote: a turn
/// of its own — the command as typed, then what it printed as the reply.
/// Claude Code mostly records both as `local_command` system rows; some
/// commands (`/output-style`) it keeps as a prompt row, and only their output
/// arrives here, for the turn that row opened.
/// A command run while Claude works goes before Claude's turn, which carries
/// on: an ended command after it would read as Claude's turn being over.
/// Output goes to the command just opened; output with none is left out.
/// Returns where the command waiting for its output now is.
fn local_command(
    turns: &mut Vec<StructuredTurn>,
    current: &mut Option<StructuredTurn>,
    awaiting: Awaiting,
    row: &Row,
    is_live: bool,
) -> Awaiting {
    let text = row.texts().collect::<Vec<_>>().join("\n");
    let opening = text.trim_start();
    if opening.starts_with("<command-name>") || opening.starts_with("<command-message>") {
        let command = StructuredTurn::open(
            crate::transcript::prompt_label(&text),
            if is_live {
                TurnSource::Live
            } else {
                TurnSource::Transcript
            },
            row.at_ms,
        );
        let claude_working = awaiting != Awaiting::Current
            && current
                .as_ref()
                .is_some_and(|turn| turn.is_opened() && !turn.ended && !turn.interrupted);
        if claude_working {
            turns.push(command);
            return Awaiting::At(turns.len() - 1);
        }
        if let Some(done) = current.take() {
            turns.push(finish(done));
        }
        *current = Some(command);
        return Awaiting::Current;
    }
    let turn = match awaiting {
        Awaiting::Nothing => None,
        Awaiting::Current => current.as_mut(),
        Awaiting::At(at) => turns.get_mut(at),
    };
    let Some(turn) = turn else {
        return Awaiting::Nothing;
    };
    let output = ["stdout", "stderr"]
        .iter()
        .filter_map(|stream| {
            let open = format!("<local-command-{stream}>");
            let close = format!("</local-command-{stream}>");
            let rest = text.split_once(open.as_str())?.1;
            Some(
                rest.split_once(close.as_str())
                    .map_or(rest, |(inside, _)| inside),
            )
        })
        .map(|inside| crate::policy::strip_csi(inside).trim().to_string())
        .find(|inside| !inside.is_empty());
    if output.is_some() {
        turn.reply = output;
    }
    turn.ended = true;
    turn.ended_ms = turn.ended_ms.max(row.at_ms);
    Awaiting::Nothing
}

/// Add one block of a row to its turn: text Claude wrote, a thought, a tool
/// call, or the result that finishes one.
fn add_block(turn: &mut StructuredTurn, block: Block, from_claude: bool, thinking_ms: Option<u64>) {
    match block {
        Block::Text(text) if from_claude && !text.trim().is_empty() => {
            turn.did.push(TurnItem::Text { text });
        }
        Block::Thinking => turn.did.push(TurnItem::Thought {
            duration_ms: thinking_ms,
        }),
        Block::ToolUse {
            id,
            name,
            input,
            target,
            description,
        } => turn.did.push(TurnItem::Step {
            kind: crate::activity_log::StepKind::of(&name),
            id,
            name,
            input,
            target,
            description,
            result: None,
            is_error: false,
        }),
        Block::ToolResult {
            id,
            is_error,
            content,
        } => {
            if let Some(TurnItem::Step {
                result,
                is_error: err,
                ..
            }) = turn
                .did
                .iter_mut()
                .rev()
                .find(|i| matches!(i, TurnItem::Step { id: sid, .. } if *sid == id))
            {
                *result = Some(content);
                *err = is_error;
            }
        }
        _ => {}
    }
}

/// Lift the turn's last text, when nothing came after it, out as the reply.
fn finish(mut turn: StructuredTurn) -> StructuredTurn {
    // A compaction after the turn ended doesn't bury its reply.
    let at = turn
        .did
        .iter()
        .rposition(|item| *item != TurnItem::Compacted);
    if let Some(at) = at.filter(|&at| matches!(turn.did[at], TurnItem::Text { .. })) {
        if let TurnItem::Text { text } = turn.did.remove(at) {
            turn.reply = Some(text);
        }
    }
    turn
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn t(uuid: &str, parent: Option<&str>, kind: &str, content: &Value) -> String {
        json!({"type": kind, "uuid": uuid, "parentUuid": parent, "message": {"role": kind, "content": content}})
            .to_string()
    }

    fn live(run: &str, seq: u64, uuid: &str, kind: &str, content: &Value) -> String {
        json!({"kind": "row", "run": run, "seq": seq, "uuid": uuid,
               "message": {"type": kind, "role": kind, "content": content}})
        .to_string()
    }

    #[test]
    fn a_turn_is_prompt_steps_and_reply() {
        let transcript = [
            t("u1", None, "user", &json!("fix the bug")),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","thinkingDurationMs":12000,
                   "message":{"content":[{"type":"thinking","thinking":""}]}})
            .to_string(),
            t(
                "a2",
                Some("a1"),
                "assistant",
                &json!([{"type":"text","text":"Looking."},
                {"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]),
            ),
            t(
                "u2",
                Some("a2"),
                "user",
                &json!([{"type":"tool_result","tool_use_id":"t1","content":"a.txt"}]),
            ),
            t(
                "a3",
                Some("u2"),
                "assistant",
                &json!([{"type":"text","text":"Fixed."}]),
            ),
        ];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert_eq!(turns.len(), 1);
        let turn = &turns[0];
        assert_eq!(turn.prompt.as_deref(), Some("fix the bug"));
        assert_eq!(turn.reply.as_deref(), Some("Fixed."));
        assert_eq!(turn.source, TurnSource::Transcript);
        assert_eq!(
            turn.did,
            vec![
                TurnItem::Thought {
                    duration_ms: Some(12000)
                },
                TurnItem::Text {
                    text: "Looking.".into()
                },
                TurnItem::Step {
                    id: "t1".into(),
                    name: "Bash".into(),
                    kind: crate::activity_log::StepKind::Command,
                    input: r#"{"command":"ls"}"#.into(),
                    target: Some("ls".into()),
                    description: None,
                    result: Some("a.txt".into()),
                    is_error: false,
                },
            ]
        );
    }

    #[test]
    fn a_step_keeps_what_it_acts_on_though_its_input_is_cut_short() {
        let long = "x".repeat(PREVIEW * 2);
        let transcript = [
            t("u1", None, "user", &json!("write it")),
            t(
                "a1",
                Some("u1"),
                "assistant",
                &json!([
                    {"type":"tool_use","id":"w","name":"Write",
                     "input":{"file_path":"/proj/src/app.ts","content":long}},
                    {"type":"tool_use","id":"b","name":"Bash",
                     "input":{"command":"pnpm test\npnpm lint","description":"Run the tests"}},
                    {"type":"tool_use","id":"g","name":"Grep","input":{"pattern":"TODO"}},
                ]),
            ),
        ];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        let steps: Vec<(Option<&str>, Option<&str>)> = turns[0]
            .did
            .iter()
            .filter_map(|item| match item {
                TurnItem::Step {
                    target,
                    description,
                    ..
                } => Some((target.as_deref(), description.as_deref())),
                _ => None,
            })
            .collect();
        assert_eq!(
            steps,
            vec![
                (Some("app.ts"), None),
                (Some("pnpm test"), Some("Run the tests")),
                (Some("TODO"), None),
            ]
        );
    }

    #[test]
    fn a_rewound_branch_is_not_shown() {
        let transcript = [
            t("u1", None, "user", &json!("first")),
            t(
                "a1",
                Some("u1"),
                "assistant",
                &json!([{"type":"text","text":"old answer"}]),
            ),
            // The user rewound to u1 and asked again; the old reply stays in the file.
            t("u2", None, "user", &json!("second try")),
            t(
                "a2",
                Some("u2"),
                "assistant",
                &json!([{"type":"text","text":"new answer"}]),
            ),
        ];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].reply.as_deref(), Some("new answer"));
    }

    #[test]
    fn live_rows_mark_the_turn_live_and_fill_in_what_the_transcript_lags() {
        let transcript = [t("u1", None, "user", &json!("go"))];
        let bridge = [
            // Arrival order differs from the mod's numbering.
            live(
                "r1",
                3,
                "a2",
                "assistant",
                &json!([{"type":"text","text":"done"}]),
            ),
            live("r1", 1, "u1", "user", &json!([{"type":"text","text":"go"}])),
            live(
                "r1",
                2,
                "a1",
                "assistant",
                &json!([{"type":"tool_use","id":"t","name":"Read","input":"{}"}]),
            ),
            json!({"kind":"hello","seq":4}).to_string(),
        ];
        let t_refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let b_refs: Vec<&str> = bridge.iter().map(String::as_str).collect();
        let turns = build_turns(&b_refs, &t_refs, None);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].source, TurnSource::Live);
        assert_eq!(turns[0].reply.as_deref(), Some("done"));
        assert!(matches!(turns[0].did[0], TurnItem::Step { .. }));
    }

    #[test]
    fn history_from_before_the_companion_is_labelled_transcript() {
        let transcript = [
            t("u1", None, "user", &json!("old")),
            t(
                "a1",
                Some("u1"),
                "assistant",
                &json!([{"type":"text","text":"old reply"}]),
            ),
            t("u2", Some("a1"), "user", &json!("new")),
        ];
        let bridge = [live(
            "r",
            1,
            "u2",
            "user",
            &json!([{"type":"text","text":"new"}]),
        )];
        let t_refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let b_refs: Vec<&str> = bridge.iter().map(String::as_str).collect();
        let turns = build_turns(&b_refs, &t_refs, None);
        assert_eq!(turns[0].source, TurnSource::Transcript);
        assert_eq!(turns[1].source, TurnSource::Live);
    }

    fn live_at(seq: u64, uuid: &str, kind: &str, text: &str, received_ms: i64) -> String {
        json!({"kind": "row", "run": "r", "seq": seq, "uuid": uuid, "receivedMs": received_ms,
               "message": {"type": kind, "role": kind, "content": [{"type":"text","text":text}]}})
        .to_string()
    }

    fn t_at(uuid: &str, parent: Option<&str>, kind: &str, text: &str, at: &str) -> String {
        json!({"type": kind, "uuid": uuid, "parentUuid": parent, "timestamp": at,
               "message": {"role": kind, "content": [{"type":"text","text":text}]}})
        .to_string()
    }

    #[test]
    fn live_rows_older_than_the_transcript_read_are_not_shown_as_newest() {
        // Only the transcript's newest part is read: u1 and a1 were cut off,
        // so the transcript doesn't hold them, but they aren't still to come.
        let transcript = [
            t_at(
                "u2",
                Some("a1"),
                "user",
                "second",
                "2026-10-18T09:00:00.000Z",
            ),
            t_at(
                "a2",
                Some("u2"),
                "assistant",
                "Second reply.",
                "2026-10-18T09:00:05.000Z",
            ),
        ];
        let at = |iso| crate::activity_log::parse_iso_ms(iso).expect("time");
        let bridge = [
            live_at(1, "u1", "user", "first", at("2026-10-18T08:00:00.000Z")),
            live_at(
                2,
                "a1",
                "assistant",
                "First reply.",
                at("2026-10-18T08:00:05.000Z"),
            ),
            live_at(3, "u2", "user", "second", at("2026-10-18T09:00:00.000Z")),
            live_at(
                4,
                "a2",
                "assistant",
                "Second reply.",
                at("2026-10-18T09:00:05.000Z"),
            ),
            live_at(5, "u3", "user", "third", at("2026-10-18T09:01:00.000Z")),
        ];
        let t_refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let b_refs: Vec<&str> = bridge.iter().map(String::as_str).collect();
        let turns = build_turns(&b_refs, &t_refs, None);
        let prompts: Vec<_> = turns.iter().map(|t| t.prompt.as_deref()).collect();
        assert_eq!(prompts, [Some("second"), Some("third")]);
    }

    #[test]
    fn a_live_row_cut_off_just_before_the_transcript_read_stays_cut_off() {
        // a1 is the last row before the cut, received a moment after the
        // first row read was written: only its place, before u2, says it
        // isn't still to come.
        let transcript = [
            t_at(
                "u2",
                Some("a1"),
                "user",
                "second",
                "2026-10-18T09:00:00.000Z",
            ),
            t_at(
                "a2",
                Some("u2"),
                "assistant",
                "Second reply.",
                "2026-10-18T09:00:05.000Z",
            ),
        ];
        let at = |iso| crate::activity_log::parse_iso_ms(iso).expect("time");
        let bridge = [
            live_at(
                1,
                "a1",
                "assistant",
                "First reply.",
                at("2026-10-18T09:00:00.020Z"),
            ),
            live_at(2, "u2", "user", "second", at("2026-10-18T09:00:00.030Z")),
            live_at(
                3,
                "a2",
                "assistant",
                "Second reply.",
                at("2026-10-18T09:00:05.010Z"),
            ),
        ];
        let t_refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let b_refs: Vec<&str> = bridge.iter().map(String::as_str).collect();
        let turns = build_turns(&b_refs, &t_refs, None);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].reply.as_deref(), Some("Second reply."));
        assert!(
            !turns[0]
                .did
                .iter()
                .any(|item| matches!(item, TurnItem::Text { text } if text == "First reply.")),
            "the cut-off row came back"
        );
    }

    #[test]
    fn live_rows_from_before_the_transcript_read_are_left_out_when_none_overlap() {
        // The companion's rows all come from an earlier run, before the part
        // of the transcript that was read.
        let transcript = [t_at(
            "u5",
            Some("a4"),
            "user",
            "later",
            "2026-10-18T12:00:00.000Z",
        )];
        let at = |iso| crate::activity_log::parse_iso_ms(iso).expect("time");
        let bridge = [
            live_at(1, "u1", "user", "early", at("2026-10-18T08:00:00.000Z")),
            live_at(
                2,
                "a1",
                "assistant",
                "Early reply.",
                at("2026-10-18T08:00:05.000Z"),
            ),
        ];
        let t_refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let b_refs: Vec<&str> = bridge.iter().map(String::as_str).collect();
        let turns = build_turns(&b_refs, &t_refs, None);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].prompt.as_deref(), Some("later"));
    }

    fn local(uuid: &str, parent: Option<&str>, content: &str) -> String {
        json!({"type":"system","subtype":"local_command","uuid":uuid,"parentUuid":parent,
               "content":content,"timestamp":"2026-10-08T06:32:36.664Z"})
        .to_string()
    }

    #[test]
    fn a_slash_command_is_a_turn_of_its_own_with_its_output() {
        let transcript = [
            local(
                "c1",
                None,
                "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>haiku</command-args>",
            ),
            local(
                "o1",
                Some("c1"),
                "<local-command-stdout>Set model to \u{1b}[1mHaiku 5.5\u{1b}[22m</local-command-stdout>",
            ),
            local(
                "c2",
                Some("o1"),
                "<command-name>/mcp</command-name>\n            <command-message>mcp</command-message>\n            <command-args></command-args>",
            ),
            local("o2", Some("c2"), "<local-command-stdout></local-command-stdout>"),
        ];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].prompt.as_deref(), Some("/model haiku"));
        assert_eq!(turns[0].reply.as_deref(), Some("Set model to Haiku 5.5"));
        assert!(turns[0].ended);
        assert_eq!(turns[1].prompt.as_deref(), Some("/mcp"));
        assert_eq!(turns[1].reply, None);
        assert!(turns[1].ended);
    }

    #[test]
    fn a_slash_command_run_while_claude_works_leaves_claudes_turn_whole() {
        let transcript = [
            t("u1", None, "user", &json!("fix it")),
            t(
                "a1",
                Some("u1"),
                "assistant",
                &json!([{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]),
            ),
            local(
                "c1",
                Some("a1"),
                "<command-name>/cost</command-name>\n            <command-message>cost</command-message>\n            <command-args></command-args>",
            ),
            local(
                "o1",
                Some("c1"),
                "<local-command-stdout>Total cost: $0.12</local-command-stdout>",
            ),
            t(
                "u2",
                Some("o1"),
                "user",
                &json!([{"type":"tool_result","tool_use_id":"t1","content":"a.txt"}]),
            ),
            t(
                "a2",
                Some("u2"),
                "assistant",
                &json!([{"type":"text","text":"Fixed."}]),
            ),
        ];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert_eq!(turns.len(), 2);
        // Placed before Claude's turn, which stays the newest: an ended
        // command after it would read as Claude's turn being over.
        assert_eq!(turns[0].prompt.as_deref(), Some("/cost"));
        assert_eq!(turns[0].reply.as_deref(), Some("Total cost: $0.12"));
        assert!(turns[0].ended);
        assert_eq!(turns[1].prompt.as_deref(), Some("fix it"));
        assert_eq!(turns[1].reply.as_deref(), Some("Fixed."));
        assert!(!turns[1].ended, "Claude's turn isn't over");
        assert_eq!(turns[1].did.len(), 1, "its step stays with it");
    }

    #[test]
    fn a_slash_command_kept_as_a_prompt_row_still_gets_its_output() {
        // 2.1.296 writes `/output-style` and `/agents` this way: the command as
        // a user row, after a meta caveat, and its output as a system row.
        let transcript = [
            t("u1", None, "user", &json!("hi")),
            t(
                "a1",
                Some("u1"),
                "assistant",
                &json!([{"type":"text","text":"Hello."}]),
            ),
            json!({"type":"system","subtype":"turn_duration","uuid":"d1","parentUuid":"a1"})
                .to_string(),
            json!({"type":"user","uuid":"m1","parentUuid":"d1","isMeta":true,
                   "message":{"content":"<local-command-caveat>Run directly in Claude Code.</local-command-caveat>"}})
            .to_string(),
            t(
                "c1",
                Some("m1"),
                "user",
                &json!("<command-name>/output-style</command-name>\n            <command-message>output-style</command-message>\n            <command-args></command-args>"),
            ),
            local(
                "o1",
                Some("c1"),
                "<local-command-stdout>Output style: default</local-command-stdout>",
            ),
        ];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[1].prompt.as_deref(), Some("/output-style"));
        assert_eq!(turns[1].reply.as_deref(), Some("Output style: default"));
        assert!(turns[1].ended);
    }

    #[test]
    fn a_skill_command_reads_as_typed_and_runs_as_claudes_turn() {
        let transcript = [
            t(
                "c1",
                None,
                "user",
                &json!("<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>src</command-args>"),
            ),
            json!({"type":"user","uuid":"m1","parentUuid":"c1","isMeta":true,
                   "message":{"content":[{"type":"text","text":"# Review\n\nReview the code."}]}})
            .to_string(),
            t(
                "a1",
                Some("m1"),
                "assistant",
                &json!([{"type":"text","text":"Looks fine."}]),
            ),
        ];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].prompt.as_deref(), Some("/review src"));
        assert_eq!(turns[0].reply.as_deref(), Some("Looks fine."));
        assert!(!turns[0].ended, "Claude's turn ends with its own row");
    }

    #[test]
    fn a_slash_command_run_during_a_skill_turn_leaves_claudes_turn_whole() {
        let transcript = [
            t(
                "c1",
                None,
                "user",
                &json!("<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>src</command-args>"),
            ),
            t(
                "a1",
                Some("c1"),
                "assistant",
                &json!([{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]),
            ),
            local(
                "c2",
                Some("a1"),
                "<command-name>/mcp</command-name>\n            <command-message>mcp</command-message>\n            <command-args></command-args>",
            ),
            local("o2", Some("c2"), "<local-command-stdout>MCP dialog dismissed</local-command-stdout>"),
            t(
                "u2",
                Some("o2"),
                "user",
                &json!([{"type":"tool_result","tool_use_id":"t1","content":"a.txt"}]),
            ),
            t(
                "a2",
                Some("u2"),
                "assistant",
                &json!([{"type":"text","text":"Looks fine."}]),
            ),
        ];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].prompt.as_deref(), Some("/mcp"));
        assert_eq!(turns[0].reply.as_deref(), Some("MCP dialog dismissed"));
        assert_eq!(turns[1].prompt.as_deref(), Some("/review src"));
        assert_eq!(turns[1].reply.as_deref(), Some("Looks fine."));
        assert!(!turns[1].ended, "Claude's turn isn't over");
    }

    #[test]
    fn stray_output_after_claude_starts_a_skill_turn_does_not_end_it() {
        let transcript = [
            t(
                "c1",
                None,
                "user",
                &json!("<command-name>/review</command-name>\n<command-args></command-args>"),
            ),
            t(
                "a1",
                Some("c1"),
                "assistant",
                &json!([{"type":"text","text":"Reading."}]),
            ),
            local(
                "o1",
                Some("a1"),
                "<local-command-stdout>stray</local-command-stdout>",
            ),
        ];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].reply.as_deref(), Some("Reading."));
        assert!(!turns[0].ended);
    }

    #[test]
    fn command_output_with_no_command_before_it_is_left_out() {
        let transcript = [
            t("u1", None, "user", &json!("hi")),
            t(
                "a1",
                Some("u1"),
                "assistant",
                &json!([{"type":"text","text":"Hello."}]),
            ),
            local(
                "o1",
                Some("a1"),
                "<local-command-stdout>stray</local-command-stdout>",
            ),
        ];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].reply.as_deref(), Some("Hello."));
        assert!(!turns[0].ended);
    }

    #[test]
    fn subagent_and_meta_rows_and_bad_lines_are_skipped() {
        let transcript = [
            t("u1", None, "user", &json!("go")),
            json!({"type":"user","uuid":"m","parentUuid":"u1","isMeta":true,"message":{"content":"<reminder>"}}).to_string(),
            "not json".to_string(),
            t("a1", Some("m"), "assistant", &json!([{"type":"text","text":"ok"}])),
        ];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].prompt.as_deref(), Some("go"));
        assert_eq!(turns[0].reply.as_deref(), Some("ok"));
    }

    #[test]
    fn a_live_row_on_a_rewound_branch_stays_hidden() {
        let transcript = [
            t("u1", None, "user", &json!("first")),
            t(
                "a1",
                Some("u1"),
                "assistant",
                &json!([{"type":"text","text":"old answer"}]),
            ),
            t("u2", None, "user", &json!("second try")),
        ];
        let bridge = [live(
            "r",
            1,
            "a1",
            "assistant",
            &json!([{"type":"text","text":"old answer"}]),
        )];
        let t_refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let b_refs: Vec<&str> = bridge.iter().map(String::as_str).collect();
        let turns = build_turns(&b_refs, &t_refs, None);
        assert_eq!(turns.len(), 1);
        assert_eq!(
            turns[0].reply, None,
            "the discarded reply doesn't come back"
        );
    }

    #[test]
    fn rows_from_another_conversation_and_subagents_are_left_out() {
        let mine = json!({"kind":"row","run":"r","seq":1,"uuid":"u1","sessionId":"main",
            "message":{"type":"user","content":[{"type":"text","text":"mine"}]}})
        .to_string();
        let nested = json!({"kind":"row","run":"n","seq":1,"uuid":"x1","sessionId":"nested",
            "message":{"type":"user","content":[{"type":"text","text":"nested -p prompt"}]}})
        .to_string();
        let subagent =
            json!({"kind":"row","run":"r","seq":2,"uuid":"s1","sessionId":"main","agentId":"a",
            "message":{"type":"assistant","content":[{"type":"text","text":"subagent says"}]}})
            .to_string();
        let sidechain = json!({"type":"assistant","uuid":"s2","parentUuid":"u1","isSidechain":true,
            "message":{"content":[{"type":"text","text":"side"}]}})
        .to_string();
        let turns = build_turns(&[&mine, &nested, &subagent], &[&sidechain], Some("main"));
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].prompt.as_deref(), Some("mine"));
        assert_eq!(turns[0].reply, None);
    }

    #[test]
    fn an_interrupt_marks_its_turn_instead_of_opening_one() {
        let transcript = [
            t("u1", None, "user", &json!("write a story")),
            t(
                "a1",
                Some("u1"),
                "assistant",
                &json!([{"type":"text","text":"Once upon"}]),
            ),
            t(
                "u2",
                Some("a1"),
                "user",
                &json!([{"type":"text","text":"[Request interrupted by user]"}]),
            ),
            t("u3", Some("u2"), "user", &json!("shorter please")),
        ];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert_eq!(turns.len(), 2, "the marker is not a prompt");
        assert!(turns[0].interrupted);
        assert_eq!(turns[0].reply.as_deref(), Some("Once upon"));
        assert!(!turns[1].interrupted);
    }

    #[test]
    fn an_interrupt_during_a_tool_still_records_the_result() {
        let transcript = [
            t("u1", None, "user", &json!("run it")),
            t(
                "a1",
                Some("u1"),
                "assistant",
                &json!([{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"sleep 9"}}]),
            ),
            t(
                "u2",
                Some("a1"),
                "user",
                &json!([{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"stopped"},
                        {"type":"text","text":"[Request interrupted by user for tool use]"}]),
            ),
        ];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert_eq!(turns.len(), 1);
        assert!(turns[0].interrupted);
        assert!(matches!(
            &turns[0].did[0],
            TurnItem::Step { is_error: true, result: Some(r), .. } if r == "stopped"
        ));
    }

    #[test]
    fn a_prompt_keeps_the_source_paths_of_its_images() {
        let transcript = [
            t(
                "u1",
                None,
                "user",
                &json!([{"type":"text","text":"what is this? [Image #1]"},
                        {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]),
            ),
            json!({"type":"user","uuid":"m1","parentUuid":"u1","isMeta":true,
                   "message":{"content":[{"type":"text","text":"[Image: source: /tmp/shots/a b.png]"}]}})
            .to_string(),
            t(
                "a1",
                Some("m1"),
                "assistant",
                &json!([{"type":"text","text":"A cat."}]),
            ),
        ];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].images, vec!["/tmp/shots/a b.png".to_string()]);
        assert_eq!(turns[0].reply.as_deref(), Some("A cat."));
    }

    #[test]
    fn a_turn_knows_when_it_started_and_last_moved() {
        let transcript = [
            json!({"type":"user","uuid":"u1","timestamp":"2026-10-07T10:00:00.000Z",
                   "message":{"content":"go"}})
            .to_string(),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-10-07T10:00:07.500Z",
                   "message":{"content":[{"type":"text","text":"done"}]}})
            .to_string(),
        ];
        let bridge = [
            json!({"kind":"row","run":"r","seq":1,"uuid":"a2","receivedMs":1_791_367_210_000_i64,
            "message":{"type":"assistant","content":[{"type":"text","text":"more"}]}})
            .to_string(),
        ];
        let t_refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let b_refs: Vec<&str> = bridge.iter().map(String::as_str).collect();
        let turns = build_turns(&b_refs, &t_refs, None);
        let start = crate::activity_log::parse_iso_ms("2026-10-07T10:00:00.000Z");
        assert_eq!(turns[0].started_ms, start);
        assert_eq!(turns[0].ended_ms, Some(1_791_367_210_000));
    }

    #[test]
    fn a_partial_reply_is_read_for_its_own_conversation_only() {
        let line = json!({"kind":"partial","turnId":"t1","step":0,"block":1,"text":"Hel",
            "final":false,"sessionId":"main","receivedMs":5})
        .to_string();
        let partial = parse_partial(&line, Some("main")).expect("reads");
        assert_eq!(partial.text, "Hel");
        assert_eq!((partial.step, partial.block, partial.done), (0, 1, false));
        assert_eq!(parse_partial(&line, Some("nested")), None);
        assert_eq!(parse_partial(r#"{"kind":"row"}"#, None), None);
        assert_eq!(parse_partial("not json", None), None);
    }

    /// Claude Code chains its injected `attachment` rows into the conversation:
    /// the walk must go through them, or it stops right before the reply.
    #[test]
    fn the_chain_runs_through_attachment_rows() {
        let transcript = [
            t("u1", None, "user", &json!("make hello.txt")),
            json!({"type":"attachment","uuid":"x1","parentUuid":"u1",
                   "attachment":{"type":"date"}})
            .to_string(),
            t(
                "a1",
                Some("x1"),
                "assistant",
                &json!([{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"echo hi"}}]),
            ),
            t(
                "u2",
                Some("a1"),
                "user",
                &json!([{"type":"tool_result","tool_use_id":"t1","content":""}]),
            ),
            t(
                "a2",
                Some("u2"),
                "assistant",
                &json!([{"type":"text","text":"Done."}]),
            ),
            json!({"type":"system","subtype":"turn_duration","uuid":"s1","parentUuid":"a2"})
                .to_string(),
        ];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].prompt.as_deref(), Some("make hello.txt"));
        assert_eq!(turns[0].reply.as_deref(), Some("Done."));
        assert!(matches!(turns[0].did[0], TurnItem::Step { .. }));
        assert!(turns[0].ended, "its turn_duration row marks the end");
    }

    fn report_row(uuid: &str, parent: &str, origin: &str, summary: &str) -> String {
        json!({"type":"user","uuid":uuid,"parentUuid":parent,"origin":{"kind":origin},
               "message":{"role":"user","content":format!(
                   "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>{summary}</summary>\n</task-notification>")}})
        .to_string()
    }

    #[test]
    fn a_work_report_opens_its_turn_without_a_prompt() {
        let transcript = [
            t("u1", None, "user", &json!("watch the build")),
            t(
                "a1",
                Some("u1"),
                "assistant",
                &json!([{"type":"text","text":"Watching."}]),
            ),
            report_row("n1", "a1", "task-notification", "Build finished"),
            t(
                "a2",
                Some("n1"),
                "assistant",
                &json!([{"type":"text","text":"It passed."}]),
            ),
        ];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].reports, Vec::new());
        assert_eq!(turns[1].prompt, None);
        assert_eq!(
            turns[1].reports,
            vec![crate::work_report::WorkReport {
                summary: "Build finished".into(),
                outcome: crate::work_report::ReportOutcome::Completed,
                event: None,
            }]
        );
        assert_eq!(turns[1].reply.as_deref(), Some("It passed."));
    }

    /// A subagent's hand-back as Claude Code writes it: a meta `user` row
    /// stamped `origin.kind: peer`.
    fn handback_row(uuid: &str, parent: &str, from: &str) -> String {
        json!({"type":"user","uuid":uuid,"parentUuid":parent,"isMeta":true,
               "origin":{"kind":"peer","from":from},
               "message":{"role":"user","content":format!(
                   "Another Claude session sent a message:\n<agent-message from=\"{from}\">\n[Subagent hand-back] The report follows:\n  [ ]\n</agent-message>")}})
        .to_string()
    }

    #[test]
    fn a_subagent_handing_back_opens_its_turn_named_by_its_launch() {
        let transcript = [
            t("u1", None, "user", &json!("review it")),
            t(
                "a1",
                Some("u1"),
                "assistant",
                &json!([{"type":"tool_use","id":"t1","name":"Agent",
                         "input":{"description":"Re-check the fix","prompt":"…"}}]),
            ),
            t(
                "r1",
                Some("a1"),
                "user",
                &json!([{"type":"tool_result","tool_use_id":"t1","content":
                    "Async agent launched successfully.\nagentId: af19c (internal ID)"}]),
            ),
            json!({"type":"system","subtype":"turn_duration","uuid":"d1","parentUuid":"r1"})
                .to_string(),
            handback_row("h1", "d1", "af19c"),
            t(
                "a2",
                Some("h1"),
                "assistant",
                &json!([{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"pnpm check"}}]),
            ),
        ];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert_eq!(turns.len(), 2, "the hand-back opens a turn of its own");
        assert!(turns[0].ended);
        assert_eq!(turns[1].prompt, None);
        assert_eq!(
            turns[1].reports,
            vec![crate::work_report::WorkReport {
                summary: "Agent \"Re-check the fix\" reported back".into(),
                outcome: crate::work_report::ReportOutcome::Completed,
                event: None,
            }]
        );
        assert!(!turns[1].ended, "Claude is still working on it");
        assert_eq!(turns[1].did.len(), 1);
    }

    #[test]
    fn a_handback_from_an_agent_not_in_view_still_says_what_woke_claude() {
        let transcript = [handback_row("h1", "", "a9")];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert_eq!(turns[0].reports[0].summary, "A subagent reported back");
    }

    #[test]
    fn claude_writing_after_a_recorded_end_reopens_the_turn() {
        // Whatever woke Claude (here a meta row) opened no turn: its work
        // joins the last one, which must not still read as over.
        let transcript = [
            t("u1", None, "user", &json!("go")),
            t(
                "a1",
                Some("u1"),
                "assistant",
                &json!([{"type":"text","text":"Done."}]),
            ),
            json!({"type":"system","subtype":"turn_duration","uuid":"d1","parentUuid":"a1"})
                .to_string(),
            json!({"type":"user","uuid":"m1","parentUuid":"d1","isMeta":true,
                   "message":{"role":"user","content":"woken"}})
            .to_string(),
            t(
                "a2",
                Some("m1"),
                "assistant",
                &json!([{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"ls"}}]),
            ),
        ];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert_eq!(turns.len(), 1);
        assert!(!turns[0].ended);
    }

    #[test]
    fn reports_with_nothing_between_share_one_turn() {
        let transcript = [
            report_row("n1", "", "task-notification", "Agent \"A\" finished"),
            report_row("n2", "n1", "task-notification", "Agent \"B\" finished"),
            t(
                "a1",
                Some("n2"),
                "assistant",
                &json!([{"type":"text","text":"Both done."}]),
            ),
        ];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].reports.len(), 2);
    }

    #[test]
    fn a_report_the_companion_forwarded_is_one_too() {
        let bridge = [json!({"kind":"row","run":"r","seq":1,"uuid":"n1","origin":"task-notification",
            "message":{"type":"user","role":"user","content":[{"type":"text",
                "text":"<task-notification>\n<status>failed</status>\n<summary>Agent \"X\" failed</summary>\n</task-notification>"}]}})
        .to_string()];
        let refs: Vec<&str> = bridge.iter().map(String::as_str).collect();
        let turns = build_turns(&refs, &[], None);
        assert_eq!(turns[0].prompt, None);
        assert_eq!(
            turns[0].reports[0].outcome,
            crate::work_report::ReportOutcome::Failed
        );
    }

    #[test]
    fn a_person_who_pastes_a_report_sent_a_prompt() {
        let transcript = [report_row("u1", "", "human", "Build finished")];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert!(turns[0].prompt.is_some());
        assert_eq!(turns[0].reports, Vec::new());
    }

    #[test]
    fn a_slash_command_run_while_claude_answers_a_report_leaves_that_turn_whole() {
        let transcript = [
            report_row("n1", "", "task-notification", "Build finished"),
            t(
                "a1",
                Some("n1"),
                "assistant",
                &json!([{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]),
            ),
            local(
                "c1",
                Some("a1"),
                "<command-name>/cost</command-name>\n            <command-message>cost</command-message>\n            <command-args></command-args>",
            ),
            local(
                "o1",
                Some("c1"),
                "<local-command-stdout>Total cost: $0.12</local-command-stdout>",
            ),
            t(
                "u2",
                Some("o1"),
                "user",
                &json!([{"type":"tool_result","tool_use_id":"t1","content":"a.txt"}]),
            ),
            t("a2", Some("u2"), "assistant", &json!([{"type":"text","text":"It passed."}])),
        ];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].prompt.as_deref(), Some("/cost"));
        assert_eq!(turns[1].reports.len(), 1);
        assert_eq!(turns[1].reply.as_deref(), Some("It passed."));
    }

    #[test]
    fn a_report_after_an_interrupted_one_opens_a_turn_of_its_own() {
        let transcript = [
            report_row("n1", "", "task-notification", "Agent \"A\" finished"),
            t(
                "i1",
                Some("n1"),
                "user",
                &json!("[Request interrupted by user]"),
            ),
            report_row("n2", "i1", "task-notification", "Agent \"B\" finished"),
            t(
                "a1",
                Some("n2"),
                "assistant",
                &json!([{"type":"text","text":"B is done."}]),
            ),
        ];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert_eq!(turns.len(), 2);
        assert!(turns[0].interrupted);
        assert!(!turns[1].interrupted);
        assert_eq!(turns[1].reply.as_deref(), Some("B is done."));
    }

    #[test]
    fn a_compaction_keeps_the_turns_before_it_and_its_summary_is_no_prompt() {
        // As 2.1.302 writes it: the boundary starts a new chain (no parent;
        // `logicalParentUuid` names the row before), then Claude Code's
        // summary as a user row.
        let transcript = [
            t("u1", None, "user", &json!("ship it")),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1",
                   "timestamp":"2026-10-18T07:32:02.000Z",
                   "message":{"role":"assistant","content":[{"type":"text","text":"Shipped. Beta.2 next?"}]}})
            .to_string(),
            json!({"type":"system","subtype":"turn_duration","uuid":"d1","parentUuid":"a1",
                   "timestamp":"2026-10-18T07:32:02.000Z"})
            .to_string(),
            json!({"type":"system","subtype":"compact_boundary","uuid":"b1","parentUuid":null,
                   "logicalParentUuid":"d1","timestamp":"2026-10-18T08:26:43.000Z"})
            .to_string(),
            json!({"type":"user","uuid":"s1","parentUuid":"b1","isCompactSummary":true,
                   "isVisibleInTranscriptOnly":true,"timestamp":"2026-10-18T08:26:43.000Z",
                   "message":{"role":"user","content":"This session is being continued from a previous conversation."}})
            .to_string(),
            json!({"type":"attachment","uuid":"x1","parentUuid":"s1"}).to_string(),
            t("u2", Some("x1"), "user", &json!("yes, ship beta.2")),
            t(
                "a2",
                Some("u2"),
                "assistant",
                &json!([{"type":"text","text":"Started."}]),
            ),
        ];
        let refs: Vec<&str> = transcript.iter().map(String::as_str).collect();
        let turns = build_turns(&[], &refs, None);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].prompt.as_deref(), Some("ship it"));
        assert_eq!(turns[0].reply.as_deref(), Some("Shipped. Beta.2 next?"));
        assert!(turns[0].did.contains(&TurnItem::Compacted));
        // The summary, written an hour later, doesn't stretch the turn.
        assert_eq!(
            turns[0].ended_ms,
            crate::activity_log::parse_iso_ms("2026-10-18T07:32:02.000Z")
        );
        assert_eq!(turns[1].prompt.as_deref(), Some("yes, ship beta.2"));
        assert_eq!(turns[1].reply.as_deref(), Some("Started."));
    }
}
