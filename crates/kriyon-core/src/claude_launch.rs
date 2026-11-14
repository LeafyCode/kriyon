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
//! The line is written for the session's shell: POSIX `sh`, or PowerShell
//! (Windows' session shell, ADR 0055), where env is set for that one `claude`
//! with `$env:` and removed after, and the seed is read as UTF-8.
//!
//! Every id that reaches the command must be a bare token (Claude's ids are
//! UUIDs); one that isn't is never typed: a resume falls back to a fresh
//! start, a report address is dropped.

use std::fmt::Write as _;

pub use crate::shellinit::ShellLanguage;

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
    /// The language of the shell that reads the line.
    pub shell: ShellLanguage,
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
    let mut env: Vec<(&str, &str)> = Vec::new();
    if let Some(report) = report {
        env.push(("KRIYON_REPORT_TO", &report.to));
        env.push(("KRIYON_REPORT_FROM", &report.from));
        if report.split_off {
            env.push(("KRIYON_REPORT_BY", "person"));
        }
    }
    let flags = report.map_or_else(String::new, |report| {
        format!(" --session-id {}", report.from)
    });
    let seed = plan
        .seed_path
        .as_deref()
        .filter(|path| safe_path(path, plan.shell));
    match plan.shell {
        ShellLanguage::Posix => posix_launch(&env, &flags, seed),
        ShellLanguage::PowerShell => powershell_launch(&env, &flags, seed),
    }
}

fn posix_launch(env: &[(&str, &str)], flags: &str, seed: Option<&str>) -> String {
    let env = env.iter().fold(String::new(), |mut out, (name, value)| {
        let _ = write!(out, "{name}={value} ");
        out
    });
    match seed {
        Some(path) => {
            format!("p=\"$(cat \"{path}\")\"; rm -f \"{path}\"; {env}claude{flags} \"$p\"\r")
        }
        None => format!("{env}claude{flags}\r"),
    }
}

/// A value inside PowerShell single quotes, where only `'` needs doubling.
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Windows PowerShell 5.1 passes a native program's argument without
/// escaping the double quotes inside it, so a prompt with a `"` would arrive
/// split. This escapes them the way the program's argument parser reads them:
/// a `"` becomes `\"` (backslashes before it doubled), and backslashes ending
/// the prompt are doubled so they can't escape the closing quote PowerShell
/// adds.
const PS_ESCAPED_ARG: &str =
    r#"(($p.TrimEnd("`r`n") -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1')"#;

/// The seed as `claude`'s argument. pwsh 7.3+ escapes a native argument's
/// quotes itself (`$PSNativeCommandArgumentPassing` is `Standard`), and
/// escaping them again would hand claude a literal backslash; Windows
/// PowerShell 5.1 has no such variable, so it gets [`PS_ESCAPED_ARG`].
fn ps_native_arg() -> String {
    format!(
        r#"$(if ($PSNativeCommandArgumentPassing -in $null, 'Legacy') {{ {PS_ESCAPED_ARG} }} else {{ $p.TrimEnd("`r`n") }})"#
    )
}

/// The launch line for PowerShell. A `$env:` assignment lasts for the whole
/// shell, not one command as `NAME=value claude` does in sh, so the variables
/// are removed again when `claude` ends (even on Ctrl-C), and a `claude`
/// started later in the same terminal doesn't inherit them.
fn powershell_launch(env: &[(&str, &str)], flags: &str, seed: Option<&str>) -> String {
    let read = seed.map_or_else(String::new, |path| {
        let path = ps_quote(path);
        format!("$p = Get-Content -Raw -Encoding UTF8 -LiteralPath {path}; Remove-Item -LiteralPath {path}; ")
    });
    let arg = seed.map_or_else(String::new, |_| format!(" {}", ps_native_arg()));
    let claude = format!("claude{flags}{arg}");
    if env.is_empty() {
        return format!("{read}{claude}\r");
    }
    let set = env.iter().fold(String::new(), |mut out, (name, value)| {
        let _ = write!(out, "$env:{name}={}; ", ps_quote(value));
        out
    });
    let unset = env
        .iter()
        .map(|(name, _)| format!("Env:{name}"))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{read}{set}try {{ {claude} }} finally {{ Remove-Item {unset} -ErrorAction Ignore }}\r")
}

