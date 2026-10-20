use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionId(pub String);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpawnSpec {
    pub cwd: String,
    pub shell: String, // e.g. "/bin/zsh"
    pub env: HashMap<String, String>,
}

/// The variables a running Claude Code sets in the processes it spawns (Bash
/// tool, hooks, status line, plugins) to say "you are running inside me".
/// Sourced from code.claude.com/docs/en/env-vars ("Set by Claude Code" /
/// "Set automatically"), plus the undocumented ones a real v2.1.287 Bash tool
/// shell carries. An explicit list, not a prefix: `CLAUDE_CODE_*` is mostly
/// the user's own configuration (ADR-0028).
const AGENT_IDENTITY_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_REMOTE",
    "CLAUDE_CODE_REMOTE_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_SESSION_ID",
    // Set by an IDE in its terminal; would bind the hosted claude to it.
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_CODE_VERSION",
    "CLAUDE_EFFORT",
    "CLAUDE_JOB_DIR",
    "CLAUDE_PID",
    "CLAUDE_PLUGIN_DATA",
    "CLAUDE_PLUGIN_ROOT",
];

/// Whether `key` is an environment variable a launching Claude Code sets to
/// mark "you are running inside me".
///
/// Kriyon hosts the user's own `claude` and must present it a clean, top-level
/// environment: if these markers leak through (e.g. Kriyon was itself launched
/// from a Claude Code session), `claude` detects a *nested* instance and does
/// not persist its `~/.claude/projects/.../<id>.jsonl` transcript — which
/// leaves the transcript with nothing to read. We strip them at the spawn
/// boundary. Everything else — the user's `CLAUDE_CODE_*` settings
/// (`CLAUDE_CODE_PLUGIN_DIRS`, `CLAUDE_CODE_NO_FLICKER`, `CLAUDE_CODE_OAUTH_TOKEN`
/// …), `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY` and Kriyon's own hook gate
/// (`KRIYON_SESSION`) — is deliberately preserved.
#[must_use]
pub fn is_agent_identity_var(key: &str) -> bool {
    AGENT_IDENTITY_VARS.contains(&key)
}

pub trait SessionEngine: Send + Sync {
    fn id(&self) -> &SessionId;

    /// Write bytes to the session's stdin.
    ///
    /// # Errors
    /// Returns [`EngineError`] if the underlying pty write fails.
    fn write_stdin(&self, bytes: &[u8]) -> Result<(), EngineError>;

    /// Resize the session's pty to the given dimensions.
    ///
    /// # Errors
    /// Returns [`EngineError`] if the underlying pty resize fails.
    fn resize(&self, cols: u16, rows: u16) -> Result<(), EngineError>;

