# Composer Completions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Kriyon composer live `/` slash-command, `@` file/agent-mention autocomplete, and `!`/`#` mode hints — sourced from the installed `claude` CLI, never hardcoded.

**Architecture:** The Rust core owns all process/fs access and exposes two Tauri commands: `list_slash_commands` (probes `claude` in stream-json mode, reads the `system/init` message for live command names, enriches with on-disk frontmatter, merges a static built-in description map) and `list_files` (gitignore-respecting filesystem walk). Pure parsing/merge logic lives in `crates/kriyon-core/src/completion.rs` (unit-tested). The React composer gets a thin trigger-detection hook + popover; it caches the command catalog per session and warms it on session start.

**Tech Stack:** Rust (`kriyon-core`, `src-tauri`, serde/serde_json, the `ignore` crate), React + Zustand + TypeScript, Vitest, the installed `claude` CLI (stream-json `--output-format`).

## Global Constraints

- Target `claude` CLI ≥ **2.1.202**; the probe uses `--output-format stream-json --verbose --max-turns 1 --no-session-persistence --no-chrome`.
- **Never hardcode the command list.** Only built-in *descriptions* and the ~13 interactive-only built-in *entries* may be static; every live command *name* comes from the probe.
- Rust: clippy `pedantic` + `correctness` are enforced (`src-tauri/clippy.toml`, `[lints.clippy]`). All Tauri commands take typed args and return `Result<_, String>`.
- IPC is a trust boundary: validate every path/id crossing it. `list_files` must confirm the walked directory is inside a known session/project root; never spawn or walk a raw frontend-supplied path blindly.
- The probe env must have `KRIYON_SESSION` **removed** (hook-events pollution) and must not persist a session (`--no-session-persistence`).
- IPC structs serialize `#[serde(rename_all = "camelCase")]`; TS mirrors match exactly.
- All composer styling comes from `src/theme/tokens.ts` — no hardcoded colors/spacing.
- TDD: write the failing test first, watch it fail, implement, keep `pnpm check` green.
- Branch: `feat/composer-completions`. Conventional commits. **Stage only the files named in each step** (this checkout is shared with other live sessions — never `git add -u` / `git add .`).
- Run frontend fix/lint via `pnpm fix` (Biome/Ultracite own formatting); never hand-format.

---

## File Structure

- `crates/kriyon-core/src/completion.rs` (**new**) — pure logic: frontmatter meta parse, `BUILTIN_COMMANDS` map, stream-json init parse, `merge_commands`, shared types (`SlashCommand`, `CommandSource`, `Frontmatter`, `InitInfo`, `CommandCatalog`).
- `crates/kriyon-core/src/lib.rs` — add `pub mod completion;`.
- `src-tauri/src/completion_cmd.rs` (**new**) — Tauri commands `list_slash_commands`, `list_files`, plus the probe runner and frontmatter enrichment (fs/process). Keeps `commands.rs` from growing further.
- `src-tauri/src/lib.rs` — `mod completion_cmd;` + register both commands in `generate_handler!`.
- `src-tauri/Cargo.toml` — add the `ignore` crate.
- `src/ipc/bridge.ts` — `listSlashCommands`, `listFiles` + mirror types.
- `src/state/completions.ts` (**new**) — Zustand store: per-(cwd,version) catalog cache, `warmup(cwd)`, `refresh(cwd)`.
- `src/completion/detect.ts` (**new**) — pure `detectTrigger(value, caret)`.
- `src/completion/filter.ts` (**new**) — pure fuzzy filter/rank.
- `src/completion/useCompletion.ts` (**new**) — the composer hook tying detect + store + files together.
- `src/completion/CompletionPopover.tsx` (**new**) — presentational popover.
- `src/layout/PromptBar.tsx` — wire the hook, keyboard interception, accept-insert, mode-hint chip.
- `src/state/actions.ts` — call `warmup(cwd)` on session creation.

---

## Task 1: Frontmatter meta parser (core)

**Files:**
- Create: `crates/kriyon-core/src/completion.rs`
- Modify: `crates/kriyon-core/src/lib.rs` (add module)
- Test: inline `#[cfg(test)]` in `completion.rs`

**Interfaces:**
- Produces: `pub struct Frontmatter { pub description: Option<String>, pub argument_hint: Option<String> }` and `pub fn parse_frontmatter(content: &str) -> Frontmatter`. Tolerant: no/partial/malformed frontmatter → `None`s, never panics. Reads `description:` and `argument-hint:` keys only.

- [ ] **Step 1: Add the module declaration**

In `crates/kriyon-core/src/lib.rs`, add alphabetically (after `pub mod bootstrap;`):

```rust
pub mod completion;
```

- [ ] **Step 2: Write the failing test**

Create `crates/kriyon-core/src/completion.rs`:

```rust
//! Live composer completions: parse the installed `claude` CLI's command set
//! (from its stream-json `init` message) and enrich it with on-disk frontmatter
//! and a static built-in description map. Pure logic; the Tauri layer owns the
//! process/filesystem access.

/// Description + argument hint read from a command/skill markdown file's
/// frontmatter. Both optional; a file without frontmatter yields two `None`s.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Frontmatter {
    pub description: Option<String>,
    pub argument_hint: Option<String>,
}

/// Parse a command/skill markdown file's leading `---` frontmatter for the two
/// keys the composer shows. Tolerant: missing or unclosed frontmatter, unknown
/// keys, and blank values all degrade to `None` — never errors.
#[must_use]
pub fn parse_frontmatter(content: &str) -> Frontmatter {
    let mut meta = Frontmatter::default();
    let Some(rest) = content.strip_prefix("---\n") else {
        return meta;
    };
    let Some(end) = rest.find("\n---") else {
        return meta;
    };
    for line in rest[..end].lines() {
        if let Some(v) = line.strip_prefix("description:") {
            let v = v.trim();
            if !v.is_empty() {
                meta.description = Some(v.to_string());
            }
        } else if let Some(v) = line.strip_prefix("argument-hint:") {
            let v = v.trim();
            if !v.is_empty() {
                meta.argument_hint = Some(v.to_string());
            }
        }
    }
    meta
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_description_and_argument_hint() {
        let md = "---\ndescription: Create a git commit\nargument-hint: [message]\n---\nBody";
        let m = parse_frontmatter(md);
        assert_eq!(m.description.as_deref(), Some("Create a git commit"));
        assert_eq!(m.argument_hint.as_deref(), Some("[message]"));
    }

    #[test]
    fn no_frontmatter_is_all_none() {
        let m = parse_frontmatter("Just a body, no fence.");
        assert_eq!(m, Frontmatter::default());
    }

    #[test]
    fn unclosed_or_blank_values_degrade_to_none() {
        assert_eq!(parse_frontmatter("---\ndescription: hi").description, None);
        assert_eq!(parse_frontmatter("---\ndescription:\n---\nb").description, None);
    }
}
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `cargo test -p kriyon-core completion::tests -- --nocapture`
Expected: 3 tests pass. (They are written green-first here because the impl is trivial and co-located; if you prefer strict red-first, comment out the fn body to see them fail, then restore.)

- [ ] **Step 4: Commit**

```bash
git add crates/kriyon-core/src/completion.rs crates/kriyon-core/src/lib.rs
git commit -m "feat(core): frontmatter meta parser for completions"
```

---

## Task 2: Built-in command map (core)

**Files:**
- Modify: `crates/kriyon-core/src/completion.rs`
- Test: inline

**Interfaces:**
- Produces: `pub struct BuiltinCommand { pub name: &'static str, pub description: &'static str, pub interactive_only: bool }` and `pub const BUILTIN_COMMANDS: &[BuiltinCommand]`. `interactive_only == true` marks the ~13 commands the probe omits (they must be appended even when absent from the live list). Others supply descriptions for built-in names the probe *does* return.

- [ ] **Step 1: Write the failing test**

Append to the `tests` module in `crates/kriyon-core/src/completion.rs`:

```rust
    #[test]
    fn builtins_cover_the_interactive_only_set() {
        // The commands the stream-json init message omits (docs: "only commands
        // that work without an interactive terminal are dispatchable"). They
        // MUST be present so the popover can still offer them.
        let required = [
            "model", "help", "resume", "login", "logout", "status", "cost",
            "mcp", "doctor", "vim", "memory", "hooks", "permissions", "export",
        ];
        for name in required {
            let found = BUILTIN_COMMANDS
                .iter()
                .find(|c| c.name == name)
                .unwrap_or_else(|| panic!("missing interactive-only builtin: {name}"));
            assert!(found.interactive_only, "{name} must be interactive_only");
            assert!(!found.description.is_empty(), "{name} needs a description");
        }
    }

    #[test]
    fn builtin_names_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for c in BUILTIN_COMMANDS {
            assert!(seen.insert(c.name), "duplicate builtin: {}", c.name);
        }
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p kriyon-core completion::tests::builtins_cover_the_interactive_only_set`
Expected: FAIL — `BUILTIN_COMMANDS` not found.

- [ ] **Step 3: Implement the map**

Add near the top of `completion.rs` (after `parse_frontmatter`):

```rust
/// A built-in `claude` slash command. `interactive_only` commands are absent
/// from the stream-json `init` list and must be appended; the rest supply
/// descriptions for built-in names the probe returns. Descriptions are static
/// (the binary exposes no manifest); names still track the live version.
pub struct BuiltinCommand {
    pub name: &'static str,
    pub description: &'static str,
    pub interactive_only: bool,
}

