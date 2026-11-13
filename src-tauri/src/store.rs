//! SQLite-backed persistence for projects, sessions, project notes, and UI
//! layout state.
//!
//! The [`Store`] wraps a single [`rusqlite::Connection`] and exposes typed
//! upsert/list/load helpers. Schema is created idempotently on open.

use std::path::Path;

use kriyon_core::project_notes::{NoteKind, ProjectNote};
use kriyon_remote::message::hex;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json;

/// Errors returned by [`Store`] operations.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

/// A paired device's sealed push token, and the push sender's key it was
/// sealed to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PushTokenRow {
    pub device: [u8; 32],
    pub key_id: u32,
    pub sealed: Vec<u8>,
}

/// A [Paired device] as the host keeps it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PairedDeviceRow {
    /// Its [Device key]'s public half: the iroh endpoint id.
    pub endpoint_id: [u8; 32],
    /// The name the device gave itself ("named by the device"), or the one
    /// the person renamed it to.
    pub name: String,
    pub role: kriyon_remote::message::Role,
    /// When it was paired, ms since epoch.
    pub paired_at: i64,
}

/// A [Host] this computer paired with as a [Remote device].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PairedHostRow {
    /// The host's endpoint id.
    pub host_id: [u8; 32],
    /// The name the host gave in `Paired`.
    pub name: String,
    /// Where it listened when paired (`ip:port`).
    pub addrs: Vec<String>,
    pub relay_url: Option<String>,
    /// When it was paired, ms since epoch.
    pub paired_at: i64,
}

/// How long a remote start's id is kept, so a resend returns the same session.
pub const REMOTE_START_KEPT_MS: i64 = 24 * 60 * 60 * 1000;

fn role_text(role: kriyon_remote::message::Role) -> &'static str {
    match role {
        kriyon_remote::message::Role::Viewer => "viewer",
        kriyon_remote::message::Role::Controller => "controller",
    }
}

