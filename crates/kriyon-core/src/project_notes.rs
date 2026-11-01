//! [Project note]s: the user's own todos, ideas and notes for a project.
//!
//! They belong to the project, not to a session, and never reach Claude. This
//! module owns the note's shape and the rules a note must meet before it is
//! stored; the Tauri layer owns the `SQLite` table and the commands.

use serde::{Deserialize, Serialize};

/// The longest a note's one-line text may be, in characters.
pub const MAX_TEXT_CHARS: usize = 500;
/// The longest a note's body may be, in characters.
pub const MAX_BODY_CHARS: usize = 20_000;
/// The longest an id (the note's or its project's) may be, in characters.
pub const MAX_ID_CHARS: usize = 64;

/// What a [Project note] is. Only a todo can be done.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteKind {
    Todo,
    Idea,
    Note,
}

impl NoteKind {
    /// The value stored in the `kind` column, the same as the wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Todo => "todo",
            Self::Idea => "idea",
            Self::Note => "note",
        }
    }

    /// Read a stored kind. An unknown value (a row a newer build wrote) reads
    /// as a plain note, so one odd row never hides the whole list.
    #[must_use]
    pub fn from_stored(value: &str) -> Self {
        match value {
            "todo" => Self::Todo,
            "idea" => Self::Idea,
            _ => Self::Note,
        }
    }
}

/// One [Project note].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectNote {
    pub id: String,
    pub project_id: String,
    pub kind: NoteKind,
    /// The one line shown in the list.
    pub text: String,
    /// Optional longer text, shown when the note is opened. Empty when unused.
    #[serde(default)]
    pub body: String,
    /// When a todo was ticked off (ms since epoch). Always `None` for an idea
    /// or a note.
    #[serde(default)]
    pub done_at: Option<i64>,
    /// Pinned notes sort above the rest.
    #[serde(default)]
    pub pinned: bool,
    pub created_ms: i64,
    pub updated_ms: i64,
}

/// Why a note was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NoteError {
    #[error("a note needs some text")]
    EmptyText,
    #[error("a note's text can be at most {MAX_TEXT_CHARS} characters")]
    TextTooLong,
    #[error("a note's body can be at most {MAX_BODY_CHARS} characters")]
    BodyTooLong,
    #[error("invalid note id")]
    BadId,
    #[error("invalid project id")]
    BadProjectId,
    #[error("this note belongs to another project")]
    OtherProject,
}

/// Check that a save does not reuse the id of a note kept under another
/// project. `stored_project_id` is the project the id is stored under, or
/// `None` for a new note. A note never moves between projects, so a save that
/// names another project is refused rather than overwriting that note.
///
/// # Errors
/// Returns [`NoteError::OtherProject`] when the id belongs to another project.
pub fn check_owner(stored_project_id: Option<&str>, note: &ProjectNote) -> Result<(), NoteError> {
    match stored_project_id {
        Some(stored) if stored != note.project_id => Err(NoteError::OtherProject),
        _ => Ok(()),
    }
}