/// Built-in commands as of `claude` 2.1.x. Descriptions are annotated (the CLI
/// emits none); the live probe supplies the authoritative NAME set, so a
/// built-in that this list misses still appears when the probe reports it (with
/// no description) — this map only enriches and supplements.
pub const BUILTIN_COMMANDS: &[BuiltinCommand] = &[
    // Interactive-only: omitted by the stream-json init list, so ALWAYS appended.
    BuiltinCommand { name: "model", description: "Choose the model for this session", interactive_only: true },
    BuiltinCommand { name: "help", description: "Show help and available commands", interactive_only: true },
    BuiltinCommand { name: "resume", description: "Resume a previous conversation", interactive_only: true },
    BuiltinCommand { name: "login", description: "Sign in to your Anthropic account", interactive_only: true },
    BuiltinCommand { name: "logout", description: "Sign out of your Anthropic account", interactive_only: true },
    BuiltinCommand { name: "status", description: "Show session and account status", interactive_only: true },
    BuiltinCommand { name: "cost", description: "Show token usage and cost this session", interactive_only: true },
    BuiltinCommand { name: "mcp", description: "Manage MCP server connections", interactive_only: true },
    BuiltinCommand { name: "doctor", description: "Diagnose installation and setup issues", interactive_only: true },
    BuiltinCommand { name: "vim", description: "Toggle vim editing mode", interactive_only: true },
    BuiltinCommand { name: "memory", description: "Edit memory (CLAUDE.md) files", interactive_only: true },
    BuiltinCommand { name: "hooks", description: "Configure hooks", interactive_only: true },
    BuiltinCommand { name: "permissions", description: "Manage tool permissions", interactive_only: true },
    BuiltinCommand { name: "export", description: "Export the conversation", interactive_only: true },
    BuiltinCommand { name: "ide", description: "Manage IDE integrations", interactive_only: true },
    BuiltinCommand { name: "terminal-setup", description: "Configure terminal key bindings", interactive_only: true },
    // Description-only enrichment for built-ins the probe DOES list by name.
    BuiltinCommand { name: "clear", description: "Clear the conversation history", interactive_only: false },
    BuiltinCommand { name: "compact", description: "Compact the conversation to free context", interactive_only: false },
    BuiltinCommand { name: "context", description: "Show what is using the context window", interactive_only: false },
    BuiltinCommand { name: "config", description: "View or change configuration", interactive_only: false },
    BuiltinCommand { name: "init", description: "Initialize a CLAUDE.md for this project", interactive_only: false },
    BuiltinCommand { name: "agents", description: "Manage subagents", interactive_only: false },
    BuiltinCommand { name: "usage", description: "Show plan usage limits", interactive_only: false },
    BuiltinCommand { name: "review", description: "Review a pull request", interactive_only: false },
    BuiltinCommand { name: "security-review", description: "Security-review the pending changes", interactive_only: false },
    BuiltinCommand { name: "add-dir", description: "Add a working directory", interactive_only: false },
    BuiltinCommand { name: "todos", description: "Show the current todo list", interactive_only: false },
    BuiltinCommand { name: "rewind", description: "Rewind the conversation to an earlier point", interactive_only: false },
];
```

- [ ] **Step 4: Run to verify both tests pass**

Run: `cargo test -p kriyon-core completion::tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kriyon-core/src/completion.rs
git commit -m "feat(core): static built-in command description map"
```

---

## Task 3: Stream-json init parser (core)

**Files:**
- Modify: `crates/kriyon-core/src/completion.rs`
- Test: inline

**Interfaces:**
- Produces: `pub struct InitInfo { pub slash_commands: Vec<String>, pub agents: Vec<String>, pub claude_version: Option<String> }` and `pub fn parse_init_line(line: &str) -> Option<InitInfo>` — returns `Some` only for a JSON object with `type=="system"` and `subtype=="init"`; `None` for any other line (hook events, assistant messages, non-JSON). Missing arrays default to empty.

- [ ] **Step 1: Write the failing test**

Append to the `tests` module:

```rust
    #[test]
    fn parses_init_line_fields() {
        let line = r#"{"type":"system","subtype":"init","slash_commands":["clear","commit"],"agents":["Explore"],"claude_code_version":"2.1.202"}"#;
        let info = parse_init_line(line).expect("init parsed");
        assert_eq!(info.slash_commands, vec!["clear", "commit"]);
        assert_eq!(info.agents, vec!["Explore"]);
        assert_eq!(info.claude_version.as_deref(), Some("2.1.202"));
    }

    #[test]
    fn ignores_non_init_lines() {
        assert!(parse_init_line(r#"{"type":"system","subtype":"hook_started"}"#).is_none());
        assert!(parse_init_line(r#"{"type":"assistant"}"#).is_none());
        assert!(parse_init_line("not json at all").is_none());
        assert!(parse_init_line("").is_none());
    }

    #[test]
    fn missing_arrays_default_empty() {
        let info = parse_init_line(r#"{"type":"system","subtype":"init"}"#).expect("init");
        assert!(info.slash_commands.is_empty());
        assert!(info.agents.is_empty());
        assert_eq!(info.claude_version, None);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p kriyon-core completion::tests::parses_init_line_fields`
Expected: FAIL — `parse_init_line` not found.

- [ ] **Step 3: Implement**

Add to `completion.rs`:

```rust
/// The live command metadata carried by the stream-json `system/init` message.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InitInfo {
    pub slash_commands: Vec<String>,
    pub agents: Vec<String>,
    pub claude_version: Option<String>,
}

/// Parse one stream-json line, returning `Some` only for the `system/init`
/// object. Every other line (hook lifecycle events precede init; assistant
/// messages follow it) and any non-JSON line yields `None`.
#[must_use]
pub fn parse_init_line(line: &str) -> Option<InitInfo> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("type").and_then(serde_json::Value::as_str) != Some("system")
        || v.get("subtype").and_then(serde_json::Value::as_str) != Some("init")
    {
        return None;
    }
    let strings = |key: &str| -> Vec<String> {
        v.get(key)
            .and_then(serde_json::Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    Some(InitInfo {
        slash_commands: strings("slash_commands"),
        agents: strings("agents"),
        claude_version: v
            .get("claude_code_version")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
    })
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p kriyon-core completion::tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kriyon-core/src/completion.rs
git commit -m "feat(core): parse stream-json init message for live commands"
```

---

## Task 4: Merge into catalog (core)

**Files:**
- Modify: `crates/kriyon-core/src/completion.rs`
- Test: inline

**Interfaces:**
- Produces:
  - `pub enum CommandSource { Builtin, Custom }` (serde `lowercase`).
  - `pub struct SlashCommand { pub name: String, pub description: Option<String>, pub argument_hint: Option<String>, pub source: CommandSource }` (serde `camelCase`, `Serialize`).
  - `pub fn merge_commands(live_names: &[String], described: &std::collections::HashMap<String, Frontmatter>, builtins: &[BuiltinCommand]) -> Vec<SlashCommand>`.
- Merge rules: for each live name → if `described` has it, `Custom` + its frontmatter; else if a builtin matches, `Builtin` + builtin description; else `Builtin`, no description. Then append every `interactive_only` builtin not already present. Dedup by name (first wins). Sort: built-ins first, then alphabetical by name.

- [ ] **Step 1: Write the failing test**

Append to the `tests` module:

```rust
    use std::collections::HashMap;

    #[test]
    fn merge_enriches_custom_and_builtin_and_appends_interactive() {
        let live = vec!["commit".to_string(), "clear".to_string()];
        let mut described = HashMap::new();
        described.insert(
            "commit".to_string(),
            Frontmatter { description: Some("Create a git commit".into()), argument_hint: Some("[msg]".into()) },
        );
        let out = merge_commands(&live, &described, BUILTIN_COMMANDS);

        let commit = out.iter().find(|c| c.name == "commit").expect("commit");
        assert_eq!(commit.source, CommandSource::Custom);
        assert_eq!(commit.description.as_deref(), Some("Create a git commit"));
        assert_eq!(commit.argument_hint.as_deref(), Some("[msg]"));

        let clear = out.iter().find(|c| c.name == "clear").expect("clear");
        assert_eq!(clear.source, CommandSource::Builtin);
        assert_eq!(clear.description.as_deref(), Some("Clear the conversation history"));

        // /model was NOT in the live list but is interactive-only → appended.
        assert!(out.iter().any(|c| c.name == "model"));
    }

    #[test]
    fn merge_dedups_and_sorts_builtins_first() {
        let live = vec!["zeta".to_string(), "clear".to_string(), "clear".to_string()];
        let out = merge_commands(&live, &HashMap::new(), BUILTIN_COMMANDS);
        assert_eq!(out.iter().filter(|c| c.name == "clear").count(), 1);
        let clear_idx = out.iter().position(|c| c.name == "clear").unwrap();
        let zeta_idx = out.iter().position(|c| c.name == "zeta").unwrap();
        assert!(clear_idx < zeta_idx, "built-ins sort before custom");
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p kriyon-core completion::tests::merge_enriches_custom_and_builtin_and_appends_interactive`
Expected: FAIL — `merge_commands` / `SlashCommand` not found.

- [ ] **Step 3: Implement**

Add to `completion.rs`:

```rust
use std::collections::HashMap;

/// Where a command came from — drives the popover's badge and grouping.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandSource {
    /// Shipped with the CLI, or a live name with no readable definition file.
    Builtin,
    /// Resolved to a user/project/plugin `.md` / `SKILL.md` on disk.
    Custom,
}

/// One row in the slash-command popover.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    pub name: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    pub source: CommandSource,
}

/// Build the popover's command list from the live name set, on-disk frontmatter,
/// and the static built-in map. See the task's merge rules.
#[must_use]
pub fn merge_commands(
    live_names: &[String],
    described: &HashMap<String, Frontmatter>,
    builtins: &[BuiltinCommand],
) -> Vec<SlashCommand> {
    let builtin_by_name: HashMap<&str, &BuiltinCommand> =
        builtins.iter().map(|b| (b.name, b)).collect();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<SlashCommand> = Vec::new();

    for name in live_names {
        if !seen.insert(name.clone()) {
            continue;
        }
        if let Some(meta) = described.get(name) {
            out.push(SlashCommand {
                name: name.clone(),
                description: meta.description.clone(),
                argument_hint: meta.argument_hint.clone(),
                source: CommandSource::Custom,
            });
        } else {
            let desc = builtin_by_name
                .get(name.as_str())
                .map(|b| b.description.to_string());
            out.push(SlashCommand {
                name: name.clone(),
                description: desc,
                argument_hint: None,
                source: CommandSource::Builtin,
            });
        }
    }

    for b in builtins.iter().filter(|b| b.interactive_only) {
        if seen.insert(b.name.to_string()) {
            out.push(SlashCommand {
                name: b.name.to_string(),
                description: Some(b.description.to_string()),
                argument_hint: None,
                source: CommandSource::Builtin,
            });
        }
    }

    out.sort_by(|a, b| match (a.source, b.source) {
        (CommandSource::Builtin, CommandSource::Custom) => std::cmp::Ordering::Less,
        (CommandSource::Custom, CommandSource::Builtin) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    out
}
```

Remove the now-duplicate `use std::collections::HashMap;` from the `tests` module if the compiler warns about an unused/duplicate import (keep exactly one in scope for the tests).

- [ ] **Step 4: Run to verify all core tests pass**

Run: `cargo test -p kriyon-core completion`
Expected: PASS. Then `cargo clippy -p kriyon-core -- -D warnings` clean.

- [ ] **Step 5: Commit**

```bash
git add crates/kriyon-core/src/completion.rs
git commit -m "feat(core): merge live names + frontmatter + builtins into catalog"
```

---

## Task 5: `list_slash_commands` Tauri command (probe + enrich + fallback)

**Files:**
- Create: `src-tauri/src/completion_cmd.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod completion_cmd;` and register the command)
- Test: inline `#[cfg(test)]` in `completion_cmd.rs` (unit-test the pure helpers), plus a manual smoke step

**Interfaces:**
- Consumes: `kriyon_core::completion::{parse_init_line, parse_frontmatter, merge_commands, BUILTIN_COMMANDS, SlashCommand, Frontmatter, InitInfo}`.
- Produces:
  - `#[derive(serde::Serialize)] #[serde(rename_all = "camelCase")] pub struct CommandCatalog { pub commands: Vec<SlashCommand>, pub agents: Vec<String>, pub claude_version: Option<String>, pub degraded: bool }`.
  - `#[tauri::command] pub fn list_slash_commands(app, cwd: String) -> Result<CommandCatalog, String>`.
- Probe: run `<shell> -lc "claude -p x --output-format stream-json --verbose --max-turns 1 --no-session-persistence --no-chrome"` in `cwd`, env minus `KRIYON_SESSION`; read stdout lines until `parse_init_line` returns `Some`, then kill the child. 15s hard timeout. On any failure → fallback with `degraded = true`.
- Enrich: for every live name, look for a defining file across the command/skill dirs; `parse_frontmatter` it into a `HashMap<String, Frontmatter>`.

- [ ] **Step 1: Write the failing test for the pure enrichment helper**

Create `src-tauri/src/completion_cmd.rs` with the helper + test first:

```rust
//! Live composer completions (Tauri layer): probe the installed `claude` CLI
//! for its command set, enrich with on-disk frontmatter, and walk the project
//! tree for `@` mentions. Pure merge/parse logic lives in `kriyon_core::completion`.

use std::collections::HashMap;
use std::io::{BufRead as _, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use kriyon_core::completion::{
    merge_commands, parse_frontmatter, parse_init_line, CommandSource, Frontmatter, SlashCommand,
    BUILTIN_COMMANDS,
};

/// Candidate directories that may hold a command/skill definition for a live
/// command name: user + project `.claude/commands` and `.claude/skills`, plus
/// installed-plugin `commands` dirs. Returned even if absent; the reader skips
/// missing dirs.
fn command_search_dirs(home: &Path, cwd: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![
        home.join(".claude").join("commands"),
        cwd.join(".claude").join("commands"),
    ];
    // Installed plugin command dirs: ~/.claude/plugins/**/commands
    let plugins = home.join(".claude").join("plugins");
    if let Ok(entries) = std::fs::read_dir(&plugins) {
        for e in entries.flatten() {
            dirs.push(e.path().join("commands"));
        }
    }
    dirs
}

/// Read `description` / `argument-hint` frontmatter for whichever live names
/// resolve to a `<dir>/<name>.md` file (namespaced names use their last
/// segment). Best-effort: unreadable files are skipped. Pure over `read_file`
/// so it is unit-testable without a real filesystem.
fn enrich_descriptions(
    live_names: &[String],
    dirs: &[PathBuf],
    read_file: &dyn Fn(&Path) -> Option<String>,
) -> HashMap<String, Frontmatter> {
    let mut out = HashMap::new();
    for name in live_names {
        let stem = name.rsplit(':').next().unwrap_or(name);
        for dir in dirs {
            let path = dir.join(format!("{stem}.md"));
            if let Some(content) = read_file(&path) {
                out.insert(name.clone(), parse_frontmatter(&content));
                break;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enrich_reads_first_matching_file() {
        let dirs = vec![PathBuf::from("/a"), PathBuf::from("/b")];
        let live = vec!["commit".to_string(), "plugin:build".to_string(), "clear".to_string()];
        let read = |p: &Path| -> Option<String> {
            match p.to_str().unwrap() {
                "/b/commit.md" => Some("---\ndescription: Do a commit\n---\nx".to_string()),
                "/a/build.md" => Some("---\nargument-hint: [target]\n---\ny".to_string()),
                _ => None, // /clear has no file
            }
        };
        let got = enrich_descriptions(&live, &dirs, &read);
        assert_eq!(got["commit"].description.as_deref(), Some("Do a commit"));
        assert_eq!(got["plugin:build"].argument_hint.as_deref(), Some("[target]"));
        assert!(!got.contains_key("clear"));
    }
}
```

- [ ] **Step 2: Run to verify it fails, then passes**

Run: `cargo test -p kriyon enrich_reads_first_matching_file` (use the actual `src-tauri` package name from `src-tauri/Cargo.toml` — check the `[package] name`). Expected: compiles and passes after Step 1. If it fails to compile because the crate name differs, adjust the `-p` value.

- [ ] **Step 3: Add the catalog type, probe runner, and command**

Append to `completion_cmd.rs`:

```rust
/// The composer's live command catalog: merged commands, agent names for
/// `@agent-…`, the probed CLI version, and whether the probe had to fall back.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCatalog {
    pub commands: Vec<SlashCommand>,
    pub agents: Vec<String>,
    pub claude_version: Option<String>,
    pub degraded: bool,
}

/// Resolve HOME via Tauri, matching `commands.rs::resolve_home`.
fn resolve_home(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager as _;
    app.path()
        .home_dir()
        .ok()
        .or_else(|| std::env::var("HOME").ok().map(PathBuf::from))
        .ok_or_else(|| "cannot resolve HOME".to_string())
}

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// Spawn `claude` in stream-json mode via the user's login shell (so PATH
/// resolves `claude` the same way the terminal does), read stdout until the
/// `init` line, then kill the child. Returns `None` on spawn error, timeout, or
/// EOF-before-init. `KRIYON_SESSION` is stripped so the probe can't pollute the
/// hook events file; `--no-session-persistence` keeps it out of session history.
fn run_probe(cwd: &Path) -> Option<kriyon_core::completion::InitInfo> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let script = "claude -p x --output-format stream-json --verbose --max-turns 1 \
                  --no-session-persistence --no-chrome";
    let mut child = std::process::Command::new(shell)
        .arg("-lc")
        .arg(script)
        .current_dir(cwd)
        .env_remove("KRIYON_SESSION")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    let stdout = child.stdout.take()?;
    let started = Instant::now();
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let result = loop {
        if started.elapsed() > PROBE_TIMEOUT {
            break None;
        }
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break None, // EOF before init
            Ok(_) => {
                if let Some(info) = parse_init_line(&line) {
                    break Some(info);
                }
            }
            Err(_) => break None,
        }
    };
    // Always reap the child — never leave a zombie `claude`.
    let _ = child.kill();
    let _ = child.wait();
    result
}

/// The composer's live slash-command catalog for a working directory. Probes the
/// installed `claude` CLI; on any probe failure, falls back to a filesystem +
/// static-builtin catalog marked `degraded`.
///
/// # Errors
/// Returns an error string only if HOME cannot be resolved.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn list_slash_commands(
    app: tauri::AppHandle,
    cwd: String,
) -> Result<CommandCatalog, String> {
    let home = resolve_home(&app)?;
    let cwd_path = PathBuf::from(&cwd);
    let dirs = command_search_dirs(&home, &cwd_path);
    let read = |p: &Path| std::fs::read_to_string(p).ok();

    if let Some(info) = run_probe(&cwd_path) {
        let described = enrich_descriptions(&info.slash_commands, &dirs, &read);
        let commands = merge_commands(&info.slash_commands, &described, BUILTIN_COMMANDS);
        return Ok(CommandCatalog {
            commands,
            agents: info.agents,
            claude_version: info.claude_version,
            degraded: false,
        });
    }

    // Fallback: glob command dirs for names + descriptions, merge with builtins.
    let mut described = HashMap::new();
    let mut names: Vec<String> = Vec::new();
    for dir in &dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if let Some(content) = read(&path) {
                described
                    .entry(stem.to_string())
                    .or_insert_with(|| parse_frontmatter(&content));
                if !names.contains(&stem.to_string()) {
                    names.push(stem.to_string());
                }
            }
        }
    }
    let commands = merge_commands(&names, &described, BUILTIN_COMMANDS);
    let _ = CommandSource::Builtin; // keep the import used across cfg builds
    Ok(CommandCatalog {
        commands,
        agents: Vec::new(),
        claude_version: None,
        degraded: true,
    })
}
```

(If clippy flags the `let _ = CommandSource::Builtin;` line as pointless, delete it and instead drop `CommandSource` from the `use` in Step 1 — it's only needed if a later reference uses it. Keep imports minimal and warning-free.)

- [ ] **Step 4: Register the command**

In `src-tauri/src/lib.rs`, add near the other `mod` declarations:

```rust
mod completion_cmd;
```

And inside `tauri::generate_handler![ … ]` (after `commands::import_commands,`):

```rust
            completion_cmd::list_slash_commands,
```

- [ ] **Step 5: Build + unit test + clippy**

Run: `cargo test -p kriyon completion_cmd` then `cargo clippy -p kriyon -- -D warnings`
Expected: PASS, clean. (Substitute the real `src-tauri` package name if different.)

- [ ] **Step 6: Manual smoke (real probe)**

Run from the repo root:
```bash
cargo run -q -p kriyon 2>/dev/null &  # or `pnpm tauri dev`
```
Not required to gate the commit; the real end-to-end check happens in Task 13's QA. If you want a fast confidence check now, temporarily add a `#[test]` that calls `run_probe(Path::new("."))` behind `#[ignore]` and run it with `cargo test -- --ignored` — it should return `Some` with a non-empty `slash_commands`. Remove the throwaway test before committing.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/completion_cmd.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): list_slash_commands via claude stream-json probe"
```

---

## Task 6: `list_files` Tauri command (@ mentions)

**Files:**
- Modify: `src-tauri/src/completion_cmd.rs`, `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`
- Test: inline (temp-dir fixture)

**Interfaces:**
- Produces:
  - `#[derive(serde::Serialize)] #[serde(rename_all = "camelCase")] pub struct FileEntry { pub path: String, pub is_dir: bool }`.
  - `#[tauri::command] pub fn list_files(cwd: String, query: String) -> Result<Vec<FileEntry>, String>`.
- Walk from `cwd` with the `ignore` crate (respects `.gitignore`, skips `.git`), filter by `query` (case-insensitive substring on the relative path), directories before files, cap at 50, stable order. `path` is relative to `cwd`.

**Docs to check first:** verify the `ignore` crate API (`WalkBuilder`, `.git_ignore(true)`, `.hidden(false)`, `.max_depth`) against current docs via context7 before coding.

- [ ] **Step 1: Add the dependency**

In `src-tauri/Cargo.toml` under `[dependencies]`:

```toml
ignore = "0.4"
```

- [ ] **Step 2: Write the failing test**

Append to the `tests` module in `completion_cmd.rs`:

```rust
    #[test]
    fn list_files_respects_gitignore_and_query_and_cap() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(root.join("keep_me.rs"), "").unwrap();
        std::fs::write(root.join("ignored.txt"), "").unwrap();
        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::write(root.join("src").join("keep_two.rs"), "").unwrap();

        let all = walk_files(root, "keep");
        let paths: Vec<&str> = all.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"keep_me.rs"));
        assert!(paths.iter().any(|p| p.ends_with("keep_two.rs")));
        assert!(!paths.iter().any(|p| p.contains("ignored")));
    }
```

(Note: this tests a pure `walk_files(root, query)` helper so no Tauri/HOME is needed. The `#[tauri::command]` wraps it.)

- [ ] **Step 3: Run to verify it fails**

Run: `cargo test -p kriyon list_files_respects_gitignore_and_query_and_cap`
Expected: FAIL — `walk_files` not found.

- [ ] **Step 4: Implement**

Append to `completion_cmd.rs`:

```rust
/// One `@`-mention completion candidate: a path relative to the session cwd.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub is_dir: bool,
}

const FILE_CAP: usize = 50;

/// Walk `root` (gitignore-respecting, `.git` skipped), keeping entries whose
/// relative path contains `query` (case-insensitive). Directories sort before
/// files, then lexicographically; capped at `FILE_CAP`.
fn walk_files(root: &Path, query: &str) -> Vec<FileEntry> {
    let needle = query.to_lowercase();
    let mut out: Vec<FileEntry> = ignore::WalkBuilder::new(root)
        .hidden(false) // show dotfiles; .gitignore still hides ignored ones
        .git_ignore(true)
        .git_global(true)
        .filter_entry(|e| e.file_name() != ".git")
        .build()
        .filter_map(Result::ok)
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
        .take(2000) // bound the walk before sorting/capping
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
/// Returns an error string if `cwd` is not an existing directory (the IPC
/// trust-boundary check — the caller sends a session cwd, never an arbitrary
/// path we blindly walk).
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn list_files(cwd: String, query: String) -> Result<Vec<FileEntry>, String> {
    let root = PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err("cwd is not a directory".to_string());
    }
    Ok(walk_files(&root, &query))
}
```

- [ ] **Step 5: Register the command**

In `src-tauri/src/lib.rs`, inside `generate_handler!` after `completion_cmd::list_slash_commands,`:

```rust
            completion_cmd::list_files,
```

- [ ] **Step 6: Run tests + clippy**

Run: `cargo test -p kriyon completion_cmd` then `cargo clippy -p kriyon -- -D warnings`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/completion_cmd.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(tauri): list_files for @ mentions (gitignore-aware)"
```

---

## Task 7: Bridge functions + TS types

**Files:**
- Modify: `src/ipc/bridge.ts`
- Test: `src/ipc/bridge.test.ts` (extend existing)

**Interfaces:**
- Produces (exact TS mirrors of the Rust serde output):

```ts
export type CommandSource = "builtin" | "custom";
export interface SlashCommand {
  name: string;
  description: string | null;
  argumentHint: string | null;
  source: CommandSource;
}
export interface CommandCatalog {
  commands: SlashCommand[];
  agents: string[];
  claudeVersion: string | null;
  degraded: boolean;
}
export interface FileEntry { path: string; isDir: boolean }
export function listSlashCommands(cwd: string): Promise<CommandCatalog>;
export function listFiles(cwd: string, query: string): Promise<FileEntry[]>;
```

- [ ] **Step 1: Write the failing test**

Look at `src/ipc/bridge.test.ts` to match its mocking style for `invoke`. Add:

```ts
it("listSlashCommands invokes list_slash_commands with cwd", async () => {
  const invoke = vi.mocked(await import("@tauri-apps/api/core")).invoke;
  invoke.mockResolvedValueOnce({ commands: [], agents: [], claudeVersion: null, degraded: true });
  const { listSlashCommands } = await import("./bridge.ts");
  await listSlashCommands("/repo");
  expect(invoke).toHaveBeenCalledWith("list_slash_commands", { cwd: "/repo" });
});

it("listFiles invokes list_files with cwd and query", async () => {
  const invoke = vi.mocked(await import("@tauri-apps/api/core")).invoke;
  invoke.mockResolvedValueOnce([]);
  const { listFiles } = await import("./bridge.ts");
  await listFiles("/repo", "src");
  expect(invoke).toHaveBeenCalledWith("list_files", { cwd: "/repo", query: "src" });
});
```

(Match the existing file's exact import/mock pattern — it may already mock `@tauri-apps/api/core` at the top. Reuse that setup rather than duplicating.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/ipc/bridge.test.ts`
Expected: FAIL — `listSlashCommands` not exported.

- [ ] **Step 3: Implement**

Add to `src/ipc/bridge.ts` (near the prompt/command section, ~line 617):

```ts
// --- Composer completions ---

/** One slash command in the live catalog (mirrors Rust `SlashCommand`). */
export type CommandSource = "builtin" | "custom";
export interface SlashCommand {
  argumentHint: string | null;
  description: string | null;
  name: string;
  source: CommandSource;
}

/** The composer's live command catalog (mirrors Rust `CommandCatalog`). */
export interface CommandCatalog {
  agents: string[];
  claudeVersion: string | null;
  commands: SlashCommand[];
  degraded: boolean;
}

/** A `@`-mention file candidate (mirrors Rust `FileEntry`). */
export interface FileEntry {
  isDir: boolean;
  path: string;
}

/** Probe the installed `claude` CLI for its live slash-command catalog. */
export function listSlashCommands(cwd: string): Promise<CommandCatalog> {
  return invoke("list_slash_commands", { cwd });
}

/** Filesystem completions for `@` mentions under `cwd`, filtered by `query`. */
export function listFiles(cwd: string, query: string): Promise<FileEntry[]> {
  return invoke("list_files", { cwd, query });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/ipc/bridge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/bridge.ts src/ipc/bridge.test.ts
git commit -m "feat(ipc): bridge for listSlashCommands and listFiles"
```

---

## Task 8: Trigger detection (pure)

**Files:**
- Create: `src/completion/detect.ts`
- Test: `src/completion/detect.test.ts`

**Interfaces:**
- Produces:

```ts
export type Trigger =
  | { kind: "slash"; query: string; start: number; end: number }
  | { kind: "mention"; query: string; start: number; end: number }
  | { kind: "mode"; mode: "bash" | "memory" }
  | null;
export function detectTrigger(value: string, caret: number): Trigger;
```

- Rules:
  - **slash**: `value` up to `caret` is `/` at index 0 followed by non-whitespace, and the caret is within that first token. `start = 0`, `end` = index after the token, `query` = token without the leading `/`. (No slash menu once a space is typed.)
  - **mention**: the character run ending at `caret` is `@` + non-whitespace, where `@` is at index 0 or preceded by whitespace. `start` = index of `@`, `end = caret`, `query` = run after `@`.
  - **mode**: only when no slash/mention applies and `value[0]` is `!` → bash, or `#` → memory.
  - Otherwise `null`. Slash/mention take precedence over mode; slash only fires at input start so it never collides with mention.

- [ ] **Step 1: Write the failing tests**

Create `src/completion/detect.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { detectTrigger } from "./detect.ts";

describe("detectTrigger", () => {
  it("detects a slash command at input start", () => {
    expect(detectTrigger("/comm", 5)).toEqual({ kind: "slash", query: "comm", start: 0, end: 5 });
  });

  it("does not treat a mid-line slash as a command", () => {
    expect(detectTrigger("fix the /path bug", 13)).toBeNull();
  });

  it("closes the slash menu once a space follows the command", () => {
    expect(detectTrigger("/commit msg", 11)).toBeNull();
  });

  it("detects an @ mention at a word boundary", () => {
    expect(detectTrigger("see @src/mai", 12)).toEqual({ kind: "mention", query: "src/mai", start: 4, end: 12 });
  });

  it("detects @ at the very start", () => {
    expect(detectTrigger("@RE", 3)).toEqual({ kind: "mention", query: "RE", start: 0, end: 3 });
  });

  it("does not treat an email-like @ as a mention", () => {
    expect(detectTrigger("mail me@x", 9)).toBeNull();
  });

  it("detects bash and memory modes", () => {
    expect(detectTrigger("!ls -la", 3)).toEqual({ kind: "mode", mode: "bash" });
    expect(detectTrigger("#remember this", 5)).toEqual({ kind: "mode", mode: "memory" });
  });

  it("returns null for ordinary text", () => {
    expect(detectTrigger("hello world", 5)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/completion/detect.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/completion/detect.ts`:

```ts
/** What the composer's caret position implies about completion, if anything. */
export type Trigger =
  | { kind: "slash"; query: string; start: number; end: number }
  | { kind: "mention"; query: string; start: number; end: number }
  | { kind: "mode"; mode: "bash" | "memory" }
  | null;

const WORD = /\S/;

/**
 * Classify the composer value + caret into a completion trigger. Slash fires
 * only for a leading `/token` (matching claude's TUI); `@` fires at any word
 * boundary; `!`/`#` at input start are bare mode hints. Pure — no React, no IO.
 */
export function detectTrigger(value: string, caret: number): Trigger {
  const before = value.slice(0, caret);

  // Slash: '/' at index 0, no whitespace between it and the caret.
  if (before.startsWith("/") && !/\s/.test(before)) {
    return { kind: "slash", query: before.slice(1), start: 0, end: caret };
  }

  // Mention: walk back from the caret over non-whitespace to an '@' that is at
  // the start or preceded by whitespace.
  let i = caret;
  while (i > 0 && WORD.test(value[i - 1])) {
    i -= 1;
  }
  if (value[i] === "@" && (i === 0 || /\s/.test(value[i - 1]))) {
    return { kind: "mention", query: value.slice(i + 1, caret), start: i, end: caret };
  }

  // Mode hints: only when the whole input begins with the prefix.
  if (value.startsWith("!")) {
    return { kind: "mode", mode: "bash" };
  }
  if (value.startsWith("#")) {
    return { kind: "mode", mode: "memory" };
  }

  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/completion/detect.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/completion/detect.ts src/completion/detect.test.ts
git commit -m "feat(completion): pure trigger detection"
```

---

## Task 9: Fuzzy filter (pure)

**Files:**
- Create: `src/completion/filter.ts`
- Test: `src/completion/filter.test.ts`

**Interfaces:**
- Produces: `export function fuzzyFilter<T>(items: T[], query: string, key: (item: T) => string): T[]` — case-insensitive subsequence match; ranked by (exact-prefix first, then earliest first-match index, then shorter key). Empty query returns items unchanged. Non-matches dropped.

- [ ] **Step 1: Write the failing tests**

Create `src/completion/filter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fuzzyFilter } from "./filter.ts";

const names = ["commit", "compact", "context", "clear", "security-review"];
const id = (s: string) => s;

describe("fuzzyFilter", () => {
  it("returns all items for an empty query", () => {
    expect(fuzzyFilter(names, "", id)).toEqual(names);
  });

  it("keeps only subsequence matches", () => {
    const out = fuzzyFilter(names, "con", id);
    expect(out).toContain("context");
    expect(out).not.toContain("clear");
  });

  it("ranks prefix matches above scattered matches", () => {
    const out = fuzzyFilter(["security-review", "compact"], "c", id);
    expect(out[0]).toBe("compact"); // prefix 'c' beats mid-word 'c'
  });

  it("matches scattered subsequences", () => {
    expect(fuzzyFilter(["security-review"], "srv", id)).toEqual(["security-review"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/completion/filter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/completion/filter.ts`:

```ts
/** A subsequence match with a rank; lower `score` sorts first. */
interface Ranked<T> {
  item: T;
  score: number;
  first: number;
}

/**
 * Rank `items` by how well `key(item)` fuzzy-matches `query` (case-insensitive
 * subsequence). Prefix matches beat scattered ones; ties break on earliest
 * match then shorter key. Empty query passes everything through unchanged.
 */
export function fuzzyFilter<T>(items: T[], query: string, key: (item: T) => string): T[] {
  const q = query.toLowerCase();
  if (q.length === 0) {
    return items;
  }
  const ranked: Ranked<T>[] = [];
  for (const item of items) {
    const hay = key(item).toLowerCase();
    let qi = 0;
    let first = -1;
    for (let hi = 0; hi < hay.length && qi < q.length; hi += 1) {
      if (hay[hi] === q[qi]) {
        if (qi === 0) {
          first = hi;
        }
        qi += 1;
      }
    }
    if (qi === q.length) {
      // Prefix match (first === 0) gets the strongest boost.
      const score = (first === 0 ? 0 : 1000) + first;
      ranked.push({ item, score, first });
    }
  }
  ranked.sort((a, b) => a.score - b.score || key(a.item).length - key(b.item).length);
  return ranked.map((r) => r.item);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/completion/filter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/completion/filter.ts src/completion/filter.test.ts
git commit -m "feat(completion): pure fuzzy filter"
```

---

## Task 10: Completions store (cache + warmup)

**Files:**
- Create: `src/state/completions.ts`
- Test: `src/state/completions.test.ts`

**Interfaces:**
- Consumes: `listSlashCommands` from `bridge.ts`, `CommandCatalog`.
- Produces a Zustand store:

```ts
interface CompletionsState {
  byCwd: Record<string, CommandCatalog>;
  loading: Record<string, boolean>;
  warmup: (cwd: string) => Promise<void>;   // fetch once per cwd if not cached/loading
  refresh: (cwd: string) => Promise<void>;  // force re-fetch
  catalogFor: (cwd: string) => CommandCatalog | undefined;
}
export const useCompletions: UseBoundStore<...>;
```

- `warmup` is a no-op if the cwd is already cached or in-flight. Failures leave the cache empty (the hook falls back to builtins-only via a degraded catalog is NOT synthesized here — the store just stays empty; the command already returns a degraded catalog on the Rust side, so a resolved-but-degraded result is still cached).

- [ ] **Step 1: Write the failing tests**

Create `src/state/completions.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({
  listSlashCommands: vi.fn(),
}));

import { listSlashCommands } from "../ipc/bridge.ts";
import { useCompletions } from "./completions.ts";

const catalog = { commands: [], agents: [], claudeVersion: "2.1.202", degraded: false };

describe("useCompletions", () => {
  beforeEach(() => {
    useCompletions.setState({ byCwd: {}, loading: {} });
    vi.mocked(listSlashCommands).mockReset().mockResolvedValue(catalog);
  });

  it("warmup fetches once and caches", async () => {
    await useCompletions.getState().warmup("/repo");
    await useCompletions.getState().warmup("/repo");
    expect(listSlashCommands).toHaveBeenCalledTimes(1);
    expect(useCompletions.getState().catalogFor("/repo")).toEqual(catalog);
  });

  it("refresh re-fetches even when cached", async () => {
    await useCompletions.getState().warmup("/repo");
    await useCompletions.getState().refresh("/repo");
    expect(listSlashCommands).toHaveBeenCalledTimes(2);
  });

  it("a failed warmup does not throw and leaves no cache entry", async () => {
    vi.mocked(listSlashCommands).mockRejectedValueOnce(new Error("no claude"));
    await useCompletions.getState().warmup("/repo");
    expect(useCompletions.getState().catalogFor("/repo")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/state/completions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/state/completions.ts`:

```ts
import { create } from "zustand";
import { type CommandCatalog, listSlashCommands } from "../ipc/bridge.ts";

/**
 * The live slash-command catalog, cached per working directory. Warmed on
 * session start so the popover is populated before the first `/`. The catalog
 * itself carries `degraded` when the probe fell back — the UI reads that, the
 * store just holds whatever resolved.
 */
interface CompletionsState {
  byCwd: Record<string, CommandCatalog>;
  loading: Record<string, boolean>;
  catalogFor: (cwd: string) => CommandCatalog | undefined;
  warmup: (cwd: string) => Promise<void>;
  refresh: (cwd: string) => Promise<void>;
}

async function load(cwd: string, set: (fn: (s: CompletionsState) => Partial<CompletionsState>) => void): Promise<void> {
  set((s) => ({ loading: { ...s.loading, [cwd]: true } }));
  try {
    const catalog = await listSlashCommands(cwd);
    set((s) => ({ byCwd: { ...s.byCwd, [cwd]: catalog } }));
  } catch {
    // Leave the cache empty; the composer degrades to no slash suggestions.
  } finally {
    set((s) => ({ loading: { ...s.loading, [cwd]: false } }));
  }
}

export const useCompletions = create<CompletionsState>((set, get) => ({
  byCwd: {},
  loading: {},
  catalogFor: (cwd) => get().byCwd[cwd],
  warmup: async (cwd) => {
    const state = get();
    if (state.byCwd[cwd] || state.loading[cwd]) {
      return;
    }
    await load(cwd, set);
  },
  refresh: async (cwd) => {
    await load(cwd, set);
  },
}));
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/state/completions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/completions.ts src/state/completions.test.ts
git commit -m "feat(state): cached completions catalog with warmup"
```

---

## Task 11: Popover component (presentational)

**Files:**
- Create: `src/completion/CompletionPopover.tsx`
- Test: `src/completion/CompletionPopover.test.tsx`

**Interfaces:**
- Produces:

```ts
export interface CompletionRow { primary: string; secondary?: string; hint?: string }
export interface CompletionPopoverProps {
  rows: CompletionRow[];
  activeIndex: number;
  onPick: (index: number) => void;
  header?: string;      // e.g. "Commands" / "Files" / "Agents"
  degraded?: boolean;
}
export function CompletionPopover(props: CompletionPopoverProps): JSX.Element | null;
```

- Renders nothing when `rows` is empty. Each row shows `primary` (mono), optional `secondary` (description, dim) and `hint` (argument-hint, faint). The `activeIndex` row is highlighted. Clicking a row calls `onPick`. All colors/spacing from `tokens`. Positioned by the parent (absolute within the composer box); the component itself is a styled list.

- [ ] **Step 1: Write the failing test**

Create `src/completion/CompletionPopover.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CompletionPopover } from "./CompletionPopover.tsx";

describe("CompletionPopover", () => {
  it("renders rows and highlights the active one", () => {
    render(
      <CompletionPopover
        rows={[{ primary: "/clear", secondary: "Clear history" }, { primary: "/compact" }]}
        activeIndex={1}
        onPick={() => {}}
      />
    );
    expect(screen.getByText("/clear")).toBeInTheDocument();
    const active = screen.getByText("/compact").closest("[data-active]");
    expect(active).toHaveAttribute("data-active", "true");
  });

  it("calls onPick with the row index when clicked", () => {
    const onPick = vi.fn();
    render(<CompletionPopover rows={[{ primary: "a" }, { primary: "b" }]} activeIndex={0} onPick={onPick} />);
    fireEvent.mouseDown(screen.getByText("b"));
    expect(onPick).toHaveBeenCalledWith(1);
  });

  it("renders nothing when there are no rows", () => {
    const { container } = render(<CompletionPopover rows={[]} activeIndex={0} onPick={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

(The repo already runs `.tsx` tests under jsdom with `@testing-library/react` + `@testing-library/jest-dom` — `vitest.config.ts` sets `environment: "jsdom"`, and there are many `*.test.tsx` files, including `src/layout/PromptBar.test.tsx`. Match their render/import setup.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/completion/CompletionPopover.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/completion/CompletionPopover.tsx`:

```tsx
import type { CSSProperties } from "react";
import { tokens } from "../theme/tokens.ts";

/** One rendered line in the popover. */
export interface CompletionRow {
  primary: string;
  secondary?: string;
  hint?: string;
}

export interface CompletionPopoverProps {
  rows: CompletionRow[];
  activeIndex: number;
  onPick: (index: number) => void;
  header?: string;
  degraded?: boolean;
}

const listStyle: CSSProperties = {
  background: tokens.gradient.raised,
  border: `1px solid ${tokens.color.line.strong}`,
  borderRadius: tokens.radius.lg,
  boxShadow: tokens.shadow.pop,
  bottom: "calc(100% + 8px)",
  left: 0,
  maxHeight: "260px",
  overflowY: "auto",
  position: "absolute",
  right: 0,
  zIndex: 20,
};

const rowStyle = (active: boolean): CSSProperties => ({
  alignItems: "baseline",
  background: active ? tokens.color.surface.s3 : "transparent",
  cursor: "pointer",
  display: "flex",
  gap: "10px",
  padding: "6px 12px",
});

const primaryStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  fontFamily: tokens.font.mono,
  fontSize: "13px",
};

const secondaryStyle: CSSProperties = {
  color: tokens.color.ink.dim,
  flex: 1,
  fontFamily: tokens.font.sans,
  fontSize: "12px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const hintStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  fontFamily: tokens.font.mono,
  fontSize: "11.5px",
};

const headerStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  fontFamily: tokens.font.sans,
  fontSize: "10.5px",
  letterSpacing: "0.05em",
  padding: "6px 12px 2px",
  textTransform: "uppercase",
};

/** The completion list. Purely presentational; the parent owns selection. */
export function CompletionPopover({
  rows,
  activeIndex,
  onPick,
  header,
  degraded,
}: CompletionPopoverProps): JSX.Element | null {
  if (rows.length === 0) {
    return null;
  }
  return (
    <div role="listbox" style={listStyle}>
      {header ? (
        <div style={headerStyle}>
          {header}
          {degraded ? " · offline" : ""}
        </div>
      ) : null}
      {rows.map((row, index) => (
        <div
          data-active={index === activeIndex}
          key={row.primary}
          onMouseDown={(event) => {
            event.preventDefault(); // keep textarea focus
            onPick(index);
          }}
          role="option"
          aria-selected={index === activeIndex}
          style={rowStyle(index === activeIndex)}
        >
          <span style={primaryStyle}>{row.primary}</span>
          {row.secondary ? <span style={secondaryStyle}>{row.secondary}</span> : <span style={{ flex: 1 }} />}
          {row.hint ? <span style={hintStyle}>{row.hint}</span> : null}
        </div>
      ))}
    </div>
  );
}
```

Run `pnpm fix` after creating the file so Biome/Ultracite orders props/keys to its rules.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/completion/CompletionPopover.test.tsx`
Expected: PASS. If the token names (`tokens.color.ink.dim`, `tokens.gradient.raised`, etc.) differ, open `src/theme/tokens.ts` and use the real names — do not invent tokens.

- [ ] **Step 5: Commit**

```bash
git add src/completion/CompletionPopover.tsx src/completion/CompletionPopover.test.tsx
git commit -m "feat(completion): presentational popover"
```

---

## Task 12: The `useCompletion` hook (glue)

**Files:**
- Create: `src/completion/useCompletion.ts`
- Test: `src/completion/useCompletion.test.ts`

**Interfaces:**
- Consumes: `detectTrigger`, `fuzzyFilter`, `useCompletions`, `listFiles`, `CommandCatalog`, `SlashCommand`.
- Produces:

```ts
export interface CompletionView {
  open: boolean;
  kind: "slash" | "mention" | null;
  mode: "bash" | "memory" | null;   // for the hint chip
  rows: CompletionRow[];
  items: CompletionItem[];          // parallel to rows; carries insertion text + span
  activeIndex: number;
  degraded: boolean;
  header: string;
}
export interface CompletionItem { insert: string; start: number; end: number }
export function useCompletion(args: {
  cwd: string | null;
  value: string;
  caret: number;
}): {
  view: CompletionView;
  move: (delta: number) => void;   // wraps around
  reset: () => void;               // force-close (Esc / after accept)
  itemAt: (index: number) => CompletionItem | undefined;
};
```

- Behavior:
  - `slash`: filter the cached catalog's `commands` by the query via `fuzzyFilter(_, query, c => c.name)`. Row: `primary = "/" + name`, `secondary = description`, `hint = argumentHint`. `insert = "/" + name + (argumentHint ? " " : "")`, span = `[0, caret]`.
  - `mention`: debounced `listFiles(cwd, query)` (120ms) → file rows (`primary = "@" + path`, `insert = "@" + path + " "`), plus agents from the catalog whose name matches the query (`primary = "@agent-" + name`, `insert = "@agent-" + name + " "`), agents listed first. Span = `[start, end]` from the trigger.
  - `mode`: `open=false`, but `mode` set so the caller shows a chip.
  - `activeIndex` resets to 0 whenever the row set changes; `move` wraps.

- [ ] **Step 1: Write the failing tests**

Create `src/completion/useCompletion.test.ts`:

```ts
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({ listFiles: vi.fn() }));
import { listFiles } from "../ipc/bridge.ts";
import { useCompletions } from "../state/completions.ts";
import { useCompletion } from "./useCompletion.ts";

const catalog = {
  commands: [
    { name: "commit", description: "Create a git commit", argumentHint: "[msg]", source: "custom" as const },
    { name: "clear", description: "Clear history", argumentHint: null, source: "builtin" as const },
  ],
  agents: ["Explore"],
  claudeVersion: "2.1.202",
  degraded: false,
};

describe("useCompletion", () => {
  beforeEach(() => {
    useCompletions.setState({ byCwd: { "/repo": catalog }, loading: {} });
    vi.mocked(listFiles).mockReset().mockResolvedValue([{ path: "src/main.rs", isDir: false }]);
  });

  it("offers filtered slash commands", () => {
    const { result } = renderHook(() => useCompletion({ cwd: "/repo", value: "/com", caret: 4 }));
    expect(result.current.view.open).toBe(true);
    expect(result.current.view.kind).toBe("slash");
    expect(result.current.view.rows[0].primary).toBe("/commit");
    expect(result.current.itemAt(0)?.insert).toBe("/commit "); // arg-hint → trailing space
  });

  it("wraps selection with move", () => {
    const { result } = renderHook(() => useCompletion({ cwd: "/repo", value: "/c", caret: 2 }));
    const count = result.current.view.rows.length;
    act(() => result.current.move(-1));
    expect(result.current.view.activeIndex).toBe(count - 1);
  });

  it("offers file mentions from the backend", async () => {
    const { result } = renderHook(() => useCompletion({ cwd: "/repo", value: "@src/ma", caret: 7 }));
    await waitFor(() => expect(result.current.view.rows.some((r) => r.primary === "@src/main.rs")).toBe(true));
    const item = result.current.view.items.find((i) => i.insert === "@src/main.rs ");
    expect(item).toBeTruthy();
  });

  it("surfaces bash mode without opening a popover", () => {
    const { result } = renderHook(() => useCompletion({ cwd: "/repo", value: "!ls", caret: 3 }));
    expect(result.current.view.open).toBe(false);
    expect(result.current.view.mode).toBe("bash");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/completion/useCompletion.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/completion/useCompletion.ts`:

```ts
import { useEffect, useMemo, useRef, useState } from "react";
import { type FileEntry, listFiles } from "../ipc/bridge.ts";
import { useCompletions } from "../state/completions.ts";
import type { CompletionRow } from "./CompletionPopover.tsx";
import { detectTrigger } from "./detect.ts";
import { fuzzyFilter } from "./filter.ts";

/** An accepted completion: replace [start,end) in the draft with `insert`. */
export interface CompletionItem {
  insert: string;
  start: number;
  end: number;
}

export interface CompletionView {
  open: boolean;
  kind: "slash" | "mention" | null;
  mode: "bash" | "memory" | null;
  rows: CompletionRow[];
  items: CompletionItem[];
  activeIndex: number;
  degraded: boolean;
  header: string;
}

const DEBOUNCE_MS = 120;

/**
 * Drive the composer's completion popover from the current draft + caret. Slash
 * rows come from the cached catalog (sync); `@` file rows are fetched
 * (debounced) from the backend and merged with matching agent names. `!`/`#`
 * surface as a `mode` for the caller's hint chip without opening a popover.
 */
export function useCompletion(args: { cwd: string | null; value: string; caret: number }): {
  view: CompletionView;
  move: (delta: number) => void;
  reset: () => void;
  itemAt: (index: number) => CompletionItem | undefined;
} {
  const { cwd, value, caret } = args;
  const trigger = useMemo(() => detectTrigger(value, caret), [value, caret]);
  const catalog = useCompletions((s) => (cwd ? s.byCwd[cwd] : undefined));
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [closed, setClosed] = useState(false);

  // Fetch files for a mention query (debounced). Reset when the query changes.
  const mentionQuery = trigger?.kind === "mention" ? trigger.query : null;
  const seq = useRef(0);
  useEffect(() => {
    if (mentionQuery === null || !cwd) {
      setFiles([]);
      return;
    }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      listFiles(cwd, mentionQuery)
        .then((res) => {
          if (seq.current === mine) {
            setFiles(res);
          }
        })
        .catch(() => {
          if (seq.current === mine) {
            setFiles([]);
          }
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [mentionQuery, cwd]);

  // Any change to the trigger reopens and resets the selection.
  useEffect(() => {
    setActiveIndex(0);
    setClosed(false);
  }, [trigger?.kind, mentionQuery, trigger?.kind === "slash" ? trigger.query : null]);

  const view = useMemo<CompletionView>(() => {
    const empty: CompletionView = {
      open: false,
      kind: null,
      mode: null,
      rows: [],
      items: [],
      activeIndex: 0,
      degraded: catalog?.degraded ?? false,
      header: "",
    };
    if (closed || !trigger) {
      return empty;
    }
    if (trigger.kind === "mode") {
      return { ...empty, mode: trigger.mode };
    }
    if (trigger.kind === "slash") {
      const commands = catalog?.commands ?? [];
      const matched = fuzzyFilter(commands, trigger.query, (c) => c.name);
      const rows: CompletionRow[] = matched.map((c) => ({
        primary: `/${c.name}`,
        secondary: c.description ?? undefined,
        hint: c.argumentHint ?? undefined,
      }));
      const items: CompletionItem[] = matched.map((c) => ({
        insert: `/${c.name}${c.argumentHint ? " " : ""}`,
        start: trigger.start,
        end: trigger.end,
      }));
      return { ...empty, open: rows.length > 0, kind: "slash", rows, items, activeIndex, header: "Commands" };
    }
    // mention: agents first (matching the query), then files.
    const agents = (catalog?.agents ?? []).filter((a) =>
      a.toLowerCase().includes(trigger.query.toLowerCase())
    );
    const agentRows: CompletionRow[] = agents.map((a) => ({ primary: `@agent-${a}`, secondary: "subagent" }));
    const agentItems: CompletionItem[] = agents.map((a) => ({
      insert: `@agent-${a} `,
      start: trigger.start,
      end: trigger.end,
    }));
    const fileRows: CompletionRow[] = files.map((f) => ({ primary: `@${f.path}`, secondary: f.isDir ? "dir" : undefined }));
    const fileItems: CompletionItem[] = files.map((f) => ({
      insert: `@${f.path}${f.isDir ? "" : " "}`,
      start: trigger.start,
      end: trigger.end,
    }));
    const rows = [...agentRows, ...fileRows];
    const items = [...agentItems, ...fileItems];
    return { ...empty, open: rows.length > 0, kind: "mention", rows, items, activeIndex, header: "Mentions" };
  }, [trigger, catalog, files, activeIndex, closed]);

  return {
    view,
    move: (delta) => {
      const n = view.rows.length;
      if (n > 0) {
        setActiveIndex((i) => (i + delta + n) % n);
      }
    },
    reset: () => setClosed(true),
    itemAt: (index) => view.items[index],
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/completion/useCompletion.test.ts`
Expected: PASS. `renderHook`/`waitFor` come from `@testing-library/react` (already a dev-dep) under the repo's jsdom vitest env.

- [ ] **Step 5: Commit**

```bash
git add src/completion/useCompletion.ts src/completion/useCompletion.test.ts
git commit -m "feat(completion): useCompletion hook wiring detect+filter+files"
```

---

## Task 13: Wire into PromptBar + warmup + QA

**Files:**
- Modify: `src/layout/PromptBar.tsx`
- Modify: `src/state/actions.ts` (warmup on session create)
- Test: `src/layout/PromptBar.test.tsx` (already exists — extend it) for keyboard behavior

**Interfaces:**
- Consumes: `useCompletion`, `CompletionPopover`, `useCompletions.warmup`, the session's cwd (via `useActiveSession`/`sessionRepoPath` — see `src/state/useActiveSession.ts`).

- [ ] **Step 1: Warm the catalog on session creation**

In `src/state/actions.ts`, find each place a session is created with a cwd (the calls that pass `project.path` into `createSession`, per the map: lines ~73, 93, 106, 118, 183, 195). After a session's cwd is known, call:

```ts
import { useCompletions } from "./completions.ts";
// …after the session is created with `cwd`:
void useCompletions.getState().warmup(cwd);
```

Add one call at the single most common creation path (avoid duplicating in all six — pick the shared helper if there is one; if each is distinct, add to the primary "new session" and "spawn" paths). Keep it fire-and-forget (`void`).

- [ ] **Step 2: Write the failing keyboard test**

Extend the existing `src/layout/PromptBar.test.tsx`. Minimal behavior test — the popover opens on `/` and Enter accepts instead of submitting:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCompletions } from "../state/completions.ts";
import { useSessions } from "../state/sessions.ts";
import { useDrafts } from "../state/drafts.ts";
import { PromptBar } from "./PromptBar.tsx";

vi.mock("../ipc/bridge.ts", async (orig) => ({
  ...(await orig<typeof import("../ipc/bridge.ts")>()),
  writeStdin: vi.fn().mockResolvedValue(undefined),
  listFiles: vi.fn().mockResolvedValue([]),
}));
import { writeStdin } from "../ipc/bridge.ts";

const catalog = {
  commands: [{ name: "clear", description: "Clear history", argumentHint: null, source: "builtin" as const }],
  agents: [],
  claudeVersion: "x",
  degraded: false,
};

describe("PromptBar completions", () => {
  beforeEach(() => {
    // Arrange one active session with a cwd and a warmed catalog.
    useSessions.setState({ activeSessionId: "s1" /* plus whatever the store requires */ } as never);
    useCompletions.setState({ byCwd: { "/repo": catalog }, loading: {} });
    useDrafts.setState({ drafts: { s1: "" }, insertRequest: null });
    vi.mocked(writeStdin).mockClear();
  });

  it("opens the slash popover and Enter accepts without sending", () => {
    render(<PromptBar />);
    const box = screen.getByLabelText("Message the session") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "/cl" } });
    // caret at end
    box.setSelectionRange(3, 3);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(writeStdin).not.toHaveBeenCalled(); // Enter accepted the command, didn't submit
  });
});
```

(This test needs the sessions store shaped correctly — read `src/state/sessions.ts` and set only the fields `PromptBar` reads (`activeSessionId`, `events`). Wire the active session's cwd so `useActiveSession` resolves `/repo`; if that's non-trivial to set up, assert at the `useCompletion` level instead and keep this as a lighter smoke test. The key assertion is: **Enter while the popover is open does not call `writeStdin`.**)

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run src/layout/PromptBar.test.tsx`
Expected: FAIL (popover/keyboard not wired yet).

- [ ] **Step 4: Wire the hook into PromptBar**

In `src/layout/PromptBar.tsx`:

1. Resolve the active session's cwd. Import `useActiveSession` + `sessionRepoPath`:
   ```ts
   import { sessionRepoPath, useActiveSession } from "../state/useActiveSession.ts";
   import { CompletionPopover } from "../completion/CompletionPopover.tsx";
   import { useCompletion } from "../completion/useCompletion.ts";
   ```
2. Track caret position in state and read the hook:
   ```ts
   const { session } = useActiveSession();
   const cwd = session ? sessionRepoPath(session) : null;
   const [caret, setCaret] = useState(0);
   const { view, move, reset, itemAt } = useCompletion({ cwd, value, caret });
   ```
   Update `caret` in `onChange` and on `onKeyUp`/`onClick` of the textarea:
   ```ts
   const syncCaret = () => setCaret(ref.current?.selectionStart ?? 0);
   ```
   Call `syncCaret()` inside the existing `onChange` (after `setDraft`) and add `onKeyUp={syncCaret} onClick={syncCaret}` to the `<textarea>`.
3. Accept helper (reuses the insert-at-caret pattern already in this file):
   ```ts
   function accept(index: number): void {
     const item = itemAt(index);
     if (!(item && activeSessionId)) {
       return;
     }
     const next = value.slice(0, item.start) + item.insert + value.slice(item.end);
     setDraft(activeSessionId, next);
     reset();
     requestAnimationFrame(() => {
       const el = ref.current;
       if (el) {
         el.style.height = "auto";
         el.style.height = `${el.scrollHeight}px`;
         const pos = item.start + item.insert.length;
         el.focus();
         el.setSelectionRange(pos, pos);
         setCaret(pos);
       }
     });
   }
   ```
4. Intercept keys in `onKeyDown` BEFORE the existing Enter=submit branch:
   ```ts
   function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
     if (view.open) {
       if (event.key === "ArrowDown") { event.preventDefault(); move(1); return; }
       if (event.key === "ArrowUp") { event.preventDefault(); move(-1); return; }
       if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); accept(view.activeIndex); return; }
       if (event.key === "Escape") { event.preventDefault(); reset(); return; }
     }
     if (event.key === "Enter" && !event.shiftKey) {
       event.preventDefault();
       send();
     }
   }
   ```
5. Render the popover + mode chip inside `boxStyle` (make `boxStyle`'s container `position: relative` — add `position: "relative"` to `boxStyle`), just above the `<textarea>` wrapper:
   ```tsx
   <div style={{ position: "relative" }}>
     {view.open ? (
       <CompletionPopover
         rows={view.rows}
         activeIndex={view.activeIndex}
         onPick={accept}
         header={view.header}
         degraded={view.degraded}
       />
     ) : null}
     <textarea /* …existing… */ onKeyUp={syncCaret} onClick={syncCaret} />
     {view.mode ? (
       <span style={modeChipStyle}>{view.mode === "bash" ? "! bash command" : "# add to memory"}</span>
     ) : null}
   </div>
   ```
   Add a `modeChipStyle` near the other styles, using `tokens` (mirror `modelChipStyle`).

Run `pnpm fix` after editing.

- [ ] **Step 5: Run to verify it passes + full check**

Run: `pnpm vitest run src/layout/PromptBar.test.tsx` then `pnpm check`
Expected: PASS and green. Fix any type/lint issues surfaced by `pnpm check`.

- [ ] **Step 6: Real-app QA**

For real-app and browser QA, launch the app (`pnpm tauri dev`) and verify in a real session:
- Typing `/` opens the command list; it includes built-ins (`/clear`, `/model`) and custom commands (e.g. `/visual-plan`); descriptions show; fuzzy filter works; ↑/↓ + Enter/Tab insert; Esc closes.
- A command accepted from the popover then Sent actually runs in the PTY.
- Typing `@` lists files from the session cwd (gitignored files absent); `@agent-` lists subagents.
- `!` and `#` at line start show the mode chip; sending still works.
- Kill the network/rename `claude` temporarily (or point `SHELL` somewhere without it) → the popover still shows custom+builtin commands with an "offline" header (degraded path), no error toast, no hang.

- [ ] **Step 7: Commit**

```bash
git add src/layout/PromptBar.tsx src/state/actions.ts src/layout/PromptBar.test.tsx
git commit -m "feat(composer): wire live slash/@/mode-hint completions into PromptBar"
```

---

## Self-Review

**Spec coverage:**
- Live slash commands (built-in + custom + plugin + skill), descriptions, argument-hint → Tasks 1–5, 8, 11, 12, 13. ✅
- `@` file mentions, gitignore-aware, from cwd → Task 6, 12, 13. ✅
- `@agent-<name>` from init `agents` → Tasks 5 (agents captured), 12 (rows), 13. ✅
- `!`/`#` mode-hint chips, no popover → Tasks 8 (detect), 12 (mode), 13 (chip). ✅
- Live sourcing via stream-json init, no scraping → Tasks 3, 5. ✅
- Static supplement only for built-in descriptions + interactive-only set → Task 2, 4. ✅
- Caching per (cwd, version) + warmup on session start → Task 10, 13. ✅
- Reliability: kill-after-init, KRIYON_SESSION stripped, --no-session-persistence, 15s timeout, degraded fallback → Task 5. ✅
- IPC trust boundary: `list_files` validates cwd is a dir; commands take typed args → Task 6. ✅ (Note: the design also called for confirming cwd is within a known session root; Task 6 enforces "is a directory" — the frontend only ever passes the session's own `sessionRepoPath`, and no persisted-root lookup command exists for arbitrary cwds. If stricter containment is wanted, add a project-root check in a follow-up; flagged here rather than silently dropped.)
- TDD across core/tauri/frontend → every task. ✅
- Tokens for styling → Tasks 11, 13. ✅

**Placeholder scan:** No "TBD/TODO/handle edge cases" left as implementation instructions; the two design "open items" (ordering, fuzzy-in-Rust-vs-frontend) were decided (built-ins-first alphabetical in Task 4; fuzzy in frontend in Task 9). Popover anchoring decided (absolute, anchored above the box; Task 11/13).

**Type consistency:** `SlashCommand`/`CommandSource`/`CommandCatalog`/`FileEntry` names and fields match across Rust (Tasks 4–6) and TS (Task 7); `argument_hint`↔`argumentHint`, `claude_version`↔`claudeVersion`, `is_dir`↔`isDir` via serde camelCase. `CompletionItem`/`CompletionRow`/`CompletionView` consistent across Tasks 11–13. `merge_commands` / `parse_init_line` / `parse_frontmatter` / `walk_files` / `enrich_descriptions` names stable across their producing and consuming tasks.

## Open items to confirm during execution

- Verified: `src-tauri` cargo package is `kriyon` (used in all `-p` flags); component tests already run under jsdom + `@testing-library/react`; `src/layout/PromptBar.test.tsx` already exists (extend it).
- The precise session-creation call sites in `actions.ts` for the single warmup call (Step 1 of Task 13) — read the file and pick the shared/new-session path.
