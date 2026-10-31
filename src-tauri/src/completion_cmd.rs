//! Composer completions (Tauri layer): build the slash-command + agent catalog
//! from disk (static built-ins, user/project `.claude/{commands,skills,agents}`,
//! and every enabled plugin's dirs) and walk the project tree for `@` mentions.
//! No `claude` process is ever spawned — enumeration is pure filesystem, so a
//! warmup costs nothing and never sends a message to Claude. Pure merge/parse
//! logic lives in `kriyon_core::completion`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use kriyon_core::completion::{
    merge_commands, parse_frontmatter, parse_plugin_manifest, path_within_roots, Frontmatter,
    SlashCommand, BUILTIN_AGENTS, BUILTIN_COMMANDS,
};

use crate::StoreState;

/// Safety bound on how many command/skill files one catalog build will read, so
/// a pathological plugin tree can't make a warmup walk unbounded.
const CATALOG_CAP: usize = 4000;

/// Recursively collect `*.md` command files under `dir`, naming each by its path
/// relative to `dir` without the extension (nested dirs namespaced with `:`),
/// carrying `prefix` (empty for user/project, `"<plugin>:"` for a plugin). Reads
/// each file's frontmatter. A missing `dir` contributes nothing.
fn collect_commands(dir: &Path, prefix: &str, out: &mut Vec<(String, Frontmatter)>) {
    for entry in ignore::WalkBuilder::new(dir)
        .standard_filters(false) // `.claude` dirs aren't git-scoped; read every `.md`
        .build()
        .filter_map(Result::ok)
    {
        if out.len() >= CATALOG_CAP {
            break;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Ok(rel) = path.strip_prefix(dir) else {
            continue;
        };
        let stem = rel.with_extension("");
        let name = format!("{prefix}{}", stem.to_string_lossy().replace('/', ":"));
        let frontmatter = std::fs::read_to_string(path)
            .map(|c| parse_frontmatter(&c))
            .unwrap_or_default();
        out.push((name, frontmatter));
    }
}

/// Collect `<dir>/<name>/SKILL.md` skills — each exposed as the slash command
/// `<prefix><name>` — with the skill's frontmatter description. One level deep,
/// matching how the CLI resolves skills.
fn collect_skills(dir: &Path, prefix: &str, out: &mut Vec<(String, Frontmatter)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= CATALOG_CAP {
            break;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if let Ok(content) = std::fs::read_to_string(entry.path().join("SKILL.md")) {
            out.push((format!("{prefix}{name}"), parse_frontmatter(&content)));
        }
    }
}

/// Collect `*.md` agent definitions in `dir`, each named `<prefix><stem>`.
fn collect_agents(dir: &Path, prefix: &str, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            out.push(format!("{prefix}{stem}"));
        }
    }
}

/// The `(short_name, install_path)` of every ENABLED plugin, read from
/// `~/.claude/plugins/installed_plugins.json`. Short name is the part before
/// `@`. Tolerant: a missing or malformed file yields no plugins. Reading the
/// enabled set (rather than globbing every marketplace/cache dir) is what keeps
/// disabled and duplicated plugins out of the catalog.
fn enabled_plugins(home: &Path) -> Vec<(String, PathBuf)> {
    let path = home
        .join(".claude")
        .join("plugins")
        .join("installed_plugins.json");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
        return Vec::new();
    };
    let Some(plugins) = value.get("plugins").and_then(serde_json::Value::as_object) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (key, installs) in plugins {
        let short = key.split('@').next().unwrap_or(key).to_string();
        let install_path = installs.as_array().and_then(|records| {
            records
                .iter()
                .find_map(|r| r.get("installPath").and_then(serde_json::Value::as_str))
        });
        if let Some(install_path) = install_path {
            out.push((short, PathBuf::from(install_path)));
        }
    }
    out
}

