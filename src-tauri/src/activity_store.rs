//! The [Activity store]: `activity.db`, the SQLite home of the [Activity log].
//!
//! The [Hook spool] feeds it. [`ingest_spool`] reads a spool from its saved
//! position and applies every new line in one transaction that also saves the
//! new position, so a crash never loses or double-counts a line. What a line
//! means is decided in `kriyon_core::activity_log`; this module only stores it.
//!
//! Kept apart from `kriyon.db` so heavy churn stays away from small config
//! data, `auto_vacuum` can be chosen up front, and "delete all" is cheap.

use std::path::Path;

use kriyon_core::activity_log::{self, LogEntry, StepKind, StepStatus, StepUpdate};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// How long the log keeps a session after its last activity (Claude Code's own
/// transcript default).
pub const RETENTION_DAYS: i64 = 30;

/// The most the log may take on disk before the oldest sessions go.
pub const SIZE_CAP_BYTES: i64 = 500 * 1024 * 1024;

/// What an exit leaves on a step it closed — replaced if the step's real end
/// is read later.
const DID_NOT_FINISH: &str = "Did not finish: the session ended";

/// The end reason an exit leaves on a turn it closed — replaced likewise.
const SESSION_ENDED: &str = "session ended";

/// How many recent spool lines each session keeps for rebuilding its status
/// once its spool is gone (a resume after the spool was cleaned up).
const SEED_LINES_KEPT: i64 = 600;

/// The most one ingest pass reads from a spool, so the first pass over a large
/// backlog is spread across ticks instead of one huge transaction.
const MAX_READ_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum ActivityError {
    #[error("activity log: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("activity log: {0}")]
    Io(#[from] std::io::Error),
}

/// Where ingest stopped in one session's spool. `dev`/`ino` tell a replaced
/// file from the one the offset belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpoolCursor {
    pub dev: i64,
    pub ino: i64,
    pub offset: i64,
}

/// Which of a session's two spools a cursor or a read is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Spool {
    /// The [Hook spool]: hook events.
    Hook,
    /// The [Bridge spool]: what the companion mod posted.
    Bridge,
}

impl Spool {
    const fn name(self) -> &'static str {
        match self {
            Self::Hook => "hook",
            Self::Bridge => "bridge",
        }
    }

    const fn cursor_table(self) -> &'static str {
        match self {
            Self::Hook => "spool_cursor",
            Self::Bridge => "bridge_cursor",
        }
    }
}

/// What the companion's posts say about one conversation right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompanionFacts {
    /// The newest `claude` process's mod connected and hasn't ended.
    pub live: bool,
    pub claude_version: Option<String>,
}

/// One turn of the [Activity log]: a prompt and the steps it led to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityTurn {
    pub id: i64,
    pub prompt: Option<String>,
    /// Who sent the prompt (`user`, `system`, `loop_wakeup`, …), when known.
    pub source: Option<String>,
    pub started_ms: i64,
    pub ended_ms: Option<i64>,
    pub end_reason: Option<String>,
    pub steps: Vec<ActivityStep>,
}

/// One [Activity step], as a timeline row shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityStep {
    pub id: i64,
    pub tool_name: String,
    pub kind: StepKind,
    pub target: Option<String>,
    pub status: StepStatus,
    pub flags: u32,
    pub agent_type: Option<String>,
    pub started_ms: i64,
    pub duration_ms: Option<i64>,
}

/// Everything about one step, for its detail dialog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityStepDetail {
    #[serde(flatten)]
    pub step: ActivityStep,
    pub input: Option<String>,
    pub result: Option<String>,
    pub agent_id: Option<String>,
    pub allowed_by: String,
    pub ended_ms: Option<i64>,
}

/// The log's size and reach, for Settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityStats {
    pub size_bytes: i64,
    pub sessions: i64,
    pub retention_days: i64,
    pub size_cap_bytes: i64,
}

pub struct ActivityStore {
    conn: Connection,
}

const SCHEMA_V1: &str = "
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  last_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE turns (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_id TEXT,
  claude_session_id TEXT,
  prompt TEXT,
  source TEXT,
  started_ms INTEGER NOT NULL,
  ended_ms INTEGER,
  end_reason TEXT,
  UNIQUE (session_id, prompt_id)
) STRICT;
CREATE INDEX turns_session ON turns(session_id, started_ms);
CREATE TABLE steps (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id INTEGER REFERENCES turns(id) ON DELETE CASCADE,
  tool_use_id TEXT NOT NULL,
  agent_id TEXT,
  agent_type TEXT,
  tool_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT,
  input TEXT,
  result TEXT,
  status TEXT NOT NULL,
  flags INTEGER NOT NULL DEFAULT 0,
  permission_mode TEXT,
  asked INTEGER NOT NULL DEFAULT 0,
  started_ms INTEGER NOT NULL,
  ended_ms INTEGER,
  duration_ms INTEGER,
  UNIQUE (session_id, tool_use_id)
) STRICT;
CREATE INDEX steps_turn ON steps(turn_id);
CREATE TABLE seed_lines (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  line TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) STRICT;
CREATE TABLE spool_cursor (
  session_id TEXT PRIMARY KEY,
  dev INTEGER NOT NULL,
  ino INTEGER NOT NULL,
  offset INTEGER NOT NULL
) STRICT;
";

impl ActivityStore {
    /// Open (creating or migrating) the store at `path`.
    ///
    /// # Errors
    /// When the file can't be opened or the schema can't be created.
    pub fn open(path: &Path) -> Result<Self, ActivityError> {
        Self::init(Connection::open(path)?)
    }

