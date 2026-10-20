//! [Handoff file] detection — spotting, from hook events alone (zero tokens),
//! the `*handoff*.md` file the user's own handoff skill writes, so Kriyon can
//! offer it on a [Handoff card] once the turn ends.
//!
//! Three cues, any is enough: a `UserPromptSubmit` whose slash command name
//! contains one of [`HANDOFF_COMMAND_FRAGMENTS`], a `Write` of a
//! `*handoff*.md` file, and a `Bash` command naming one inside a temp dir.
//! [`HandoffPlaces`] says where each may live. Pure: the shell does the IO
//! (the temp-dir scan and the canonical, size-capped, fresh-enough validation).
//!
//! It also picks the new session's [Handoff prompt]: the handoff file's own
//! starting-prompt section, else the handoff command's arguments, else a plain
//! "read it and continue".

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::hooks::HookEvent;

/// Slash-command name fragments that mark a handoff command (matched
/// case-insensitively against the command name, plugin prefix included).
pub const HANDOFF_COMMAND_FRAGMENTS: &[&str] = &["handoff"];

/// The largest [Handoff file] Kriyon will offer — a handoff is a page of notes,
/// not a dump.
pub const HANDOFF_FILE_MAX_BYTES: u64 = 256 * 1024;

/// Temp roots that are always considered, beside `$TMPDIR`. macOS's per-user
/// `$TMPDIR` lives under `/var/folders`, which canonicalizes to
/// `/private/var/folders`.
const FIXED_TEMP_ROOTS: &[&str] = &[
    "/tmp",
    "/private/tmp",
    "/var/folders",
    "/private/var/folders",
];

/// The temp dirs a [Handoff file] may live in: `$TMPDIR` (when set) plus the
/// fixed system roots.
#[must_use]
pub fn temp_roots(tmpdir: Option<&str>) -> Vec<PathBuf> {
    tmpdir
        .filter(|t| !t.is_empty())
        .map(PathBuf::from)
        .into_iter()
        .chain(FIXED_TEMP_ROOTS.iter().map(PathBuf::from))
        .collect()
}

/// How a [Handoff file] was found, which decides where it may live
/// ([`HandoffPlaces::allows`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandoffOrigin {
    /// The session's own `Write` made it during the turn.
    Written,
    /// A shell command named it, or a scan of the temp dirs found it.
    Named,
}

/// Where a [Handoff file] may live — the one rule every cue goes through.
/// Anywhere a handoff turns up must be a temp dir, except a file the session's
/// own `Write` made during the turn: that one may also sit anywhere under the
/// home folder, outside its hidden folders (`~/.claude`, `~/.ssh`, a repo's
/// `.git`). A shell command or a scan can name any file, so those stay in the
/// temp dirs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HandoffPlaces {
    temp: Vec<PathBuf>,
    homes: Vec<PathBuf>,
}

impl HandoffPlaces {
    /// The temp dirs ([`temp_roots`]) and the home folder, in every form a
    /// path to it may take (as given, and its canonical form when that
    /// differs, as with the temp dirs' `/var/folders` and `/private/var/folders`).
    /// A home that isn't an absolute path below `/` is ignored: `/` would let
    /// every file in.
    #[must_use]
    pub fn new(temp: Vec<PathBuf>, homes: impl IntoIterator<Item = PathBuf>) -> Self {
        let mut kept: Vec<PathBuf> = Vec::new();
        for home in homes {
            if home.is_absolute() && home.parent().is_some() && !kept.contains(&home) {
                kept.push(home);
            }
        }
        Self { temp, homes: kept }
    }

    /// The temp dirs.
    #[must_use]
    pub fn temp(&self) -> &[PathBuf] {
        &self.temp
    }

    /// The forms of the home folder, empty when it is unknown.
    #[must_use]
    pub fn homes(&self) -> &[PathBuf] {
        &self.homes
    }

    /// Whether `path` may be a [Handoff file] found this way. Lexical only —
    /// the shell re-checks the canonical path on disk.
    #[must_use]
    pub fn allows(&self, path: &Path, origin: HandoffOrigin) -> bool {
        is_handoff_path(path, &self.temp)
            || (origin == HandoffOrigin::Written
                && self
                    .homes
                    .iter()
                    .any(|home| is_visible_home_handoff(path, home)))
    }
}