/// Resolve a plugin component directory: the manifest's relative override when
/// present, else the default `<install_path>/<default>` subdirectory.
fn plugin_dir(install_path: &Path, override_rel: Option<&str>, default: &str) -> PathBuf {
    override_rel.map_or_else(|| install_path.join(default), |rel| install_path.join(rel))
}

/// Build the composer's slash-command + agent catalog entirely from disk — no
/// `claude` process, no network, no cost, no message ever sent to Claude.
/// Sources: the static built-in commands, user + project
/// `.claude/{commands,skills,agents}`, and each enabled plugin's resolved
/// `{commands,skills,agents}` dirs. User/project entries win a name clash over a
/// plugin's (first-wins dedup, user scope before project before plugins).
fn build_catalog(home: &Path, cwd: &Path) -> CommandCatalog {
    let mut command_pairs: Vec<(String, Frontmatter)> = Vec::new();
    let mut agents: Vec<String> = Vec::new();

    // User then project scope, unprefixed.
    for base in [home.join(".claude"), cwd.join(".claude")] {
        collect_commands(&base.join("commands"), "", &mut command_pairs);
        collect_skills(&base.join("skills"), "", &mut command_pairs);
        collect_agents(&base.join("agents"), "", &mut agents);
    }

    // Every enabled plugin, namespaced `<plugin>:<name>`.
    for (name, install_path) in enabled_plugins(home) {
        let manifest =
            std::fs::read_to_string(install_path.join(".claude-plugin").join("plugin.json"))
                .map(|c| parse_plugin_manifest(&c))
                .unwrap_or_default();
        let prefix = format!("{name}:");
        collect_commands(
            &plugin_dir(&install_path, manifest.commands_dir.as_deref(), "commands"),
            &prefix,
            &mut command_pairs,
        );
        collect_skills(
            &plugin_dir(&install_path, manifest.skills_dir.as_deref(), "skills"),
            &prefix,
            &mut command_pairs,
        );
        collect_agents(
            &plugin_dir(&install_path, manifest.agents_dir.as_deref(), "agents"),
            &prefix,
            &mut agents,
        );
    }

    // Built-in command names must appear even with no file on disk;
    // `merge_commands` supplies their static descriptions. A disk entry with the
    // same name overrides (it carries `described` frontmatter → Custom source).
    let mut described: HashMap<String, Frontmatter> = HashMap::new();
    for (name, frontmatter) in command_pairs {
        described.entry(name).or_insert(frontmatter); // first (user/project) wins
    }
    let mut names: Vec<String> = BUILTIN_COMMANDS
        .iter()
        .map(|b| b.name.to_string())
        .collect();
    names.extend(described.keys().cloned());

    for builtin in BUILTIN_AGENTS {
        agents.push((*builtin).to_string());
    }
    agents.sort();
    agents.dedup();

    CommandCatalog {
        commands: merge_commands(&names, &described, BUILTIN_COMMANDS),
        agents,
        claude_version: None,
        degraded: false,
    }
}

/// Every directory the composer is allowed to touch: each persisted project
/// root, session cwd, and session worktree path, canonicalized (entries whose
/// path no longer resolves are dropped). The IPC trust-boundary allowlist that
/// [`validate_cwd`] checks a frontend-supplied `cwd` against.
pub(crate) fn known_roots(store: &StoreState) -> Vec<PathBuf> {
    // The store lock is scoped to the queries alone. Canonicalizing is one
    // `realpath` syscall per root, and this runs on every `@`-mention keystroke
    // (via `list_files`) — holding the mutex across that loop parked every
    // main-thread store command (`list_sessions`, `save_layout`,
    // `session_snapshots`, the tray poll) behind a pile of filesystem calls.
    let roots: Vec<PathBuf> = {
        let store = store.0.lock();
        let mut roots: Vec<PathBuf> = Vec::new();
        if let Ok(projects) = store.list_projects() {
            roots.extend(projects.into_iter().map(|p| PathBuf::from(p.path)));
        }
        if let Ok(sessions) = store.list_sessions() {
            for s in sessions {
                roots.push(PathBuf::from(s.cwd));
                if let Some(w) = s.worktree_path {
                    roots.push(PathBuf::from(w));
                }
            }
        }
        roots
    };
    roots
        .into_iter()
        .filter_map(|r| r.canonicalize().ok())
        .collect()
}