    /// Close the session and release its resources.
    ///
    /// # Errors
    /// Returns [`EngineError`] if closing the underlying pty fails.
    fn close(&self) -> Result<(), EngineError>;
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("pty error: {0}")]
    Pty(String),
    #[error("session not found")]
    NotFound,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Idle,
    Running,
    Waiting,
    Done,
    Error,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_claude_code_identity_but_keeps_config_and_kriyon() {
        // Markers a launching Claude Code (or nested agent) sets — stripping
        // them lets the hosted `claude` persist its transcript as a top-level
        // session.
        assert!(is_agent_identity_var("CLAUDECODE"));
        assert!(is_agent_identity_var("CLAUDE_CODE_ENTRYPOINT"));
        assert!(is_agent_identity_var("CLAUDE_CODE_SESSION_ID"));
        assert!(is_agent_identity_var("CLAUDE_CODE_CHILD_SESSION"));
        assert!(is_agent_identity_var("CLAUDE_CODE_EXECPATH"));
        assert!(is_agent_identity_var("CLAUDE_CODE_VERSION"));
        // An IDE terminal's link to that IDE: a session Kriyon hosts must not
        // attach to whichever editor happened to launch Kriyon.
        assert!(is_agent_identity_var("CLAUDE_CODE_SSE_PORT"));
        assert!(is_agent_identity_var("CLAUDE_EFFORT"));
        assert!(is_agent_identity_var("CLAUDE_CODE_SESSION_ATTENDED"));
        assert!(is_agent_identity_var("CLAUDE_CODE_BRIDGE_SESSION_ID"));
        assert!(is_agent_identity_var("CLAUDE_CODE_MESSAGING_SOCKET"));
        assert!(is_agent_identity_var("CLAUDE_CODE_MESSAGING_TOKEN"));
        assert!(is_agent_identity_var("CLAUDE_CODE_REMOTE"));
        assert!(is_agent_identity_var("CLAUDE_CODE_REMOTE_SESSION_ID"));
        assert!(is_agent_identity_var("CLAUDE_PID"));
        assert!(is_agent_identity_var("CLAUDE_JOB_DIR"));
        assert!(is_agent_identity_var("CLAUDE_PLUGIN_ROOT"));
        assert!(is_agent_identity_var("CLAUDE_PLUGIN_DATA"));

        // Must NOT strip the user's config/auth or Kriyon's own gate.
        assert!(!is_agent_identity_var("CLAUDE_CONFIG_DIR"));
        assert!(!is_agent_identity_var("ANTHROPIC_API_KEY"));
        assert!(!is_agent_identity_var("KRIYON_SESSION"));
        assert!(!is_agent_identity_var("PATH"));
        assert!(!is_agent_identity_var("HOME"));
    }

    #[test]
    fn keeps_the_users_own_claude_code_settings() {
        // `CLAUDE_CODE_*` is also the prefix of the CLI's user configuration
        // (code.claude.com/docs/en/env-vars). A value inherited from Kriyon's
        // launch environment is the user's choice and must reach `claude`.
        for key in [
            "CLAUDE_CODE_PLUGIN_DIRS",
            "CLAUDE_CODE_NO_FLICKER",
            "CLAUDE_CODE_DISABLE_MOUSE",
            "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN",
            "CLAUDE_CODE_SCROLL_SPEED",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_EFFORT_LEVEL",
            "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE",
            "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
        ] {
            assert!(!is_agent_identity_var(key), "{key} is user config");
        }
    }

    #[test]
    fn a_kriyon_launched_from_claude_code_sheds_every_nesting_marker() {
        // The `CLAUDE*` keys a real Claude Code (v2.1.287) Bash tool shell
        // carries. None of them is user config, so all must go — this is the
        // guarantee that the hosted `claude` writes a top-level transcript.
        for key in [
            "CLAUDECODE",
            "CLAUDE_CODE_CHILD_SESSION",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_CODE_EXECPATH",
            "CLAUDE_CODE_MESSAGING_SOCKET",
            "CLAUDE_CODE_MESSAGING_TOKEN",
            "CLAUDE_CODE_SESSION_ATTENDED",
            "CLAUDE_CODE_SESSION_ID",
            "CLAUDE_EFFORT",
            "CLAUDE_PID",
            "CLAUDE_PLUGIN_DATA",
        ] {
            assert!(is_agent_identity_var(key), "{key} marks a nested session");
        }
    }

    #[test]
    fn status_serializes_lowercase() {
        let j = serde_json::to_string(&SessionStatus::Waiting).unwrap();
        assert_eq!(j, "\"waiting\"");
    }

    #[test]
    fn spawn_spec_round_trips_through_serde() {
        let mut env = HashMap::new();
        env.insert("PATH".to_string(), "/usr/bin".to_string());
        env.insert("HOME".to_string(), "/Users/test".to_string());
        let spec = SpawnSpec {
            cwd: "/tmp/work".to_string(),
            shell: "/bin/zsh".to_string(),
            env,
        };
        let json = serde_json::to_string(&spec).unwrap();
        let back: SpawnSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(spec, back);
    }

    #[test]
    fn session_engine_is_object_safe() {
        struct StubEngine {
            id: SessionId,
        }

        impl SessionEngine for StubEngine {
            fn id(&self) -> &SessionId {
                &self.id
            }
            fn write_stdin(&self, _bytes: &[u8]) -> Result<(), EngineError> {
                Ok(())
            }
            fn resize(&self, _cols: u16, _rows: u16) -> Result<(), EngineError> {
                Ok(())
            }
            fn close(&self) -> Result<(), EngineError> {
                Ok(())
            }
        }

        let engine: Box<dyn SessionEngine> = Box::new(StubEngine {
            id: SessionId("s1".to_string()),
        });
        assert_eq!(engine.id(), &SessionId("s1".to_string()));
    }
}