/// Whether `path` has a [Handoff file]'s shape under `home`, with no hidden
/// folder (or hidden file name) between them.
fn is_visible_home_handoff(path: &Path, home: &Path) -> bool {
    has_handoff_shape(path)
        && path.strip_prefix(home).is_ok_and(|rest| {
            rest.components().all(|part| match part {
                std::path::Component::Normal(name) => !name.to_string_lossy().starts_with('.'),
                _ => false,
            })
        })
}

/// Whether `prompt` invokes a slash command whose name contains a handoff
/// fragment, e.g. `/handoff` or `/mattpocock-skills:handoff now`.
#[must_use]
pub fn is_handoff_command(prompt: &str) -> bool {
    let Some(rest) = prompt.trim_start().strip_prefix('/') else {
        return false;
    };
    let name = rest
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_lowercase();
    !name.is_empty()
        && HANDOFF_COMMAND_FRAGMENTS
            .iter()
            .any(|fragment| name.contains(fragment))
}

/// Whether `path` has the shape of a [Handoff file]: an absolute `.md` path
/// whose file name contains "handoff", with no `..` component, inside one of
/// `roots`. Callers go through [`HandoffPlaces::allows`].
fn is_handoff_path(path: &Path, roots: &[PathBuf]) -> bool {
    has_handoff_shape(path) && roots.iter().any(|root| path.starts_with(root))
}

/// An absolute `.md` path whose file name contains "handoff", with no `..`.
fn has_handoff_shape(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    path.is_absolute()
        && name.to_lowercase().contains("handoff")
        && path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        && !path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
}

/// The [Handoff file] a `PostToolUse` `Write` event wrote, if it wrote one.
/// The path comes from the tool input's `file_path`, falling back to the
/// event's `target` (the input is capped and may be cut mid-JSON).
#[must_use]
pub fn written_handoff(event: &HookEvent, places: &HandoffPlaces) -> Option<PathBuf> {
    if event.event != "PostToolUse" || event.tool_name.as_deref() != Some("Write") {
        return None;
    }
    let from_input = event
        .input
        .as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|v| v.get("file_path")?.as_str().map(PathBuf::from));
    let path = from_input.or_else(|| event.target.as_deref().map(PathBuf::from))?;
    places.allows(&path, HandoffOrigin::Written).then_some(path)
}

/// What follows the command name in a handoff command — what the user said the
/// next session is for — trimmed; `None` when it isn't a handoff command or
/// says nothing more.
#[must_use]
pub fn handoff_focus(prompt: &str) -> Option<String> {
    if !is_handoff_command(prompt) {
        return None;
    }
    let rest = prompt.trim_start().strip_prefix('/')?;
    let after = rest.split_once(char::is_whitespace)?.1.trim();
    (!after.is_empty()).then(|| after.to_string())
}

/// Shell words in `command`, with quotes removed and redirections, pipes and
/// separators as breaks: `> "$TMPDIR/a.md"` yields `$TMPDIR/a.md`.
fn shell_words(command: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote: Option<char> = None;
    for ch in command.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            None if ch == '"' || ch == '\'' => quote = Some(ch),
            None if ch.is_whitespace() || "<>|;&()".contains(ch) => {
                if !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
            }
            // Inside quotes, or an ordinary character outside them.
            _ => word.push(ch),
        }
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}

/// `word` with a leading `$TMPDIR` / `${TMPDIR}` replaced by `tmpdir`; `None`
/// when it names `$TMPDIR` but the real one is unknown.
fn expand_tmpdir(word: &str, tmpdir: Option<&str>) -> Option<PathBuf> {
    let rest = word
        .strip_prefix("${TMPDIR}")
        .or_else(|| word.strip_prefix("$TMPDIR"));
    let Some(rest) = rest else {
        return Some(PathBuf::from(word));
    };
    let base = tmpdir.filter(|t| !t.is_empty())?.trim_end_matches('/');
    // Rebuilt from components, so `T//x.md` reads as `T/x.md`.
    Some(Path::new(&format!("{base}{rest}")).components().collect())
}

