//! Live composer completions: parse the installed `claude` CLI's command set
//! (from its stream-json `init` message) and enrich it with on-disk frontmatter
//! and a static built-in description map. Pure logic; the Tauri layer owns the
//! process/filesystem access.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// True when `candidate` equals one of `roots` or is nested within one. All
/// paths must already be canonicalized by the caller (symlinks resolved, `..`
/// collapsed) so the component-wise `starts_with` comparison is sound — a raw
/// string prefix would wrongly accept `/home/u/project2` under `/home/u/proj`.
///
/// This is the composer's IPC trust-boundary check: the Tauri layer
/// canonicalizes the frontend-supplied `cwd` and every known session/project
/// root, then gates `@` file walks and `claude` probes on this returning `true`
/// — never walking or spawning in a blindly-trusted path.
#[must_use]
pub fn path_within_roots(candidate: &Path, roots: &[PathBuf]) -> bool {
    roots
        .iter()
        .any(|root| candidate == root.as_path() || candidate.starts_with(root))
}

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
    // Normalize CRLF so a Windows-authored `.md` (fence `---\r\n`) parses like
    // an LF one; without this the `---\n` fence match fails and the command
    // silently loses its description/hint in the popover. Only pay the
    // allocation when a `\r` is actually present (the common macOS/Linux case
    // stays borrow-only).
    let normalized;
    let content = if content.contains('\r') {
        normalized = content.replace("\r\n", "\n");
        normalized.as_str()
    } else {
        content
    };
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
    BuiltinCommand {
        name: "model",
        description: "Choose the model for this session",
        interactive_only: true,
    },
    BuiltinCommand {
        name: "help",
        description: "Show help and available commands",
        interactive_only: true,
    },
    BuiltinCommand {
        name: "resume",
        description: "Resume a previous conversation",
        interactive_only: true,
    },
    BuiltinCommand {
        name: "login",
        description: "Sign in to your Anthropic account",
        interactive_only: true,
    },
    BuiltinCommand {
        name: "logout",
        description: "Sign out of your Anthropic account",
        interactive_only: true,
    },
    BuiltinCommand {
        name: "status",
        description: "Show session and account status",
        interactive_only: true,
    },
    BuiltinCommand {
        name: "cost",
        description: "Show token usage and cost this session",
        interactive_only: true,
    },
    BuiltinCommand {
        name: "mcp",
        description: "Manage MCP server connections",
        interactive_only: true,
    },
    BuiltinCommand {
        name: "doctor",
        description: "Diagnose installation and setup issues",
        interactive_only: true,
    },
    BuiltinCommand {
        name: "vim",
        description: "Toggle vim editing mode",
        interactive_only: true,
    },
    BuiltinCommand {
        name: "memory",
        description: "Edit memory (CLAUDE.md) files",
        interactive_only: true,
    },
    BuiltinCommand {
        name: "hooks",
        description: "Configure hooks",
        interactive_only: true,
    },
    BuiltinCommand {
        name: "permissions",
        description: "Manage tool permissions",
        interactive_only: true,
    },
    BuiltinCommand {
        name: "export",
        description: "Export the conversation",
        interactive_only: true,
    },
    BuiltinCommand {
        name: "ide",
        description: "Manage IDE integrations",
        interactive_only: true,
    },
    BuiltinCommand {
        name: "terminal-setup",
        description: "Configure terminal key bindings",
        interactive_only: true,
    },
    // Description-only enrichment for built-ins the probe DOES list by name.
    BuiltinCommand {
        name: "clear",
        description: "Clear the conversation history",
        interactive_only: false,
    },
    BuiltinCommand {
        name: "compact",
        description: "Compact the conversation to free context",
        interactive_only: false,
    },
    BuiltinCommand {
        name: "context",
        description: "Show what is using the context window",
        interactive_only: false,
    },
    BuiltinCommand {
        name: "config",
        description: "View or change configuration",
        interactive_only: false,
    },
    BuiltinCommand {
        name: "init",
        description: "Initialize a CLAUDE.md for this project",
        interactive_only: false,
    },
    BuiltinCommand {
        name: "agents",
        description: "Manage subagents",
        interactive_only: false,
    },
    BuiltinCommand {
        name: "usage",
        description: "Show plan usage limits",
        interactive_only: false,
    },
    BuiltinCommand {
        name: "review",
        description: "Review a pull request",
        interactive_only: false,
    },
    BuiltinCommand {
        name: "security-review",
        description: "Security-review the pending changes",
        interactive_only: false,
    },
    BuiltinCommand {
        name: "add-dir",
        description: "Add a working directory",
        interactive_only: false,
    },
    BuiltinCommand {
        name: "todos",
        description: "Show the current todo list",
        interactive_only: false,
    },
    BuiltinCommand {
        name: "rewind",
        description: "Rewind the conversation to an earlier point",
        interactive_only: false,
    },
];

/// Built-in subagent types the CLI ships with (no on-disk file). Surfaced for
/// `@agent-` mentions alongside the user/project/plugin agents read from disk.
pub const BUILTIN_AGENTS: &[&str] = &["general-purpose", "Explore", "Plan"];

/// The subset of a plugin's `.claude-plugin/plugin.json` the composer needs: the
/// optional relative-path overrides for where its commands, skills, and agents
/// live. An absent key means "use the default `commands/` / `skills/` /
/// `agents/` subdirectory". Tolerant — malformed JSON, or a non-string value
/// (e.g. an array of dirs, which we don't resolve), yields `None` for that key
/// and the caller falls back to the default subdirectory.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PluginManifest {
    pub commands_dir: Option<String>,
    pub skills_dir: Option<String>,
    pub agents_dir: Option<String>,
}

