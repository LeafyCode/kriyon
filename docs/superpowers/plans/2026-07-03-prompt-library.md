# Prompt Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A global library of saved prompts (favourite/tag/search), summoned with ⌘⇧P, that inserts the picked prompt into the composer draft — never auto-sending — with placeholder fill and `.claude/commands/` interop.

**Architecture:** SQLite `prompts` table behind the existing `Store` → thin Tauri commands → `bridge.ts` → a `usePromptLibrary` zustand store → a `PromptPicker` overlay + `PromptEditor` dialog. The composer draft is lifted from `PromptBar` local state into a `useDrafts` store so the picker can insert into it. Promote/import round-trips with `.claude/commands/*.md`; the pure markdown parsing lives in `kriyon-core`.

**Tech Stack:** Rust (rusqlite, serde, serde_json), Tauri v2 commands, React + zustand, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-03-prompt-library-design.md` (approved). Domain terms already in `CONTEXT.md`: Saved prompt, Prompt picker, Placeholder, Promote, Composer draft.

## Global Constraints

- Formatting/lint is owned by Ultracite+Biome: run `pnpm fix` after writing TS/TSX, never hand-format. Rust: `cargo fmt` and clippy `pedantic` must pass.
- TDD: write the failing test, run it to see it fail, implement, run to see it pass, commit. Never skip the fail run.
- Conventional commits; stage **named files only** (never `git add -u` / `-A`).
- Design values only from `src/theme/tokens.ts` — no hardcoded colors/spacing.
- The IPC boundary is a trust boundary: validate every frontend-supplied id/name/path in Rust; never interpolate unvalidated input into filesystem paths.
- The library must NEVER write to PTY stdin. Insertion only touches the composer draft.
- Frontend test command: `pnpm vitest run <file>`; whole suite `pnpm test`. Rust: `cargo test -p kriyon <filter>` (src-tauri crate is named `kriyon`), `cargo test -p kriyon-core <filter>`.
- `pnpm check` must pass before the final task completes (pre-push hook runs the full suite anyway).

---

### Task 1: Rust store — `prompts` table + `PromptRow` + helpers

**Files:**
- Modify: `src-tauri/src/store.rs`

**Interfaces:**
- Produces (used by Task 2):

```rust
pub struct PromptRow {
    pub id: String,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,          // serialized to tags_json TEXT in SQL
    pub favourite: bool,
    pub use_count: i64,
    pub last_used_ms: Option<i64>,
    pub created_ms: i64,
    pub updated_ms: i64,
}
impl Store {
    pub fn upsert_prompt(&self, p: &PromptRow) -> Result<(), StoreError>;
    pub fn list_prompts(&self) -> Result<Vec<PromptRow>, StoreError>;
    pub fn delete_prompt(&self, id: &str) -> Result<(), StoreError>;
    pub fn record_prompt_use(&self, id: &str, now_ms: i64) -> Result<(), StoreError>;
}
```

- [ ] **Step 1: Write the failing tests** — append to `mod tests` in `store.rs`:

```rust
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
    assert_eq!(store.list_prompts().expect("list")[0].tags, Vec::<String>::new());
}
```

Add a test-only accessor next to the other `impl Store` methods:

```rust
#[cfg(test)]
pub(crate) fn conn_for_tests(&self) -> &Connection {
    &self.conn
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p kriyon store::tests::upsert_and_list_prompt`
Expected: compile FAIL — `PromptRow` / `upsert_prompt` not found.

- [ ] **Step 3: Implement** — in `store.rs`:

Add the struct after `SessionRow`:

```rust
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
```

Add the table to `init_schema`'s `execute_batch` (after `app_state`):

```sql
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
```

Add helpers (mirror the `upsert_session`/`list_sessions` doc-comment + `# Errors` style):

```rust
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
            p.id, p.title, p.body, tags_json, p.favourite,
            p.use_count, p.last_used_ms, p.created_ms, p.updated_ms
        ],
    )?;
    Ok(())
}

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

pub fn delete_prompt(&self, id: &str) -> Result<(), StoreError> {
    self.conn
        .execute("DELETE FROM prompts WHERE id = ?1", rusqlite::params![id])?;
    Ok(())
}

pub fn record_prompt_use(&self, id: &str, now_ms: i64) -> Result<(), StoreError> {
    self.conn.execute(
        "UPDATE prompts SET use_count = use_count + 1, last_used_ms = ?2 WHERE id = ?1",
        rusqlite::params![id, now_ms],
    )?;
    Ok(())
}
```

Add `use serde_json;` only if the compiler asks (the crate is already a dependency).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p kriyon store::tests`
Expected: all store tests PASS (old + 5 new).

- [ ] **Step 5: Format, lint, commit**

```bash
cargo fmt
cargo clippy -p kriyon --all-targets -- -D warnings
git add src-tauri/src/store.rs
git commit -m "feat(prompts): prompts table and PromptRow store helpers"
```

---

### Task 2: IPC — prompt commands, registration, bridge bindings, `SavedPrompt` type

**Files:**
- Modify: `src-tauri/src/commands.rs` (persistence section, after `delete_session`)
- Modify: `src-tauri/src/lib.rs` (`generate_handler!` list)
- Modify: `src/ipc/bridge.ts` (persistence section)
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: `Store::{upsert_prompt, list_prompts, delete_prompt, record_prompt_use}`, `PromptRow` (Task 1).
- Produces (used by Tasks 7–10):

```ts
// src/types.ts
export interface SavedPrompt {
  body: string;
  createdMs: number;
  favourite: boolean;
  id: string;
  lastUsedMs: number | null;
  tags: string[];
  title: string;
  updatedMs: number;
  useCount: number;
}
// src/ipc/bridge.ts
export function upsertPrompt(prompt: SavedPrompt): Promise<void>;
export function listPrompts(): Promise<SavedPrompt[]>;
export function deletePrompt(id: string): Promise<void>;
export function recordPromptUse(id: string): Promise<void>;
```

- [ ] **Step 1: Write the Rust commands** (thin wrappers — the logic is already tested at the store layer in Task 1; these follow the exact `upsert_session` pattern):

In `commands.rs`, extend the store import and add after `delete_session`:

```rust
use crate::store::{ProjectRow, PromptRow, SessionRow};
```

```rust
/// Insert or update a [Saved prompt] in the prompt library.
///
/// # Errors
/// Returns an error string if the database write fails.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn upsert_prompt(
    store: tauri::State<'_, StoreState>,
    prompt: PromptRow,
) -> Result<(), String> {
    store
        .0
        .lock()
        .upsert_prompt(&prompt)
        .map_err(|e| e.to_string())
}

/// List all [Saved prompt]s.
///
/// # Errors
/// Returns an error string if the database read fails.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn list_prompts(store: tauri::State<'_, StoreState>) -> Result<Vec<PromptRow>, String> {
    store.0.lock().list_prompts().map_err(|e| e.to_string())
}

/// Delete a [Saved prompt] by id. No-op if it does not exist.
///
/// # Errors
/// Returns an error string if the database write fails.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn delete_prompt(store: tauri::State<'_, StoreState>, id: String) -> Result<(), String> {
    store.0.lock().delete_prompt(&id).map_err(|e| e.to_string())
}

