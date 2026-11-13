//! What Kriyon types into a [Session]'s shell to start `claude` (ADR 0003),
//! decided here once for every way a session starts: the desktop and a
//! [Remote device] alike.
//!
//! - A session with a known [Claude session id] resumes it:
//!   `claude --resume <id>`.
//! - Otherwise a fresh `claude`, seeded with a first prompt when there is
//!   one. The prompt is never typed or shell-escaped: Kriyon writes it to a
//!   file of its own, and the command reads that file into a variable,
//!   removes it, and passes the variable as `claude`'s argument.
//! - A [Nested session] starts under the conversation id it reports from,
//!   told where to send its first answer (ADR-0049).
//!
//! Every id that reaches the command must be a bare token (Claude's ids are
//! UUIDs); one that isn't is never typed: a resume falls back to a fresh
//! start, a report address is dropped.

/// Where a [Nested session] sends its first answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    /// The lead's conversation id.
    pub to: String,
    /// The nested session's own conversation id.
    pub from: String,
    /// The person split it off, rather than Claude asking for it.
    pub split_off: bool,
}

/// How `claude` is to start in a session.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LaunchPlan {
    /// The [Claude session id] to resume, if the session has one.
    pub claude_session_id: Option<String>,
    /// The seed prompt's file, already written, when there is a first prompt.
    pub seed_path: Option<String>,
    pub report: Option<Report>,
}