/// Check a note that came from the webview and return the copy to store.
///
/// The text is trimmed, and a done mark on anything but a todo is dropped:
/// turning a done todo into an idea makes it an open idea, not a hidden one.
///
/// # Errors
/// Returns a [`NoteError`] for an empty or over-long text, an over-long body,
/// or an id that is empty, too long or holds control characters.
pub fn validate(note: ProjectNote) -> Result<ProjectNote, NoteError> {
    if !valid_id(&note.id) {
        return Err(NoteError::BadId);
    }
    if !valid_id(&note.project_id) {
        return Err(NoteError::BadProjectId);
    }
    let text = note.text.trim();
    if text.is_empty() {
        return Err(NoteError::EmptyText);
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(NoteError::TextTooLong);
    }
    if note.body.chars().count() > MAX_BODY_CHARS {
        return Err(NoteError::BodyTooLong);
    }
    let done_at = if note.kind == NoteKind::Todo {
        note.done_at
    } else {
        None
    };
    Ok(ProjectNote {
        text: text.to_string(),
        done_at,
        ..note
    })
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= MAX_ID_CHARS && !id.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note() -> ProjectNote {
        ProjectNote {
            id: "n1".into(),
            project_id: "p1".into(),
            kind: NoteKind::Todo,
            text: "Write the ADR".into(),
            body: String::new(),
            done_at: None,
            pinned: false,
            created_ms: 1,
            updated_ms: 1,
        }
    }

    #[test]
    fn a_valid_note_passes_unchanged() {
        assert_eq!(validate(note()), Ok(note()));
    }

    #[test]
    fn text_is_trimmed() {
        let checked = validate(ProjectNote {
            text: "  Write the ADR \n".into(),
            ..note()
        })
        .expect("valid");
        assert_eq!(checked.text, "Write the ADR");
    }

    #[test]
    fn blank_text_is_refused() {
        let result = validate(ProjectNote {
            text: " \t\n".into(),
            ..note()
        });
        assert_eq!(result, Err(NoteError::EmptyText));
    }

    #[test]
    fn text_over_the_limit_is_refused_and_at_the_limit_passes() {
        let at_limit = "é".repeat(MAX_TEXT_CHARS);
        assert!(validate(ProjectNote {
            text: at_limit.clone(),
            ..note()
        })
        .is_ok());
        let result = validate(ProjectNote {
            text: format!("{at_limit}x"),
            ..note()
        });
        assert_eq!(result, Err(NoteError::TextTooLong));
    }

    #[test]
    fn body_over_the_limit_is_refused() {
        let result = validate(ProjectNote {
            body: "x".repeat(MAX_BODY_CHARS + 1),
            ..note()
        });
        assert_eq!(result, Err(NoteError::BodyTooLong));
    }

    #[test]
    fn bad_ids_are_refused() {
        for id in ["", "a\u{0}b", &"x".repeat(MAX_ID_CHARS + 1)] {
            assert_eq!(
                validate(ProjectNote {
                    id: id.to_string(),
                    ..note()
                }),
                Err(NoteError::BadId),
                "note id {id:?}"
            );
            assert_eq!(
                validate(ProjectNote {
                    project_id: id.to_string(),
                    ..note()
                }),
                Err(NoteError::BadProjectId),
                "project id {id:?}"
            );
        }
    }

    #[test]
    fn only_a_todo_keeps_its_done_mark() {
        let done_todo = validate(ProjectNote {
            done_at: Some(5),
            ..note()
        })
        .expect("valid");
        assert_eq!(done_todo.done_at, Some(5));
        for kind in [NoteKind::Idea, NoteKind::Note] {
            let checked = validate(ProjectNote {
                kind,
                done_at: Some(5),
                ..note()
            })
            .expect("valid");
            assert_eq!(checked.done_at, None, "{kind:?}");
        }
    }

    #[test]
    fn a_new_note_or_one_in_its_own_project_may_be_saved() {
        assert_eq!(check_owner(None, &note()), Ok(()));
        assert_eq!(check_owner(Some("p1"), &note()), Ok(()));
    }

    #[test]
    fn a_note_id_kept_under_another_project_is_refused() {
        assert_eq!(
            check_owner(Some("p2"), &note()),
            Err(NoteError::OtherProject)
        );
    }

    #[test]
    fn kind_round_trips_through_its_stored_name() {
        for kind in [NoteKind::Todo, NoteKind::Idea, NoteKind::Note] {
            assert_eq!(NoteKind::from_stored(kind.as_str()), kind);
        }
    }

    #[test]
    fn an_unknown_stored_kind_reads_as_a_note() {
        assert_eq!(NoteKind::from_stored("checklist"), NoteKind::Note);
    }

    #[test]
    fn wire_shape_is_camel_case_with_lowercase_kind() {
        let json = serde_json::to_value(note()).expect("serialize");
        assert_eq!(json["projectId"], "p1");
        assert_eq!(json["kind"], "todo");
        assert_eq!(json["doneAt"], serde_json::Value::Null);
        assert_eq!(json["createdMs"], 1);
    }
}