/// The [Handoff file] a shell command names, if it names one where `places`
/// lets a named handoff live — the last such word, as a command usually writes
/// then shows it. Only a candidate: the shell checks the file was written
/// during the turn.
#[must_use]
pub fn shell_handoff(
    command: &str,
    tmpdir: Option<&str>,
    places: &HandoffPlaces,
) -> Option<PathBuf> {
    shell_words(command)
        .iter()
        .filter_map(|word| expand_tmpdir(word, tmpdir))
        .rfind(|path| places.allows(path, HandoffOrigin::Named))
}

/// The [Handoff file] a `PostToolUse` `Bash` event's command names.
fn shell_written_handoff(
    event: &HookEvent,
    tmpdir: Option<&str>,
    places: &HandoffPlaces,
) -> Option<PathBuf> {
    if event.event != "PostToolUse" || event.tool_name.as_deref() != Some("Bash") {
        return None;
    }
    let from_input = event
        .input
        .as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|v| v.get("command")?.as_str().map(str::to_string));
    let command = from_input.or_else(|| event.target.clone())?;
    shell_handoff(&command, tmpdir, places)
}

/// The longest [Handoff prompt] taken from a handoff file's own section.
pub const START_PROMPT_MAX_CHARS: usize = 4000;

/// Headings that introduce the prompt a handoff wants the next session to
/// start with (matched case-insensitively, as a substring).
const START_PROMPT_HEADINGS: &[&str] = &[
    "next prompt",
    "next-session prompt",
    "next session prompt",
    "starting prompt",
    "start with",
    "first prompt",
    "kickoff prompt",
    "prompt for the next session",
];

/// The body of the handoff's starting-prompt section: its first fenced block,
/// else its text up to the next heading.
fn section_prompt(content: &str) -> Option<String> {
    let mut lines = content.lines();
    lines.by_ref().find(|line| {
        let line = line.trim_start();
        line.starts_with('#') && {
            let title = line.trim_start_matches('#').to_lowercase();
            START_PROMPT_HEADINGS.iter().any(|h| title.contains(h))
        }
    })?;
    let mut text = Vec::new();
    let mut fence: Option<Vec<&str>> = None;
    for line in lines {
        let fenced = line.trim_start().starts_with("```");
        match fence.as_mut() {
            Some(body) if fenced => {
                let body = body.join("\n");
                return Some(body.trim().to_string()).filter(|b| !b.is_empty());
            }
            Some(body) => body.push(line),
            None if fenced => fence = Some(Vec::new()),
            None if line.trim_start().starts_with('#') => break,
            None => text.push(line),
        }
    }
    let text = text.join("\n");
    Some(text.trim().to_string()).filter(|t| !t.is_empty())
}

/// The [Handoff prompt] for a new session continuing from the [Handoff file] at
/// `path`: the file's own starting-prompt section (pointing back at the file
/// if it doesn't), else the handoff command's `focus`, else "read and continue".
#[must_use]
pub fn start_prompt(path: &Path, content: &str, focus: Option<&str>) -> String {
    let path = path.display().to_string();
    if let Some(prompt) = section_prompt(content) {
        let prompt: String = prompt.chars().take(START_PROMPT_MAX_CHARS).collect();
        return if prompt.contains(&path) {
            prompt
        } else {
            format!("{prompt}\n\n(Handoff: {path})")
        };
    }
    match focus {
        Some(focus) => format!("Read {path} and continue. Focus: {focus}"),
        None => format!("Read {path} and continue."),
    }
}

/// The newest candidate modified at or after `since` — the fallback when a
/// handoff command ran but no `Write` was seen.
#[must_use]
pub fn newest_since(
    candidates: impl IntoIterator<Item = (PathBuf, SystemTime)>,
    since: SystemTime,
) -> Option<PathBuf> {
    candidates
        .into_iter()
        .filter(|(_, modified)| *modified >= since)
        .max_by_key(|(_, modified)| *modified)
        .map(|(path, _)| path)
}

/// What a finished turn found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandoffFound {
    /// The turn wrote this [Handoff file].
    Written(PathBuf),
    /// A shell command in the turn named this [Handoff file]; it counts only if
    /// it was modified at or after `since` (the turn's start), so a command
    /// that merely reads an old handoff doesn't offer it.
    ShellWritten { path: PathBuf, since: SystemTime },
    /// A handoff command ran at this time but no write was seen: look for the
    /// newest [Handoff file] modified since.
    AskedSince(SystemTime),
}