/// Whether `id` is safe to type: a bare token, as Claude's ids are.
#[must_use]
pub fn is_bare_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && id.len() <= 128
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Whether `plan` resumes a conversation (and so can fail to, when it has
/// expired).
#[must_use]
pub fn resumes(plan: &LaunchPlan) -> bool {
    plan.claude_session_id.as_deref().is_some_and(is_bare_id)
}

/// The command line to type, ending in a carriage return.
#[must_use]
pub fn claude_command(plan: &LaunchPlan) -> String {
    if let Some(id) = plan
        .claude_session_id
        .as_deref()
        .filter(|id| is_bare_id(id))
    {
        return format!("claude --resume {id}\r");
    }
    let report = plan
        .report
        .as_ref()
        .filter(|report| is_bare_id(&report.to) && is_bare_id(&report.from));
    let env = report.map_or_else(String::new, |report| {
        let by = if report.split_off {
            "KRIYON_REPORT_BY=person "
        } else {
            ""
        };
        format!(
            "KRIYON_REPORT_TO={} KRIYON_REPORT_FROM={} {by}",
            report.to, report.from
        )
    });
    let flags = report.map_or_else(String::new, |report| {
        format!(" --session-id {}", report.from)
    });
    match plan.seed_path.as_deref().filter(|path| safe_path(path)) {
        Some(path) => {
            format!("p=\"$(cat \"{path}\")\"; rm -f \"{path}\"; {env}claude{flags} \"$p\"\r")
        }
        None => format!("{env}claude{flags}\r"),
    }
}

/// Whether a seed file path is safe inside double quotes: nothing in it
/// that the shell would read there.
#[must_use]
pub fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && !path
            .chars()
            .any(|c| matches!(c, '"' | '$' | '`' | '\\' | '\n' | '\r') || c.is_control())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(to: &str, from: &str, split_off: bool) -> Report {
        Report {
            to: to.into(),
            from: from.into(),
            split_off,
        }
    }

    #[test]
    fn a_session_without_a_conversation_starts_a_plain_claude() {
        assert_eq!(claude_command(&LaunchPlan::default()), "claude\r");
    }

    #[test]
    fn a_known_conversation_is_resumed() {
        let plan = LaunchPlan {
            claude_session_id: Some("claude-abc".into()),
            ..LaunchPlan::default()
        };
        assert!(resumes(&plan));
        assert_eq!(claude_command(&plan), "claude --resume claude-abc\r");
    }

    #[test]
    fn a_conversation_id_that_isnt_a_bare_token_is_never_typed() {
        let plan = LaunchPlan {
            claude_session_id: Some("abc; rm -rf ~".into()),
            ..LaunchPlan::default()
        };
        assert!(!resumes(&plan));
        assert_eq!(claude_command(&plan), "claude\r");
    }

    #[test]
    fn a_seed_prompt_is_read_from_its_file_never_typed() {
        let plan = LaunchPlan {
            seed_path: Some("/run/s1.prompt".into()),
            ..LaunchPlan::default()
        };
        assert_eq!(
            claude_command(&plan),
            "p=\"$(cat \"/run/s1.prompt\")\"; rm -f \"/run/s1.prompt\"; claude \"$p\"\r"
        );
    }

    #[test]
    fn a_resume_wins_over_a_seed() {
        let plan = LaunchPlan {
            claude_session_id: Some("claude-abc".into()),
            seed_path: Some("/run/s1.prompt".into()),
            ..LaunchPlan::default()
        };
        assert_eq!(claude_command(&plan), "claude --resume claude-abc\r");
    }

    #[test]
    fn a_nested_session_starts_under_its_own_id_told_where_to_report() {
        let plan = LaunchPlan {
            seed_path: Some("/run/s1.prompt".into()),
            report: Some(report("parent-uuid", "child-uuid", false)),
            ..LaunchPlan::default()
        };
        assert_eq!(
            claude_command(&plan),
            "p=\"$(cat \"/run/s1.prompt\")\"; rm -f \"/run/s1.prompt\"; KRIYON_REPORT_TO=parent-uuid KRIYON_REPORT_FROM=child-uuid claude --session-id child-uuid \"$p\"\r"
        );
        let unseeded = LaunchPlan {
            report: Some(report("lead-uuid", "child-uuid", false)),
            ..LaunchPlan::default()
        };
        assert_eq!(
            claude_command(&unseeded),
            "KRIYON_REPORT_TO=lead-uuid KRIYON_REPORT_FROM=child-uuid claude --session-id child-uuid\r"
        );
    }

    #[test]
    fn a_split_off_session_is_told_the_person_started_it() {
        let plan = LaunchPlan {
            report: Some(report("lead-uuid", "child-uuid", true)),
            ..LaunchPlan::default()
        };
        assert_eq!(
            claude_command(&plan),
            "KRIYON_REPORT_TO=lead-uuid KRIYON_REPORT_FROM=child-uuid KRIYON_REPORT_BY=person claude --session-id child-uuid\r"
        );
    }

    #[test]
    fn a_report_address_that_isnt_a_bare_id_is_never_typed() {
        let plan = LaunchPlan {
            seed_path: Some("/run/s1.prompt".into()),
            report: Some(report("parent-uuid", "child; rm -rf ~", false)),
            ..LaunchPlan::default()
        };
        assert_eq!(
            claude_command(&plan),
            "p=\"$(cat \"/run/s1.prompt\")\"; rm -f \"/run/s1.prompt\"; claude \"$p\"\r"
        );
    }

    #[test]
    fn a_seed_path_the_shell_would_read_inside_quotes_is_never_typed() {
        for path in [
            "/run/$(evil).prompt",
            "/run/\"x.prompt",
            "/run/`x`.prompt",
            "",
        ] {
            let plan = LaunchPlan {
                seed_path: Some(path.into()),
                ..LaunchPlan::default()
            };
            assert_eq!(claude_command(&plan), "claude\r", "{path}");
        }
    }

    #[test]
    fn a_bare_id_is_a_letter_or_digit_then_word_characters_or_dashes() {
        assert!(is_bare_id("0b7e-uuid_1"));
        for bad in ["", "-x", "a b", "a;b", &"a".repeat(129)] {
            assert!(!is_bare_id(bad), "{bad}");
        }
        assert!(is_bare_id(&"a".repeat(128)));
    }
}