/// Record one use of a [Saved prompt]: bump its use count and last-used time.
///
/// # Errors
/// Returns an error string if the database write fails.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn record_prompt_use(store: tauri::State<'_, StoreState>, id: String) -> Result<(), String> {
    let now_ms = i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis(),
    )
    .map_err(|e| e.to_string())?;
    store
        .0
        .lock()
        .record_prompt_use(&id, now_ms)
        .map_err(|e| e.to_string())
}
```

Register in `lib.rs` inside `generate_handler![...]` after `commands::delete_session`:

```rust
commands::upsert_prompt,
commands::list_prompts,
commands::delete_prompt,
commands::record_prompt_use,
```

- [ ] **Step 2: Verify Rust compiles and clippy passes**

Run: `cargo clippy -p kriyon --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 3: Add the frontend type and bindings**

`src/types.ts` — add the `SavedPrompt` interface from the Interfaces block above, next to `SessionRow`/`ProjectRow`, with a doc comment: `/** A [Saved prompt] in the user's global prompt library (mirrors Rust PromptRow). */`

`src/ipc/bridge.ts` — add `SavedPrompt` to the type import from `../types.ts`, and in the `// --- Persistence ---` section:

```ts
export function upsertPrompt(prompt: SavedPrompt): Promise<void> {
  return invoke("upsert_prompt", { prompt });
}

export function listPrompts(): Promise<SavedPrompt[]> {
  return invoke("list_prompts");
}

export function deletePrompt(id: string): Promise<void> {
  return invoke("delete_prompt", { id });
}

/** Bump a prompt's use count / last-used time (backend stamps the clock). */
export function recordPromptUse(id: string): Promise<void> {
  return invoke("record_prompt_use", { id });
}
```

- [ ] **Step 4: Verify frontend compiles**

Run: `pnpm fix && pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/ipc/bridge.ts src/types.ts
git commit -m "feat(prompts): prompt IPC commands and bridge bindings"
```

---

### Task 3: Rust — promote to / import from `.claude/commands/`

**Files:**
- Create: `crates/kriyon-core/src/prompt_files.rs`
- Modify: `crates/kriyon-core/src/lib.rs` (add `pub mod prompt_files;`)
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`
- Modify: `src/ipc/bridge.ts`

**Interfaces:**
- Produces (used by Tasks 8 & 10):

```rust
// kriyon-core prompt_files (pure, no fs):
pub fn valid_command_name(name: &str) -> bool;                    // ^[a-z0-9][a-z0-9-_]{0,63}$
pub fn to_command_markdown(description: &str, body: &str) -> String;
pub struct ParsedCommand { pub name: String, pub description: Option<String>, pub body: String }
pub fn parse_command_markdown(name: &str, content: &str) -> ParsedCommand; // tolerant, never errors
```

```ts
// bridge.ts:
export interface ImportedCommand { body: string; description: string | null; name: string }
export function promotePromptToCommand(projectId: string | null, name: string, description: string, body: string, overwrite: boolean): Promise<string>; // resolves to written path
export function importCommands(projectId: string | null): Promise<ImportedCommand[]>;
```

- [ ] **Step 1: Write failing kriyon-core tests** — in `crates/kriyon-core/src/prompt_files.rs` (module with `#[cfg(test)] mod tests` at bottom, like sibling modules):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_names_are_slugs() {
        assert!(valid_command_name("review-diff"));
        assert!(valid_command_name("fix_bug2"));
        assert!(!valid_command_name(""));
        assert!(!valid_command_name("-leading-dash"));
        assert!(!valid_command_name("has space"));
        assert!(!valid_command_name("Upper"));
        assert!(!valid_command_name("../escape"));
        assert!(!valid_command_name(&"a".repeat(65)));
    }

    #[test]
    fn markdown_round_trips_description_and_body() {
        let md = to_command_markdown("Review the diff", "Review {focus} carefully.");
        let parsed = parse_command_markdown("review-diff", &md);
        assert_eq!(parsed.name, "review-diff");
        assert_eq!(parsed.description.as_deref(), Some("Review the diff"));
        assert_eq!(parsed.body, "Review {focus} carefully.");
    }

    #[test]
    fn parse_tolerates_missing_frontmatter() {
        let parsed = parse_command_markdown("plain", "Just a body.\nTwo lines.");
        assert_eq!(parsed.description, None);
        assert_eq!(parsed.body, "Just a body.\nTwo lines.");
    }

    #[test]
    fn parse_tolerates_unknown_frontmatter_keys_and_unclosed_fence() {
        let parsed = parse_command_markdown(
            "odd",
            "---\nmodel: opus\ndescription: Hi\nargument-hint: x\n---\nBody",
        );
        assert_eq!(parsed.description.as_deref(), Some("Hi"));
        assert_eq!(parsed.body, "Body");
        // Unclosed frontmatter: treat the whole content as body, never error.
        let unclosed = parse_command_markdown("odd2", "---\ndescription: Hi\nBody");
        assert_eq!(unclosed.body, "---\ndescription: Hi\nBody");
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p kriyon-core prompt_files`
Expected: compile FAIL — module missing.

- [ ] **Step 3: Implement `prompt_files.rs`** (pure string logic; add `pub mod prompt_files;` to `crates/kriyon-core/src/lib.rs` keeping alphabetical order):

```rust
//! Reading and writing `.claude/commands/*.md` files — the [Promote] and
//! import halves of the prompt library's slash-command interop. Pure string
//! logic; the Tauri layer owns filesystem access.

/// A command file parsed tolerantly: unknown or malformed structure degrades
/// to "everything is the body" — parsing never errors.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedCommand {
    pub name: String,
    pub description: Option<String>,
    pub body: String,
}

/// A valid command file stem: lowercase slug, starts alphanumeric, max 64.
#[must_use]
pub fn valid_command_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 64 {
        return false;
    }
    let mut chars = name.chars();
    let first = chars.next().unwrap_or(' ');
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// Render a [Saved prompt] as command-file markdown with a `description`
/// frontmatter line (the format Claude Code's slash commands read).
#[must_use]
pub fn to_command_markdown(description: &str, body: &str) -> String {
    format!("---\ndescription: {description}\n---\n{body}")
}

/// Parse a command file. Frontmatter is optional; only `description` is read;
/// unknown keys are ignored; an unclosed fence degrades to body-only.
#[must_use]
pub fn parse_command_markdown(name: &str, content: &str) -> ParsedCommand {
    let mut description = None;
    let mut body = content;
    if let Some(rest) = content.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---\n") {
            let (front, after) = rest.split_at(end);
            for line in front.lines() {
                if let Some(value) = line.strip_prefix("description:") {
                    description = Some(value.trim().to_string());
                }
            }
            body = &after["\n---\n".len()..];
        }
    }
    ParsedCommand {
        name: name.to_string(),
        description,
        body: body.trim_start_matches('\n').trim_end().to_string(),
    }
}
```

- [ ] **Step 4: Run kriyon-core tests**

Run: `cargo test -p kriyon-core prompt_files`
Expected: 4 tests PASS.

- [ ] **Step 5: Write failing command-layer tests** — `commands.rs` has no test module for the persistence section; add filesystem tests to `store.rs`? No — put them in a new `#[cfg(test)] mod prompt_command_tests` at the bottom of `commands.rs` testing the path-resolution helper directly (the `#[tauri::command]` wrappers can't be constructed in tests). First add the helper being tested (Step 6 shows it); the tests:

