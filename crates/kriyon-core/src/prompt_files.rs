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
