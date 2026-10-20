//! [Redaction]: best-effort removal of known secret shapes from text Kriyon
//! stores — a command line, a tool input, a tool result. The hook script runs
//! the same rules in Python before it writes the [Hook spool]; this copy runs
//! again at ingest, so lines written by an older script are covered too.
//! Both halves are pinned by one shared case file.

use std::sync::LazyLock;

use regex::{Captures, Regex};

/// What a whole-match rule leaves behind.
const MARK: &str = "[REDACTED]";

/// Token shapes replaced whole, most specific first. Each pattern is a
/// constant, so a failed compile is a bug caught by the tests.
static TOKENS: LazyLock<Vec<(Regex, &'static str)>> =
    LazyLock::new(|| {
        [
        (
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----(?s:.*?)(?:-----END [A-Z ]*PRIVATE KEY-----|\z)",
            "[REDACTED PRIVATE KEY]",
        ),
        (r"sk-ant-[A-Za-z0-9_\-]{8,}", MARK),
        (r"\bsk-[A-Za-z0-9_\-]{16,}", MARK),
        (r"\bgh[pousr]_[A-Za-z0-9]{20,}", MARK),
        (r"\bgithub_pat_[A-Za-z0-9_]{20,}", MARK),
        (r"\bAKIA[0-9A-Z]{16}\b", MARK),
        (r"\bxox[abprs]-[A-Za-z0-9\-]{10,}", MARK),
        (r"(?i)\b(bearer\s+)[A-Za-z0-9._~+/=\-]{8,}", "${1}[REDACTED]"),
        (r"(://[^/\s:@]+:)[^/\s@]+@", "${1}[REDACTED]@"),
    ]
    .into_iter()
    .map(|(pattern, with)| (Regex::new(pattern).expect("a constant pattern"), with))
    .collect()
    });

/// `name=value` / `name: value` where the name says it holds a secret. The
/// value keeps its quotes, so redacted JSON stays JSON.
static NAMED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)([A-Za-z0-9_\-]*(?:password|passwd|secret|token|api[_-]?key))(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;&|]+)"#,
    )
    .expect("a constant pattern")
});

/// Replace every known secret shape in `text`. Best-effort: a secret in a
/// shape not listed here is kept, which the UI says plainly.
#[must_use]
pub fn redact(text: &str) -> String {
    let mut out = text.to_string();
    for (pattern, with) in TOKENS.iter() {
        if let std::borrow::Cow::Owned(next) = pattern.replace_all(&out, *with) {
            out = next;
        }
    }
    NAMED
        .replace_all(&out, |caps: &Captures| {
            let quote = caps[3].chars().next().filter(|c| matches!(c, '"' | '\''));
            let masked = quote.map_or_else(|| MARK.to_string(), |q| format!("{q}{MARK}{q}"));
            format!("{}{}{masked}", &caps[1], &caps[2])
        })
        .into_owned()
}

/// A key whose value is a secret whatever it looks like (`password`,
/// `API_TOKEN`, `client_secret`, …).
static SECRET_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:password|passwd|secret|token|api[_-]?key)$").expect("a constant pattern")
});

/// [`redact`] every string inside a JSON value, and blank the value of a
/// secret-named key. Works on the parsed value — never on serialized text, which
/// a rule could cut through and leave unparseable — so the result is always
/// valid JSON. A string holding JSON (a stringified tool input) is redacted as
/// text, where the `name: value` rule still sees its quotes.
pub fn redact_value(value: &mut serde_json::Value) {
    use serde_json::Value;
    match value {
        // A string holding JSON (a stringified tool input) is redacted by
        // value too: a text rule could stop at an escaped quote inside it.
        Value::String(text) => {
            let trimmed = text.trim_start();
            let nested = (trimmed.starts_with('{') || trimmed.starts_with('['))
                .then(|| serde_json::from_str::<Value>(text).ok())
                .flatten();
            *text = match nested {
                Some(mut inner) => {
                    redact_value(&mut inner);
                    inner.to_string()
                }
                None => redact(text),
            };
        }
        Value::Array(items) => items.iter_mut().for_each(redact_value),
        Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                if SECRET_KEY.is_match(key) && !item.is_object() && !item.is_array() {
                    *item = Value::String(MARK.to_string());
                } else {
                    redact_value(item);
                }
            }
        }
        _ => {}
    }
}

/// Redact text that may hold JSON (a recorded tool input, a spool line): by
/// value when it parses, so it stays parseable; as plain text when it doesn't
/// (a capped input cut mid-way).
#[must_use]
pub fn redact_json_text(text: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(mut value) => {
            redact_value(&mut value);
            value.to_string()
        }
        Err(_) => redact(text),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Case {
        #[serde(rename = "in")]
        input: String,
        out: String,
    }

    pub(crate) const CASES: &str = include_str!("../scripts/redaction-cases.json");

    #[test]
    fn redacts_every_shared_case() {
        let cases: Vec<Case> = serde_json::from_str(CASES).expect("case file parses");
        for case in cases {
            assert_eq!(redact(&case.input), case.out, "input: {}", case.input);
        }
    }

    #[test]
    fn redacting_a_json_value_keeps_it_valid_and_finds_nested_secrets() {
        let mut value = serde_json::json!({
            "text": "password=\"a b\" and more",
            "key": "-----BEGIN RSA PRIVATE KEY-----\nabc",
            "after": "kept",
            "url": "https://u:p@host/x",
            "input": "{\"api_key\":\"abc\",\"n\":1}",
            "env": { "API_TOKEN": "xyz", "max_tokens": 5 },
        });
        redact_value(&mut value);
        let text = value.to_string();
        let back: serde_json::Value = serde_json::from_str(&text).expect("still JSON");
        assert_eq!(back["text"], "password=\"[REDACTED]\" and more");
        assert_eq!(back["key"], "[REDACTED PRIVATE KEY]");
        assert_eq!(
            back["after"], "kept",
            "a key without an END line eats only its own string"
        );
        assert_eq!(back["url"], "https://u:[REDACTED]@host/x");
        assert_eq!(back["input"], "{\"api_key\":\"[REDACTED]\",\"n\":1}");
        assert_eq!(back["env"]["API_TOKEN"], "[REDACTED]");
        assert_eq!(back["env"]["max_tokens"], 5);
    }

    #[test]
    fn json_text_is_redacted_by_value_when_it_parses() {
        let text = r#"{"command":"echo \"a b\"","password":"x"}"#;
        let out = redact_json_text(text);
        let back: serde_json::Value = serde_json::from_str(&out).expect("still JSON");
        assert_eq!(back["password"], "[REDACTED]");
        assert_eq!(
            redact_json_text("{\"cut\": \"token=abc"),
            "{\"cut\": \"token=[REDACTED]"
        );
    }

    #[test]
    fn a_secret_inside_stringified_json_with_escaped_quotes_is_gone() {
        let mut value = serde_json::json!({"input": r#"{"password":"abc\"still-secret"}"#});
        redact_value(&mut value);
        let inner: serde_json::Value =
            serde_json::from_str(value["input"].as_str().expect("a string")).expect("inner JSON");
        assert_eq!(inner["password"], "[REDACTED]");
        assert!(!value.to_string().contains("still-secret"));
    }

    #[test]
    fn a_multibyte_value_is_safe() {
        assert_eq!(redact("token=é1"), "token=[REDACTED]");
    }

    #[test]
    fn redaction_is_idempotent() {
        let once = redact("password=hunter2 sk-ant-api03-abcdefghijklmnop");
        assert_eq!(redact(&once), once);
    }
}
