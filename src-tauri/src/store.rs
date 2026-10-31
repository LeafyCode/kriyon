//! SQLite-backed persistence for projects, sessions, and UI layout state.
//!
//! The [`Store`] wraps a single [`rusqlite::Connection`] and exposes typed
//! upsert/list/load helpers. Schema is created idempotently on open.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json;

/// Errors returned by [`Store`] operations.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

/// A persisted project: a named workspace rooted at a filesystem path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    pub path: String,
    pub color: Option<String>,
    /// The project's optional per-worktree [Setup command], run at the end of a
    /// [Worktree bootstrap]. `None` = no custom step.
    pub setup_command: Option<String>,
}

/// A persisted session belonging to a project.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub cwd: String,
    pub worktree_path: Option<String>,
    pub created_at: i64,
    /// Claude Code's own session id, learned from hook events and persisted so
    /// the session can be resumed (`claude --resume`) on a later launch. `None`
    /// until Claude has reported it.
    pub claude_session_id: Option<String>,
    /// When the session was archived (ms since epoch), or `None` while active.
    /// A soft flag: the transcript and worktree are untouched.
    pub archived_at: Option<i64>,
    /// The git oid captured at session start (see `capture_baseline`), used as
    /// the base of the working-tree diff for the Changes view. `None` until a
    /// baseline has been captured, or when the session's cwd is not a git repo.
    pub baseline_oid: Option<String>,
    /// The user renamed this session's title by hand. Once set, Claude's own
    /// `ai-title` updates must not overwrite it — a manual name wins for the
    /// session's life. `#[serde(default)]` keeps an older frontend payload (one
    /// without the field) deserializing to unlocked instead of erroring.
    #[serde(default)]
    pub title_locked: bool,
    /// The [Handoff link]: the session this [Follow-up session] was spawned
    /// from, or `None` for an ordinary session. Display only.
    #[serde(default)]
    pub parent_session_id: Option<String>,
    /// The session this [Nested session] was started from (ADR-0049), or
    /// `None` for a top-level one. Nests the row under it in the sidebar.
    #[serde(default)]
    pub nested_under: Option<String>,
    /// When the session was parked (ms since epoch), or `None`. A parked
    /// session is stopped and kept off the rail until it is opened again
    /// (ADR-0052).
    #[serde(default)]
    pub parked_at: Option<i64>,
}

impl SessionRow {
    /// Whether the session is put away — an [Archived session] or a parked
    /// one. Both are stopped, so neither is live.
    #[must_use]
    pub fn is_put_away(&self) -> bool {
        self.archived_at.is_some() || self.parked_at.is_some()
    }
}

/// A [Session]'s display identity: the fields a notification, sidebar row, or
/// [Session standing] shows to name it — the project's display name, the session
/// title, and the branch. A pure join of a [`SessionRow`] with its [`ProjectRow`].
pub struct SessionIdentity {
    /// The project's display name, falling back to the raw `project_id` when the
    /// project row is missing (an orphaned session).
    pub project: String,
    /// The session title.
    pub title: String,
    /// The branch, derived from the worktree path's basename, or `None` when the
    /// session runs in the project root (no worktree).
    pub branch: Option<String>,
}

impl SessionIdentity {
    /// Build an identity from a session row and its (optional) project row. The
    /// single home for the project-name fallback and the branch-from-worktree
    /// derivation, shared by the pure batch join ([`session_identity`]) and the
    /// Store's single-row [`Store::session_identity`], so the two can't drift.
    #[must_use]
    pub fn from_rows(session: &SessionRow, project: Option<&ProjectRow>) -> Self {
        let project = project.map_or_else(|| session.project_id.clone(), |row| row.name.clone());
        let branch = session.worktree_path.as_deref().and_then(|w| {
            w.rsplit('/')
                .find(|seg| !seg.is_empty())
                .map(str::to_string)
        });
        Self {
            project,
            title: session.title.clone(),
            branch,
        }
    }
}

/// Resolve a [`SessionIdentity`] from already-loaded rows. Returns `None` when
/// no session row matches `id`, so each caller supplies its own
/// missing-session fallback (a notification shows the id; a snapshot titles the
/// row with it). Pure — no IO, no locks — so it is unit-tested without Tauri.
/// For a single session, prefer [`Store::session_identity`], which does two
/// indexed lookups instead of scanning every row.
#[must_use]
pub fn session_identity(
    sessions: &[SessionRow],
    projects: &[ProjectRow],
    id: &str,
) -> Option<SessionIdentity> {
    let session = sessions.iter().find(|r| r.id == id)?;
    let project = projects.iter().find(|p| p.id == session.project_id);
    Some(SessionIdentity::from_rows(session, project))
}

