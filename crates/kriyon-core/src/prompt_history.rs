//! [Prompt history]: the prompts sent in a folder, newest first — what the
//! CLI's own Up arrow walks through. Read from Claude Code's
//! `~/.claude/history.jsonl`, which records every prompt the CLI takes,
//! whether it was typed in the terminal or sent by Kriyon's composer.
//!
//! Each line is `{display, pastedContents, timestamp, project, sessionId}`.
//! A long paste shows in `display` as `[Pasted text #N +L lines]` with its
//! text in `pastedContents`, so the placeholder is put back as the text.
//! Tolerant: an unreadable line is skipped, never an error.

use std::collections::HashSet;

use serde_json::Value;

/// `[Pasted text #3]` or `[Pasted text #3 +12 lines]`.
fn paste_placeholder(id: &str) -> regex::Regex {
    regex::Regex::new(&format!(
        r"\[Pasted text #{} ?(?:\+\d+ lines)?\]",
        regex::escape(id)
    ))
    .expect("valid regex")
}

/// The prompt a history line records, its pastes put back in.
fn prompt_of(value: &Value) -> Option<String> {
    let mut text = value.get("display")?.as_str()?.to_string();
    if let Some(Value::Object(pastes)) = value.get("pastedContents") {
        for (id, paste) in pastes {
            let is_text = paste.get("type").and_then(Value::as_str) == Some("text");
            if let (true, Some(content)) = (is_text, paste.get("content").and_then(Value::as_str)) {
                text = paste_placeholder(id)
                    .replace_all(&text, regex::NoExpand(content))
                    .into_owned();
            }
        }
    }
    Some(text)
}

/// The prompts sent in `project`, newest first, each once (its newest use),
/// at most `limit`. `lines` are the history file's lines, oldest first.
#[must_use]
pub fn recent_prompts(lines: &[&str], project: &str, limit: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for line in lines.iter().rev() {
        if out.len() >= limit {
            break;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("project").and_then(Value::as_str) != Some(project) {
            continue;
        }
        let Some(prompt) = prompt_of(&value) else {
            continue;
        };
        if prompt.trim().is_empty() || !seen.insert(prompt.clone()) {
            continue;
        }
        out.push(prompt);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(display: &str, project: &str) -> String {
        json!({"display": display, "pastedContents": {}, "timestamp": 1, "project": project})
            .to_string()
    }

    #[test]
    fn a_folders_prompts_come_newest_first_each_once() {
        let lines = [
            line("first", "/w/app"),
            line("elsewhere", "/w/other"),
            line("second", "/w/app"),
            line("first", "/w/app"),
            "not json".to_string(),
            line("   ", "/w/app"),
        ];
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        assert_eq!(recent_prompts(&refs, "/w/app", 10), ["first", "second"]);
        assert_eq!(recent_prompts(&refs, "/w/app", 1), ["first"]);
        assert_eq!(recent_prompts(&refs, "/w/none", 10), Vec::<String>::new());
    }

    #[test]
    fn a_long_paste_comes_back_as_its_text() {
        let pasted = json!({
            "display": "[Pasted text #2 +1 lines] then fix it",
            "pastedContents": {"2": {"id": 2, "type": "text", "content": "line a\nline b $1"}},
            "project": "/w/app"
        })
        .to_string();
        assert_eq!(
            recent_prompts(&[&pasted], "/w/app", 10),
            ["line a\nline b $1 then fix it"]
        );
    }
}