/// A role read back from the store. Anything else reads as a Viewer: an
/// unknown value must never grant more than seeing.
fn role_from_text(text: &str) -> kriyon_remote::message::Role {
    if text == "controller" {
        kriyon_remote::message::Role::Controller
    } else {
        kriyon_remote::message::Role::Viewer
    }
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
    /// When the person pinned this project to the top of the sidebar (ms since
    /// epoch), or `None`. Pinned order is by this time.
    #[serde(default)]
    pub pinned_at: Option<i64>,
    /// The [Project folder] this project sits in, or `None`. The folder list
    /// itself lives in `app_state`; an id no folder answers to reads as none.
    #[serde(default)]
    pub folder_id: Option<String>,
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
    /// When the person pinned this session to the top of the sidebar (ms since
    /// epoch), or `None`. Display only: a pinned session runs as before.
    #[serde(default)]
    pub pinned_at: Option<i64>,
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

/// The `project_notes` columns, in the order [`project_note_from_row`] reads.
const PROJECT_NOTE_COLUMNS: &str =
    "id, project_id, kind, text, body, done_at, pinned, created_ms, updated_ms";

fn project_note_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectNote> {
    let kind: String = row.get(2)?;
    Ok(ProjectNote {
        id: row.get(0)?,
        project_id: row.get(1)?,
        kind: NoteKind::from_stored(&kind),
        text: row.get(3)?,
        body: row.get(4)?,
        done_at: row.get(5)?,
        pinned: row.get(6)?,
        created_ms: row.get(7)?,
        updated_ms: row.get(8)?,
    })
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
                 setup_command TEXT,
                 pinned_at     INTEGER,
                 folder_id     TEXT
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
                 pinned_at INTEGER,
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
             );
             CREATE TABLE IF NOT EXISTS project_notes (
                 id         TEXT PRIMARY KEY,
                 project_id TEXT NOT NULL,
                 kind       TEXT NOT NULL,
                 text       TEXT NOT NULL,
                 body       TEXT NOT NULL DEFAULT '',
                 done_at    INTEGER,
                 pinned     INTEGER NOT NULL DEFAULT 0,
                 created_ms INTEGER NOT NULL,
                 updated_ms INTEGER NOT NULL,
                 FOREIGN KEY(project_id) REFERENCES projects(id)
             );
             CREATE INDEX IF NOT EXISTS project_notes_by_project
                 ON project_notes(project_id);
             CREATE TABLE IF NOT EXISTS paired_devices (
                 endpoint_id TEXT PRIMARY KEY,
                 name        TEXT NOT NULL,
                 role        TEXT NOT NULL,
                 paired_at   INTEGER NOT NULL
             );
             -- Tokens from before they named their sender key (development
             -- builds only): unusable, and each phone gives a new one on
             -- its next connect.
             DROP TABLE IF EXISTS push_tokens;
             CREATE TABLE IF NOT EXISTS sealed_push_tokens (
                 device_id TEXT PRIMARY KEY,
                 key_id    INTEGER NOT NULL,
                 sealed    BLOB NOT NULL
             );
             CREATE TABLE IF NOT EXISTS paired_hosts (
                 host_id    TEXT PRIMARY KEY,
                 name       TEXT NOT NULL,
                 addrs_json TEXT NOT NULL,
                 relay_url  TEXT,
                 paired_at  INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS remote_starts (
                 device_id  TEXT NOT NULL,
                 request_id TEXT NOT NULL,
                 session_id TEXT NOT NULL,
                 at_ms      INTEGER NOT NULL,
                 PRIMARY KEY(device_id, request_id)
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
        self.migrate_column("sessions", "pinned_at", "INTEGER")?;
        self.migrate_column("projects", "pinned_at", "INTEGER")?;
        self.migrate_column("projects", "folder_id", "TEXT")?;
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

    /// Keep a host this computer paired with, replacing an earlier pairing
    /// of the same host.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the statement fails.
    pub fn add_paired_host(&self, row: &PairedHostRow) -> Result<(), StoreError> {
        let addrs = serde_json::to_string(&row.addrs).unwrap_or_else(|_| "[]".into());
        self.conn.execute(
            "INSERT OR REPLACE INTO paired_hosts (host_id, name, addrs_json, relay_url, paired_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                hex(&row.host_id),
                row.name,
                addrs,
                row.relay_url,
                row.paired_at
            ],
        )?;
        Ok(())
    }

    /// Every host this computer paired with, oldest first. A row that doesn't
    /// read back is skipped.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the query fails.
    pub fn paired_hosts(&self) -> Result<Vec<PairedHostRow>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT host_id, name, addrs_json, relay_url, paired_at FROM paired_hosts
             ORDER BY paired_at, host_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, name, addrs, relay_url, paired_at) = row?;
            let (Some(host_id), Ok(addrs)) = (
                kriyon_remote::message::parse_id_hex(&id),
                serde_json::from_str::<Vec<String>>(&addrs),
            ) else {
                continue;
            };
            out.push(PairedHostRow {
                host_id,
                name,
                addrs,
                relay_url,
                paired_at,
            });
        }
        Ok(out)
    }

    /// Forget a host. Returns whether it was there.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the statement fails.
    pub fn forget_paired_host(&self, host_id: &[u8; 32]) -> Result<bool, StoreError> {
        Ok(self.conn.execute(
            "DELETE FROM paired_hosts WHERE host_id = ?1",
            [hex(host_id)],
        )? > 0)
    }

    /// Keep a newly paired device, replacing an earlier pairing of the same
    /// device.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the statement fails.
    pub fn add_paired_device(&self, row: &PairedDeviceRow) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO paired_devices (endpoint_id, name, role, paired_at)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                hex(&row.endpoint_id),
                row.name,
                role_text(row.role),
                row.paired_at
            ],
        )?;
        Ok(())
    }

    /// Every paired device, oldest pairing first. A row whose id doesn't read
    /// back is skipped rather than failing the list.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the query fails.
    pub fn paired_devices(&self) -> Result<Vec<PairedDeviceRow>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT endpoint_id, name, role, paired_at FROM paired_devices
             ORDER BY paired_at, endpoint_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, name, role, paired_at) = row?;
            if let Some(endpoint_id) = kriyon_remote::message::parse_id_hex(&id) {
                out.push(PairedDeviceRow {
                    endpoint_id,
                    name,
                    role: role_from_text(&role),
                    paired_at,
                });
            }
        }
        Ok(out)
    }

    /// The role of a paired device, or `None` if it isn't paired.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the query fails.
    pub fn paired_device_role(
        &self,
        endpoint_id: &[u8; 32],
    ) -> Result<Option<kriyon_remote::message::Role>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT role FROM paired_devices WHERE endpoint_id = ?1",
                [hex(endpoint_id)],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .map(|role| role_from_text(&role)))
    }

    /// Rename a paired device. Returns whether it was there.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the statement fails.
    pub fn rename_paired_device(
        &self,
        endpoint_id: &[u8; 32],
        name: &str,
    ) -> Result<bool, StoreError> {
        let changed = self.conn.execute(
            "UPDATE paired_devices SET name = ?2 WHERE endpoint_id = ?1",
            rusqlite::params![hex(endpoint_id), name],
        )?;
        Ok(changed > 0)
    }

    /// Change a paired device's role. Returns whether it was there.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the statement fails.
    pub fn set_paired_device_role(
        &self,
        endpoint_id: &[u8; 32],
        role: kriyon_remote::message::Role,
    ) -> Result<bool, StoreError> {
        let changed = self.conn.execute(
            "UPDATE paired_devices SET role = ?2 WHERE endpoint_id = ?1",
            rusqlite::params![hex(endpoint_id), role_text(role)],
        )?;
        // A device made a Viewer gives a new token when it connects again
        // (spec §4).
        if role == kriyon_remote::message::Role::Viewer {
            self.conn.execute(
                "DELETE FROM sealed_push_tokens WHERE device_id = ?1",
                [hex(endpoint_id)],
            )?;
        }
        Ok(changed > 0)
    }

    /// Keep paired device `device`'s push token, sealed to the push
    /// sender's key `key_id` (spec §10), in place of any it gave before. A
    /// device not paired here is ignored.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the statement fails.
    pub fn set_push_token(
        &self,
        device: &[u8; 32],
        key_id: u32,
        sealed: &[u8],
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO sealed_push_tokens (device_id, key_id, sealed)
             SELECT ?1, ?2, ?3 WHERE EXISTS
                 (SELECT 1 FROM paired_devices WHERE endpoint_id = ?1)",
            rusqlite::params![hex(device), key_id, sealed],
        )?;
        Ok(())
    }

    /// Every paired device's sealed push token.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the query fails.
    pub fn push_tokens(&self) -> Result<Vec<PushTokenRow>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT device_id, key_id, sealed FROM sealed_push_tokens ORDER BY device_id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, key_id, sealed) = row?;
            // A row that doesn't read is skipped, not the whole list.
            if let (Some(device), Ok(key_id)) = (
                kriyon_remote::message::parse_id_hex(&id),
                u32::try_from(key_id),
            ) {
                out.push(PushTokenRow {
                    device,
                    key_id,
                    sealed,
                });
            }
        }
        Ok(out)
    }

    /// Forget a paired device and the session starts it asked for. Returns
    /// whether it was there.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if a statement fails.
    pub fn remove_paired_device(&self, endpoint_id: &[u8; 32]) -> Result<bool, StoreError> {
        let id = hex(endpoint_id);
        self.conn
            .execute("DELETE FROM remote_starts WHERE device_id = ?1", [&id])?;
        self.conn
            .execute("DELETE FROM sealed_push_tokens WHERE device_id = ?1", [&id])?;
        let removed = self
            .conn
            .execute("DELETE FROM paired_devices WHERE endpoint_id = ?1", [&id])?;
        Ok(removed > 0)
    }

    /// Remember that `device`'s start `request_id` made `session_id`, so a
    /// resend returns it instead of starting a second session.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the statement fails.
    pub fn record_remote_start(
        &self,
        device: &[u8; 32],
        request_id: &[u8; 16],
        session_id: &str,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO remote_starts (device_id, request_id, session_id, at_ms)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![hex(device), hex(request_id), session_id, now_ms],
        )?;
        Ok(())
    }

    /// The session `device`'s start `request_id` made, if it was in the last
    /// [`REMOTE_START_KEPT_MS`].
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the query fails.
    pub fn remote_start(
        &self,
        device: &[u8; 32],
        request_id: &[u8; 16],
        now_ms: i64,
    ) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT session_id FROM remote_starts
                 WHERE device_id = ?1 AND request_id = ?2 AND at_ms > ?3",
                rusqlite::params![hex(device), hex(request_id), now_ms - REMOTE_START_KEPT_MS],
                |r| r.get::<_, String>(0),
            )
            .optional()?)
    }

    /// Drop starts older than [`REMOTE_START_KEPT_MS`]. Returns how many went.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the statement fails.
    pub fn prune_remote_starts(&self, now_ms: i64) -> Result<usize, StoreError> {
        Ok(self.conn.execute(
            "DELETE FROM remote_starts WHERE at_ms <= ?1",
            [now_ms - REMOTE_START_KEPT_MS],
        )?)
    }

    /// Insert a project, replacing the existing row on `id` conflict.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the statement fails.
    pub fn upsert_project(&self, p: &ProjectRow) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO projects (id, name, path, color, setup_command, pinned_at, folder_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name, path = excluded.path,
                 color = excluded.color, setup_command = excluded.setup_command,
                 pinned_at = excluded.pinned_at, folder_id = excluded.folder_id",
            rusqlite::params![
                p.id,
                p.name,
                p.path,
                p.color,
                p.setup_command,
                p.pinned_at,
                p.folder_id
            ],
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
            .prepare("SELECT id, name, path, color, setup_command, pinned_at, folder_id FROM projects ORDER BY name")?;
        let rows = stmt.query_map([], |row| {
            Ok(ProjectRow {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                color: row.get(3)?,
                setup_command: row.get(4)?,
                pinned_at: row.get(5)?,
                folder_id: row.get(6)?,
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
                 (id, project_id, title, cwd, worktree_path, created_at, claude_session_id, archived_at, baseline_oid, title_locked, parent_session_id, nested_under, parked_at, pinned_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(id) DO UPDATE SET
                 project_id = excluded.project_id, title = excluded.title,
                 cwd = excluded.cwd, worktree_path = excluded.worktree_path,
                 created_at = excluded.created_at, claude_session_id = excluded.claude_session_id,
                 archived_at = excluded.archived_at, baseline_oid = excluded.baseline_oid,
                 title_locked = excluded.title_locked,
                 parent_session_id = excluded.parent_session_id,
                 nested_under = excluded.nested_under,
                 parked_at = excluded.parked_at,
                 pinned_at = excluded.pinned_at",
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
                s.parked_at,
                s.pinned_at
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
            "SELECT id, project_id, title, cwd, worktree_path, created_at, claude_session_id, archived_at, baseline_oid, title_locked, parent_session_id, nested_under, parked_at, pinned_at
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
                pinned_at: row.get(13)?,
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

    /// Insert a [Project note], or update the one with its `id`. An update
    /// never changes which project the note belongs to.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the statement fails, including when
    /// the note's project does not exist (the foreign key).
    pub fn upsert_project_note(&self, n: &ProjectNote) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO project_notes
                 (id, project_id, kind, text, body, done_at, pinned, created_ms, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                 kind = excluded.kind, text = excluded.text, body = excluded.body,
                 done_at = excluded.done_at, pinned = excluded.pinned,
                 updated_ms = excluded.updated_ms",
            rusqlite::params![
                n.id,
                n.project_id,
                n.kind.as_str(),
                n.text,
                n.body,
                n.done_at,
                n.pinned,
                n.created_ms,
                n.updated_ms
            ],
        )?;
        Ok(())
    }

    /// List every [Project note], oldest first.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the query fails.
    pub fn list_project_notes(&self) -> Result<Vec<ProjectNote>, StoreError> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {PROJECT_NOTE_COLUMNS} FROM project_notes ORDER BY created_ms, id"
        ))?;
        let rows = stmt.query_map([], project_note_from_row)?;
        let notes = rows.collect::<Result<Vec<_>, _>>()?;
        Ok(notes)
    }

    /// The [Project note] with the given `id`, or `None`.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the query fails.
    pub fn project_note(&self, id: &str) -> Result<Option<ProjectNote>, StoreError> {
        let note = self
            .conn
            .query_row(
                &format!("SELECT {PROJECT_NOTE_COLUMNS} FROM project_notes WHERE id = ?1"),
                rusqlite::params![id],
                project_note_from_row,
            )
            .optional()?;
        Ok(note)
    }

    /// Delete the [Project note] with the given `id`. No-op if it does not exist.
    ///
    /// # Errors
    /// Returns [`StoreError::Sqlite`] if the statement fails.
    pub fn delete_project_note(&self, id: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "DELETE FROM project_notes WHERE id = ?1",
            rusqlite::params![id],
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
                "SELECT id, project_id, title, cwd, worktree_path, created_at, claude_session_id, archived_at, baseline_oid, title_locked, parent_session_id, nested_under, parked_at, pinned_at
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
                    pinned_at: row.get(13)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    /// Fetch a single project row by primary key, or `None` if absent.
    pub(crate) fn project_row(&self, id: &str) -> Result<Option<ProjectRow>, StoreError> {
        let row = self
            .conn
            .query_row(
                "SELECT id, name, path, color, setup_command, pinned_at, folder_id FROM projects WHERE id = ?1",
                rusqlite::params![id],
                |row| {
                    Ok(ProjectRow {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        path: row.get(2)?,
                        color: row.get(3)?,
                        setup_command: row.get(4)?,
                    pinned_at: row.get(5)?,
                    folder_id: row.get(6)?,
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
    mod remote {
        use super::super::*;
        use kriyon_remote::message::Role;

        const PHONE: [u8; 32] = [1; 32];
        const LAPTOP: [u8; 32] = [2; 32];
        const DAY_MS: i64 = 24 * 60 * 60 * 1000;

        fn store() -> Store {
            Store::open_in_memory().expect("open in-memory store")
        }

        fn phone() -> PairedDeviceRow {
            PairedDeviceRow {
                endpoint_id: PHONE,
                name: "Test phone".into(),
                role: Role::Controller,
                paired_at: 1_000,
            }
        }

        #[test]
        fn a_paired_device_is_kept_with_its_name_role_and_time() {
            let s = store();
            assert_eq!(s.paired_device_role(&PHONE).expect("reads"), None);
            s.add_paired_device(&phone()).expect("adds");
            assert_eq!(s.paired_devices().expect("lists"), vec![phone()]);
            assert_eq!(
                s.paired_device_role(&PHONE).expect("reads"),
                Some(Role::Controller)
            );
        }

        #[test]
        fn pairing_the_same_device_again_replaces_it() {
            let s = store();
            s.add_paired_device(&phone()).expect("adds");
            let again = PairedDeviceRow {
                name: "New name".into(),
                role: Role::Viewer,
                paired_at: 2_000,
                ..phone()
            };
            s.add_paired_device(&again).expect("adds");
            assert_eq!(s.paired_devices().expect("lists"), vec![again]);
        }

        #[test]
        fn a_device_can_be_renamed_and_its_role_changed() {
            let s = store();
            s.add_paired_device(&phone()).expect("adds");
            assert!(s
                .rename_paired_device(&PHONE, "Work phone")
                .expect("renames"));
            assert!(s
                .set_paired_device_role(&PHONE, Role::Viewer)
                .expect("sets"));
            let row = &s.paired_devices().expect("lists")[0];
            assert_eq!((row.name.as_str(), row.role), ("Work phone", Role::Viewer));
            assert!(!s
                .rename_paired_device(&LAPTOP, "x")
                .expect("no such device"));
        }

        #[test]
        fn removing_a_device_forgets_its_starts_too() {
            let s = store();
            s.add_paired_device(&phone()).expect("adds");
            s.record_remote_start(&PHONE, &[5; 16], "s1", 0)
                .expect("records");
            s.record_remote_start(&LAPTOP, &[5; 16], "s2", 0)
                .expect("records");
            assert!(s.remove_paired_device(&PHONE).expect("removes"));
            assert_eq!(s.paired_devices().expect("lists"), vec![]);
            assert_eq!(s.remote_start(&PHONE, &[5; 16], 1).expect("reads"), None);
            assert_eq!(
                s.remote_start(&LAPTOP, &[5; 16], 1).expect("reads"),
                Some("s2".to_string())
            );
            assert!(!s.remove_paired_device(&PHONE).expect("already gone"));
        }

        #[test]
        fn a_push_token_is_kept_per_device_and_replaced_by_a_newer_one() {
            let s = store();
            s.add_paired_device(&phone()).expect("adds");
            assert_eq!(s.push_tokens().expect("lists"), vec![]);
            s.set_push_token(&PHONE, 1, b"old").expect("keeps");
            s.set_push_token(&PHONE, 2, b"sealed").expect("keeps");
            assert_eq!(
                s.push_tokens().expect("lists"),
                vec![PushTokenRow {
                    device: PHONE,
                    key_id: 2,
                    sealed: b"sealed".to_vec()
                }]
            );
        }

        #[test]
        fn a_push_token_goes_with_its_device_or_when_it_becomes_a_viewer() {
            let s = store();
            s.add_paired_device(&phone()).expect("adds");
            s.set_push_token(&PHONE, 1, b"sealed").expect("keeps");
            assert!(s
                .set_paired_device_role(&PHONE, Role::Viewer)
                .expect("changes"));
            assert_eq!(s.push_tokens().expect("lists"), vec![]);
            s.set_push_token(&PHONE, 1, b"again").expect("keeps");
            assert!(s.remove_paired_device(&PHONE).expect("removes"));
            assert_eq!(s.push_tokens().expect("lists"), vec![]);
        }

        #[test]
        fn a_token_from_a_device_not_paired_is_not_kept() {
            let s = store();
            s.set_push_token(&LAPTOP, 1, b"sealed").expect("ignored");
            assert_eq!(s.push_tokens().expect("lists"), vec![]);
        }

        #[test]
        fn a_resent_start_finds_the_session_for_a_day() {
            let s = store();
            s.record_remote_start(&PHONE, &[5; 16], "s1", 0)
                .expect("records");
            assert_eq!(
                s.remote_start(&PHONE, &[5; 16], DAY_MS - 1).expect("reads"),
                Some("s1".to_string())
            );
            assert_eq!(s.remote_start(&PHONE, &[6; 16], 0).expect("reads"), None);
            assert_eq!(
                s.remote_start(&PHONE, &[5; 16], DAY_MS).expect("reads"),
                None
            );
        }

        fn studio() -> PairedHostRow {
            PairedHostRow {
                host_id: LAPTOP,
                name: "Studio".into(),
                addrs: vec!["192.168.1.20:41641".into(), "100.64.0.7:41641".into()],
                relay_url: None,
                paired_at: 5,
            }
        }

        #[test]
        fn a_host_this_computer_paired_with_is_kept_with_how_to_reach_it() {
            let s = store();
            assert_eq!(s.paired_hosts().expect("lists"), vec![]);
            s.add_paired_host(&studio()).expect("adds");
            assert_eq!(s.paired_hosts().expect("lists"), vec![studio()]);
            let again = PairedHostRow {
                name: "Studio Mac".into(),
                ..studio()
            };
            s.add_paired_host(&again).expect("replaces");
            assert_eq!(s.paired_hosts().expect("lists"), vec![again]);
        }

        #[test]
        fn a_host_can_be_forgotten() {
            let s = store();
            s.add_paired_host(&studio()).expect("adds");
            assert!(s.forget_paired_host(&LAPTOP).expect("forgets"));
            assert_eq!(s.paired_hosts().expect("lists"), vec![]);
            assert!(!s.forget_paired_host(&LAPTOP).expect("already gone"));
        }

        #[test]
        fn old_starts_are_pruned() {
            let s = store();
            s.record_remote_start(&PHONE, &[5; 16], "old", 0)
                .expect("records");
            s.record_remote_start(&PHONE, &[6; 16], "new", DAY_MS)
                .expect("records");
            assert_eq!(s.prune_remote_starts(DAY_MS + 1).expect("prunes"), 1);
            assert_eq!(
                s.remote_start(&PHONE, &[6; 16], DAY_MS + 1).expect("reads"),
                Some("new".to_string())
            );
        }
    }

    use super::*;

    fn sample_project() -> ProjectRow {
        ProjectRow {
            id: "p1".to_string(),
            name: "Kriyon".to_string(),
            path: "/Users/dev/Projects/kriyon".to_string(),
            color: Some("#ff8800".to_string()),
            setup_command: None,
            pinned_at: None,
            folder_id: None,
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
            pinned_at: None,
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
            pinned_at: None,
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
    fn project_round_trips_pin_and_folder() {
        let store = Store::open_in_memory().expect("open");
        let project = ProjectRow {
            pinned_at: Some(1_730_000_000_000),
            folder_id: Some("f1".to_string()),
            ..sample_project()
        };
        store.upsert_project(&project).expect("upsert");
        assert_eq!(store.list_projects().expect("list"), vec![project.clone()]);
        let cleared = ProjectRow {
            pinned_at: None,
            folder_id: None,
            ..project
        };
        store.upsert_project(&cleared).expect("clear");
        assert_eq!(store.list_projects().expect("list"), vec![cleared]);
    }

    #[test]
    fn session_round_trips_pinned_at() {
        let store = Store::open_in_memory().expect("open");
        store.upsert_project(&sample_project()).expect("project");
        let pinned = SessionRow {
            pinned_at: Some(1_730_000_000_000),
            ..sample_session()
        };
        store.upsert_session(&pinned).expect("pin");
        assert_eq!(store.list_sessions().expect("list"), vec![pinned.clone()]);
        assert_eq!(store.session_row("s1").expect("row"), Some(pinned.clone()));
        assert!(!pinned.is_put_away(), "a pin is not putting away");
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
        assert_eq!(store.list_sessions().expect("list")[0].pinned_at, None);
        assert_eq!(store.list_projects().expect("list")[0].pinned_at, None);
        assert_eq!(store.list_projects().expect("list")[0].folder_id, None);
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
    fn sample_note() -> ProjectNote {
        ProjectNote {
            id: "n1".to_string(),
            project_id: "p1".to_string(),
            kind: NoteKind::Todo,
            text: "Write the ADR".to_string(),
            body: "Why, then what".to_string(),
            done_at: None,
            pinned: false,
            created_ms: 1_000,
            updated_ms: 1_000,
        }
    }

    #[test]
    fn project_note_round_trips() {
        let store = Store::open_in_memory().expect("open");
        store.upsert_project(&sample_project()).expect("project");
        store.upsert_project_note(&sample_note()).expect("insert");
        assert_eq!(
            store.list_project_notes().expect("list"),
            vec![sample_note()]
        );
    }

    #[test]
    fn upsert_project_note_updates_in_place_but_never_moves_projects() {
        let store = Store::open_in_memory().expect("open");
        store.upsert_project(&sample_project()).expect("project");
        store
            .upsert_project(&ProjectRow {
                id: "p2".to_string(),
                ..sample_project()
            })
            .expect("second project");
        store.upsert_project_note(&sample_note()).expect("insert");
        let edited = ProjectNote {
            kind: NoteKind::Idea,
            text: "Edited".to_string(),
            pinned: true,
            updated_ms: 2_000,
            ..sample_note()
        };
        store
            .upsert_project_note(&ProjectNote {
                project_id: "p2".to_string(),
                ..edited.clone()
            })
            .expect("update");
        assert_eq!(store.list_project_notes().expect("list"), vec![edited]);
    }

    #[test]
    fn project_notes_list_oldest_first() {
        let store = Store::open_in_memory().expect("open");
        store.upsert_project(&sample_project()).expect("project");
        let newer = ProjectNote {
            id: "n2".to_string(),
            created_ms: 5_000,
            ..sample_note()
        };
        store.upsert_project_note(&newer).expect("newer");
        store.upsert_project_note(&sample_note()).expect("older");
        let ids: Vec<String> = store
            .list_project_notes()
            .expect("list")
            .into_iter()
            .map(|n| n.id)
            .collect();
        assert_eq!(ids, ["n1", "n2"]);
    }

    #[test]
    fn delete_project_note_removes_it_and_is_a_noop_when_missing() {
        let store = Store::open_in_memory().expect("open");
        store.upsert_project(&sample_project()).expect("project");
        store.upsert_project_note(&sample_note()).expect("insert");
        store.delete_project_note("n1").expect("delete");
        store.delete_project_note("n1").expect("delete again");
        assert_eq!(store.list_project_notes().expect("list"), vec![]);
    }

    #[test]
    fn project_note_without_a_project_is_rejected() {
        let store = Store::open_in_memory().expect("open");
        assert!(store.upsert_project_note(&sample_note()).is_err());
    }

    #[test]
    fn project_note_with_an_unknown_stored_kind_reads_as_a_note() {
        let store = Store::open_in_memory().expect("open");
        store.upsert_project(&sample_project()).expect("project");
        store.upsert_project_note(&sample_note()).expect("insert");
        store
            .conn_for_tests()
            .execute("UPDATE project_notes SET kind = 'checklist'", [])
            .expect("corrupt");
        assert_eq!(
            store.list_project_notes().expect("list")[0].kind,
            NoteKind::Note
        );
    }
}