/// A [Saved prompt]: one reusable prompt in the user's global prompt library.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRow {
    pub id: String,
    pub title: String,
    pub body: String,
    /// Free-form tags. Stored as a JSON array in `tags_json`.
    pub tags: Vec<String>,
    pub favourite: bool,
    pub use_count: i64,
    pub last_used_ms: Option<i64>,
    pub created_ms: i64,
    pub updated_ms: i64,
}

/// SQLite-backed persistence wrapping a single [`Connection`].
pub struct Store {
    conn: Connection,
}

impl Store {
    /// Open a store at `path`, creating/migrating the schema.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the database cannot be opened or the
    /// schema cannot be created.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let conn = Connection::open(path)?;
        Self::from_connection(conn)
    }

    /// Open an in-memory store, primarily for tests.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the database cannot be opened or the
    /// schema cannot be created.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory()?;
        Self::from_connection(conn)
    }

    fn from_connection(conn: Connection) -> Result<Self, StoreError> {
        let store = Self { conn };
        store.init_schema()?;
        Ok(store)
    }

    fn init_schema(&self) -> Result<(), StoreError> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS projects (
                 id            TEXT PRIMARY KEY,
                 name          TEXT NOT NULL,
                 path          TEXT NOT NULL,
                 color         TEXT,
                 setup_command TEXT
             );
             CREATE TABLE IF NOT EXISTS sessions (
                 id                TEXT PRIMARY KEY,
                 project_id        TEXT NOT NULL,
                 title             TEXT NOT NULL,
                 cwd               TEXT NOT NULL,
                 worktree_path     TEXT,
                 created_at        INTEGER NOT NULL,
                 claude_session_id TEXT,
                 archived_at       INTEGER,
                 baseline_oid      TEXT,
                 title_locked      INTEGER NOT NULL DEFAULT 0,
                 parent_session_id TEXT,
                 nested_under TEXT,
                 parked_at INTEGER,
                 FOREIGN KEY(project_id) REFERENCES projects(id)
             );
             CREATE TABLE IF NOT EXISTS app_state (
                 key        TEXT PRIMARY KEY,
                 value_json TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS prompts (
                 id           TEXT PRIMARY KEY,
                 title        TEXT NOT NULL,
                 body         TEXT NOT NULL,
                 tags_json    TEXT NOT NULL DEFAULT '[]',
                 favourite    INTEGER NOT NULL DEFAULT 0,
                 use_count    INTEGER NOT NULL DEFAULT 0,
                 last_used_ms INTEGER,
                 created_ms   INTEGER NOT NULL,
                 updated_ms   INTEGER NOT NULL
             );",
        )?;
        self.migrate_claude_session_id()?;
        self.migrate_column("projects", "setup_command", "TEXT")?;
        self.migrate_column("sessions", "archived_at", "INTEGER")?;
        self.migrate_column("sessions", "baseline_oid", "TEXT")?;
        // The [Sleeping session] mark, so a session Kriyon stopped is restored
        // as asleep after an app restart instead of silently losing its moon.
        self.migrate_column("sessions", "sleep_state", "TEXT")?;
        self.migrate_column("sessions", "title_locked", "INTEGER NOT NULL DEFAULT 0")?;
        self.migrate_column("sessions", "parent_session_id", "TEXT")?;
        self.migrate_column("sessions", "nested_under", "TEXT")?;
        self.migrate_column("sessions", "parked_at", "INTEGER")?;
        Ok(())
    }

    /// Add the `claude_session_id` column to a pre-existing `sessions` table.
    /// A "duplicate column" error means the migration already ran (the column
    /// is present), which is not a failure.
    fn migrate_claude_session_id(&self) -> Result<(), StoreError> {
        self.migrate_column("sessions", "claude_session_id", "TEXT")
    }

    /// Add `column <ty>` to `table` if it is missing. A "duplicate column" error
    /// means the migration already ran, which is not a failure.
    fn migrate_column(&self, table: &str, column: &str, ty: &str) -> Result<(), StoreError> {
        match self
            .conn
            .execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {ty}"), [])
        {
            Ok(_) => Ok(()),
            Err(rusqlite::Error::SqliteFailure(_, Some(msg)))
                if msg.contains("duplicate column") =>
            {
                Ok(())
            }
            Err(e) => Err(StoreError::Sqlite(e)),
        }
    }

    /// Insert a project, replacing the existing row on `id` conflict.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the statement fails.
    pub fn upsert_project(&self, p: &ProjectRow) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO projects (id, name, path, color, setup_command)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name, path = excluded.path,
                 color = excluded.color, setup_command = excluded.setup_command",
            rusqlite::params![p.id, p.name, p.path, p.color, p.setup_command],
        )?;
        Ok(())
    }

    /// List all projects.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the query fails.
    pub fn list_projects(&self) -> Result<Vec<ProjectRow>, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, name, path, color, setup_command FROM projects ORDER BY name")?;
        let rows = stmt.query_map([], |row| {
            Ok(ProjectRow {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                color: row.get(3)?,
                setup_command: row.get(4)?,
            })
        })?;
        let projects = rows.collect::<Result<Vec<_>, _>>()?;
        Ok(projects)
    }

    /// Insert a session, replacing the existing row on `id` conflict.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the statement fails.
    pub fn upsert_session(&self, s: &SessionRow) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO sessions
                 (id, project_id, title, cwd, worktree_path, created_at, claude_session_id, archived_at, baseline_oid, title_locked, parent_session_id, nested_under, parked_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(id) DO UPDATE SET
                 project_id = excluded.project_id, title = excluded.title,
                 cwd = excluded.cwd, worktree_path = excluded.worktree_path,
                 created_at = excluded.created_at, claude_session_id = excluded.claude_session_id,
                 archived_at = excluded.archived_at, baseline_oid = excluded.baseline_oid,
                 title_locked = excluded.title_locked,
                 parent_session_id = excluded.parent_session_id,
                 nested_under = excluded.nested_under,
                 parked_at = excluded.parked_at",
            rusqlite::params![
                s.id,
                s.project_id,
                s.title,
                s.cwd,
                s.worktree_path,
                s.created_at,
                s.claude_session_id,
                s.archived_at,
                s.baseline_oid,
                s.title_locked,
                s.parent_session_id,
                s.nested_under,
                s.parked_at
            ],
        )?;
        Ok(())
    }

    /// List all sessions ordered by `created_at`.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the query fails.
    pub fn list_sessions(&self) -> Result<Vec<SessionRow>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project_id, title, cwd, worktree_path, created_at, claude_session_id, archived_at, baseline_oid, title_locked, parent_session_id, nested_under, parked_at
             FROM sessions ORDER BY created_at",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(SessionRow {
                id: row.get(0)?,
                project_id: row.get(1)?,
                title: row.get(2)?,
                cwd: row.get(3)?,
                worktree_path: row.get(4)?,
                created_at: row.get(5)?,
                claude_session_id: row.get(6)?,
                archived_at: row.get(7)?,
                baseline_oid: row.get(8)?,
                title_locked: row.get::<_, Option<i64>>(9)?.unwrap_or(0) != 0,
                parent_session_id: row.get(10)?,
                nested_under: row.get(11)?,
                parked_at: row.get(12)?,
            })
        })?;
        let sessions = rows.collect::<Result<Vec<_>, _>>()?;
        Ok(sessions)
    }

    /// Delete the session with the given `id`. No-op if it does not exist.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the statement fails.
    pub fn delete_session(&self, id: &str) -> Result<(), StoreError> {
        self.conn
            .execute("DELETE FROM sessions WHERE id = ?1", rusqlite::params![id])?;
        Ok(())
    }

    /// Write (or clear, with `None`) a session's [Sleeping session] mark —
    /// `"asleep"` / `"stuck"`, from [`kriyon_core::sleep::SleepState::persist_mark`].
    /// Kept off [`SessionRow`] deliberately: it is backend-only lifecycle state
    /// the frontend learns from the `session-sleeping` event, never a display
    /// field. No-op if the session row does not exist.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the statement fails.
    pub fn set_sleep_state(&self, id: &str, mark: Option<&str>) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE sessions SET sleep_state = ?2 WHERE id = ?1",
            rusqlite::params![id, mark],
        )?;
        Ok(())
    }

    /// Persist a session's learned [Claude session id] directly, without a
    /// full-row upsert. Written backend-side the moment the watch reports it, so
    /// the resumable id the [Sleeping session] wake path reads is authoritative
    /// even if the webview reloads or its debounced save is lost. No-op if the
    /// session row does not exist yet.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the statement fails.
    pub fn set_claude_session_id(&self, id: &str, claude_id: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE sessions SET claude_session_id = ?2 WHERE id = ?1",
            rusqlite::params![id, claude_id],
        )?;
        Ok(())
    }

    /// One session's [Sleeping session] mark (`"asleep"`/`"stuck"`), or `None`
    /// when it is not marked or the row does not exist.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the query fails.
    pub fn sleep_state(&self, id: &str) -> Result<Option<String>, StoreError> {
        let mark = self
            .conn
            .query_row(
                "SELECT sleep_state FROM sessions WHERE id = ?1",
                rusqlite::params![id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        Ok(mark)
    }

    /// Insert a prompt, replacing the existing row on `id` conflict.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the statement fails.
    pub fn upsert_prompt(&self, p: &PromptRow) -> Result<(), StoreError> {
        let tags_json = serde_json::to_string(&p.tags).unwrap_or_else(|_| "[]".to_string());
        self.conn.execute(
            "INSERT INTO prompts
                 (id, title, body, tags_json, favourite, use_count, last_used_ms, created_ms, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                 title = excluded.title, body = excluded.body,
                 tags_json = excluded.tags_json, favourite = excluded.favourite,
                 use_count = excluded.use_count, last_used_ms = excluded.last_used_ms,
                 created_ms = excluded.created_ms, updated_ms = excluded.updated_ms",
            rusqlite::params![
                p.id, p.title, p.body, tags_json, p.favourite, p.use_count, p.last_used_ms,
                p.created_ms, p.updated_ms
            ],
        )?;
        Ok(())
    }

    /// List all prompts ordered by `title`.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the query fails.
    pub fn list_prompts(&self) -> Result<Vec<PromptRow>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, body, tags_json, favourite, use_count, last_used_ms, created_ms, updated_ms
             FROM prompts ORDER BY title",
        )?;
        let rows = stmt.query_map([], |row| {
            let tags_json: String = row.get(3)?;
            Ok(PromptRow {
                id: row.get(0)?,
                title: row.get(1)?,
                body: row.get(2)?,
                // Tolerant read: malformed tags degrade to [] rather than failing.
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                favourite: row.get(4)?,
                use_count: row.get(5)?,
                last_used_ms: row.get(6)?,
                created_ms: row.get(7)?,
                updated_ms: row.get(8)?,
            })
        })?;
        let prompts = rows.collect::<Result<Vec<_>, _>>()?;
        Ok(prompts)
    }

    /// Delete the prompt with the given `id`. No-op if it does not exist.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the statement fails.
    pub fn delete_prompt(&self, id: &str) -> Result<(), StoreError> {
        self.conn
            .execute("DELETE FROM prompts WHERE id = ?1", rusqlite::params![id])?;
        Ok(())
    }

    /// Increment the use count and update the last used timestamp for a prompt.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the statement fails.
    pub fn record_prompt_use(&self, id: &str, now_ms: i64) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE prompts SET use_count = use_count + 1, last_used_ms = ?2 WHERE id = ?1",
            rusqlite::params![id, now_ms],
        )?;
        Ok(())
    }

    /// Upsert a layout/app-state value keyed by `key`.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the statement fails.
    pub fn save_layout(&self, key: &str, value_json: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO app_state (key, value_json)
             VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
            rusqlite::params![key, value_json],
        )?;
        Ok(())
    }

    /// Resolve one session's [Session identity] with two indexed single-row
    /// lookups (session by primary key, then its project), instead of loading
    /// every session and project row. `None` when no session matches `id`.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if a query fails.
    pub fn session_identity(&self, id: &str) -> Result<Option<SessionIdentity>, StoreError> {
        let Some(session) = self.session_row(id)? else {
            return Ok(None);
        };
        let project = self.project_row(&session.project_id)?;
        Ok(Some(SessionIdentity::from_rows(&session, project.as_ref())))
    }

    /// Fetch a single session row by primary key, or `None` if absent.
    ///
    /// # Errors
    /// Returns a [`StoreError`] when the underlying query fails.
    pub fn session_row(&self, id: &str) -> Result<Option<SessionRow>, StoreError> {
        let row = self
            .conn
            .query_row(
                "SELECT id, project_id, title, cwd, worktree_path, created_at, claude_session_id, archived_at, baseline_oid, title_locked, parent_session_id, nested_under, parked_at
                 FROM sessions WHERE id = ?1",
                rusqlite::params![id],
                |row| {
                    Ok(SessionRow {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        title: row.get(2)?,
                        cwd: row.get(3)?,
                        worktree_path: row.get(4)?,
                        created_at: row.get(5)?,
                        claude_session_id: row.get(6)?,
                        archived_at: row.get(7)?,
                        baseline_oid: row.get(8)?,
                        title_locked: row.get::<_, Option<i64>>(9)?.unwrap_or(0) != 0,
                parent_session_id: row.get(10)?,
                        nested_under: row.get(11)?,
                        parked_at: row.get(12)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    /// Fetch a single project row by primary key, or `None` if absent.
    fn project_row(&self, id: &str) -> Result<Option<ProjectRow>, StoreError> {
        let row = self
            .conn
            .query_row(
                "SELECT id, name, path, color, setup_command FROM projects WHERE id = ?1",
                rusqlite::params![id],
                |row| {
                    Ok(ProjectRow {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        path: row.get(2)?,
                        color: row.get(3)?,
                        setup_command: row.get(4)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    /// Load a layout/app-state value, or `None` if absent.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the query fails.
    pub fn load_layout(&self, key: &str) -> Result<Option<String>, StoreError> {
        let value = self
            .conn
            .query_row(
                "SELECT value_json FROM app_state WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get(0),
            )
            .optional()?;
        Ok(value)
    }

    #[cfg(test)]
    pub(crate) fn conn_for_tests(&self) -> &Connection {
        &self.conn
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_project() -> ProjectRow {
        ProjectRow {
            id: "p1".to_string(),
            name: "Kriyon".to_string(),
            path: "/Users/dev/Projects/kriyon".to_string(),
            color: Some("#ff8800".to_string()),
            setup_command: None,
        }
    }

    fn sample_session() -> SessionRow {
        SessionRow {
            id: "s1".to_string(),
            project_id: "p1".to_string(),
            title: "First session".to_string(),
            cwd: "/Users/dev/Projects/kriyon".to_string(),
            worktree_path: None,
            created_at: 1_000,
            claude_session_id: None,
            archived_at: None,
            baseline_oid: None,
            title_locked: false,
            parent_session_id: None,
            nested_under: None,
            parked_at: None,
        }
    }

    #[test]
    fn session_identity_resolves_project_title_and_branch() {
        let projects = vec![sample_project()];
        let mut session = sample_session();
        session.worktree_path = Some("/Users/dev/wt/feat-login".to_string());
        let sessions = vec![session];

        let id = session_identity(&sessions, &projects, "s1").expect("identity");
        assert_eq!(id.project, "Kriyon");
        assert_eq!(id.title, "First session");
        assert_eq!(id.branch.as_deref(), Some("feat-login"));
    }

    #[test]
    fn session_identity_has_no_branch_without_a_worktree() {
        let projects = vec![sample_project()];
        let sessions = vec![sample_session()];
        let id = session_identity(&sessions, &projects, "s1").expect("identity");
        assert_eq!(id.branch, None);
    }

    #[test]
    fn session_identity_falls_back_to_project_id_when_project_row_missing() {
        // Orphaned session (project row absent): show the id, never blank.
        let sessions = vec![sample_session()];
        let id = session_identity(&sessions, &[], "s1").expect("identity");
        assert_eq!(id.project, "p1");
    }

    #[test]
    fn session_identity_is_none_for_unknown_session() {
        assert!(session_identity(&[], &[], "ghost").is_none());
    }

    #[test]
    fn upsert_and_list_project() {
        let store = Store::open_in_memory().expect("open in-memory store");
        let project = sample_project();
        store.upsert_project(&project).expect("upsert project");

        let projects = store.list_projects().expect("list projects");
        assert_eq!(projects, vec![project]);
    }

    #[test]
    fn upsert_and_list_session() {
        let store = Store::open_in_memory().expect("open in-memory store");
        store
            .upsert_project(&sample_project())
            .expect("upsert project");
        let session = sample_session();
        store.upsert_session(&session).expect("upsert session");

        let sessions = store.list_sessions().expect("list sessions");
        assert_eq!(sessions, vec![session]);
    }

    #[test]
    fn store_session_identity_matches_the_pure_join() {
        let store = Store::open_in_memory().expect("open in-memory store");
        store
            .upsert_project(&sample_project())
            .expect("upsert project");
        let mut session = sample_session();
        session.worktree_path = Some("/Users/dev/wt/feat-login".to_string());
        store.upsert_session(&session).expect("upsert session");

        let id = store
            .session_identity("s1")
            .expect("query")
            .expect("identity");
        assert_eq!(id.project, "Kriyon");
        assert_eq!(id.title, "First session");
        assert_eq!(id.branch.as_deref(), Some("feat-login"));
    }

    #[test]
    fn store_session_identity_is_none_for_unknown_session() {
        let store = Store::open_in_memory().expect("open in-memory store");
        assert!(
            store.session_identity("nope").expect("query").is_none(),
            "an unknown session id resolves to None, not an error"
        );
    }

    // The project-id fallback in `SessionIdentity::from_rows` is exercised by the
    // pure `session_identity` test above, not at the Store level: an orphaned
    // session can't be inserted, because the foreign key is enforced (below).
    #[test]
    fn upsert_session_without_a_project_is_rejected_by_the_foreign_key() {
        // rusqlite's `bundled` SQLite compiles with SQLITE_DEFAULT_FOREIGN_KEYS=1,
        // so the schema's `FOREIGN KEY(project_id)` is enforced without a
        // `PRAGMA foreign_keys = ON`. This test guards that non-obvious default:
        // if a future SQLite/rusqlite bump turns it off, orphaned sessions would
        // silently become insertable and this fails.
        let store = Store::open_in_memory().expect("open in-memory store");
        assert!(
            store.upsert_session(&sample_session()).is_err(),
            "a session with no project row must be rejected by the foreign key"
        );
    }

    #[test]
    fn save_and_load_layout() {
        let store = Store::open_in_memory().expect("open in-memory store");
        let json = r#"{"active":"s1","focus":true}"#;
        store.save_layout("layout", json).expect("save layout");

        assert_eq!(
            store.load_layout("layout").expect("load layout"),
            Some(json.to_string())
        );
        assert_eq!(store.load_layout("missing").expect("load missing"), None);
    }

    #[test]
    fn session_round_trips_claude_session_id() {
        let store = Store::open_in_memory().expect("open in-memory store");
        store
            .upsert_project(&sample_project())
            .expect("upsert project");
        let session = SessionRow {
            claude_session_id: Some("claude-abc".to_string()),
            ..sample_session()
        };
        store.upsert_session(&session).expect("upsert session");
        assert_eq!(
            store.list_sessions().expect("list"),
            vec![session],
            "the persisted Claude session id must round-trip"
        );
    }

    #[test]
    fn migrates_legacy_sessions_table_without_claude_session_id() {
        // A pre-existing DB created before the column was added must gain it on
        // open (ALTER TABLE), with existing rows defaulting to NULL.
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch(
            "CREATE TABLE sessions (
                 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
                 cwd TEXT NOT NULL, worktree_path TEXT, created_at INTEGER NOT NULL
             );
             INSERT INTO sessions (id, project_id, title, cwd, created_at)
             VALUES ('s1','p1','Old','/tmp',1000);",
        )
        .expect("seed legacy schema");

        let store = Store::from_connection(conn).expect("migrate on open");
        let sessions = store.list_sessions().expect("list");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].claude_session_id, None);
    }

    #[test]
    fn upsert_session_updates_in_place() {
        let store = Store::open_in_memory().expect("open in-memory store");
        store
            .upsert_project(&sample_project())
            .expect("upsert project");
        store
            .upsert_session(&sample_session())
            .expect("first insert");

        let updated = SessionRow {
            id: "s1".to_string(),
            project_id: "p1".to_string(),
            title: "Renamed session".to_string(),
            cwd: "/tmp/wt".to_string(),
            worktree_path: Some("/tmp/wt".to_string()),
            created_at: 2_000,
            claude_session_id: None,
            archived_at: None,
            baseline_oid: None,
            title_locked: false,
            parent_session_id: None,
            nested_under: None,
            parked_at: None,
        };
        store.upsert_session(&updated).expect("update session");

        let sessions = store.list_sessions().expect("list sessions");
        assert_eq!(sessions, vec![updated]);
    }

    #[test]
    fn session_round_trips_parked_at() {
        let store = Store::open_in_memory().expect("open");
        store.upsert_project(&sample_project()).expect("project");
        let parked = SessionRow {
            parked_at: Some(1_730_000_000_000),
            ..sample_session()
        };
        store.upsert_session(&parked).expect("park");
        assert_eq!(store.list_sessions().expect("list"), vec![parked.clone()]);
        assert!(parked.is_put_away());
        let unparked = SessionRow {
            parked_at: None,
            ..parked
        };
        store.upsert_session(&unparked).expect("unpark");
        assert_eq!(store.list_sessions().expect("list"), vec![unparked]);
    }

    #[test]
    fn session_round_trips_archived_at() {
        let store = Store::open_in_memory().expect("open");
        store.upsert_project(&sample_project()).expect("project");
        let session = SessionRow {
            archived_at: Some(1_720_000_000),
            ..sample_session()
        };
        store.upsert_session(&session).expect("upsert");
        assert_eq!(store.list_sessions().expect("list"), vec![session]);
    }

    #[test]
    fn upsert_session_roundtrips_baseline_oid() {
        let store = Store::open_in_memory().expect("open in-memory store");
        store.upsert_project(&sample_project()).expect("project");
        let mut row = sample_session();
        row.baseline_oid = Some("deadbeef".to_string());
        store.upsert_session(&row).expect("upsert session");

        let got = store
            .session_row(&row.id)
            .expect("query")
            .expect("session row present");
        assert_eq!(got.baseline_oid.as_deref(), Some("deadbeef"));
    }

    #[test]
    fn list_sessions_roundtrips_a_non_null_baseline_oid() {
        let store = Store::open_in_memory().expect("open in-memory store");
        store.upsert_project(&sample_project()).expect("project");
        let mut row = sample_session();
        row.baseline_oid = Some("deadbeef".to_string());
        store.upsert_session(&row).expect("upsert session");

        let sessions = store.list_sessions().expect("list sessions");
        let listed = sessions
            .iter()
            .find(|s| s.id == row.id)
            .expect("session present in list");
        assert_eq!(listed.baseline_oid.as_deref(), Some("deadbeef"));
    }

    #[test]
    fn sleep_mark_round_trips_and_clears_and_stays_off_the_session_row() {
        let store = Store::open_in_memory().expect("open");
        store.upsert_project(&sample_project()).expect("project");
        store.upsert_session(&sample_session()).expect("upsert");

        assert_eq!(store.sleep_state("s1").expect("read"), None, "unmarked");

        store.set_sleep_state("s1", Some("asleep")).expect("mark");
        assert_eq!(
            store.sleep_state("s1").expect("read"),
            Some("asleep".to_string())
        );
        // The mark is backend-only lifecycle state; it never leaks into the
        // display row the frontend reads.
        let round_tripped = store.list_sessions().expect("list");
        assert_eq!(round_tripped, vec![sample_session()]);

        store.set_sleep_state("s1", None).expect("clear");
        assert_eq!(store.sleep_state("s1").expect("read"), None, "cleared");

        // A mark for a row that does not exist is a harmless no-op.
        store
            .set_sleep_state("ghost", Some("stuck"))
            .expect("no-op");
        assert_eq!(store.sleep_state("ghost").expect("read"), None);
    }

    #[test]
    fn project_round_trips_setup_command() {
        let store = Store::open_in_memory().expect("open");
        let project = ProjectRow {
            setup_command: Some("docker compose up -d".to_string()),
            ..sample_project()
        };
        store.upsert_project(&project).expect("upsert");
        assert_eq!(store.list_projects().expect("list"), vec![project]);
    }

    #[test]
    fn migrates_tables_missing_the_new_columns() {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, color TEXT);
             CREATE TABLE sessions (
                 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
                 cwd TEXT NOT NULL, worktree_path TEXT, created_at INTEGER NOT NULL, claude_session_id TEXT
             );
             INSERT INTO projects (id,name,path) VALUES ('p1','Old','/tmp');
             INSERT INTO sessions (id,project_id,title,cwd,created_at) VALUES ('s1','p1','Old','/tmp',1000);",
        )
        .expect("seed legacy schema");
        let store = Store::from_connection(conn).expect("migrate on open");
        assert_eq!(store.list_sessions().expect("list")[0].archived_at, None);
        assert_eq!(store.list_sessions().expect("list")[0].baseline_oid, None);
        assert_eq!(store.list_sessions().expect("list")[0].parked_at, None);
        assert_eq!(
            store.list_sessions().expect("list")[0].parent_session_id,
            None
        );
        assert_eq!(store.list_sessions().expect("list")[0].nested_under, None);
        assert!(
            !store.list_sessions().expect("list")[0].title_locked,
            "a legacy row must default to unlocked so auto-titles still apply"
        );
        assert_eq!(store.list_projects().expect("list")[0].setup_command, None);
        // The sleep_state column is added by migration too: reading and writing
        // it must not fail on a table created before the column existed.
        assert_eq!(store.sleep_state("s1").expect("read migrated column"), None);
        store
            .set_sleep_state("s1", Some("asleep"))
            .expect("sleep_state column migrated in");
        assert_eq!(
            store.sleep_state("s1").expect("read"),
            Some("asleep".to_string())
        );
    }

    #[test]
    fn session_round_trips_its_handoff_link() {
        let store = Store::open_in_memory().expect("open");
        store.upsert_project(&sample_project()).expect("project");
        let session = SessionRow {
            id: "s2".to_string(),
            parent_session_id: Some("s1".to_string()),
            ..sample_session()
        };
        store.upsert_session(&session).expect("upsert");
        assert_eq!(store.session_row("s2").expect("row"), Some(session.clone()));
        assert_eq!(store.list_sessions().expect("list"), vec![session]);
    }

    #[test]
    fn session_round_trips_its_nesting() {
        let store = Store::open_in_memory().expect("open");
        store.upsert_project(&sample_project()).expect("project");
        let session = SessionRow {
            id: "s2".to_string(),
            nested_under: Some("s1".to_string()),
            ..sample_session()
        };
        store.upsert_session(&session).expect("upsert");
        assert_eq!(store.session_row("s2").expect("row"), Some(session));
    }

    #[test]
    fn session_round_trips_title_locked() {
        let store = Store::open_in_memory().expect("open");
        store.upsert_project(&sample_project()).expect("project");
        let session = SessionRow {
            title: "My custom name".to_string(),
            title_locked: true,
            ..sample_session()
        };
        store.upsert_session(&session).expect("upsert");
        assert_eq!(store.list_sessions().expect("list"), vec![session]);
    }

    fn sample_prompt() -> PromptRow {
        PromptRow {
            id: "pr1".to_string(),
            title: "Review this diff".to_string(),
            body: "Review the current diff for {focus}.".to_string(),
            tags: vec!["review".to_string()],
            favourite: false,
            use_count: 0,
            last_used_ms: None,
            created_ms: 1_000,
            updated_ms: 1_000,
        }
    }

    #[test]
    fn upsert_and_list_prompt_round_trips() {
        let store = Store::open_in_memory().expect("open");
        let prompt = sample_prompt();
        store.upsert_prompt(&prompt).expect("upsert");
        assert_eq!(store.list_prompts().expect("list"), vec![prompt]);
    }

    #[test]
    fn upsert_prompt_updates_in_place() {
        let store = Store::open_in_memory().expect("open");
        store.upsert_prompt(&sample_prompt()).expect("insert");
        let updated = PromptRow {
            title: "Review this diff carefully".to_string(),
            favourite: true,
            tags: vec!["review".to_string(), "git".to_string()],
            updated_ms: 2_000,
            ..sample_prompt()
        };
        store.upsert_prompt(&updated).expect("update");
        assert_eq!(store.list_prompts().expect("list"), vec![updated]);
    }

    #[test]
    fn delete_prompt_removes_row_and_is_noop_when_missing() {
        let store = Store::open_in_memory().expect("open");
        store.upsert_prompt(&sample_prompt()).expect("insert");
        store.delete_prompt("pr1").expect("delete");
        store.delete_prompt("pr1").expect("delete again is a no-op");
        assert_eq!(store.list_prompts().expect("list"), vec![]);
    }

    #[test]
    fn record_prompt_use_bumps_count_and_timestamp() {
        let store = Store::open_in_memory().expect("open");
        store.upsert_prompt(&sample_prompt()).expect("insert");
        store.record_prompt_use("pr1", 5_000).expect("use");
        store.record_prompt_use("pr1", 6_000).expect("use again");
        let listed = store.list_prompts().expect("list");
        assert_eq!(listed[0].use_count, 2);
        assert_eq!(listed[0].last_used_ms, Some(6_000));
    }

    #[test]
    fn prompt_with_malformed_tags_json_degrades_to_empty_tags() {
        // Tolerant read: a hand-edited/corrupt tags_json must not fail the list.
        let store = Store::open_in_memory().expect("open");
        store.upsert_prompt(&sample_prompt()).expect("insert");
        store
            .conn_for_tests()
            .execute("UPDATE prompts SET tags_json = 'not-json'", [])
            .expect("corrupt");
        assert_eq!(
            store.list_prompts().expect("list")[0].tags,
            Vec::<String>::new()
        );
    }
}