```rust
#[cfg(test)]
mod prompt_command_tests {
    use super::commands_dir_for;
    use std::path::Path;

    #[test]
    fn global_scope_resolves_under_home() {
        let dir = commands_dir_for(Path::new("/home/u"), None).expect("global");
        assert_eq!(dir, Path::new("/home/u/.claude/commands"));
    }

    #[test]
    fn project_scope_resolves_under_project_path() {
        let dir =
            commands_dir_for(Path::new("/home/u"), Some(Path::new("/repo"))).expect("project");
        assert_eq!(dir, Path::new("/repo/.claude/commands"));
    }
}
```

- [ ] **Step 6: Implement the Tauri commands** — in `commands.rs`, after `record_prompt_use`:

```rust
/// Resolve the `.claude/commands` directory for a scope: the user's home
/// (global) or a project root. Pure path math; callers create the dir.
fn commands_dir_for(home: &Path, project_path: Option<&Path>) -> Option<PathBuf> {
    let base = project_path.map_or_else(|| home.to_path_buf(), Path::to_path_buf);
    Some(base.join(".claude").join("commands"))
}

/// Resolve HOME via Tauri, mirroring `seed_prompt`.
fn resolve_home(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager as _;
    app.path()
        .home_dir()
        .ok()
        .or_else(|| std::env::var("HOME").ok().map(PathBuf::from))
        .ok_or_else(|| "cannot resolve HOME".to_string())
}

/// Look up a persisted project's root path by id — the trust-boundary step:
/// the frontend sends an id, never a path.
fn project_path_by_id(
    store: &tauri::State<'_, StoreState>,
    project_id: &str,
) -> Result<PathBuf, String> {
    let projects = store.0.lock().list_projects().map_err(|e| e.to_string())?;
    projects
        .into_iter()
        .find(|p| p.id == project_id)
        .map(|p| PathBuf::from(p.path))
        .ok_or_else(|| "unknown project".to_string())
}

/// [Promote] a [Saved prompt] to a `.claude/commands/<name>.md` slash command.
/// `project_id = None` targets the global `~/.claude/commands`. The name is
/// validated as a slug before it touches the path; refuses to overwrite unless
/// `overwrite` is set. Resolves to the written file's absolute path.
///
/// # Errors
/// Returns an error string for an invalid name, unknown project, existing file
/// without `overwrite`, or a filesystem failure.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn promote_prompt_to_command(
    app: tauri::AppHandle,
    store: tauri::State<'_, StoreState>,
    project_id: Option<String>,
    name: String,
    description: String,
    body: String,
    overwrite: bool,
) -> Result<String, String> {
    if !kriyon_core::prompt_files::valid_command_name(&name) {
        return Err("invalid command name".to_string());
    }
    let home = resolve_home(&app)?;
    let project = project_id
        .map(|id| project_path_by_id(&store, &id))
        .transpose()?;
    let dir = commands_dir_for(&home, project.as_deref())
        .ok_or_else(|| "cannot resolve commands dir".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{name}.md"));
    if path.exists() && !overwrite {
        return Err(format!("/{name} already exists"));
    }
    let content = kriyon_core::prompt_files::to_command_markdown(&description, &body);
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// One command file read by [`import_commands`] (mirrors `ParsedCommand`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedCommand {
    pub name: String,
    pub description: Option<String>,
    pub body: String,
}

/// Read every `.claude/commands/*.md` in a scope into parsed prompts, for
/// import into the library. Malformed files degrade per-file (tolerant parse);
/// a missing directory is an empty list, never an error.
///
/// # Errors
/// Returns an error string only for an unknown project id.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn import_commands(
    app: tauri::AppHandle,
    store: tauri::State<'_, StoreState>,
    project_id: Option<String>,
) -> Result<Vec<ImportedCommand>, String> {
    let home = resolve_home(&app)?;
    let project = project_id
        .map(|id| project_path_by_id(&store, &id))
        .transpose()?;
    let dir = commands_dir_for(&home, project.as_deref())
        .ok_or_else(|| "cannot resolve commands dir".to_string())?;
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut imported = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue; // Unreadable file: per-file skip, never fail the batch.
        };
        let parsed = kriyon_core::prompt_files::parse_command_markdown(stem, &content);
        imported.push(ImportedCommand {
            name: parsed.name,
            description: parsed.description,
            body: parsed.body,
        });
    }
    Ok(imported)
}
```

Check the imports at the top of `commands.rs` — `Path`, `PathBuf`, and `Serialize` are already imported for other commands; add whatever the compiler reports missing. Register both commands in `lib.rs` after `commands::record_prompt_use`:

```rust
commands::promote_prompt_to_command,
commands::import_commands,
```

- [ ] **Step 7: Run the tests**

Run: `cargo test -p kriyon prompt_command_tests && cargo clippy -p kriyon --all-targets -- -D warnings`
Expected: 2 tests PASS, clippy clean.

- [ ] **Step 8: Add bridge bindings** — in `bridge.ts` persistence section:

```ts
/** One `.claude/commands/*.md` file parsed for import (mirrors Rust ImportedCommand). */
export interface ImportedCommand {
  body: string;
  description: string | null;
  name: string;
}

/**
 * [Promote] a saved prompt to a `.claude/commands/<name>.md` slash command.
 * `projectId = null` targets the global `~/.claude/commands`. Resolves to the
 * written file's absolute path.
 */
export function promotePromptToCommand(
  projectId: string | null,
  name: string,
  description: string,
  body: string,
  overwrite: boolean
): Promise<string> {
  return invoke("promote_prompt_to_command", {
    body,
    description,
    name,
    overwrite,
    projectId,
  });
}

/** Read a scope's `.claude/commands/*.md` files for import into the library. */
export function importCommands(
  projectId: string | null
): Promise<ImportedCommand[]> {
  return invoke("import_commands", { projectId });
}
```

- [ ] **Step 9: Verify and commit**

```bash
pnpm fix && pnpm typecheck && cargo fmt
git add crates/kriyon-core/src/prompt_files.rs crates/kriyon-core/src/lib.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src/ipc/bridge.ts
git commit -m "feat(prompts): promote/import interop with .claude/commands"
```

---

### Task 4: Placeholders — pure parse/resolve module

**Files:**
- Create: `src/prompts/placeholders.ts`
- Test: `src/prompts/placeholders.test.ts`

**Interfaces:**
- Produces (used by Task 9):

```ts
export const CLIPBOARD_PLACEHOLDER = "clipboard";
/** Unique {name} placeholders in body order, excluding {clipboard}. */
export function parsePlaceholders(body: string): string[];
/** Fill {name} slots from values and {clipboard} from clipboardText. Unknown names resolve to "". */
export function resolvePlaceholders(body: string, values: Record<string, string>, clipboardText: string): string;
```

- [ ] **Step 1: Write the failing tests** — `src/prompts/placeholders.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parsePlaceholders, resolvePlaceholders } from "./placeholders.ts";