    /// An in-memory store, for tests.
    ///
    /// # Errors
    /// When the schema can't be created.
    pub fn open_in_memory() -> Result<Self, ActivityError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self, ActivityError> {
        // auto_vacuum only takes on a file with no tables yet; harmless after.
        conn.execute_batch(
            "PRAGMA auto_vacuum = INCREMENTAL;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA journal_size_limit = 67108864;
             PRAGMA secure_delete = FAST;",
        )?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 1 {
            conn.execute_batch(&format!(
                "BEGIN; {SCHEMA_V1} PRAGMA user_version = 1; COMMIT;"
            ))?;
        }
        if version < 2 {
            // Which `claude` conversation ran each step, so a nested `claude
            // -p` ending closes only its own.
            conn.execute_batch(
                "BEGIN; ALTER TABLE steps ADD COLUMN claude_session_id TEXT;
                 UPDATE steps SET claude_session_id =
                   (SELECT t.claude_session_id FROM turns t WHERE t.id = steps.turn_id)
                 WHERE claude_session_id IS NULL;
                 PRAGMA user_version = 2; COMMIT;",
            )?;
        }
        if version < 3 {
            // The companion's posts, ingested like the hook spool (ADR-0032):
            // runs (one per `claude` process), the rows the Structured view
            // shows, and each tool call's permission check.
            conn.execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS companion_runs (
                   session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                   run TEXT NOT NULL,
                   conversation TEXT,
                   version TEXT,
                   ended INTEGER NOT NULL DEFAULT 0,
                   PRIMARY KEY (session_id, run)
                 ) STRICT;
                 CREATE TABLE IF NOT EXISTS bridge_rows (
                   session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                   run TEXT NOT NULL,
                   seq INTEGER NOT NULL,
                   line TEXT NOT NULL,
                   PRIMARY KEY (session_id, run, seq)
                 ) STRICT;
                 CREATE TABLE IF NOT EXISTS tool_checks (
                   session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                   tool_use_id TEXT NOT NULL,
                   decision TEXT NOT NULL,
                   rule TEXT,
                   PRIMARY KEY (session_id, tool_use_id)
                 ) STRICT;
                 CREATE TABLE IF NOT EXISTS bridge_cursor (
                   session_id TEXT PRIMARY KEY,
                   dev INTEGER NOT NULL,
                   ino INTEGER NOT NULL,
                   offset INTEGER NOT NULL
                 ) STRICT;
                 PRAGMA user_version = 3; COMMIT;",
            )?;
        }
        if version < 4 {
            // Each companion run's newest number, so a late post can't take a
            // run back; and where each spool stood when the session's terminal
            // died, so lines written before that and read later are closed.
            conn.execute_batch(
                "BEGIN;
                 ALTER TABLE companion_runs ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0;
                 CREATE TABLE IF NOT EXISTS exit_marks (
                   session_id TEXT NOT NULL,
                   spool TEXT NOT NULL,
                   dev INTEGER NOT NULL,
                   ino INTEGER NOT NULL,
                   offset INTEGER NOT NULL,
                   at_ms INTEGER NOT NULL,
                   PRIMARY KEY (session_id, spool)
                 ) STRICT;
                 PRAGMA user_version = 4; COMMIT;",
            )?;
        }
        if version < 5 {
            // An early v4 lacked the exit marks; create them for every database.
            conn.execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS exit_marks (
                   session_id TEXT NOT NULL,
                   spool TEXT NOT NULL,
                   dev INTEGER NOT NULL,
                   ino INTEGER NOT NULL,
                   offset INTEGER NOT NULL,
                   at_ms INTEGER NOT NULL,
                   PRIMARY KEY (session_id, spool)
                 ) STRICT;
                 PRAGMA user_version = 5; COMMIT;",
            )?;
        }
        Ok(Self { conn })
    }

    /// Where ingest stopped in one of `session_id`'s spools, if it has started.
    ///
    /// # Errors
    /// On a database error.
    pub fn cursor(
        &self,
        spool: Spool,
        session_id: &str,
    ) -> Result<Option<SpoolCursor>, ActivityError> {
        Ok(self
            .conn
            .query_row(
                &format!(
                    "SELECT dev, ino, offset FROM {} WHERE session_id = ?1",
                    spool.cursor_table()
                ),
                [session_id],
                |r| {
                    Ok(SpoolCursor {
                        dev: r.get(0)?,
                        ino: r.get(1)?,
                        offset: r.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    /// Apply `lines` from `session_id`'s spool and save `cursor`, in one
    /// transaction. Unreadable lines are skipped, never an error.
    ///
    /// # Errors
    /// On a database error; nothing is applied then.
    pub fn ingest(
        &mut self,
        session_id: &str,
        lines: &[&str],
        cursor: SpoolCursor,
        before_exit: usize,
    ) -> Result<(), ActivityError> {
        let exit_at = self.exit_mark(Spool::Hook, session_id)?.map(|(_, at)| at);
        let tx = self.conn.transaction()?;
        let mut dead_steps: Vec<String> = Vec::new();
        let mut dead_turns: Vec<String> = Vec::new();
        let mut dead_turn_rows: Vec<i64> = Vec::new();
        let mut last_ms: Option<i64> = None;
        for (index, line) in lines.iter().enumerate() {
            let Some(event) = kriyon_core::hooks::parse_hook_line(line) else {
                continue;
            };
            ensure_session(&tx, session_id)?;
            tx.execute(
                "INSERT INTO seed_lines (session_id, seq, line)
                 VALUES (?1, COALESCE((SELECT MAX(seq) FROM seed_lines WHERE session_id = ?1), 0) + 1, ?2)",
                params![session_id, kriyon_core::redact::redact_json_text(line.trim())],
            )?;
            if let Some(ms) = event.ts.as_deref().and_then(activity_log::parse_iso_ms) {
                last_ms = Some(last_ms.map_or(ms, |m| m.max(ms)));
            }
            if let Some(entry) = activity_log::log_entry(&event) {
                if index < before_exit {
                    match &entry {
                        LogEntry::Step(step) => {
                            dead_steps.push(step.tool_use_id.clone());
                            dead_turns.extend(step.prompt_id.clone());
                        }
                        LogEntry::Prompt { prompt_id, .. } => dead_turns.extend(prompt_id.clone()),
                        _ => {}
                    }
                }
                apply(&tx, session_id, &entry)?;
                if index < before_exit {
                    if let LogEntry::Prompt {
                        prompt_id: None, ..
                    } = &entry
                    {
                        // No id to find it by later: keep the row it made.
                        dead_turn_rows.push(tx.last_insert_rowid());
                    }
                }
            }
        }
        if let Some(ms) = last_ms {
            tx.execute(
                "UPDATE sessions SET last_ms = MAX(last_ms, ?2) WHERE id = ?1",
                params![session_id, ms],
            )?;
        }
        tx.execute(
            "DELETE FROM seed_lines WHERE session_id = ?1
             AND seq <= (SELECT MAX(seq) FROM seed_lines WHERE session_id = ?1) - ?2",
            params![session_id, SEED_LINES_KEPT],
        )?;
        if let Some(at_ms) = exit_at {
            close_before_exit(&tx, session_id, &dead_steps, &dead_turns, at_ms)?;
            for row in &dead_turn_rows {
                tx.execute(
                    "UPDATE turns SET ended_ms = ?2, end_reason = ?3
                     WHERE id = ?1 AND ended_ms IS NULL",
                    params![row, at_ms, SESSION_ENDED],
                )?;
            }
        }
        clear_passed_mark(&tx, Spool::Hook, session_id, cursor)?;
        tx.execute(
            "INSERT INTO spool_cursor (session_id, dev, ino, offset) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(session_id) DO UPDATE SET dev = ?2, ino = ?3, offset = ?4",
            params![session_id, cursor.dev, cursor.ino, cursor.offset],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// The newest `limit` turns of a session, newest first, with their steps.
    ///
    /// # Errors
    /// On a database error.
    pub fn turns(&self, session_id: &str, limit: i64) -> Result<Vec<ActivityTurn>, ActivityError> {
        let mut turns_stmt = self.conn.prepare(
            "SELECT id, prompt, source, started_ms, ended_ms, end_reason FROM turns
             WHERE session_id = ?1 ORDER BY started_ms DESC, id DESC LIMIT ?2",
        )?;
        let mut steps_stmt = self.conn.prepare(&format!(
            "SELECT {STEP_COLUMNS} FROM steps WHERE turn_id = ?1 ORDER BY started_ms, id"
        ))?;
        let mut turns = turns_stmt
            .query_map(params![session_id, limit], |r| {
                Ok(ActivityTurn {
                    id: r.get(0)?,
                    prompt: r.get(1)?,
                    source: r.get(2)?,
                    started_ms: r.get(3)?,
                    ended_ms: r.get(4)?,
                    end_reason: r.get(5)?,
                    steps: Vec::new(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for turn in &mut turns {
            turn.steps = steps_stmt
                .query_map([turn.id], step_row)?
                .collect::<Result<Vec<_>, _>>()?;
        }
        Ok(turns)
    }

    /// One step in full, or `None` when it isn't `session_id`'s — with the
    /// permission check the companion saw for it, when it was on.
    ///
    /// # Errors
    /// On a database error.
    pub fn step(
        &self,
        session_id: &str,
        step_id: i64,
    ) -> Result<Option<ActivityStepDetail>, ActivityError> {
        Ok(self
            .conn
            .query_row(
                &format!(
                    "SELECT {STEP_COLUMNS}, input, result, agent_id, permission_mode, asked, ended_ms,
                            (SELECT decision FROM tool_checks c
                               WHERE c.session_id = steps.session_id
                                 AND c.tool_use_id = steps.tool_use_id),
                            (SELECT rule FROM tool_checks c
                               WHERE c.session_id = steps.session_id
                                 AND c.tool_use_id = steps.tool_use_id)
                     FROM steps WHERE session_id = ?1 AND id = ?2"
                ),
                params![session_id, step_id],
                |r| {
                    let step = step_row(r)?;
                    let mode: Option<String> = r.get(12)?;
                    let asked: i64 = r.get(13)?;
                    let decision: Option<String> = r.get(15)?;
                    let check = decision.map(|decision| kriyon_core::bridge::ToolCheck {
                        decision,
                        rule: r.get(16).ok().flatten(),
                    });
                    Ok(ActivityStepDetail {
                        allowed_by: activity_log::allowed_by(
                            step.kind,
                            mode.as_deref(),
                            asked != 0,
                            step.status,
                            check.as_ref(),
                        ),
                        step,
                        input: r.get(9)?,
                        result: r.get(10)?,
                        agent_id: r.get(11)?,
                        ended_ms: r.get(14)?,
                    })
                },
            )
            .optional()?)
    }

    /// The recent spool lines kept for `session_id`, oldest first — what the
    /// status seed replays when the spool itself is gone.
    ///
    /// # Errors
    /// On a database error.
    pub fn seed_lines(&self, session_id: &str) -> Result<Vec<String>, ActivityError> {
        let mut stmt = self
            .conn
            .prepare("SELECT line FROM seed_lines WHERE session_id = ?1 ORDER BY seq")?;
        let lines = stmt
            .query_map([session_id], |r| r.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(lines)
    }

    /// Every session the log holds.
    ///
    /// # Errors
    /// On a database error.
    pub fn session_ids(&self) -> Result<Vec<String>, ActivityError> {
        let mut stmt = self.conn.prepare("SELECT id FROM sessions")?;
        let ids = stmt
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(ids)
    }

    /// The session's terminal died at `at_ms`: whatever was open then will
    /// never report an end, so it is closed now. `marks` say where each spool
    /// stood at that moment: lines before a mark that are read later belong to
    /// the dead terminal and are closed too, whatever their own clock says,
    /// while lines after it (a resume) start afresh.
    ///
    /// # Errors
    /// On a database error.
    pub fn close_open(
        &mut self,
        session_id: &str,
        at_ms: i64,
        marks: &[(Spool, SpoolCursor)],
    ) -> Result<(), ActivityError> {
        let tx = self.conn.transaction()?;
        ensure_session(&tx, session_id)?;
        for (spool, mark) in marks {
            tx.execute(
                "INSERT INTO exit_marks (session_id, spool, dev, ino, offset, at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(session_id, spool) DO UPDATE SET
                   dev = ?3, ino = ?4, offset = ?5, at_ms = ?6",
                params![
                    session_id,
                    spool.name(),
                    mark.dev,
                    mark.ino,
                    mark.offset,
                    at_ms
                ],
            )?;
        }
        tx.execute(
            "UPDATE steps SET status = 'error', ended_ms = ?2, result = COALESCE(result, ?3)
             WHERE session_id = ?1 AND status = 'running'",
            params![session_id, at_ms, DID_NOT_FINISH],
        )?;
        tx.execute(
            "UPDATE turns SET ended_ms = ?2, end_reason = ?3
             WHERE session_id = ?1 AND ended_ms IS NULL",
            params![session_id, at_ms, SESSION_ENDED],
        )?;
        tx.execute(
            "UPDATE companion_runs SET ended = 1 WHERE session_id = ?1",
            [session_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Where `spool` stood when the session's terminal died, if it died since
    /// that point was read.
    fn exit_mark(
        &self,
        spool: Spool,
        session_id: &str,
    ) -> Result<Option<(SpoolCursor, i64)>, ActivityError> {
        Ok(self
            .conn
            .query_row(
                "SELECT dev, ino, offset, at_ms FROM exit_marks WHERE session_id = ?1 AND spool = ?2",
                params![session_id, spool.name()],
                |r| {
                    Ok((
                        SpoolCursor {
                            dev: r.get(0)?,
                            ino: r.get(1)?,
                            offset: r.get(2)?,
                        },
                        r.get(3)?,
                    ))
                },
            )
            .optional()?)
    }

    /// Forget one session's activity. Its cursor stays, so a still-running
    /// session doesn't re-ingest the lines just deleted.
    ///
    /// # Errors
    /// On a database error.
    pub fn delete_session(&self, session_id: &str) -> Result<(), ActivityError> {
        self.conn
            .execute("DELETE FROM sessions WHERE id = ?1", [session_id])?;
        Ok(())
    }

    /// Forget every session's activity and give the space back.
    ///
    /// # Errors
    /// On a database error.
    pub fn delete_all(&self) -> Result<(), ActivityError> {
        self.conn.execute("DELETE FROM sessions", [])?;
        self.conn.execute_batch("VACUUM;")?;
        Ok(())
    }

    /// Forget the cursor of a spool that is gone, so a new one starts at 0.
    ///
    /// # Errors
    /// On a database error.
    pub fn forget_cursor(&self, spool: Spool, session_id: &str) -> Result<(), ActivityError> {
        self.conn.execute(
            &format!("DELETE FROM {} WHERE session_id = ?1", spool.cursor_table()),
            [session_id],
        )?;
        Ok(())
    }

    /// Apply lines of `session_id`'s [Bridge spool] and save `cursor`, in one
    /// transaction. Runs are kept in the order they first appear, rows by the
    /// mod's number, and a permission check is kept by tool call — so every
    /// reader gets the same order and the same scoping.
    ///
    /// # Errors
    /// On a database error; nothing is applied then.
    pub fn ingest_bridge(
        &mut self,
        session_id: &str,
        lines: &[&str],
        cursor: SpoolCursor,
        before_exit: usize,
    ) -> Result<(), ActivityError> {
        use kriyon_core::bridge::{classify, BridgeEvent};
        let exited = self.exit_mark(Spool::Bridge, session_id)?.is_some();
        let tx = self.conn.transaction()?;
        let mut dead_runs: Vec<String> = Vec::new();
        ensure_session(&tx, session_id)?;
        for (index, line) in lines.iter().enumerate() {
            let Some(event) = classify(line) else {
                continue;
            };
            if exited && index < before_exit {
                if let BridgeEvent::Hello { run, .. }
                | BridgeEvent::Row { run, .. }
                | BridgeEvent::End { run, .. } = &event
                {
                    dead_runs.push(run.clone());
                }
            }
            apply_bridge(&tx, session_id, event)?;
        }
        // A run that posted before its terminal died is over, whatever came after.
        for run in &dead_runs {
            tx.execute(
                "UPDATE companion_runs SET ended = 1 WHERE session_id = ?1 AND run = ?2",
                params![session_id, run],
            )?;
        }
        // Posts keep a session recent, as hook events do: retention must not
        // drop history the companion just delivered.
        let newest = lines
            .iter()
            .filter_map(|l| {
                serde_json::from_str::<serde_json::Value>(l)
                    .ok()?
                    .get("receivedMs")?
                    .as_i64()
            })
            .max();
        if let Some(ms) = newest {
            tx.execute(
                "UPDATE sessions SET last_ms = MAX(last_ms, ?2) WHERE id = ?1",
                params![session_id, ms],
            )?;
        }
        clear_passed_mark(&tx, Spool::Bridge, session_id, cursor)?;
        tx.execute(
            "INSERT INTO bridge_cursor (session_id, dev, ino, offset) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(session_id) DO UPDATE SET dev = ?2, ino = ?3, offset = ?4",
            params![session_id, cursor.dev, cursor.ino, cursor.offset],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// What the companion says about `conversation` (or, with none, the
    /// session's newest run): live while its newest run hasn't ended. `None`
    /// when the companion never posted.
    ///
    /// # Errors
    /// On a database error.
    pub fn companion(
        &self,
        session_id: &str,
        conversation: Option<&str>,
    ) -> Result<Option<CompanionFacts>, ActivityError> {
        Ok(self
            .conn
            .query_row(
                "SELECT ended, version FROM companion_runs
                 WHERE session_id = ?1 AND (?2 IS NULL OR conversation IS ?2)
                 ORDER BY rowid DESC LIMIT 1",
                params![session_id, conversation],
                |r| {
                    let ended: i64 = r.get(0)?;
                    Ok(CompanionFacts {
                        live: ended == 0,
                        claude_version: r.get(1)?,
                    })
                },
            )
            .optional()?)
    }

    /// The companion's rows for `session_id`: runs in the order they first
    /// appeared, rows by the mod's number — the Structured view's live input.
    ///
    /// # Errors
    /// On a database error.
    pub fn bridge_rows(&self, session_id: &str) -> Result<Vec<String>, ActivityError> {
        let mut stmt = self.conn.prepare(
            "SELECT b.line FROM bridge_rows b
             JOIN companion_runs r ON r.session_id = b.session_id AND r.run = b.run
             WHERE b.session_id = ?1 ORDER BY r.rowid, b.seq",
        )?;
        let rows = stmt
            .query_map([session_id], |r| r.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(rows)
    }

    /// Bytes in use (free pages excluded).
    ///
    /// # Errors
    /// On a database error.
    pub fn size_bytes(&self) -> Result<i64, ActivityError> {
        Ok(self.conn.query_row(
            "SELECT (page_count - freelist_count) * page_size
             FROM pragma_page_count(), pragma_freelist_count(), pragma_page_size()",
            [],
            |r| r.get(0),
        )?)
    }

    /// Size and reach, for Settings.
    ///
    /// # Errors
    /// On a database error.
    pub fn stats(&self) -> Result<ActivityStats, ActivityError> {
        Ok(ActivityStats {
            size_bytes: self.size_bytes()?,
            sessions: self
                .conn
                .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))?,
            retention_days: RETENTION_DAYS,
            size_cap_bytes: SIZE_CAP_BYTES,
        })
    }

    /// Apply retention: drop sessions idle since before `cutoff_ms`, then the
    /// oldest until the log fits `cap_bytes`. A live session is never dropped.
    /// Returns the ids dropped, so their spools can go too.
    ///
    /// # Errors
    /// On a database error.
    pub fn prune(
        &self,
        cutoff_ms: i64,
        cap_bytes: i64,
        is_live: &dyn Fn(&str) -> bool,
    ) -> Result<Vec<String>, ActivityError> {
        let mut oldest_first: Vec<(String, i64)> = {
            let mut stmt = self
                .conn
                .prepare("SELECT id, last_ms FROM sessions ORDER BY last_ms")?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        oldest_first.retain(|(id, _)| !is_live(id));
        let mut dropped = Vec::new();
        for (id, last_ms) in oldest_first {
            if last_ms >= cutoff_ms && self.size_bytes()? <= cap_bytes {
                break;
            }
            self.delete_session(&id)?;
            dropped.push(id);
        }
        self.conn.execute_batch(
            "PRAGMA incremental_vacuum(2000); PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;",
        )?;
        Ok(dropped)
    }
}

const STEP_COLUMNS: &str =
    "id, tool_name, kind, target, status, flags, agent_type, started_ms, duration_ms";

fn step_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ActivityStep> {
    let kind: String = r.get(2)?;
    let status: String = r.get(4)?;
    Ok(ActivityStep {
        id: r.get(0)?,
        tool_name: r.get(1)?,
        kind: StepKind::parse(&kind),
        target: r.get(3)?,
        status: StepStatus::parse(&status),
        flags: r.get(5)?,
        agent_type: r.get(6)?,
        started_ms: r.get(7)?,
        duration_ms: r.get(8)?,
    })
}

/// A companion post from `run`: record the run, and move it to a new
/// conversation only on a newer post (by the mod's number). `/clear` or a
/// resume ends a conversation without unloading the mod, so the same run then
/// speaks for the new one; a late post of an earlier conversation never takes
/// it back.
fn note_run(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    run: &str,
    seq: u64,
    conversation: Option<&str>,
) -> rusqlite::Result<usize> {
    tx.execute(
        "INSERT INTO companion_runs (session_id, run, conversation, last_seq)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(session_id, run) DO UPDATE SET
               ended = CASE WHEN excluded.last_seq > last_seq
                             AND excluded.conversation IS NOT NULL
                             AND conversation IS NOT NULL
                             AND excluded.conversation <> conversation
                        THEN 0 ELSE ended END,
               conversation = CASE WHEN excluded.last_seq > last_seq OR conversation IS NULL
                              THEN COALESCE(excluded.conversation, conversation)
                              ELSE conversation END,
               last_seq = MAX(last_seq, excluded.last_seq)",
        params![
            session_id,
            run,
            conversation,
            i64::try_from(seq).unwrap_or(i64::MAX)
        ],
    )
}

/// Apply one companion event to the store.
fn apply_bridge(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    event: kriyon_core::bridge::BridgeEvent,
) -> rusqlite::Result<()> {
    use kriyon_core::bridge::BridgeEvent;
    match event {
        BridgeEvent::Hello {
            run,
            seq,
            conversation,
            version,
            ..
        } => {
            note_run(tx, session_id, &run, seq, conversation.as_deref())?;
            tx.execute(
                "UPDATE companion_runs SET version = COALESCE(?3, version)
                     WHERE session_id = ?1 AND run = ?2",
                params![session_id, run, version],
            )?;
        }
        BridgeEvent::Row {
            run,
            seq,
            conversation,
            line,
            ..
        } => {
            note_run(tx, session_id, &run, seq, conversation.as_deref())?;
            tx.execute(
                "INSERT OR IGNORE INTO bridge_rows (session_id, run, seq, line)
                     VALUES (?1, ?2, ?3, ?4)",
                params![
                    session_id,
                    run,
                    i64::try_from(seq).unwrap_or(i64::MAX),
                    line
                ],
            )?;
        }
        BridgeEvent::Check { tool_use_id, check } => {
            tx.execute(
                "INSERT INTO tool_checks (session_id, tool_use_id, decision, rule)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(session_id, tool_use_id) DO UPDATE SET
                       decision = excluded.decision, rule = excluded.rule",
                params![session_id, tool_use_id, check.decision, check.rule],
            )?;
        }
        // An end closes the run's current conversation only: a late
        // end of an earlier one changes nothing.
        BridgeEvent::End {
            run,
            seq,
            conversation,
            ..
        } => {
            note_run(tx, session_id, &run, seq, conversation.as_deref())?;
            tx.execute(
                "UPDATE companion_runs SET ended = 1
                     WHERE session_id = ?1 AND run = ?2 AND (?3 IS NULL OR conversation IS ?3)",
                params![session_id, run, conversation],
            )?;
        }
    }
    Ok(())
}

/// Close the steps and turns that lines from before the terminal's exit
/// opened and that are still open: they belong to the dead terminal.
fn close_before_exit(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    steps: &[String],
    turns: &[String],
    at_ms: i64,
) -> rusqlite::Result<()> {
    for id in steps {
        tx.execute(
            "UPDATE steps SET status = 'error', ended_ms = ?3, result = COALESCE(result, ?4)
             WHERE session_id = ?1 AND tool_use_id = ?2 AND status = 'running'",
            params![session_id, id, at_ms, DID_NOT_FINISH],
        )?;
    }
    for id in turns {
        tx.execute(
            "UPDATE turns SET ended_ms = ?3, end_reason = ?4
             WHERE session_id = ?1 AND prompt_id = ?2 AND ended_ms IS NULL",
            params![session_id, id, at_ms, SESSION_ENDED],
        )?;
    }
    Ok(())
}

/// Drop an exit mark once ingest has read past it (or the spool was replaced).
fn clear_passed_mark(
    tx: &rusqlite::Transaction<'_>,
    spool: Spool,
    session_id: &str,
    cursor: SpoolCursor,
) -> rusqlite::Result<()> {
    tx.execute(
        "DELETE FROM exit_marks WHERE session_id = ?1 AND spool = ?2
           AND (dev <> ?3 OR ino <> ?4 OR offset <= ?5)",
        params![
            session_id,
            spool.name(),
            cursor.dev,
            cursor.ino,
            cursor.offset
        ],
    )?;
    Ok(())
}

fn ensure_session(tx: &rusqlite::Transaction<'_>, session_id: &str) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO sessions (id, last_ms) VALUES (?1, 0) ON CONFLICT(id) DO NOTHING",
        [session_id],
    )?;
    Ok(())
}

fn apply(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    entry: &LogEntry,
) -> rusqlite::Result<()> {
    match entry {
        LogEntry::Prompt {
            prompt_id,
            claude_session_id,
            text,
            source,
            at_ms,
        } => {
            if prompt_id.is_some() {
                tx.execute(
                    "INSERT INTO turns (session_id, prompt_id, claude_session_id, prompt, source, started_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(session_id, prompt_id) DO UPDATE SET
                       prompt = ?4, source = ?5, claude_session_id = ?3,
                       started_ms = MIN(started_ms, ?6)",
                    params![session_id, prompt_id, claude_session_id, text, source, at_ms],
                )?;
            } else {
                tx.execute(
                    "INSERT INTO turns (session_id, claude_session_id, prompt, source, started_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![session_id, claude_session_id, text, source, at_ms],
                )?;
            }
        }
        LogEntry::TurnEnd {
            prompt_id,
            reason,
            at_ms,
            ..
        } => {
            let turn = match prompt_id {
                Some(_) => turn_for(tx, session_id, prompt_id.as_deref(), *at_ms)?,
                None => latest_turn(tx, session_id)?,
            };
            if let Some(turn) = turn {
                tx.execute(
                    "UPDATE turns SET
                       ended_ms = CASE WHEN ended_ms IS NULL OR end_reason = ?4 THEN ?2
                                       ELSE MAX(ended_ms, ?2) END,
                       end_reason = ?3
                     WHERE id = ?1",
                    params![turn, at_ms, reason, SESSION_ENDED],
                )?;
            }
        }
        LogEntry::Asked {
            tool_name,
            claude_session_id,
            ..
        } => {
            tx.execute(
                "UPDATE steps SET asked = 1 WHERE id = (
                   SELECT id FROM steps WHERE session_id = ?1 AND tool_name = ?2 AND status = 'running'
                     AND (?3 IS NULL OR claude_session_id = ?3)
                   ORDER BY started_ms DESC, id DESC LIMIT 1)",
                params![session_id, tool_name, claude_session_id],
            )?;
        }
        LogEntry::Step(step) => upsert_step(tx, session_id, step)?,
        LogEntry::SessionEnded {
            claude_session_id: Some(claude),
            at_ms,
        } => {
            tx.execute(
                "UPDATE steps SET status = 'error', ended_ms = ?3, result = COALESCE(result, ?4)
                 WHERE session_id = ?1 AND claude_session_id = ?2 AND status = 'running'",
                params![session_id, claude, at_ms, DID_NOT_FINISH],
            )?;
            tx.execute(
                "UPDATE turns SET ended_ms = COALESCE(ended_ms, ?3),
                   end_reason = COALESCE(end_reason, 'session ended')
                 WHERE session_id = ?1 AND claude_session_id = ?2",
                params![session_id, claude, at_ms],
            )?;
        }
        // Without its conversation an end can't be scoped: close nothing.
        LogEntry::SessionEnded { .. } => {}
    }
    Ok(())
}

fn upsert_step(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    step: &StepUpdate,
) -> rusqlite::Result<()> {
    let turn = match step.prompt_id {
        Some(_) => turn_for(tx, session_id, step.prompt_id.as_deref(), step.at_ms)?,
        None => latest_turn(tx, session_id)?,
    };
    // A finished step with no start seen (an end that raced ahead, or a spool
    // read mid-turn) still knows when it started from its duration.
    let (started, ended) = if step.status == StepStatus::Running {
        (step.at_ms, None)
    } else {
        (step.at_ms - step.duration_ms.unwrap_or(0), Some(step.at_ms))
    };
    tx.execute(
        "INSERT INTO steps (session_id, turn_id, tool_use_id, agent_id, agent_type, tool_name, kind,
                            target, input, result, status, flags, permission_mode, started_ms,
                            ended_ms, duration_ms, claude_session_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
         ON CONFLICT(session_id, tool_use_id) DO UPDATE SET
           claude_session_id = COALESCE(claude_session_id, excluded.claude_session_id),
           turn_id = COALESCE(turn_id, excluded.turn_id),
           agent_id = COALESCE(agent_id, excluded.agent_id),
           agent_type = COALESCE(agent_type, excluded.agent_type),
           target = COALESCE(target, excluded.target),
           input = COALESCE(input, excluded.input),
           result = CASE WHEN excluded.status <> 'running' AND result = 'Did not finish: the session ended'
                         THEN excluded.result
                         ELSE COALESCE(excluded.result, result) END,
           status = CASE WHEN excluded.status = 'running' THEN status ELSE excluded.status END,
           flags = flags | excluded.flags,
           permission_mode = COALESCE(permission_mode, excluded.permission_mode),
           started_ms = MIN(started_ms, excluded.started_ms),
           ended_ms = COALESCE(excluded.ended_ms, ended_ms),
           duration_ms = COALESCE(excluded.duration_ms, duration_ms)",
        params![
            session_id,
            turn,
            step.tool_use_id,
            step.agent_id,
            step.agent_type,
            step.tool_name,
            step.kind.as_str(),
            step.target,
            step.input,
            step.result,
            step.status.as_str(),
            step.flags,
            step.permission_mode,
            started,
            ended,
            step.duration_ms,
            step.claude_session_id,
        ],
    )?;
    Ok(())
}

/// The turn for `prompt_id`, opened here when its prompt line wasn't seen (a
/// spool read from mid-turn).
fn turn_for(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    prompt_id: Option<&str>,
    at_ms: i64,
) -> rusqlite::Result<Option<i64>> {
    tx.execute(
        "INSERT INTO turns (session_id, prompt_id, started_ms) VALUES (?1, ?2, ?3)
         ON CONFLICT(session_id, prompt_id) DO NOTHING",
        params![session_id, prompt_id, at_ms],
    )?;
    tx.query_row(
        "SELECT id FROM turns WHERE session_id = ?1 AND prompt_id = ?2",
        params![session_id, prompt_id],
        |r| r.get(0),
    )
    .optional()
}

fn latest_turn(tx: &rusqlite::Transaction<'_>, session_id: &str) -> rusqlite::Result<Option<i64>> {
    tx.query_row(
        "SELECT id FROM turns WHERE session_id = ?1 ORDER BY started_ms DESC, id DESC LIMIT 1",
        [session_id],
        |r| r.get(0),
    )
    .optional()
}

/// Read `session_id`'s spool at `path` from where ingest stopped and apply
/// what is new. Only whole lines are taken; a torn last line waits for the
/// next pass. The saved position means each line is applied once. A spool
/// replaced or cut short is a new file, read from its start; its steps and
/// turns still merge by id with what came before. Returns whether anything
/// new was read.
///
/// # Errors
/// On a read or database error. A missing spool is not an error.
pub fn ingest_spool(
    store: &mut ActivityStore,
    spool: Spool,
    session_id: &str,
    path: &Path,
) -> Result<bool, ActivityError> {
    use std::io::{Read as _, Seek as _, SeekFrom};
    use std::os::unix::fs::MetadataExt as _;

    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.into()),
    };
    let meta = file.metadata()?;
    let (dev, ino, len) = (
        i64::try_from(meta.dev()).unwrap_or(0),
        i64::try_from(meta.ino()).unwrap_or(0),
        i64::try_from(meta.len()).unwrap_or(i64::MAX),
    );
    let start = match store.cursor(spool, session_id)? {
        Some(c) if c.dev == dev && c.ino == ino && c.offset <= len => c.offset,
        _ => 0,
    };
    if start >= len {
        return Ok(false);
    }
    file.seek(SeekFrom::Start(u64::try_from(start).unwrap_or(0)))?;
    let mut buf = Vec::new();
    file.take(MAX_READ_BYTES).read_to_end(&mut buf)?;
    let Some(last_newline) = buf.iter().rposition(|b| *b == b'\n') else {
        // One line longer than a whole read is never going to finish: skip it.
        if buf.len() as u64 == MAX_READ_BYTES {
            let offset = start + i64::try_from(buf.len()).unwrap_or(0);
            apply_lines(
                store,
                spool,
                session_id,
                &[],
                SpoolCursor { dev, ino, offset },
                0,
            )?;
        }
        return Ok(false);
    };
    let whole = &buf[..=last_newline];
    let text = String::from_utf8_lossy(whole);
    let lines: Vec<&str> = text.lines().collect();
    let offset = start + i64::try_from(whole.len()).unwrap_or(0);
    // How many of these lines were written before the terminal died.
    let before_exit = match store.exit_mark(spool, session_id)? {
        Some((mark, _)) if mark.dev == dev && mark.ino == ino => {
            let mut end = start;
            whole
                .split_inclusive(|b| *b == b'\n')
                .take_while(|l| {
                    end += i64::try_from(l.len()).unwrap_or(0);
                    end <= mark.offset
                })
                .count()
        }
        _ => 0,
    };
    apply_lines(
        store,
        spool,
        session_id,
        &lines,
        SpoolCursor { dev, ino, offset },
        before_exit,
    )?;
    Ok(true)
}

fn apply_lines(
    store: &mut ActivityStore,
    spool: Spool,
    session_id: &str,
    lines: &[&str],
    cursor: SpoolCursor,
    before_exit: usize,
) -> Result<(), ActivityError> {
    match spool {
        Spool::Hook => store.ingest(session_id, lines, cursor, before_exit),
        Spool::Bridge => store.ingest_bridge(session_id, lines, cursor, before_exit),
    }
}

/// Where `path` ends right now (device, inode, length): an exit mark.
#[must_use]
pub fn spool_mark(path: &Path) -> Option<SpoolCursor> {
    use std::os::unix::fs::MetadataExt as _;
    let meta = std::fs::metadata(path).ok()?;
    Some(SpoolCursor {
        dev: i64::try_from(meta.dev()).ok()?,
        ino: i64::try_from(meta.ino()).ok()?,
        offset: i64::try_from(meta.len()).ok()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use kriyon_core::activity_log::flags;

    const CUR: SpoolCursor = SpoolCursor {
        dev: 1,
        ino: 1,
        offset: 0,
    };

    fn line(json: &serde_json::Value) -> String {
        json.to_string()
    }

    fn at(secs: u32) -> String {
        format!("1970-01-01T00:00:{secs:02}Z")
    }

    fn prompt(id: &str, text: &str, secs: u32) -> String {
        line(
            &serde_json::json!({"event":"UserPromptSubmit","prompt_id":id,"prompt":text,"ts":at(secs)}),
        )
    }

    fn tool(event: &str, id: &str, tool: &str, secs: u32) -> String {
        line(&serde_json::json!({
            "event": event, "tool_name": tool, "tool_use_id": id, "prompt_id": "p1",
            "command": "pnpm add zod", "target": "pnpm add zod", "result": "added 1",
            "duration_ms": 1000, "permission_mode": "default", "session_id": "main",
            "ts": at(secs),
        }))
    }

    fn ingest(store: &mut ActivityStore, lines: &[String]) {
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        store.ingest("s1", &refs, CUR, 0).expect("ingests");
    }

    #[test]
    fn a_prompt_and_its_tool_calls_become_one_turn_of_steps() {
        let mut store = ActivityStore::open_in_memory().expect("opens");
        ingest(
            &mut store,
            &[
                prompt("p1", "add zod", 1),
                tool("PreToolUse", "t1", "Bash", 2),
                tool("PostToolUse", "t1", "Bash", 3),
                line(&serde_json::json!({"event":"Stop","prompt_id":"p1","ts":at(4)})),
            ],
        );

        let turns = store.turns("s1", 10).expect("reads");
        assert_eq!(turns.len(), 1);
        let turn = &turns[0];
        assert_eq!(turn.prompt.as_deref(), Some("add zod"));
        assert_eq!((turn.started_ms, turn.ended_ms), (1000, Some(4000)));
        assert_eq!(turn.end_reason.as_deref(), Some("stop"));
        let step = &turn.steps[0];
        assert_eq!(step.status, StepStatus::Ok);
        assert_eq!(step.kind, StepKind::Command);
        assert_ne!(step.flags & flags::INSTALLED, 0);
        assert_eq!((step.started_ms, step.duration_ms), (2000, Some(1000)));
    }

    #[test]
    fn an_end_that_lands_before_its_start_still_reads_finished() {
        // The spool is in completion order: parallel hooks race.
        let mut store = ActivityStore::open_in_memory().expect("opens");
        ingest(
            &mut store,
            &[
                tool("PostToolUse", "t1", "Bash", 3),
                tool("PreToolUse", "t1", "Bash", 2),
            ],
        );
        let steps = &store.turns("s1", 10).expect("reads")[0].steps;
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].status, StepStatus::Ok);
        assert_eq!(steps[0].started_ms, 2000);
    }

    #[test]
    fn ingesting_the_same_lines_twice_doubles_nothing() {
        let mut store = ActivityStore::open_in_memory().expect("opens");
        let lines = [prompt("p1", "x", 1), tool("PostToolUse", "t1", "Bash", 3)];
        ingest(&mut store, &lines);
        ingest(&mut store, &lines);
        let turns = store.turns("s1", 10).expect("reads");
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].steps.len(), 1);
    }

    #[test]
    fn a_step_still_running_when_the_session_ends_is_closed() {
        let mut store = ActivityStore::open_in_memory().expect("opens");
        ingest(
            &mut store,
            &[
                tool("PreToolUse", "t1", "Bash", 2),
                line(&serde_json::json!({"event":"SessionEnd","session_id":"main","ts":at(5)})),
            ],
        );
        let step = &store.turns("s1", 10).expect("reads")[0].steps[0];
        assert_eq!(step.status, StepStatus::Error, "never left running");
        let detail = store.step("s1", step.id).expect("reads").expect("a step");
        // The test helper gives every line a result; a real start has none,
        // and then the step reads "Did not finish: the session ended".
        assert_eq!(detail.ended_ms, Some(5000));
    }

    #[test]
    fn a_nested_claude_ending_leaves_the_parents_running_steps_alone() {
        let mut store = ActivityStore::open_in_memory().expect("opens");
        let pre = |id: &str, claude: &str| {
            line(
                &serde_json::json!({"event":"PreToolUse","tool_name":"Bash","tool_use_id":id,
                "prompt_id":"p1","session_id":claude,"ts":at(2)}),
            )
        };
        ingest(
            &mut store,
            &[
                pre("parent", "main"),
                pre("child", "nested"),
                line(&serde_json::json!({"event":"SessionEnd","session_id":"nested","ts":at(5)})),
            ],
        );
        let steps = &store.turns("s1", 10).expect("reads")[0].steps;
        let status = |id: i64| steps.iter().find(|s| s.id == id).map(|s| s.status);
        assert_eq!(
            status(steps[0].id),
            Some(StepStatus::Running),
            "the parent's step runs on"
        );
        assert_eq!(
            status(steps[1].id),
            Some(StepStatus::Error),
            "the nested one ended"
        );
    }

    #[test]
    fn a_dead_terminal_closes_whatever_was_still_open() {
        let mut store = ActivityStore::open_in_memory().expect("opens");
        ingest(
            &mut store,
            &[prompt("p1", "x", 1), tool("PreToolUse", "t1", "Bash", 2)],
        );
        bridge(
            &mut store,
            &[serde_json::json!({"kind":"hello","run":"r1","seq":1,"sessionId":"main"})],
        );
        store.close_open("s1", 9000, &[]).expect("closes");
        assert!(
            !store
                .companion("s1", None)
                .expect("reads")
                .expect("facts")
                .live,
            "a dead terminal's companion is not on"
        );
        let turn = &store.turns("s1", 10).expect("reads")[0];
        assert_eq!(turn.ended_ms, Some(9000));
        assert_eq!(turn.steps[0].status, StepStatus::Error);
    }

    #[test]
    fn a_permission_request_marks_a_step_of_its_own_conversation() {
        let mut store = ActivityStore::open_in_memory().expect("opens");
        let pre = |id: &str, claude: &str, secs: u32| {
            line(
                &serde_json::json!({"event":"PreToolUse","tool_name":"Bash","tool_use_id":id,
                "prompt_id":"p1","session_id":claude,"ts":at(secs)}),
            )
        };
        ingest(
            &mut store,
            &[
                pre("main-step", "main", 2),
                // A nested run's later Bash call is the newest running Bash.
                pre("nested-step", "nested", 3),
                line(
                    &serde_json::json!({"event":"PermissionRequest","tool_name":"Bash",
                    "session_id":"main","ts":at(4)}),
                ),
            ],
        );
        let asked: i64 = store
            .conn
            .query_row(
                "SELECT asked FROM steps WHERE tool_use_id = 'main-step'",
                [],
                |r| r.get(0),
            )
            .expect("reads");
        assert_eq!(
            asked, 1,
            "the dialog belongs to the main conversation's call"
        );
    }

    #[test]
    fn a_permission_request_marks_the_step_as_approved_by_the_user() {
        let mut store = ActivityStore::open_in_memory().expect("opens");
        ingest(
            &mut store,
            &[
                tool("PreToolUse", "t1", "Bash", 2),
                line(
                    &serde_json::json!({"event":"PermissionRequest","tool_name":"Bash","ts":at(2)}),
                ),
                tool("PostToolUse", "t1", "Bash", 3),
            ],
        );
        let id = store.turns("s1", 10).expect("reads")[0].steps[0].id;
        let detail = store.step("s1", id).expect("reads").expect("a step");
        assert_eq!(detail.allowed_by, "You approved it in the terminal");
        assert_eq!(detail.result.as_deref(), Some("added 1"));
        assert_eq!(
            store.step("other", id).expect("reads"),
            None,
            "another session's step"
        );
    }

    #[test]
    fn seed_lines_keep_only_the_recent_tail_redacted() {
        let mut store = ActivityStore::open_in_memory().expect("opens");
        let lines: Vec<String> = (0..700)
            .map(|i| {
                line(
                    &serde_json::json!({"event":"Notification","message":format!("m{i} token=abc")}),
                )
            })
            .collect();
        ingest(&mut store, &lines);
        let kept = store.seed_lines("s1").expect("reads");
        assert_eq!(kept.len(), 600);
        assert!(kept[0].contains("m100 token=[REDACTED]"));
        assert!(kept[599].contains("m699"));
    }

    #[test]
    fn prune_drops_old_and_oversized_sessions_but_never_a_live_one() {
        let mut store = ActivityStore::open_in_memory().expect("opens");
        for (id, secs) in [("old", 1), ("live", 2), ("new", 50)] {
            let refs = [prompt("p", "x", secs)];
            let refs: Vec<&str> = refs.iter().map(String::as_str).collect();
            store.ingest(id, &refs, CUR, 0).expect("ingests");
        }
        let dropped = store
            .prune(10_000, i64::MAX, &|id| id == "live")
            .expect("prunes");
        assert_eq!(dropped, ["old"]);

        let dropped = store.prune(0, 0, &|id| id == "live").expect("prunes");
        assert_eq!(dropped, ["new"], "over the cap: oldest first, live kept");
        assert_eq!(store.session_ids().expect("reads"), ["live"]);
    }

    #[test]
    fn delete_session_and_delete_all_forget_activity() {
        let mut store = ActivityStore::open_in_memory().expect("opens");
        ingest(
            &mut store,
            &[prompt("p1", "x", 1), tool("PostToolUse", "t1", "Bash", 2)],
        );
        store.delete_session("s1").expect("deletes");
        assert_eq!(store.turns("s1", 10).expect("reads"), []);
        assert!(
            store.cursor(Spool::Hook, "s1").expect("reads").is_some(),
            "the cursor stays"
        );

        ingest(&mut store, &[prompt("p2", "y", 3)]);
        store.delete_all().expect("deletes");
        assert_eq!(store.session_ids().expect("reads"), Vec::<String>::new());
    }

    #[test]
    fn ingest_spool_takes_whole_lines_and_resumes_where_it_stopped() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("s1.jsonl");
        let mut store = ActivityStore::open_in_memory().expect("opens");
        let first = format!(
            "{}\n{}",
            prompt("p1", "x", 1),
            &tool("PreToolUse", "t1", "Bash", 2)[..20]
        );
        std::fs::write(&path, &first).expect("writes");

        assert!(ingest_spool(&mut store, Spool::Hook, "s1", &path).expect("ingests"));
        assert_eq!(
            store.turns("s1", 10).expect("reads")[0].steps.len(),
            0,
            "torn line waits"
        );

        let whole = format!(
            "{}\n{}\n",
            prompt("p1", "x", 1),
            tool("PreToolUse", "t1", "Bash", 2)
        );
        std::fs::write(&path, whole).expect("rewrites");
        assert!(ingest_spool(&mut store, Spool::Hook, "s1", &path).expect("ingests"));
        assert_eq!(store.turns("s1", 10).expect("reads")[0].steps.len(), 1);
        assert!(
            !ingest_spool(&mut store, Spool::Hook, "s1", &path).expect("ingests"),
            "nothing new"
        );
        assert_eq!(
            store.seed_lines("s1").expect("reads").len(),
            2,
            "each line kept once"
        );
        assert!(
            !ingest_spool(&mut store, Spool::Hook, "s1", &tmp.path().join("gone")).expect("fine")
        );
    }

    #[test]
    fn a_spool_cut_short_is_read_again_from_the_start() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("s1.jsonl");
        let mut store = ActivityStore::open_in_memory().expect("opens");
        std::fs::write(
            &path,
            format!("{}\n{}\n", prompt("p1", "x", 1), prompt("p2", "y", 2)),
        )
        .expect("writes");
        ingest_spool(&mut store, Spool::Hook, "s1", &path).expect("ingests");
        std::fs::write(&path, format!("{}\n", prompt("p3", "z", 3))).expect("rewrites");
        ingest_spool(&mut store, Spool::Hook, "s1", &path).expect("ingests");
        assert_eq!(store.turns("s1", 10).expect("reads").len(), 3);
    }

    fn bridge(store: &mut ActivityStore, lines: &[serde_json::Value]) {
        let owned: Vec<String> = lines.iter().map(ToString::to_string).collect();
        let refs: Vec<&str> = owned.iter().map(String::as_str).collect();
        store.ingest_bridge("s1", &refs, CUR, 0).expect("ingests");
    }

    #[test]
    fn the_companion_is_live_until_its_newest_run_ends_whatever_the_arrival_order() {
        let mut store = ActivityStore::open_in_memory().expect("opens");
        assert_eq!(
            store.companion("s1", None).expect("reads"),
            None,
            "never posted"
        );
        bridge(
            &mut store,
            &[
                serde_json::json!({"kind":"hello","run":"r1","seq":1,"sessionId":"main","version":"2.1.288"}),
                serde_json::json!({"kind":"end","run":"r1","seq":3,"sessionId":"main"}),
                // Fire-and-forget posts can land after the end.
                serde_json::json!({"kind":"row","run":"r1","seq":2,"sessionId":"main","uuid":"u"}),
            ],
        );
        let facts = store
            .companion("s1", Some("main"))
            .expect("reads")
            .expect("facts");
        assert!(!facts.live, "a late row doesn't revive an ended run");
        assert_eq!(facts.claude_version.as_deref(), Some("2.1.288"));

        bridge(
            &mut store,
            &[
                serde_json::json!({"kind":"hello","run":"r2","seq":1,"sessionId":"main"}),
                serde_json::json!({"kind":"hello","run":"n1","seq":1,"sessionId":"nested"}),
                serde_json::json!({"kind":"end","run":"n1","seq":2,"sessionId":"nested"}),
            ],
        );
        assert!(
            store
                .companion("s1", Some("main"))
                .expect("reads")
                .expect("facts")
                .live,
            "a nested claude ending doesn't end the main one"
        );
    }

    #[test]
    fn after_a_clear_the_same_run_speaks_for_the_new_conversation() {
        // `/clear` ends a conversation without unloading the mod: the same run
        // posts on, for a new conversation.
        let mut store = ActivityStore::open_in_memory().expect("opens");
        bridge(
            &mut store,
            &[
                serde_json::json!({"kind":"hello","run":"r1","seq":1,"sessionId":"old"}),
                serde_json::json!({"kind":"end","run":"r1","seq":2,"sessionId":"old"}),
                serde_json::json!({"kind":"row","run":"r1","seq":3,"sessionId":"new","uuid":"u"}),
            ],
        );
        assert!(
            store
                .companion("s1", Some("new"))
                .expect("reads")
                .expect("facts")
                .live
        );
    }

    #[test]
    fn bridge_posts_keep_a_session_recent() {
        let mut store = ActivityStore::open_in_memory().expect("opens");
        bridge(
            &mut store,
            &[serde_json::json!({"kind":"hello","run":"r1","seq":1,"receivedMs":50_000})],
        );
        let dropped = store.prune(10_000, i64::MAX, &|_| false).expect("prunes");
        assert!(dropped.is_empty(), "posted after the cutoff: kept");
    }

    #[test]
    fn migrating_a_v1_database_backfills_each_steps_conversation() {
        let conn = Connection::open_in_memory().expect("opens");
        conn.execute_batch(&format!("{SCHEMA_V1} PRAGMA user_version = 1;"))
            .expect("v1");
        conn.execute_batch(
            "INSERT INTO sessions VALUES ('s1', 1);
             INSERT INTO turns (id, session_id, prompt_id, claude_session_id, started_ms)
               VALUES (1, 's1', 'p1', 'main', 1);
             INSERT INTO steps (session_id, turn_id, tool_use_id, tool_name, kind, status, started_ms)
               VALUES ('s1', 1, 't1', 'Bash', 'command', 'running', 2);",
        )
        .expect("rows");
        let mut store = ActivityStore::init(conn).expect("migrates");
        ingest(
            &mut store,
            &[line(
                &serde_json::json!({"event":"SessionEnd","session_id":"main","ts":at(5)}),
            )],
        );
        assert_eq!(
            store.turns("s1", 10).expect("reads")[0].steps[0].status,
            StepStatus::Error,
            "a pre-upgrade step is closed by its conversation's end"
        );
    }

    #[test]
    fn a_late_post_of_an_older_conversation_never_takes_the_run_back() {
        let mut store = ActivityStore::open_in_memory().expect("opens");
        bridge(
            &mut store,
            &[
                serde_json::json!({"kind":"end","run":"r1","seq":2,"sessionId":"old"}),
                serde_json::json!({"kind":"row","run":"r1","seq":3,"sessionId":"new","uuid":"a"}),
                serde_json::json!({"kind":"end","run":"r1","seq":4,"sessionId":"new"}),
                // Posted before the clear, delivered last.
                serde_json::json!({"kind":"row","run":"r1","seq":1,"sessionId":"old","uuid":"b"}),
            ],
        );
        assert!(
            !store
                .companion("s1", Some("new"))
                .expect("reads")
                .expect("facts")
                .live
        );
        assert_eq!(
            store.companion("s1", Some("old")).expect("reads"),
            None,
            "not taken back"
        );
    }

    fn append(path: &Path, lines: &[String]) {
        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
            .expect("opens");
        for l in lines {
            writeln!(f, "{l}").expect("writes");
        }
    }

    #[test]
    fn lines_written_before_an_exit_are_closed_whatever_their_clock_says() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("s1.jsonl");
        let mut store = ActivityStore::open_in_memory().expect("opens");
        // Written before the terminal died, stamped after it (a clock that
        // stepped back), and read only after the exit.
        append(
            &path,
            &[prompt("p1", "x", 1), tool("PreToolUse", "t1", "Bash", 10)],
        );
        let mark = spool_mark(&path).expect("a mark");
        store
            .close_open("s1", 9000, &[(Spool::Hook, mark)])
            .expect("closes");
        ingest_spool(&mut store, Spool::Hook, "s1", &path).expect("ingests");
        let step = &store.turns("s1", 10).expect("reads")[0].steps[0];
        assert_eq!(step.status, StepStatus::Error, "not running after its exit");

        // A resume writes after the mark: it runs afresh.
        append(&path, &[tool("PreToolUse", "t2", "Bash", 20)]);
        ingest_spool(&mut store, Spool::Hook, "s1", &path).expect("ingests");
        let steps = &store.turns("s1", 10).expect("reads")[0].steps;
        let t2 = steps.iter().find(|s| s.started_ms == 20_000).expect("t2");
        assert_eq!(t2.status, StepStatus::Running);
    }

    #[test]
    fn a_real_end_read_after_an_exit_replaces_the_exits_placeholder() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("s1.jsonl");
        let mut store = ActivityStore::open_in_memory().expect("opens");
        append(
            &path,
            &[
                prompt("p1", "x", 1),
                line(
                    &serde_json::json!({"event":"PreToolUse","tool_name":"Agent","tool_use_id":"t1",
                    "prompt_id":"p1","session_id":"main","ts":at(2)}),
                ),
            ],
        );
        ingest_spool(&mut store, Spool::Hook, "s1", &path).expect("ingests");
        // The turn finished and the agent succeeded, but those lines weren't
        // read before the terminal died.
        append(
            &path,
            &[
                line(
                    &serde_json::json!({"event":"PostToolUse","tool_name":"Agent","tool_use_id":"t1",
                    "prompt_id":"p1","session_id":"main","duration_ms":1000,"ts":at(3)}),
                ),
                line(
                    &serde_json::json!({"event":"Stop","prompt_id":"p1","session_id":"main","ts":at(8)}),
                ),
            ],
        );
        let mark = spool_mark(&path).expect("a mark");
        store
            .close_open("s1", 9000, &[(Spool::Hook, mark)])
            .expect("closes");
        ingest_spool(&mut store, Spool::Hook, "s1", &path).expect("ingests");
        let turn = &store.turns("s1", 10).expect("reads")[0];
        assert_eq!(turn.ended_ms, Some(8000), "the real end, not the exit");
        assert_eq!(turn.end_reason.as_deref(), Some("stop"));
        let step = &turn.steps[0];
        assert_eq!(step.status, StepStatus::Ok);
        let detail = store.step("s1", step.id).expect("reads").expect("a step");
        assert_eq!(detail.result, None, "no leftover \"did not finish\"");
    }

    #[test]
    fn a_database_already_at_v4_gets_the_exit_marks_table() {
        let conn = Connection::open_in_memory().expect("opens");
        conn.execute_batch(&format!("{SCHEMA_V1} PRAGMA user_version = 4;"))
            .expect("an early v4");
        conn.execute_batch(
            "CREATE TABLE companion_runs (session_id TEXT, run TEXT, conversation TEXT,
               version TEXT, ended INTEGER NOT NULL DEFAULT 0, last_seq INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY (session_id, run));",
        )
        .expect("runs");
        let store = ActivityStore::init(conn).expect("migrates");
        assert!(
            store.exit_mark(Spool::Hook, "s1").is_ok(),
            "the table exists"
        );
    }

    #[test]
    fn a_prompt_without_an_id_written_before_an_exit_is_closed_too() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("s1.jsonl");
        let mut store = ActivityStore::open_in_memory().expect("opens");
        append(
            &path,
            &[line(
                &serde_json::json!({"event":"UserPromptSubmit","prompt":"x","ts":at(1)}),
            )],
        );
        let mark = spool_mark(&path).expect("a mark");
        store
            .close_open("s1", 9000, &[(Spool::Hook, mark)])
            .expect("closes");
        ingest_spool(&mut store, Spool::Hook, "s1", &path).expect("ingests");
        assert_eq!(
            store.turns("s1", 10).expect("reads")[0].ended_ms,
            Some(9000)
        );
    }

    #[test]
    fn rows_come_back_in_run_then_number_order_and_checks_join_their_step() {
        let mut store = ActivityStore::open_in_memory().expect("opens");
        bridge(
            &mut store,
            &[
                serde_json::json!({"kind":"row","run":"r1","seq":2,"uuid":"b"}),
                serde_json::json!({"kind":"row","run":"r1","seq":1,"uuid":"a"}),
                serde_json::json!({"kind":"row","run":"r2","seq":1,"uuid":"c"}),
                serde_json::json!({"kind":"check","toolUseId":"t1","decision":"allow","rule":"Bash(pnpm *)"}),
            ],
        );
        let uuids: Vec<String> = store
            .bridge_rows("s1")
            .expect("reads")
            .iter()
            .map(|l| {
                serde_json::from_str::<serde_json::Value>(l).expect("JSON")["uuid"].to_string()
            })
            .collect();
        assert_eq!(uuids, [r#""a""#, r#""b""#, r#""c""#]);

        // The hook side of the same call, ingested after the check.
        ingest(&mut store, &[tool("PostToolUse", "t1", "Bash", 3)]);
        let id = store.turns("s1", 10).expect("reads")[0].steps[0].id;
        let detail = store.step("s1", id).expect("reads").expect("a step");
        assert_eq!(detail.allowed_by, "Allowed by your rule Bash(pnpm *)");
    }

    #[test]
    fn open_creates_the_schema_once_on_disk() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("activity.db");
        drop(ActivityStore::open(&path).expect("creates"));
        let store = ActivityStore::open(&path).expect("reopens");
        let mode: String = store
            .conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .expect("reads");
        assert_eq!(mode, "wal");
        let vacuum: i64 = store
            .conn
            .query_row("PRAGMA auto_vacuum", [], |r| r.get(0))
            .expect("reads");
        assert_eq!(vacuum, 2, "incremental");
    }
}