/// How much of `~/.claude/history.jsonl` is read: the newest part is what
/// the Up arrow reaches.
const HISTORY_TAIL: u64 = 4 * 1024 * 1024;

/// The most prompts the composer's Up arrow walks back through.
const HISTORY_LIMIT: usize = 200;

/// The [Prompt history] of a session's folder, newest first: every prompt the
/// CLI took there, typed in the terminal or sent from the composer.
///
/// # Errors
/// When `cwd` isn't a known session or project folder, or HOME is unknown.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
pub fn prompt_history(
    app: tauri::AppHandle,
    store: tauri::State<'_, StoreState>,
    cwd: String,
) -> Result<Vec<String>, String> {
    validate_cwd(store.inner(), Path::new(&cwd))?;
    let home = crate::commands::resolve_home(&app)?;
    let lines = crate::status_rt::read_tail_lines(
        &home.join(".claude").join("history.jsonl"),
        HISTORY_TAIL,
    );
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    // Claude Code records the folder it was started in, as given.
    Ok(kriyon_core::prompt_history::recent_prompts(
        &refs,
        cwd.trim_end_matches('/'),
        HISTORY_LIMIT,
    ))
}

/// Validate a frontend-supplied `cwd` before any filesystem walk or process
/// spawn: it must canonicalize to an existing directory that is (or sits inside)
/// a known session/project root. Returns the canonical path so callers act on
/// the resolved directory, never the raw string. This enforces the AGENTS.md
/// IPC trust-boundary rule — never walk or spawn in a blindly-trusted path.
///
/// # Errors
/// `cwd is not a directory` when the path does not resolve to a directory;
/// `cwd is not a known session or project root` when it resolves but falls
/// outside every registered root.
pub(crate) fn validate_cwd(store: &StoreState, cwd: &Path) -> Result<PathBuf, String> {
    let canonical = cwd
        .canonicalize()
        .map_err(|_| "cwd is not a directory".to_string())?;
    if !canonical.is_dir() {
        return Err("cwd is not a directory".to_string());
    }
    if path_within_roots(&canonical, &known_roots(store)) {
        Ok(canonical)
    } else {
        Err("cwd is not a known session or project root".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_catalog_merges_user_project_plugins_and_builtins() {
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();

        // User command + skill + agent.
        let user_cmd = home.path().join(".claude/commands");
        std::fs::create_dir_all(&user_cmd).unwrap();
        std::fs::write(
            user_cmd.join("deploy.md"),
            "---\ndescription: Ship it\n---\n",
        )
        .unwrap();
        let user_skill = home.path().join(".claude/skills/refactor");
        std::fs::create_dir_all(&user_skill).unwrap();
        std::fs::write(
            user_skill.join("SKILL.md"),
            "---\ndescription: Refactor code\n---\n",
        )
        .unwrap();
        let user_agents = home.path().join(".claude/agents");
        std::fs::create_dir_all(&user_agents).unwrap();
        std::fs::write(user_agents.join("scout.md"), "").unwrap();

        // Project command.
        let proj_cmd = cwd.path().join(".claude/commands");
        std::fs::create_dir_all(&proj_cmd).unwrap();
        std::fs::write(proj_cmd.join("localonly.md"), "").unwrap();

        // An enabled plugin: install dir + installed_plugins.json entry.
        let install = home.path().join(".claude/plugins/cache/acme/1.0.0");
        std::fs::create_dir_all(install.join("skills/widget")).unwrap();
        std::fs::write(
            install.join("skills/widget/SKILL.md"),
            "---\ndescription: A widget\n---\n",
        )
        .unwrap();
        std::fs::create_dir_all(install.join("commands")).unwrap();
        std::fs::write(install.join("commands/build.md"), "").unwrap();
        std::fs::write(
            home.path().join(".claude/plugins/installed_plugins.json"),
            format!(
                r#"{{"version":2,"plugins":{{"acme@market":[{{"installPath":"{}"}}]}}}}"#,
                install.to_string_lossy()
            ),
        )
        .unwrap();

        let cat = build_catalog(home.path(), cwd.path());
        let names: Vec<&str> = cat.commands.iter().map(|c| c.name.as_str()).collect();

        assert!(names.contains(&"deploy"), "user command");
        assert!(names.contains(&"refactor"), "user skill");
        assert!(names.contains(&"localonly"), "project command");
        assert!(names.contains(&"acme:widget"), "plugin skill, namespaced");
        assert!(names.contains(&"acme:build"), "plugin command, namespaced");
        assert!(names.contains(&"clear"), "non-interactive builtin");
        assert!(names.contains(&"model"), "interactive-only builtin");

        assert!(cat.agents.contains(&"scout".to_string()), "user agent");
        assert!(
            cat.agents.contains(&"general-purpose".to_string()),
            "builtin agent"
        );

        let deploy = cat.commands.iter().find(|c| c.name == "deploy").unwrap();
        assert_eq!(deploy.description.as_deref(), Some("Ship it"));
        assert!(!cat.degraded);
    }

    #[test]
    fn build_catalog_excludes_plugins_absent_from_installed_json() {
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        // A plugin's files exist on disk, but with no installed_plugins.json it
        // is not enabled → its skills must NOT appear (the over-report guard).
        let orphan = home
            .path()
            .join(".claude/plugins/cache/ghost/1.0.0/skills/haunt");
        std::fs::create_dir_all(&orphan).unwrap();
        std::fs::write(orphan.join("SKILL.md"), "---\ndescription: boo\n---\n").unwrap();

        let cat = build_catalog(home.path(), cwd.path());
        assert!(!cat.commands.iter().any(|c| c.name.contains("haunt")));
    }

    /// Build a fixture with a `.gitignore` (no `.git` dir — the walked root is
    /// NOT a real git repo) covering `ignored.txt` and `build/`, plus files
    /// that should survive: `keep_me.rs`, `src/keep_two.rs`.
    fn gitignore_fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join(".gitignore"), "ignored.txt\nbuild/\n").unwrap();
        std::fs::write(root.join("keep_me.rs"), "").unwrap();
        std::fs::write(root.join("ignored.txt"), "").unwrap();
        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::write(root.join("src").join("keep_two.rs"), "").unwrap();
        std::fs::create_dir(root.join("build")).unwrap();
        std::fs::write(root.join("build").join("artifact.txt"), "").unwrap();
        dir
    }

    #[test]
    fn list_files_respects_gitignore_outside_a_git_repo() {
        let dir = gitignore_fixture();
        let root = dir.path();

        // Empty query: exclusion must hold independent of any query
        // substring match (a query like "keep" would vacuously pass even
        // without gitignore support, since "ignored.txt" doesn't contain
        // "keep").
        let all = walk_files(root, "");
        let paths: Vec<&str> = all.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"keep_me.rs"));
        assert!(!paths.iter().any(|p| p.contains("ignored")));
        assert!(!paths.iter().any(|p| p.contains("build")));
    }

    #[test]
    fn list_files_filters_by_query() {
        let dir = gitignore_fixture();
        let root = dir.path();

        let matched = walk_files(root, "keep");
        let paths: Vec<&str> = matched.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"keep_me.rs"));
        assert!(paths.iter().any(|p| p.ends_with("keep_two.rs")));
        assert_eq!(paths.len(), 2);
    }

    #[test]
    fn list_files_caps_results() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for i in 0..60 {
            std::fs::write(root.join(format!("f{i:02}.txt")), "").unwrap();
        }

        let matched = walk_files(root, "f");
        assert_eq!(matched.len(), FILE_CAP);
    }

    #[test]
    fn walk_files_sorts_dirs_before_files_and_matches_case_insensitively() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // A file that sorts alphabetically BEFORE the directory, so only the
        // dirs-first rule (not lexicographic order) can put the dir on top.
        std::fs::write(root.join("aaa_MATCH.txt"), "").unwrap();
        std::fs::create_dir(root.join("zzz_match")).unwrap();

        // Uppercase query against lowercase/mixed paths → case-insensitive hit.
        let out = walk_files(root, "MATCH");
        assert_eq!(out.len(), 2);
        assert!(out[0].is_dir, "directories sort before files");
        assert_eq!(out[0].path, "zzz_match");
        assert_eq!(out[1].path, "aaa_MATCH.txt");
    }

    use parking_lot::Mutex;

    fn store_with_project_root(path: &str) -> StoreState {
        let store = crate::store::Store::open_in_memory().unwrap();
        store
            .upsert_project(&crate::store::ProjectRow {
                id: "p1".into(),
                name: "proj".into(),
                path: path.to_string(),
                color: None,
                setup_command: None,
            })
            .unwrap();
        StoreState(Mutex::new(store))
    }

    #[test]
    fn validate_cwd_accepts_a_known_root_and_its_descendants() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("sub")).unwrap();
        let state = store_with_project_root(&root.to_string_lossy());

        assert_eq!(validate_cwd(&state, &root).unwrap(), root);
        assert_eq!(
            validate_cwd(&state, &root.join("sub")).unwrap(),
            root.join("sub").canonicalize().unwrap()
        );
    }

    #[test]
    fn validate_cwd_rejects_a_dir_outside_every_known_root() {
        // A real, existing directory that was never registered as a root.
        let outside = tempfile::tempdir().unwrap();
        let registered = tempfile::tempdir().unwrap();
        let state = store_with_project_root(&registered.path().to_string_lossy());
        let err = validate_cwd(&state, outside.path()).unwrap_err();
        assert_eq!(err, "cwd is not a known session or project root");
    }

    #[test]
    fn validate_cwd_rejects_a_nonexistent_path() {
        let state = store_with_project_root("/tmp");
        let err = validate_cwd(&state, Path::new("/no/such/dir/anywhere")).unwrap_err();
        assert_eq!(err, "cwd is not a directory");
    }
}