/// Whether a seed file path is safe to type for `shell`: inside POSIX double
/// quotes, nothing the shell would read there; inside PowerShell single
/// quotes (a `'` doubled), no control character.
#[must_use]
pub fn safe_path(path: &str, shell: ShellLanguage) -> bool {
    if path.is_empty() || path.chars().any(char::is_control) {
        return false;
    }
    match shell {
        ShellLanguage::Posix => !path.chars().any(|c| matches!(c, '"' | '$' | '`' | '\\')),
        ShellLanguage::PowerShell => true,
    }
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

    /// The expression that escapes the seed for a native argument where
    /// PowerShell passes quotes raw (Windows PowerShell 5.1).
    const PS_ESCAPED: &str =
        r#"(($p.TrimEnd("`r`n") -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1')"#;

    fn ps_arg() -> String {
        format!(
            r#"$(if ($PSNativeCommandArgumentPassing -in $null, 'Legacy') {{ {PS_ESCAPED} }} else {{ $p.TrimEnd("`r`n") }})"#
        )
    }

    fn powershell(plan: LaunchPlan) -> LaunchPlan {
        LaunchPlan {
            shell: ShellLanguage::PowerShell,
            ..plan
        }
    }

    #[test]
    fn powershell_starts_claude_bare_or_resumes_the_same_way() {
        assert_eq!(
            claude_command(&powershell(LaunchPlan::default())),
            "claude\r"
        );
        let resume = powershell(LaunchPlan {
            claude_session_id: Some("claude-abc".into()),
            ..LaunchPlan::default()
        });
        assert_eq!(claude_command(&resume), "claude --resume claude-abc\r");
    }

    /// A `$env:` assignment lasts for the whole shell, so it is removed again
    /// when claude ends, even on Ctrl-C.
    #[test]
    fn powershell_sets_a_nested_sessions_env_for_that_claude_only() {
        let plan = powershell(LaunchPlan {
            report: Some(report("aaa", "bbb", false)),
            ..LaunchPlan::default()
        });
        assert_eq!(
            claude_command(&plan),
            "$env:KRIYON_REPORT_TO='aaa'; $env:KRIYON_REPORT_FROM='bbb'; try { claude --session-id bbb } finally { Remove-Item Env:KRIYON_REPORT_TO, Env:KRIYON_REPORT_FROM -ErrorAction Ignore }\r"
        );
        let split = powershell(LaunchPlan {
            report: Some(report("aaa", "bbb", true)),
            ..LaunchPlan::default()
        });
        assert!(claude_command(&split).contains(
            "$env:KRIYON_REPORT_BY='person'; try { claude --session-id bbb } finally { Remove-Item Env:KRIYON_REPORT_TO, Env:KRIYON_REPORT_FROM, Env:KRIYON_REPORT_BY -ErrorAction Ignore }"
        ));
    }

    /// The seed is read as UTF-8 (Kriyon writes it without a BOM), its file
    /// removed, and passed escaped only where PowerShell passes quotes raw.
    #[test]
    fn powershell_reads_a_seed_from_a_windows_path_and_passes_it() {
        let plan = powershell(LaunchPlan {
            seed_path: Some(r"C:\Users\O'Neil\run\s.prompt".into()),
            ..LaunchPlan::default()
        });
        assert_eq!(
            claude_command(&plan),
            format!(
                r"$p = Get-Content -Raw -Encoding UTF8 -LiteralPath 'C:\Users\O''Neil\run\s.prompt'; Remove-Item -LiteralPath 'C:\Users\O''Neil\run\s.prompt'; claude {}{}",
                ps_arg(),
                "\r"
            )
        );
        let nested = powershell(LaunchPlan {
            seed_path: Some(r"C:\r\s.prompt".into()),
            report: Some(report("aaa", "bbb", false)),
            ..LaunchPlan::default()
        });
        assert!(claude_command(&nested).contains(&format!(
            "try {{ claude --session-id bbb {} }} finally {{ Remove-Item Env:KRIYON_REPORT_TO, Env:KRIYON_REPORT_FROM -ErrorAction Ignore }}\r",
            ps_arg()
        )));
    }

    #[test]
    fn a_seed_path_powershell_can_quote_is_one_without_control_characters() {
        assert!(safe_path(
            r"C:\Users\me\run\s.prompt",
            ShellLanguage::PowerShell
        ));
        assert!(safe_path("C:\\a'b\\s.prompt", ShellLanguage::PowerShell));
        assert!(!safe_path(
            r"C:\Users\me\run\s.prompt",
            ShellLanguage::Posix
        ));
        for bad in ["", "C:\\a\nb", "C:\\a\rb"] {
            assert!(!safe_path(bad, ShellLanguage::PowerShell), "{bad:?}");
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
