//! [Nested session]s (ADR-0049): a session asking Kriyon, through the
//! Companion's `start_session` tool, to start another session beside it.
//!
//! The request crosses from the user's own `claude` into Kriyon, so it is
//! read defensively and checked here, once: what the mod says the person
//! asked for is only a claim, and what Kriyon does with it is decided by
//! [`outcome`].

use serde::{Deserialize, Serialize};

/// The longest task prompt kept; the mod caps it the same way.
pub const MAX_PROMPT: usize = 20_000;
/// The longest sidebar title kept.
pub const MAX_TITLE: usize = 80;
/// The longest branch name kept.
pub const MAX_BRANCH: usize = 120;

/// Who wanted the session started.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Initiation {
    /// The person asked, in their own words to the session (typed, or over
    /// Remote Control), and the main loop made the call.
    UserAsked,
    /// Claude's own idea, a subagent's, or a turn someone else started.
    OwnInitiative,
}

/// One validated request to start a [Nested session].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRequest {
    /// The tool call's id: one request per call, however often it is read.
    pub request_id: String,
    pub initiation: Initiation,
    pub prompt: String,
    pub title: String,
    pub worktree: bool,
    /// A branch name that is safe to hand to git; `None` when absent or not.
    pub branch: Option<String>,
}

/// What Kriyon does with a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// Start it now, in the background, nested under the session that asked.
    Start,
    /// Show the person a suggestion card; it starts only if they choose it.
    Propose,
}

/// Start only what the person asked for, and only while fewer than `cap`
/// sessions are running (`None`: no cap). Everything else is a suggestion.
#[must_use]
pub fn outcome(initiation: Initiation, running: usize, cap: Option<usize>) -> Outcome {
    let under_cap = cap.is_none_or(|cap| running < cap);
    if initiation == Initiation::UserAsked && under_cap {
        Outcome::Start
    } else {
        Outcome::Propose
    }
}

/// Read one `session_request` spool line. `None` for anything unreadable or
/// missing its prompt, title or id — never an error.
#[must_use]
pub fn parse(value: &serde_json::Value) -> Option<SessionRequest> {
    let text = |key: &str, max: usize| -> Option<String> {
        let s = value.get(key)?.as_str()?.trim();
        (!s.is_empty()).then(|| s.chars().take(max).collect())
    };
    let initiation = match value.get("initiation")?.as_str()? {
        "user_asked" => Initiation::UserAsked,
        _ => Initiation::OwnInitiative,
    };
    Some(SessionRequest {
        request_id: text("requestId", 200)?,
        initiation,
        prompt: text("prompt", MAX_PROMPT)?,
        title: text("title", MAX_TITLE)?,
        worktree: value.get("worktree").and_then(serde_json::Value::as_bool) == Some(true),
        branch: text("branch", MAX_BRANCH + 1).filter(|b| safe_branch(b)),
    })
}

/// A branch name git would take and that can't be read as an option or a
/// path outside the repo: letters, digits, `.`, `_`, `-`, `/`, no `..`, no
/// leading `-` or `/`, no trailing `/` or `.lock`.
#[must_use]
pub fn safe_branch(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_BRANCH
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))
        && !name.starts_with(['-', '/', '.'])
        && !name.ends_with(['/', '.'])
        && !name.to_ascii_lowercase().ends_with(".lock")
        && !name.contains("..")
        && !name.contains("//")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(json: &str) -> Option<SessionRequest> {
        parse(&serde_json::from_str(json).expect("json"))
    }

    #[test]
    fn a_full_request_is_read_and_trimmed() {
        let req = line(
            r#"{"kind":"session_request","requestId":"tu1","initiation":"user_asked",
                "prompt":"  Fix it  ","title":"Fix","worktree":true,"branch":"fix/flaky"}"#,
        )
        .expect("a request");
        assert_eq!(req.request_id, "tu1");
        assert_eq!(req.initiation, Initiation::UserAsked);
        assert_eq!(req.prompt, "Fix it");
        assert!(req.worktree);
        assert_eq!(req.branch.as_deref(), Some("fix/flaky"));
    }

    #[test]
    fn a_request_without_prompt_title_or_id_is_dropped() {
        assert!(line(r#"{"requestId":"a","initiation":"user_asked","title":"T"}"#).is_none());
        assert!(
            line(r#"{"requestId":"a","initiation":"user_asked","prompt":"P","title":" "}"#)
                .is_none()
        );
        assert!(line(r#"{"initiation":"user_asked","prompt":"P","title":"T"}"#).is_none());
    }

    #[test]
    fn an_unknown_initiation_is_only_a_suggestion() {
        let req = line(r#"{"requestId":"a","initiation":"admin","prompt":"P","title":"T"}"#)
            .expect("a request");
        assert_eq!(req.initiation, Initiation::OwnInitiative);
    }

    #[test]
    fn long_text_is_cut_to_its_limit() {
        let long = "x".repeat(MAX_PROMPT + 50);
        let req = line(&format!(
            r#"{{"requestId":"a","initiation":"user_asked","prompt":"{long}","title":"{long}"}}"#
        ))
        .expect("a request");
        assert_eq!(req.prompt.len(), MAX_PROMPT);
        assert_eq!(req.title.len(), MAX_TITLE);
    }

    #[test]
    fn an_unsafe_branch_is_dropped_not_passed_to_git() {
        for bad in [
            "-rf", "/etc", "a..b", "a b", "a;rm", "x.lock", "a//b", ".hidden", "a/",
        ] {
            let req = line(&format!(
                r#"{{"requestId":"a","initiation":"user_asked","prompt":"P","title":"T","branch":"{bad}"}}"#
            ))
            .expect("a request");
            assert_eq!(req.branch, None, "{bad}");
        }
        assert!(safe_branch("feat/nested-sessions_2"));
    }

    #[test]
    fn only_what_the_person_asked_for_starts_and_only_under_the_cap() {
        use Initiation::{OwnInitiative, UserAsked};
        assert_eq!(outcome(UserAsked, 0, None), Outcome::Start);
        assert_eq!(outcome(UserAsked, 3, Some(4)), Outcome::Start);
        assert_eq!(outcome(UserAsked, 4, Some(4)), Outcome::Propose);
        assert_eq!(outcome(OwnInitiative, 0, None), Outcome::Propose);
    }
}
