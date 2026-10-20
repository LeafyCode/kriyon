//! The [Saved prompt] command family: library CRUD over the `SQLite` store, plus
//! [Promote]/import against `.claude/commands/*.md`. `promote_prompt_to_command`
//! and `import_commands` are the two commands that cross from the store into
//! the filesystem — the name is validated as a slug before it ever touches a
//! path, and a scope resolves to either the user's home (global) or a
//! project's root via [`project_path_by_id`], the trust-boundary step that
//! turns a frontend-supplied project id into a real path.

use std::path::{Path, PathBuf};

use crate::commands::resolve_home;
use crate::store::PromptRow;
use crate::StoreState;

/// Insert or update a [Saved prompt] in the prompt library.
///
/// # Errors
/// Returns an error string if the database write fails.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn upsert_prompt(store: tauri::State<'_, StoreState>, prompt: PromptRow) -> Result<(), String> {
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

/// Resolve the `.claude/commands` directory for a scope: the user's home
/// (global) or a project root. Pure path math; callers create the dir.
// `Option` (never `None` today) matches the two call sites, which treat a
// missing commands dir as a possible future case (e.g. an unresolvable root).
#[allow(clippy::unnecessary_wraps)]
fn commands_dir_for(home: &Path, project_path: Option<&Path>) -> Option<PathBuf> {
    let base = project_path.map_or_else(|| home.to_path_buf(), Path::to_path_buf);
    Some(base.join(".claude").join("commands"))
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
#[derive(Clone, Debug, serde::Serialize)]
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
// `(async)` — this reads a whole directory, one `read_to_string` per file, with
// no cap (unlike the catalog build's `CATALOG_CAP`), and the prompt library
// calls it twice on open (global + project scope). On the main thread that is a
// visible stall on a large `.claude/commands` dir.
#[tauri::command(async)]
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