describe("parsePlaceholders", () => {
  it("finds unique names in order, excluding clipboard", () => {
    const body = "Review {focus} in {file} — again {focus}. Use {clipboard}.";
    expect(parsePlaceholders(body)).toEqual(["focus", "file"]);
  });

  it("returns empty for a body without placeholders", () => {
    expect(parsePlaceholders("plain text { not a placeholder ")).toEqual([]);
  });

  it("ignores multi-line and empty braces", () => {
    expect(parsePlaceholders("a {} b {\nx} c {ok-name_2}")).toEqual([
      "ok-name_2",
    ]);
  });
});

describe("resolvePlaceholders", () => {
  it("fills named values and clipboard", () => {
    const body = "Fix {bug} using {clipboard}";
    expect(resolvePlaceholders(body, { bug: "the race" }, "pasted")).toBe(
      "Fix the race using pasted"
    );
  });

  it("repeated names share one value; unknown names become empty", () => {
    expect(resolvePlaceholders("{a}+{a}+{b}", { a: "x" }, "")).toBe("x+x+");
  });

  it("leaves brace-less text untouched", () => {
    expect(resolvePlaceholders("no slots", {}, "clip")).toBe("no slots");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/prompts/placeholders.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/prompts/placeholders.ts`:

```ts
/**
 * [Placeholder] parsing and resolution for [Saved prompt]s: `{name}` slots
 * filled via inline fields in the [Prompt picker] at insert time, plus the
 * reserved `{clipboard}` that resolves silently from the pasteboard.
 * Pure functions — no UI, no IPC.
 */

export const CLIPBOARD_PLACEHOLDER = "clipboard";

/** `{name}`: one line, letters/digits/dash/underscore/space, non-empty. */
const PLACEHOLDER_RE = /\{([\w- ]+)\}/g;

/** Unique `{name}` placeholders in body order, excluding `{clipboard}`. */
export function parsePlaceholders(body: string): string[] {
  const names: string[] = [];
  for (const match of body.matchAll(PLACEHOLDER_RE)) {
    const name = match[1];
    if (name !== CLIPBOARD_PLACEHOLDER && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Fill `{name}` slots from `values` and `{clipboard}` from `clipboardText`.
 * A name with no provided value resolves to the empty string.
 */
export function resolvePlaceholders(
  body: string,
  values: Record<string, string>,
  clipboardText: string
): string {
  return body.replaceAll(PLACEHOLDER_RE, (_whole, name: string) =>
    name === CLIPBOARD_PLACEHOLDER ? clipboardText : (values[name] ?? "")
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/prompts/placeholders.test.ts`
Expected: 6 tests PASS. (Note: the "multi-line and empty braces" test constrains the regex — `[\w- ]` must not match `\n`; if it fails, the regex is wrong, not the test.)

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/prompts/placeholders.ts src/prompts/placeholders.test.ts
git commit -m "feat(prompts): placeholder parse/resolve module"
```

---

### Task 5: Composer draft store + PromptBar refactor

**Files:**
- Create: `src/state/drafts.ts`
- Test: `src/state/drafts.test.ts`
- Modify: `src/layout/PromptBar.tsx`

**Interfaces:**
- Produces (used by Task 9):

```ts
export interface InsertRequest { seq: number; sessionId: string; text: string }
interface DraftsState {
  clearInsertRequest: () => void;
  drafts: Record<string, string>;
  insertRequest: InsertRequest | null;
  requestInsert: (sessionId: string, text: string) => void; // picker → composer
  setDraft: (sessionId: string, text: string) => void;
}
export const useDrafts: UseBoundStore<StoreApi<DraftsState>>;
```

- [ ] **Step 1: Write the failing store tests** — `src/state/drafts.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useDrafts } from "./drafts.ts";

describe("useDrafts", () => {
  beforeEach(() => {
    useDrafts.setState({ drafts: {}, insertRequest: null });
  });

  it("keeps one draft per session", () => {
    useDrafts.getState().setDraft("s1", "hello");
    useDrafts.getState().setDraft("s2", "other");
    expect(useDrafts.getState().drafts).toEqual({ s1: "hello", s2: "other" });
  });

  it("requestInsert targets a session and bumps seq so repeats re-fire", () => {
    useDrafts.getState().requestInsert("s1", "snippet");
    const first = useDrafts.getState().insertRequest;
    expect(first).toMatchObject({ sessionId: "s1", text: "snippet" });
    useDrafts.getState().requestInsert("s1", "snippet");
    const second = useDrafts.getState().insertRequest;
    expect(second?.seq).not.toBe(first?.seq);
  });

  it("clearInsertRequest resets the request", () => {
    useDrafts.getState().requestInsert("s1", "x");
    useDrafts.getState().clearInsertRequest();
    expect(useDrafts.getState().insertRequest).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/state/drafts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/state/drafts.ts`:

```ts
import { create } from "zustand";

/**
 * The per-session [Composer draft]: unsent composer text, lifted out of
 * PromptBar so the [Prompt picker] can insert into it. `insertRequest` is a
 * one-shot mailbox: the picker posts text for a session; the mounted PromptBar
 * consumes it (inserting at the caret) and clears it. `seq` makes identical
 * consecutive requests distinguishable.
 */
export interface InsertRequest {
  seq: number;
  sessionId: string;
  text: string;
}

interface DraftsState {
  clearInsertRequest: () => void;
  drafts: Record<string, string>;
  insertRequest: InsertRequest | null;
  requestInsert: (sessionId: string, text: string) => void;
  setDraft: (sessionId: string, text: string) => void;
}

let nextSeq = 1;

export const useDrafts = create<DraftsState>((set) => ({
  drafts: {},
  insertRequest: null,
  setDraft: (sessionId, text) =>
    set((state) => ({ drafts: { ...state.drafts, [sessionId]: text } })),
  requestInsert: (sessionId, text) => {
    nextSeq += 1;
    set({ insertRequest: { seq: nextSeq, sessionId, text } });
  },
  clearInsertRequest: () => set({ insertRequest: null }),
}));
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/state/drafts.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Refactor PromptBar onto the store.** In `src/layout/PromptBar.tsx`:

Replace `const [value, setValue] = useState("")` with:

```ts
const value = useDrafts((state) =>
  activeSessionId ? (state.drafts[activeSessionId] ?? "") : ""
);
const setDraft = useDrafts((state) => state.setDraft);
const insertRequest = useDrafts((state) => state.insertRequest);
const clearInsertRequest = useDrafts((state) => state.clearInsertRequest);
```

Every `setValue(x)` becomes `activeSessionId && setDraft(activeSessionId, x)` (the textarea is disabled-equivalent with no active session — `canSend` already guards send; for onChange, guard with `if (activeSessionId)`). `setValue("")` in `send()` becomes `setDraft(id, "")`.

Add the insert-consumer effect (imports: `useEffect` from react):

```ts
// Consume a Prompt-picker insert: splice at the caret, refocus, resize.
useEffect(() => {
  if (!insertRequest || insertRequest.sessionId !== activeSessionId) {
    return;
  }
  const el = ref.current;
  const start = el?.selectionStart ?? value.length;
  const end = el?.selectionEnd ?? value.length;
  const next = value.slice(0, start) + insertRequest.text + value.slice(end);
  setDraft(activeSessionId, next);
  clearInsertRequest();
  requestAnimationFrame(() => {
    autosize();
    el?.focus();
    const caret = start + insertRequest.text.length;
    el?.setSelectionRange(caret, caret);
  });
}, [insertRequest]); // eslint-disable-line react-hooks/exhaustive-deps -- one-shot mailbox: only the request should trigger
```

(If Biome rejects the suppression comment style, restructure: read `value`, `activeSessionId`, `setDraft`, `clearInsertRequest` via `useDrafts.getState()`/`useSessions.getState()` inside the effect so `insertRequest` is genuinely the only dependency.)

- [ ] **Step 6: Add a PromptBar behavior test** — there is no `PromptBar.test.tsx` today; create `src/layout/PromptBar.test.tsx`, following the render pattern of `src/spawn/SpawnDialog.test.tsx` (jsdom + @testing-library/react — read that file first and mirror its setup/mocks; mock `../ipc/bridge.ts` with `vi.mock` providing `writeStdin: vi.fn()`):

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDrafts } from "../state/drafts.ts";
import { useSessions } from "../state/sessions.ts";
import { PromptBar } from "./PromptBar.tsx";

vi.mock("../ipc/bridge.ts", () => ({
  writeStdin: vi.fn(() => Promise.resolve()),
}));

describe("PromptBar drafts", () => {
  beforeEach(() => {
    useDrafts.setState({ drafts: {}, insertRequest: null });
    useSessions.setState({ activeSessionId: "s1" });
  });

  it("binds the textarea to the active session's draft", () => {
    useDrafts.getState().setDraft("s1", "saved text");
    render(<PromptBar />);
    expect(screen.getByLabelText("Message the session")).toHaveValue(
      "saved text"
    );
  });

  it("consumes an insert request into the draft and clears it", async () => {
    render(<PromptBar />);
    const area = screen.getByLabelText("Message the session");
    fireEvent.change(area, { target: { value: "before " } });
    useDrafts.getState().requestInsert("s1", "INSERTED");
    await vi.waitFor(() => {
      expect(useDrafts.getState().drafts.s1).toContain("INSERTED");
    });
    expect(useDrafts.getState().insertRequest).toBeNull();
  });

  it("keeps separate drafts per session when switching", () => {
    useDrafts.getState().setDraft("s1", "one");
    useDrafts.getState().setDraft("s2", "two");
    const { rerender } = render(<PromptBar />);
    useSessions.setState({ activeSessionId: "s2" });
    rerender(<PromptBar />);
    expect(screen.getByLabelText("Message the session")).toHaveValue("two");
  });
});
```

Adjust `useSessions.setState` seeding to whatever minimal shape `PromptBar` reads (it also reads `state.events[id]` — undefined is fine). If `toHaveValue` matchers aren't configured, use `(area as HTMLTextAreaElement).value` assertions instead — mirror what existing component tests do.

- [ ] **Step 7: Run the tests, then the whole suite (this refactor touches the composer — protect existing behavior)**

Run: `pnpm vitest run src/layout/PromptBar.test.tsx src/state/drafts.test.ts && pnpm test`
Expected: all PASS (304 pre-existing + new).

- [ ] **Step 8: Commit**

```bash
pnpm fix
git add src/state/drafts.ts src/state/drafts.test.ts src/layout/PromptBar.tsx src/layout/PromptBar.test.tsx
git commit -m "feat(prompts): lift composer draft into shared per-session store"
```

---

### Task 6: UI store — picker/editor open state + mutual exclusivity

**Files:**
- Modify: `src/state/ui.ts`
- Test: `src/state/ui.test.ts` (extend)

**Interfaces:**
- Produces (used by Tasks 8–10):

```ts
/** Prefill for the Prompt editor: no id = creating a new Saved prompt. */
export interface PromptEditorSeed { body: string; id?: string; tags: string[]; title: string }
// New UiState fields:
promptPickerOpen: boolean;
openPromptPicker: () => void;
closePromptPicker: () => void;
promptEditorSeed: PromptEditorSeed | null;   // non-null = editor open
openPromptEditor: (seed: PromptEditorSeed) => void;
closePromptEditor: () => void;
```

- [ ] **Step 1: Write the failing tests** — extend `src/state/ui.test.ts` (read it first; mirror its reset pattern):

```ts
describe("prompt picker exclusivity", () => {
  it("openPromptPicker closes palette, spawn, and needs-you", () => {
    useUi.getState().openPalette();
    useUi.getState().openPromptPicker();
    const state = useUi.getState();
    expect(state.promptPickerOpen).toBe(true);
    expect(state.paletteOpen).toBe(false);
    expect(state.needsYouOpen).toBe(false);
    expect(state.spawnOpen).toBe(false);
  });

  it("opening any other surface closes the picker and editor", () => {
    useUi.getState().openPromptPicker();
    useUi.getState().openPalette();
    expect(useUi.getState().promptPickerOpen).toBe(false);
    useUi
      .getState()
      .openPromptEditor({ body: "b", tags: [], title: "t" });
    useUi.getState().openNeedsYou();
    expect(useUi.getState().promptEditorSeed).toBeNull();
  });

  it("editor seed round-trips through open/close", () => {
    useUi
      .getState()
      .openPromptEditor({ body: "b", id: "p1", tags: ["x"], title: "t" });
    expect(useUi.getState().promptEditorSeed?.id).toBe("p1");
    useUi.getState().closePromptEditor();
    expect(useUi.getState().promptEditorSeed).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/state/ui.test.ts`
Expected: FAIL — `openPromptPicker` not a function.

- [ ] **Step 3: Implement in `ui.ts`.** Add the fields to `UiState` (alphabetical, matching the file's style) plus the `PromptEditorSeed` export. Every existing `open*` gains `promptPickerOpen: false, promptEditorSeed: null`, and the new ones close everything else:

```ts
openPromptPicker: () =>
  set({
    needsYouOpen: false,
    paletteOpen: false,
    promptEditorSeed: null,
    promptPickerOpen: true,
    spawnOpen: false,
  }),
closePromptPicker: () => set({ promptPickerOpen: false }),
openPromptEditor: (seed) =>
  set({
    needsYouOpen: false,
    paletteOpen: false,
    promptEditorSeed: seed,
    promptPickerOpen: false,
    spawnOpen: false,
  }),
closePromptEditor: () => set({ promptEditorSeed: null }),
```

Update `openPalette`, `openNeedsYou`, `openSpawn`, and `togglePalette` to also reset `promptPickerOpen: false, promptEditorSeed: null` (in `togglePalette`, only when opening). Update the mutual-exclusivity comment to name all five surfaces.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/state/ui.test.ts`
Expected: PASS (old + 3 new).

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/state/ui.ts src/state/ui.test.ts
git commit -m "feat(prompts): picker/editor ui state joins overlay exclusivity"
```

---

### Task 7: `usePromptLibrary` store + hydrate + QA hook

**Files:**
- Create: `src/state/promptLibrary.ts`
- Test: `src/state/promptLibrary.test.ts`
- Modify: `src/state/persistence.ts` (hydrate loads prompts)
- Modify: `src/dev/qaHook.ts`

**Interfaces:**
- Consumes: `upsertPrompt/listPrompts/deletePrompt/recordPromptUse` (Task 2), `SavedPrompt` (Task 2).
- Produces (used by Tasks 8–10):

```ts
interface PromptLibraryState {
  prompts: SavedPrompt[];
  remove: (id: string) => void;                 // optimistic + deletePrompt IPC
  save: (prompt: SavedPrompt) => void;          // optimistic upsert + upsertPrompt IPC
  setPrompts: (prompts: SavedPrompt[]) => void; // hydrate
  markUsed: (id: string, nowMs: number) => void;// optimistic + recordPromptUse IPC
  toggleFavourite: (id: string, nowMs: number) => void; // save() with flipped flag
}
export const usePromptLibrary: UseBoundStore<StoreApi<PromptLibraryState>>;
/** Favourites first, then most-recently/most-used, then title. Exported for the picker. */
export function orderPrompts(prompts: SavedPrompt[]): SavedPrompt[];
```

- [ ] **Step 1: Write the failing tests** — `src/state/promptLibrary.test.ts`. Mock the bridge:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedPrompt } from "../types.ts";
import { orderPrompts, usePromptLibrary } from "./promptLibrary.ts";

vi.mock("../ipc/bridge.ts", () => ({
  deletePrompt: vi.fn(() => Promise.resolve()),
  listPrompts: vi.fn(() => Promise.resolve([])),
  recordPromptUse: vi.fn(() => Promise.resolve()),
  upsertPrompt: vi.fn(() => Promise.resolve()),
}));

function prompt(over: Partial<SavedPrompt>): SavedPrompt {
  return {
    body: "body",
    createdMs: 1,
    favourite: false,
    id: "p1",
    lastUsedMs: null,
    tags: [],
    title: "title",
    updatedMs: 1,
    useCount: 0,
    ...over,
  };
}

describe("usePromptLibrary", () => {
  beforeEach(() => {
    usePromptLibrary.setState({ prompts: [] });
    vi.clearAllMocks();
  });

  it("save upserts optimistically and calls the bridge", async () => {
    const bridge = await import("../ipc/bridge.ts");
    usePromptLibrary.getState().save(prompt({}));
    usePromptLibrary.getState().save(prompt({ title: "renamed" }));
    expect(usePromptLibrary.getState().prompts).toHaveLength(1);
    expect(usePromptLibrary.getState().prompts[0].title).toBe("renamed");
    expect(bridge.upsertPrompt).toHaveBeenCalledTimes(2);
  });

  it("remove deletes optimistically and calls the bridge", async () => {
    const bridge = await import("../ipc/bridge.ts");
    usePromptLibrary.setState({ prompts: [prompt({})] });
    usePromptLibrary.getState().remove("p1");
    expect(usePromptLibrary.getState().prompts).toEqual([]);
    expect(bridge.deletePrompt).toHaveBeenCalledWith("p1");
  });

  it("markUsed bumps count/time optimistically and calls the bridge", async () => {
    const bridge = await import("../ipc/bridge.ts");
    usePromptLibrary.setState({ prompts: [prompt({})] });
    usePromptLibrary.getState().markUsed("p1", 9_000);
    const updated = usePromptLibrary.getState().prompts[0];
    expect(updated.useCount).toBe(1);
    expect(updated.lastUsedMs).toBe(9_000);
    expect(bridge.recordPromptUse).toHaveBeenCalledWith("p1");
  });

  it("toggleFavourite flips the flag through save", () => {
    usePromptLibrary.setState({ prompts: [prompt({})] });
    usePromptLibrary.getState().toggleFavourite("p1", 9_000);
    expect(usePromptLibrary.getState().prompts[0].favourite).toBe(true);
  });
});

describe("orderPrompts", () => {
  it("orders favourites first, then recent use, then title", () => {
    const ordered = orderPrompts([
      prompt({ id: "c", title: "c zebra" }),
      prompt({ id: "b", lastUsedMs: 100, title: "b used" }),
      prompt({ favourite: true, id: "a", title: "a fav" }),
      prompt({ id: "d", title: "a alpha" }),
    ]);
    expect(ordered.map((p) => p.id)).toEqual(["a", "b", "d", "c"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/state/promptLibrary.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/state/promptLibrary.ts`:

```ts
import { create } from "zustand";
import {
  deletePrompt,
  recordPromptUse,
  upsertPrompt,
} from "../ipc/bridge.ts";
import type { SavedPrompt } from "../types.ts";

/**
 * The prompt library: every [Saved prompt], hydrated from SQLite at boot.
 * Mutations apply optimistically and fire-and-forget the IPC write — the
 * store is the UI's source of truth between hydrates.
 */
interface PromptLibraryState {
  markUsed: (id: string, nowMs: number) => void;
  prompts: SavedPrompt[];
  remove: (id: string) => void;
  save: (prompt: SavedPrompt) => void;
  setPrompts: (prompts: SavedPrompt[]) => void;
  toggleFavourite: (id: string, nowMs: number) => void;
}

function ignore(promise: Promise<unknown>): void {
  promise.catch(() => {
    // Fire-and-forget IPC; persistence errors are non-fatal.
  });
}

export const usePromptLibrary = create<PromptLibraryState>((set, get) => ({
  prompts: [],
  setPrompts: (prompts) => set({ prompts }),
  save: (prompt) => {
    set((state) => {
      const rest = state.prompts.filter((p) => p.id !== prompt.id);
      return { prompts: [...rest, prompt] };
    });
    ignore(upsertPrompt(prompt));
  },
  remove: (id) => {
    set((state) => ({ prompts: state.prompts.filter((p) => p.id !== id) }));
    ignore(deletePrompt(id));
  },
  markUsed: (id, nowMs) => {
    set((state) => ({
      prompts: state.prompts.map((p) =>
        p.id === id
          ? { ...p, lastUsedMs: nowMs, useCount: p.useCount + 1 }
          : p
      ),
    }));
    ignore(recordPromptUse(id));
  },
  toggleFavourite: (id, nowMs) => {
    const existing = get().prompts.find((p) => p.id === id);
    if (existing) {
      get().save({ ...existing, favourite: !existing.favourite, updatedMs: nowMs });
    }
  },
}));

/**
 * Picker default order: favourites first, then most-recently-used, then most
 * used, then title — cheap frecency without a decay model.
 */
export function orderPrompts(prompts: SavedPrompt[]): SavedPrompt[] {
  return [...prompts].sort(
    (a, b) =>
      Number(b.favourite) - Number(a.favourite) ||
      (b.lastUsedMs ?? 0) - (a.lastUsedMs ?? 0) ||
      b.useCount - a.useCount ||
      a.title.localeCompare(b.title)
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/state/promptLibrary.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Hydrate + QA hook.** In `src/state/persistence.ts`: import `listPrompts` from the bridge and `usePromptLibrary` from `./promptLibrary.ts`; extend `hydrate()`'s `Promise.all` to also `listPrompts()`, then `usePromptLibrary.getState().setPrompts(prompts)`. Extend the existing test in `src/state/persistence.test.ts` that covers `hydrate()` (read it; add `listPrompts` to its bridge mock returning one sample prompt, and assert `usePromptLibrary.getState().prompts` contains it).

In `src/dev/qaHook.ts`: add `usePromptLibrary` and `useDrafts` to the imports, the type literal, and the assigned object, mentioning prompts in the doc comment.

- [ ] **Step 6: Run to verify pass**

Run: `pnpm vitest run src/state/persistence.test.ts src/state/promptLibrary.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm fix
git add src/state/promptLibrary.ts src/state/promptLibrary.test.ts src/state/persistence.ts src/state/persistence.test.ts src/dev/qaHook.ts
git commit -m "feat(prompts): prompt library store, hydration, QA seam"
```

---

### Task 8: PromptEditor dialog (save / edit / delete / promote)

**Files:**
- Create: `src/prompts/PromptEditor.tsx`
- Test: `src/prompts/PromptEditor.test.tsx`

**Interfaces:**
- Consumes: `useUi.promptEditorSeed/closePromptEditor` (Task 6), `usePromptLibrary.save/remove` (Task 7), `promotePromptToCommand` (Task 3), `showToast` from `src/ui/Toast.tsx`, `useSessions` (active session → its `projectId` for project-scope promote).
- Produces: `export function PromptEditor(): JSX.Element | null` — mounted in `Shell.tsx` (Task 10). Also `export function slugify(title: string): string` (promote default name; used only here but exported for tests).

**Behavior spec:**
- Renders only when `promptEditorSeed !== null`. Fields: title `<input>` (autofocused), body `<textarea rows={8}>` (plain text, monospace via `tokens.font.mono`), tags `<input>` (comma-separated, split/trimmed/deduped on save). No other metadata.
- Overlay/backdrop/panel: copy the style objects from `SpawnDialog.tsx` verbatim (`overlayStyle`/`backdropStyle`/`panelStyle` — same tokens; there is deliberately no shared Modal primitive in this codebase yet). `data-testid="prompt-editor"` on the panel.
- Keyboard: window keydown effect like `SpawnDialog.tsx:242-258` — Escape closes, ⌘/Ctrl+Enter saves.
- Save (button "Save prompt", disabled while title or body is blank): builds a `SavedPrompt` — `id: seed.id ?? crypto.randomUUID()`, `createdMs`: existing prompt's when editing else `Date.now()`, `updatedMs: Date.now()`, preserving `favourite/useCount/lastUsedMs` when editing (look the existing prompt up in `usePromptLibrary` by `seed.id`) — calls `save`, then `closePromptEditor()`.
- Delete (button, only when `seed.id` set): first click arms ("Really delete?"), second calls `remove(seed.id)` + close (two-click confirm, no window.confirm — blocking dialogs are banned in this app).
- Promote (button "Promote to /command", enabled when title+body non-blank): a small inline `<select>` chooses Global / `<active project name>` (project option only when an active session exists). Click calls `promotePromptToCommand(projectIdOrNull, slugify(title), title, body, false)`; on success `showToast(`Wrote ${path}`)`; on an "already exists" error, re-call once with `overwrite: true` after arming the button the same two-click way ("Overwrite /name?"); other errors → `showToast(message)`.
- `slugify(title)`: lowercase → non `[a-z0-9]` runs → `-` → trim `-` → truncate 64 → fallback `"prompt"` when empty.

- [ ] **Step 1: Write failing tests** — `src/prompts/PromptEditor.test.tsx`. Mock `../ipc/bridge.ts` (all prompt fns + `promotePromptToCommand: vi.fn(() => Promise.resolve("/tmp/x.md"))`) and mock `../ui/Toast.tsx` (`showToast: vi.fn()`). Reset `useUi`/`usePromptLibrary` state in `beforeEach`. Tests:

```tsx
it("renders nothing while closed", ...);              // seed null → queryByTestId("prompt-editor") is null
it("saves a new prompt from the seed", ...);          // open with seed {title:"T", body:"B", tags:["a"]}, click "Save prompt", expect usePromptLibrary prompts[0] matches + editor closed
it("editing preserves identity and stats", ...);      // seed with id of an existing favourite prompt, save, expect same id, favourite still true, useCount preserved
it("delete requires an armed second click", ...);     // first click leaves prompt, second removes and closes
it("slugify produces command-safe names", () => {
  expect(slugify("Review the Diff!")).toBe("review-the-diff");
  expect(slugify("  ")).toBe("prompt");
});
it("promote calls the bridge with the slug and toasts the path", ...); // click promote, await, expect promotePromptToCommand called with (null, "t", "T", "B", false)
```

Write each fully (render `<PromptEditor />`, drive with `fireEvent`/`screen`, follow `SpawnDialog.test.tsx` idioms for async assertions).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/prompts/PromptEditor.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `PromptEditor.tsx`** per the behavior spec. Structure sketch (fill in with SpawnDialog's real style objects and the repo's exact idioms):

```tsx
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug.length > 0 ? slug : "prompt";
}

export function PromptEditor() {
  const seed = useUi((state) => state.promptEditorSeed);
  const close = useUi((state) => state.closePromptEditor);
  // local field state initialised from seed via key={} remount or useEffect on seed
  ...
  if (!seed) { return null; }
  return ( <div style={overlayStyle}> ...backdrop button... <div style={panelStyle} data-testid="prompt-editor"> ...fields, footer buttons... </div> </div> );
}
```

Initialise field state with `useState(seed.title)` etc. and remount on seed change by rendering `<PromptEditorForm key={formKey} seed={seed} />` where `formKey` is `seed.id ?? "new"` — the pattern avoids stale fields when a different prompt opens.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/prompts/PromptEditor.test.tsx`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/prompts/PromptEditor.tsx src/prompts/PromptEditor.test.tsx
git commit -m "feat(prompts): prompt editor dialog with save/delete/promote"
```

---

### Task 9: PromptPicker overlay (⌘⇧P → search → fill → insert)

**Files:**
- Create: `src/prompts/PromptPicker.tsx`
- Test: `src/prompts/PromptPicker.test.tsx`

**Interfaces:**
- Consumes: `useUi.promptPickerOpen/openPromptPicker/closePromptPicker/openPromptEditor` (Task 6), `usePromptLibrary` + `orderPrompts` (Task 7), `parsePlaceholders/resolvePlaceholders` (Task 4), `useDrafts.requestInsert` (Task 5), `useSessions` (active session id).
- Produces: `export function PromptPicker(): JSX.Element | null` — mounted in `Shell.tsx` (Task 10).

**Behavior spec:**
- Global hotkey: window keydown, `(metaKey || ctrlKey) && shiftKey && key.toLowerCase() === "p"` → preventDefault + `openPromptPicker()` (mirror `CommandPalette.tsx:230-245`).
- Renders only while `promptPickerOpen`. Overlay/backdrop/panel/search-row/list styles copied from `CommandPalette.tsx` (same tokens), panel widened to `min(700px, 92vw)` with a two-column body: list (flex 1) + preview pane (`width: 260px`, `borderLeft: 1px solid tokens.color.line.soft`, monospace body preview with `whiteSpace: "pre-wrap"`, showing the highlighted prompt's full body and tag chips; placeholders rendered highlighted by splitting on the placeholder regex and wrapping matches in an accent-colored `<span>`). `data-testid="prompt-picker"`.
- Two stages, one component state machine: `stage: "search" | "fill"`.
  - **search**: pre-focused input filters `orderPrompts(prompts)` by needle over `title` + `tags.join(" ")` + `body` (lowercased substring, like the palette). ↑↓ moves highlight (clamped), Enter picks. Esc closes. Row = title (labelStyle) + tag chips (subStyle) + star `★` when favourite (accent color). Empty library shows an empty state with the copy: `No saved prompts yet — save one from the composer, or import your /commands from the palette.`
  - Picking a prompt with `parsePlaceholders(body).length === 0`: resolve `{clipboard}` if present (`navigator.clipboard.readText().catch(() => "")`), `requestInsert(activeSessionId, resolved)`, `markUsed(id, Date.now())`, `closePromptPicker()`. With no active session, do nothing but close.
  - Picking a prompt with placeholders → `stage = "fill"`: the search row is replaced by one input per placeholder name (labelled with the name), Tab/Shift-Tab natural focus order, Enter on the last field (or ⌘Enter anywhere) resolves and inserts as above; Esc returns to search stage.
- Row hover sets highlight (like the palette). Secondary actions while searching: ⌘F toggles favourite on the highlighted prompt, ⌘E opens it in the editor (`openPromptEditor({ body, id, tags, title })`), ⌘⌫ (Backspace with meta) removes it after an armed repeat (first press flags the row "confirm ⌘⌫", second deletes) — all handled in the input's onKeyDown.

- [ ] **Step 1: Write failing tests** — `src/prompts/PromptPicker.test.tsx`, mocking the bridge as in Task 7's test and seeding `usePromptLibrary`/`useSessions`/`useUi` state directly. Cover:

```tsx
it("renders nothing while closed", ...);
it("filters by title and tag and orders favourites first", ...);
it("Enter on a plain prompt inserts into the draft mailbox, marks use, closes", async () => {
  // seed prompts + activeSessionId "s1"; open; press Enter
  // expect useDrafts.getState().insertRequest to match {sessionId:"s1", text: body}
  // expect useCount bumped; promptPickerOpen false
});
it("a templated prompt enters fill stage and resolves fields", async () => {
  // body "Fix {bug} in {file}"; Enter → two labelled inputs; type values; Enter on last
  // expect insertRequest.text === "Fix the-race in store.rs"
});
it("cmd+F toggles favourite; cmd+E opens the editor seeded", ...);
it("escape in fill stage returns to search; escape in search closes", ...);
```

Write each fully. For clipboard: `Object.defineProperty(navigator, "clipboard", { value: { readText: () => Promise.resolve("clip") }, configurable: true })` in a `beforeEach` (jsdom has none).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/prompts/PromptPicker.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `PromptPicker.tsx`** per the behavior spec, reusing the palette's style objects and keyboard idioms. Keep the two stages in one component; extract nothing to new files (one caller — YAGNI).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/prompts/PromptPicker.test.tsx`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
pnpm fix
git add src/prompts/PromptPicker.tsx src/prompts/PromptPicker.test.tsx
git commit -m "feat(prompts): prompt picker overlay with placeholder fill"
```

---

### Task 10: Wire-up — palette verbs, save-last-prompt, import, Shell mount, full check

**Files:**
- Modify: `src/palette/CommandPalette.tsx` (`buildItems` command array)
- Modify: `src/layout/Shell.tsx` (mount `<PromptPicker />` and `<PromptEditor />` next to `<CommandPalette />`, around line 407)
- Test: `src/palette/CommandPalette.test.tsx` (extend)

**Interfaces:**
- Consumes: everything above. No new exports.

**Behavior:**
- New `commandItems` entries (after `cmd:spawn-worktree`):

```ts
{
  icon: "❯",
  id: "cmd:insert-prompt",
  kind: "Prompts",
  label: "Insert prompt…",
  run: () => useUi.getState().openPromptPicker(),
  sub: "⌘⇧P",
},
{
  icon: "✦",
  id: "cmd:save-last-prompt",
  kind: "Prompts",
  label: "Save last prompt…",
  run: () => {
    const { activeSessionId, events } = useSessions.getState();
    const list = activeSessionId ? (events[activeSessionId] ?? []) : [];
    const last = [...list].reverse().find((e) => e.kind === "prompt");
    if (last?.kind === "prompt") {
      useUi.getState().openPromptEditor({
        body: last.text,
        tags: [],
        title: last.text.split("\n")[0].slice(0, 60),
      });
    }
  },
},
{
  icon: "⇲",
  id: "cmd:import-commands",
  kind: "Prompts",
  label: "Import prompts from /commands…",
  run: () => {
    importPromptsFromCommands();
  },
},
```

- `importPromptsFromCommands()` — a small exported helper in `src/state/promptLibrary.ts` (it owns library mutations): fetch `importCommands(null)` and, when the active session has a project, `importCommands(projectId)`; flatten; for each `ImportedCommand` whose `name` does not case-insensitively match an existing prompt's `title`, `save()` a new `SavedPrompt` (`id: crypto.randomUUID()`, `title: imported.description ?? imported.name`, `body`, `tags: ["imported"]`, timestamps `Date.now()`, zero stats); finish with `showToast(`Imported ${added} prompt${added === 1 ? "" : "s"}${skipped ? ` (${skipped} already in library)` : ""}`)`. Errors → `showToast(String(error))`. Dedup key is the imported **name vs title** match so re-import stays idempotent for untouched imports.
- `events` StudioEvent union member used above is `{ kind: "prompt"; text: string }` (see `src/types.ts:170`).

- [ ] **Step 1: Write failing tests.** Extend `CommandPalette.test.tsx`: typing "prompt" surfaces both verbs; running "Insert prompt…" sets `promptPickerOpen`; running "Save last prompt…" with a seeded prompt event opens the editor with that text. Add an `importPromptsFromCommands` test to `src/state/promptLibrary.test.ts`: mock `importCommands` to return `[{ body: "B", description: "Review", name: "review" }]`, expect a saved prompt titled "Review" tagged `imported`, and a second call to add nothing.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/palette/CommandPalette.test.tsx src/state/promptLibrary.test.ts`
Expected: new tests FAIL.

- [ ] **Step 3: Implement** — palette items, `importPromptsFromCommands` in `promptLibrary.ts`, and mount both components in `Shell.tsx`:

```tsx
<CommandPalette />
<PromptPicker />
<PromptEditor />
```

- [ ] **Step 4: Run to verify pass, then the full local gate**

Run: `pnpm vitest run src/palette/CommandPalette.test.tsx src/state/promptLibrary.test.ts`
Expected: PASS.

Run: `pnpm check`
Expected: lint, typecheck, 300+ frontend tests, rust fmt/clippy/tests — all green.

- [ ] **Step 5: Commit**

```bash
git add src/palette/CommandPalette.tsx src/layout/Shell.tsx src/palette/CommandPalette.test.tsx src/state/promptLibrary.ts src/state/promptLibrary.test.ts
git commit -m "feat(prompts): palette verbs, command import, shell mount"
```

---

## Execution notes for the orchestrator

- Task order: 1 → 2 → 3 (Rust chain), 4/5/6 independent of Rust (4 and 6 can run in parallel with 2/3; 5 touches PromptBar only), 7 needs 2+6, 8 needs 3+6+7, 9 needs 4+5+6+7, 10 needs all.
- Every implementer subagent must be told: worktree path `/Users/dev/Projects/kriyon/.claude/worktrees/prompt-library`, branch `feat/prompt-library`, stage named files only, `pnpm fix` before committing TS, and the spec/plan paths.
- The pre-push hook runs the full suite; nothing is pushed until the user asks.