/// Parse the three dir-override keys from a plugin manifest's JSON. Never errors:
/// bad JSON or missing keys degrade to `None`s.
#[must_use]
pub fn parse_plugin_manifest(json: &str) -> PluginManifest {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return PluginManifest::default();
    };
    let str_key = |key: &str| {
        v.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    PluginManifest {
        commands_dir: str_key("commands"),
        skills_dir: str_key("skills"),
        agents_dir: str_key("agents"),
    }
}

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
#[allow(clippy::implicit_hasher)] // `described` is always the default-hasher HashMap the IPC layer builds.
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
    fn crlf_frontmatter_parses_like_lf() {
        // A command `.md` authored on Windows uses CRLF line endings; the fence
        // is `---\r\n`. It must yield the same result as the LF form, not lose
        // its description/hint to a failed fence match.
        let md = "---\r\ndescription: Windows authored\r\nargument-hint: [x]\r\n---\r\nBody";
        let m = parse_frontmatter(md);
        assert_eq!(m.description.as_deref(), Some("Windows authored"));
        assert_eq!(m.argument_hint.as_deref(), Some("[x]"));
    }

    #[test]
    fn path_within_roots_matches_root_and_descendants_only() {
        let roots = vec![PathBuf::from("/home/u/proj"), PathBuf::from("/tmp/work")];
        // Exact root and a nested descendant are inside.
        assert!(path_within_roots(Path::new("/home/u/proj"), &roots));
        assert!(path_within_roots(Path::new("/home/u/proj/src/lib"), &roots));
        assert!(path_within_roots(Path::new("/tmp/work/a"), &roots));
        // An ancestor of a root is NOT inside it.
        assert!(!path_within_roots(Path::new("/home/u"), &roots));
        // A sibling that merely shares a string prefix is NOT inside (this is
        // the bug a raw string `starts_with` would introduce).
        assert!(!path_within_roots(Path::new("/home/u/project2"), &roots));
        // Wholly unrelated paths are rejected.
        assert!(!path_within_roots(Path::new("/etc/passwd"), &roots));
        // No roots → nothing is allowed.
        assert!(!path_within_roots(Path::new("/home/u/proj"), &[]));
    }

    #[test]
    fn unclosed_or_blank_values_degrade_to_none() {
        assert_eq!(parse_frontmatter("---\ndescription: hi").description, None);
        assert_eq!(
            parse_frontmatter("---\ndescription:\n---\nb").description,
            None
        );
    }

    #[test]
    fn builtins_cover_the_interactive_only_set() {
        // The commands the stream-json init message omits (docs: "only commands
        // that work without an interactive terminal are dispatchable"). They
        // MUST be present so the popover can still offer them.
        let required = [
            "model",
            "help",
            "resume",
            "login",
            "logout",
            "status",
            "cost",
            "mcp",
            "doctor",
            "vim",
            "memory",
            "hooks",
            "permissions",
            "export",
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

    #[test]
    fn plugin_manifest_reads_dir_overrides() {
        let json = r#"{"name":"neon","skills":"./skills/","commands":"cmds"}"#;
        let m = parse_plugin_manifest(json);
        assert_eq!(m.skills_dir.as_deref(), Some("./skills/"));
        assert_eq!(m.commands_dir.as_deref(), Some("cmds"));
        assert_eq!(m.agents_dir, None);
    }

    #[test]
    fn plugin_manifest_tolerates_junk_and_non_string_values() {
        assert_eq!(parse_plugin_manifest("not json"), PluginManifest::default());
        // An array value (multiple dirs) is not resolved → None, caller uses default.
        let m = parse_plugin_manifest(r#"{"commands":["a","b"]}"#);
        assert_eq!(m.commands_dir, None);
    }

    #[test]
    fn merge_enriches_custom_and_builtin_and_appends_interactive() {
        let live = vec!["commit".to_string(), "clear".to_string()];
        let mut described = HashMap::new();
        described.insert(
            "commit".to_string(),
            Frontmatter {
                description: Some("Create a git commit".into()),
                argument_hint: Some("[msg]".into()),
            },
        );
        let out = merge_commands(&live, &described, BUILTIN_COMMANDS);

        let commit = out.iter().find(|c| c.name == "commit").expect("commit");
        assert_eq!(commit.source, CommandSource::Custom);
        assert_eq!(commit.description.as_deref(), Some("Create a git commit"));
        assert_eq!(commit.argument_hint.as_deref(), Some("[msg]"));

        let clear = out.iter().find(|c| c.name == "clear").expect("clear");
        assert_eq!(clear.source, CommandSource::Builtin);
        assert_eq!(
            clear.description.as_deref(),
            Some("Clear the conversation history")
        );

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

    #[test]
    fn merge_sorts_builtin_before_alphabetically_earlier_custom() {
        let mut described = HashMap::new();
        described.insert(
            "aaa".to_string(),
            Frontmatter {
                description: Some("custom aaa".into()),
                argument_hint: None,
            },
        );
        let live = vec!["aaa".to_string(), "clear".to_string()];
        let out = merge_commands(&live, &described, BUILTIN_COMMANDS);

        let aaa = out.iter().find(|c| c.name == "aaa").expect("aaa");
        assert_eq!(aaa.source, CommandSource::Custom);
        let clear = out.iter().find(|c| c.name == "clear").expect("clear");
        assert_eq!(clear.source, CommandSource::Builtin);

        let aaa_idx = out.iter().position(|c| c.name == "aaa").unwrap();
        let clear_idx = out.iter().position(|c| c.name == "clear").unwrap();
        assert!(
            clear_idx < aaa_idx,
            "builtin 'clear' must sort before custom 'aaa' despite 'aaa' < 'clear' alphabetically"
        );
    }
}