/// The composer's slash-command catalog: merged commands and agent names for
/// `@agent-…`. `claude_version` is always `None` and `degraded` always `false`
/// now that the catalog is built from disk (no probe to fall back from); both
/// fields are retained for the TS IPC mirror.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCatalog {
    pub commands: Vec<SlashCommand>,
    pub agents: Vec<String>,
    pub claude_version: Option<String>,
    pub degraded: bool,
}

/// The composer's slash-command catalog for a working directory, built entirely
/// from disk (static built-ins + user/project `.claude` dirs + enabled plugins).
/// No `claude` process is spawned, so a warmup costs nothing and never sends a
/// message to Claude.
///
/// # Errors
/// Returns an error string if HOME cannot be resolved, or if `cwd` is not a
/// known session/project directory (the IPC trust-boundary check).
#[allow(clippy::needless_pass_by_value)]
// `(async)` for the same reason as `list_files`: a non-async command runs on
// the main thread, and this one walks every enabled plugin dir and reads up to
// `CATALOG_CAP` markdown files. With a large plugin set that is hundreds of
// milliseconds warm and seconds cold — a visible whole-app stall each time a
// session in an uncached cwd is opened.
#[tauri::command(async)]
pub fn list_slash_commands(
    app: tauri::AppHandle,
    store: tauri::State<'_, StoreState>,
    cwd: String,
) -> Result<CommandCatalog, String> {
    let home = crate::commands::resolve_home(&app)?;
    let cwd_path = validate_cwd(store.inner(), Path::new(&cwd))?;
    Ok(build_catalog(&home, &cwd_path))
}