impl HandoffFound {
    /// How the file was found, which decides where it may live.
    #[must_use]
    pub fn origin(&self) -> HandoffOrigin {
        match self {
            Self::Written(_) => HandoffOrigin::Written,
            Self::ShellWritten { .. } | Self::AskedSince(_) => HandoffOrigin::Named,
        }
    }
}

/// A turn that ended with a handoff: what it found, and the handoff command's
/// arguments, if it ran one with any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandoffTurn {
    pub found: HandoffFound,
    pub focus: Option<String>,
}

/// Per-session [Handoff file] detector: fed every hook event, it answers on the
/// turn's `Stop` with what that turn produced, then forgets it.
#[derive(Debug, Default)]
pub struct HandoffFileWatch {
    asked_at: Option<SystemTime>,
    focus: Option<String>,
    started_at: Option<SystemTime>,
    written: Option<PathBuf>,
    shell_written: Option<PathBuf>,
    /// The `claude` conversation whose turn is being watched. A nested
    /// `claude -p` in the same terminal shares the hook spool; while a
    /// handoff is pending its events neither end nor reset this turn.
    conversation: Option<String>,
}

impl HandoffFileWatch {
    /// Observe one hook event; `now` stamps a prompt; `tmpdir` places a shell
    /// command's `$TMPDIR`. Returns what the turn found when `event` ends it.
    pub fn observe(
        &mut self,
        event: &HookEvent,
        places: &HandoffPlaces,
        tmpdir: Option<&str>,
        now: SystemTime,
    ) -> Option<HandoffTurn> {
        let pending =
            self.asked_at.is_some() || self.written.is_some() || self.shell_written.is_some();
        let other = self
            .conversation
            .as_deref()
            .zip(event.session_id.as_deref())
            .is_some_and(|(mine, theirs)| mine != theirs);
        if pending && other {
            return None;
        }
        match event.event.as_str() {
            "UserPromptSubmit" => {
                self.conversation.clone_from(&event.session_id);
                self.written = None;
                self.shell_written = None;
                self.started_at = Some(now);
                let prompt = event.prompt.as_deref().unwrap_or_default();
                self.asked_at = is_handoff_command(prompt).then_some(now);
                self.focus = handoff_focus(prompt);
                None
            }
            "PostToolUse" => {
                if let Some(path) = written_handoff(event, places) {
                    self.written = Some(path);
                } else if let Some(path) = shell_written_handoff(event, tmpdir, places) {
                    self.shell_written = Some(path);
                }
                None
            }
            // Its conversation ended without a Stop (exited mid-turn): nothing
            // is pending any more, so the next conversation is watched.
            "SessionEnd" => {
                *self = Self::default();
                None
            }
            "Stop" => {
                let asked_at = self.asked_at.take();
                let since = self.started_at.take().unwrap_or(now);
                let shell = self
                    .shell_written
                    .take()
                    .map(|path| HandoffFound::ShellWritten { path, since });
                let found = self
                    .written
                    .take()
                    .map(HandoffFound::Written)
                    .or(shell)
                    .or_else(|| asked_at.map(HandoffFound::AskedSince))?;
                Some(HandoffTurn {
                    found,
                    focus: self.focus.take(),
                })
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn roots() -> Vec<PathBuf> {
        temp_roots(Some("/var/folders/ab/T/"))
    }

    fn places() -> HandoffPlaces {
        HandoffPlaces::new(roots(), [PathBuf::from("/Users/me")])
    }

    fn prompt(text: &str) -> HookEvent {
        HookEvent {
            event: "UserPromptSubmit".to_string(),
            prompt: Some(text.to_string()),
            ..HookEvent::default()
        }
    }

    fn write(input: Option<&str>, target: Option<&str>) -> HookEvent {
        HookEvent {
            event: "PostToolUse".to_string(),
            tool_name: Some("Write".to_string()),
            input: input.map(str::to_string),
            target: target.map(str::to_string),
            ..HookEvent::default()
        }
    }

    fn asked_since(at: SystemTime) -> HandoffTurn {
        HandoffTurn {
            found: HandoffFound::AskedSince(at),
            focus: None,
        }
    }

    fn bash(command: &str) -> HookEvent {
        HookEvent {
            event: "PostToolUse".to_string(),
            tool_name: Some("Bash".to_string()),
            input: Some(serde_json::json!({ "command": command }).to_string()),
            ..HookEvent::default()
        }
    }

    const TMP: &str = "/var/folders/ab/T/";

    #[test]
    fn a_shell_command_that_writes_a_handoff_into_tmpdir_names_it() {
        let r = places();
        let cmd = r#"echo "Read me" > "$TMPDIR/test-handoff.md" && echo "$TMPDIR/test-handoff.md" && cat "$TMPDIR/test-handoff.md""#;
        assert_eq!(
            shell_handoff(cmd, Some(TMP), &r),
            Some(PathBuf::from("/var/folders/ab/T/test-handoff.md"))
        );
        assert_eq!(
            shell_handoff(
                "cat <<'EOF' > ${TMPDIR}/x-handoff.md\nhi\nEOF",
                Some(TMP),
                &r
            ),
            Some(PathBuf::from("/var/folders/ab/T/x-handoff.md"))
        );
        assert_eq!(
            shell_handoff("printf x | tee /tmp/handoff-2.md>/dev/null", None, &r),
            Some(PathBuf::from("/tmp/handoff-2.md"))
        );
        assert_eq!(shell_handoff("ls -la /tmp", Some(TMP), &r), None);
        assert_eq!(
            shell_handoff("echo x > /Users/me/handoff.md", Some(TMP), &r),
            None
        );
        // `$TMPDIR` unknown: the path can't be placed, so it is not a candidate.
        assert_eq!(shell_handoff("echo x > $TMPDIR/handoff.md", None, &r), None);
    }

    #[test]
    fn a_shell_written_handoff_is_reported_with_the_turn_start() {
        let r = places();
        let start = SystemTime::UNIX_EPOCH + Duration::from_secs(9);
        let mut watch = HandoffFileWatch::default();
        watch.observe(&prompt("save notes"), &r, Some(TMP), start);
        watch.observe(
            &bash(r#"echo hi > "$TMPDIR/test-handoff.md""#),
            &r,
            Some(TMP),
            start + Duration::from_secs(3),
        );
        assert_eq!(
            watch.observe(&stop(), &r, Some(TMP), start + Duration::from_secs(5)),
            Some(HandoffTurn {
                found: HandoffFound::ShellWritten {
                    path: PathBuf::from("/var/folders/ab/T/test-handoff.md"),
                    since: start,
                },
                focus: None,
            })
        );
    }

    #[test]
    fn a_handoff_command_s_arguments_are_its_focus() {
        assert_eq!(
            handoff_focus("/mattpocock-skills:handoff  test the card \n"),
            Some("test the card".to_string())
        );
        assert_eq!(handoff_focus("/handoff"), None);
        assert_eq!(handoff_focus("write a handoff"), None);
        let r = places();
        let now = SystemTime::UNIX_EPOCH;
        let mut watch = HandoffFileWatch::default();
        watch.observe(&prompt("/handoff polish the UI"), &r, None, now);
        assert_eq!(
            watch.observe(&stop(), &r, None, now),
            Some(HandoffTurn {
                found: HandoffFound::AskedSince(now),
                focus: Some("polish the UI".to_string()),
            })
        );
    }

    #[test]
    fn the_start_prompt_comes_from_the_handoff_s_own_section() {
        let path = Path::new("/tmp/x-handoff.md");
        let fenced = "# Handoff\nnotes\n\n## Next prompt\n\n```\nRead /tmp/x-handoff.md and fix the chip.\n# not a heading\n```\n\n## Other\nmore";
        assert_eq!(
            start_prompt(path, fenced, None),
            "Read /tmp/x-handoff.md and fix the chip.\n# not a heading"
        );
        let prose = "# H\n### Start with:\nPolish the Activity tab.\nThen rebuild.\n\n## Done\nx";
        assert_eq!(
            start_prompt(path, prose, Some("ignored")),
            "Polish the Activity tab.\nThen rebuild.\n\n(Handoff: /tmp/x-handoff.md)"
        );
        let long = format!("## First prompt\n{}", "a".repeat(5000));
        assert!(start_prompt(path, &long, None).starts_with(&"a".repeat(START_PROMPT_MAX_CHARS)));
        assert!(!start_prompt(path, &long, None).contains(&"a".repeat(START_PROMPT_MAX_CHARS + 1)));
    }

    #[test]
    fn without_a_section_the_start_prompt_uses_the_focus_or_the_default() {
        let path = Path::new("/tmp/h-handoff.md");
        assert_eq!(
            start_prompt(path, "# Handoff\nstuff", Some("test the card")),
            "Read /tmp/h-handoff.md and continue. Focus: test the card"
        );
        assert_eq!(
            start_prompt(path, "## Next prompt\n\n## Empty", None),
            "Read /tmp/h-handoff.md and continue."
        );
    }

    fn stop() -> HookEvent {
        HookEvent {
            event: "Stop".to_string(),
            ..HookEvent::default()
        }
    }

    #[test]
    fn a_slash_command_naming_handoff_is_a_handoff_command() {
        assert!(is_handoff_command("/handoff"));
        assert!(is_handoff_command("  /mattpocock-skills:handoff wrap up"));
        assert!(is_handoff_command("/HandOff"));
        assert!(!is_handoff_command("please write a handoff"));
        assert!(!is_handoff_command("/review handoff"));
        assert!(!is_handoff_command("/"));
    }

    #[test]
    fn a_handoff_path_is_an_md_named_handoff_inside_a_temp_dir() {
        let r = roots();
        assert!(is_handoff_path(Path::new("/tmp/handoff-2026.md"), &r));
        assert!(is_handoff_path(
            Path::new("/var/folders/ab/T/x-HANDOFF.md"),
            &r
        ));
        assert!(is_handoff_path(Path::new("/private/tmp/handoff.md"), &r));
        assert!(!is_handoff_path(Path::new("/Users/me/handoff.md"), &r));
        assert!(!is_handoff_path(Path::new("/tmp/handoff.txt"), &r));
        assert!(!is_handoff_path(Path::new("/tmp/notes.md"), &r));
        assert!(!is_handoff_path(Path::new("/tmp/../etc/handoff.md"), &r));
        assert!(!is_handoff_path(Path::new("tmp/handoff.md"), &r));
    }

    #[test]
    fn a_write_reads_the_path_from_input_then_target() {
        let r = places();
        let from_input = write(
            Some(r#"{"file_path":"/tmp/handoff.md","content":"x"}"#),
            None,
        );
        assert_eq!(
            written_handoff(&from_input, &r),
            Some(PathBuf::from("/tmp/handoff.md"))
        );
        // A cut input does not parse; the target still names the file.
        let cut = write(
            Some(r#"{"file_path":"/tmp/a-handoff.md","content":"xx"#),
            Some("/tmp/b-handoff.md"),
        );
        assert_eq!(
            written_handoff(&cut, &r),
            Some(PathBuf::from("/tmp/b-handoff.md"))
        );
        let elsewhere = write(None, Some("/opt/notes/handoff.md"));
        assert_eq!(written_handoff(&elsewhere, &r), None);
        let edit = HookEvent {
            tool_name: Some("Edit".to_string()),
            ..write(None, Some("/tmp/handoff.md"))
        };
        assert_eq!(written_handoff(&edit, &r), None);
    }

    #[test]
    fn newest_since_picks_the_latest_fresh_candidate() {
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1000);
        let at = |s| t0 + Duration::from_secs(s);
        let found = newest_since(
            vec![
                (
                    PathBuf::from("/tmp/old-handoff.md"),
                    t0 - Duration::from_secs(5),
                ),
                (PathBuf::from("/tmp/a-handoff.md"), at(1)),
                (PathBuf::from("/tmp/b-handoff.md"), at(3)),
            ],
            t0,
        );
        assert_eq!(found, Some(PathBuf::from("/tmp/b-handoff.md")));
        assert_eq!(
            newest_since(vec![(PathBuf::from("/tmp/old-handoff.md"), t0)], at(1)),
            None
        );
    }

    #[test]
    fn a_written_handoff_is_reported_when_the_turn_stops() {
        let r = places();
        let now = SystemTime::UNIX_EPOCH;
        let mut watch = HandoffFileWatch::default();
        assert_eq!(watch.observe(&prompt("/handoff"), &r, None, now), None);
        assert_eq!(
            watch.observe(&write(None, Some("/tmp/handoff.md")), &r, None, now),
            None
        );
        assert_eq!(
            watch.observe(&stop(), &r, None, now),
            Some(HandoffTurn {
                found: HandoffFound::Written(PathBuf::from("/tmp/handoff.md")),
                focus: None,
            })
        );
        // Forgotten once reported.
        assert_eq!(watch.observe(&stop(), &r, None, now), None);
    }

    #[test]
    fn a_write_without_a_command_still_counts() {
        let r = places();
        let now = SystemTime::UNIX_EPOCH;
        let mut watch = HandoffFileWatch::default();
        watch.observe(&prompt("write me a handoff"), &r, None, now);
        watch.observe(&write(None, Some("/tmp/handoff.md")), &r, None, now);
        assert!(matches!(
            watch.observe(&stop(), &r, None, now),
            Some(HandoffTurn {
                found: HandoffFound::Written(_),
                ..
            })
        ));
    }

    #[test]
    fn a_command_without_a_write_asks_for_a_search_since_the_prompt() {
        let r = places();
        let asked = SystemTime::UNIX_EPOCH + Duration::from_secs(7);
        let mut watch = HandoffFileWatch::default();
        watch.observe(&prompt("/handoff"), &r, None, asked);
        assert_eq!(
            watch.observe(&stop(), &r, None, asked + Duration::from_secs(30)),
            Some(asked_since(asked))
        );
    }

    #[test]
    fn an_ordinary_turn_finds_nothing_and_a_new_prompt_resets() {
        let r = places();
        let now = SystemTime::UNIX_EPOCH;
        let mut watch = HandoffFileWatch::default();
        watch.observe(&prompt("/handoff"), &r, None, now);
        watch.observe(&prompt("never mind"), &r, None, now);
        assert_eq!(watch.observe(&stop(), &r, None, now), None);
        watch.observe(&prompt("fix the bug"), &r, None, now);
        assert_eq!(watch.observe(&stop(), &r, None, now), None);
    }

    #[test]
    fn a_nested_claude_in_the_terminal_neither_ends_nor_resets_the_turn() {
        let mut watch = HandoffFileWatch::default();
        let now = SystemTime::UNIX_EPOCH;
        let from = |mut ev: HookEvent, id: &str| {
            ev.session_id = Some(id.to_string());
            ev
        };
        watch.observe(&from(prompt("/handoff"), "main"), &places(), None, now);
        // A `claude -p` the main turn ran: its own prompt and its own Stop.
        assert_eq!(
            watch.observe(&from(prompt("summarize x"), "nested"), &places(), None, now),
            None
        );
        assert_eq!(
            watch.observe(&from(stop(), "nested"), &places(), None, now),
            None
        );
        assert_eq!(
            watch.observe(&from(stop(), "main"), &places(), None, now),
            Some(asked_since(now)),
            "the main turn's own Stop still answers"
        );
    }

    #[test]
    fn a_conversation_that_ends_without_a_stop_lets_the_next_one_be_watched() {
        let mut watch = HandoffFileWatch::default();
        let now = SystemTime::UNIX_EPOCH;
        let from = |mut ev: HookEvent, id: &str| {
            ev.session_id = Some(id.to_string());
            ev
        };
        let end = || HookEvent {
            event: "SessionEnd".to_string(),
            ..HookEvent::default()
        };
        watch.observe(&from(prompt("/handoff"), "first"), &places(), None, now);
        // Exited mid-turn: no Stop.
        watch.observe(&from(end(), "first"), &places(), None, now);
        watch.observe(&from(prompt("/handoff"), "second"), &places(), None, now);
        assert_eq!(
            watch.observe(&from(stop(), "second"), &places(), None, now),
            Some(asked_since(now))
        );
    }

    #[test]
    fn a_session_s_own_write_may_put_a_handoff_anywhere_in_home() {
        let p = places();
        for path in [
            "/Users/me/Projects/kriyon-handoffs/phase6/HANDOFF.md",
            "/Users/me/handoff.md",
            "/tmp/handoff.md",
        ] {
            assert!(p.allows(Path::new(path), HandoffOrigin::Written), "{path}");
        }
    }

    #[test]
    fn a_written_handoff_stays_out_of_hidden_folders_and_outside_home() {
        let p = places();
        for path in [
            "/Users/me/.claude/handoff.md",
            "/Users/me/Projects/kriyon/.git/handoff.md",
            "/Users/me/.handoff.md",
            "/Users/other/handoff.md",
            "/Users/meme/handoff.md",
            "/etc/handoff.md",
            "/Users/me/../other/handoff.md",
            "/Users/me/Projects/notes.md",
            "/Users/me/Projects/handoff.txt",
        ] {
            assert!(!p.allows(Path::new(path), HandoffOrigin::Written), "{path}");
        }
    }

    #[test]
    fn a_write_through_either_form_of_the_home_folder_counts() {
        let p = HandoffPlaces::new(
            roots(),
            [
                PathBuf::from("/Users/me"),
                PathBuf::from("/Volumes/Data/me"),
            ],
        );
        for path in [
            "/Users/me/notes/handoff.md",
            "/Volumes/Data/me/notes/handoff.md",
        ] {
            assert!(p.allows(Path::new(path), HandoffOrigin::Written), "{path}");
        }
        assert!(!p.allows(
            Path::new("/Volumes/Data/other/handoff.md"),
            HandoffOrigin::Written
        ));
    }

    #[test]
    fn a_named_or_scanned_handoff_must_be_in_a_temp_dir() {
        let p = places();
        assert!(p.allows(Path::new("/tmp/handoff.md"), HandoffOrigin::Named));
        assert!(!p.allows(
            Path::new("/Users/me/Projects/handoff.md"),
            HandoffOrigin::Named
        ));
    }

    #[test]
    fn a_home_of_slash_or_a_relative_home_counts_for_nothing() {
        for home in ["/", "me"] {
            let p = HandoffPlaces::new(roots(), [PathBuf::from(home)]);
            assert!(
                !p.allows(Path::new("/etc/handoff.md"), HandoffOrigin::Written),
                "{home}"
            );
            assert!(
                !p.allows(Path::new("me/handoff.md"), HandoffOrigin::Written),
                "{home}"
            );
        }
    }

    #[test]
    fn a_turn_that_wrote_a_handoff_in_home_reports_it() {
        let p = places();
        let now = SystemTime::UNIX_EPOCH;
        let file = "/Users/me/Projects/kriyon-handoffs/phase6/HANDOFF.md";
        let mut watch = HandoffFileWatch::default();
        watch.observe(&prompt("write the phase 6 handoff"), &p, Some(TMP), now);
        watch.observe(&write(None, Some(file)), &p, Some(TMP), now);
        assert_eq!(
            watch.observe(&stop(), &p, Some(TMP), now),
            Some(HandoffTurn {
                found: HandoffFound::Written(PathBuf::from(file)),
                focus: None,
            })
        );
    }

    #[test]
    fn a_shell_command_naming_a_handoff_in_home_is_not_offered() {
        let p = places();
        let now = SystemTime::UNIX_EPOCH;
        let mut watch = HandoffFileWatch::default();
        watch.observe(&prompt("what did we hand off?"), &p, Some(TMP), now);
        watch.observe(
            &bash("cat /Users/me/Projects/kriyon-handoffs/phase6/HANDOFF.md"),
            &p,
            Some(TMP),
            now,
        );
        assert_eq!(watch.observe(&stop(), &p, Some(TMP), now), None);
    }

    #[test]
    fn only_a_written_find_may_come_from_home() {
        let at = SystemTime::UNIX_EPOCH;
        let path = PathBuf::from("/tmp/handoff.md");
        assert_eq!(
            HandoffFound::Written(path.clone()).origin(),
            HandoffOrigin::Written
        );
        assert_eq!(
            HandoffFound::ShellWritten { path, since: at }.origin(),
            HandoffOrigin::Named
        );
        assert_eq!(HandoffFound::AskedSince(at).origin(), HandoffOrigin::Named);
    }
}