/// One `@`-mention completion candidate: a path relative to the session cwd.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub is_dir: bool,
}

const FILE_CAP: usize = 50;

/// How many directory entries one `@`-mention walk may visit before giving up.
/// Generous enough to cover an ordinary repo whole (a large source tree is a
/// few tens of thousands of entries) while putting a ceiling on the pathological
/// case — an unignored `Pods`/`DerivedData`/`node_modules` under the session
/// cwd, where a full walk is ~89k entries and hundreds of milliseconds.
/// A truncated walk can miss a deep match; a walk with no ceiling burns that
/// cost on every keystroke.
const WALK_VISIT_CAP: usize = 20_000;

/// Walk `root` (gitignore-respecting, `.git` skipped), keeping entries whose
/// relative path contains `query` (case-insensitive). Directories sort before
/// files, then lexicographically; capped at `FILE_CAP`.
fn walk_files(root: &Path, query: &str) -> Vec<FileEntry> {
    let needle = query.to_lowercase();
    let mut out: Vec<FileEntry> = ignore::WalkBuilder::new(root)
        .hidden(false) // show dotfiles; .gitignore still hides ignored ones
        .git_ignore(true)
        .git_global(true)
        // `require_git` defaults to true, which makes WalkBuilder apply
        // .gitignore/.ignore rules ONLY when `root` sits inside a real git
        // repo (has a `.git`). Session cwds are often not git repos, and the
        // feature's intent is to respect .gitignore regardless — so disable
        // that requirement.
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build()
        .filter_map(Result::ok)
        // Bounds entries *visited*, which is the only thing that bounds the
        // walk. The cap used to sit after the query filter, where it bounds
        // matches instead: a selective query matches few entries, so the take
        // was never satisfied and the walk ran to the end of the tree every
        // time. On a cwd with a large unignored build dir that is the whole
        // difference between a bounded read and ~89k stat calls per keystroke.
        .take(WALK_VISIT_CAP)
        .filter_map(|entry| {
            let rel = entry.path().strip_prefix(root).ok()?;
            if rel.as_os_str().is_empty() {
                return None; // skip the root itself
            }
            let path = rel.to_string_lossy().to_string();
            if !needle.is_empty() && !path.to_lowercase().contains(&needle) {
                return None;
            }
            let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
            Some(FileEntry { path, is_dir })
        })
        .collect();

    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.path.cmp(&b.path),
    });
    out.truncate(FILE_CAP);
    out
}

/// Filesystem completions for `@` mentions, relative to a session's `cwd`.
///
/// # Errors
/// Returns an error string if `cwd` is not a known session/project directory
/// (the IPC trust-boundary check — the caller sends a session cwd, and we
/// confirm it against the persisted roots rather than blindly walking any path).
#[allow(clippy::needless_pass_by_value)]
// `(async)` is load-bearing, not decoration: a plain `#[tauri::command]` on a
// non-async fn runs on the **main thread**, which on macOS is the app's run
// loop. This command walks a whole directory tree and fires on every keystroke
// of an `@` mention, so on a large cwd (an iOS project with Pods/DerivedData
// unignored — ~89k files, ~400ms warm) it froze the entire window: no key
// events, no repaint, no terminal output, for as long as the walk took.
// `(async)` on a sync fn hands it to the async runtime's blocking pool.
#[tauri::command(async)]
pub fn list_files(
    store: tauri::State<'_, StoreState>,
    cwd: String,
    query: String,
) -> Result<Vec<FileEntry>, String> {
    let root = validate_cwd(store.inner(), Path::new(&cwd))?;
    Ok(walk_files(&root, &query))
}
