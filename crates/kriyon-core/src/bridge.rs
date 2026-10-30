//! The [Companion bridge]'s pure half: reading the one kind of request the
//! companion mod sends (an HTTP `POST` of one JSON event over the session's
//! Unix socket), and turning its body into one spool line.
//!
//! The PTY daemon serves the socket and appends the line to the [Bridge
//! spool], because it lives exactly as long as the session and survives an
//! app crash (ADR-0022).

/// The largest event body accepted. Rows are capped by the mod well below it.
pub const MAX_BODY: usize = 512 * 1024;

/// The largest request head (request line plus headers) accepted.
const MAX_HEAD: usize = 8 * 1024;

/// How far a request has been read.
#[derive(Debug, PartialEq, Eq)]
pub enum Request<'a> {
    /// More bytes are needed.
    Incomplete,
    /// A whole `POST` with its body.
    Post(&'a [u8]),
    /// Anything else (another method, a malformed or oversized request).
    Rejected,
}

/// Read an HTTP/1.1 request from the bytes received so far.
#[must_use]
pub fn parse_request(buf: &[u8]) -> Request<'_> {
    let Some(head_end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
        return if buf.len() > MAX_HEAD {
            Request::Rejected
        } else {
            Request::Incomplete
        };
    };
    let Ok(head) = std::str::from_utf8(&buf[..head_end]) else {
        return Request::Rejected;
    };
    let mut lines = head.split("\r\n");
    if !lines.next().is_some_and(|l| l.starts_with("POST ")) {
        return Request::Rejected;
    }
    let length = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse::<usize>().ok());
    let Some(length) = length.filter(|n| *n <= MAX_BODY) else {
        return Request::Rejected;
    };
    let body = &buf[head_end + 4..];
    if body.len() < length {
        return Request::Incomplete;
    }
    Request::Post(&body[..length])
}

/// The reply to every request: nothing to say back, except that this bridge
/// takes [Partial reply] posts (`X-Kriyon-Bridge: 2`). A mod streams only to
/// a bridge that says so, so an older daemon's spool never fills with them.
pub const NO_CONTENT: &[u8] =
    b"HTTP/1.1 204 No Content\r\nX-Kriyon-Bridge: 2\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

/// Whether an event body is a [Partial reply]: a snapshot of Claude's reply
/// as it streams. It replaces the last one rather than joining the spool —
/// only the newest is ever worth reading.
#[must_use]
pub fn is_partial(body: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("kind")?.as_str().map(|k| k == "partial"))
        .unwrap_or(false)
}

/// The reply to a request the bridge doesn't take.
pub const BAD_REQUEST: &[u8] =
    b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

/// One [Bridge spool] line for an event body: the JSON object, [Redaction]
/// applied, with the time the daemon received it, on one line. `None` when
/// the body isn't a JSON object.
#[must_use]
pub fn spool_line(body: &[u8], received_ms: u64) -> Option<String> {
    let mut value: serde_json::Value = serde_json::from_slice(body).ok()?;
    crate::redact::redact_value(&mut value);
    value
        .as_object_mut()?
        .insert("receivedMs".to_string(), received_ms.into());
    Some(value.to_string())
}

/// What one [Bridge spool] line is, for the [Activity store] to keep. Every
/// event names its `run` (one `claude` process) and the conversation it came
/// from, so ordering and scoping are decided where it is stored, once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeEvent {
    /// A `claude` process's mod connected.
    Hello {
        run: String,
        seq: u64,
        conversation: Option<String>,
        version: Option<String>,
        received_ms: Option<i64>,
    },
    /// A conversation row, kept whole (as its spool line) for the Structured view.
    Row {
        run: String,
        seq: u64,
        conversation: Option<String>,
        line: String,
        received_ms: Option<i64>,
    },
    /// What Claude Code's permission check decided for one tool call.
    Check {
        tool_use_id: String,
        check: ToolCheck,
    },
    /// A [Nested session] the session asked Kriyon to start (ADR-0049).
    SessionRequest(crate::nested::SessionRequest),
    /// The `claude` process ended cleanly.
    End {
        run: String,
        seq: u64,
        conversation: Option<String>,
        received_ms: Option<i64>,
    },
}

/// What Claude Code's permission check decided for one tool call, as the
/// companion saw it — the exact rule, which hooks can't see.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCheck {
    pub decision: String,
    pub rule: Option<String>,
}

fn text(value: &serde_json::Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string)
}

/// Read one [Bridge spool] line. `None` for anything unreadable or of a kind
/// nothing keeps — never an error.
#[must_use]
pub fn classify(line: &str) -> Option<BridgeEvent> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let run = text(&value, "run").unwrap_or_default();
    let conversation = text(&value, "sessionId");
    let seq = value
        .get("seq")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_default();
    let received_ms = value.get("receivedMs").and_then(serde_json::Value::as_i64);
    match value.get("kind")?.as_str()? {
        "hello" => Some(BridgeEvent::Hello {
            run,
            seq,
            conversation,
            version: text(&value, "version"),
            received_ms,
        }),
        "row" => Some(BridgeEvent::Row {
            seq,
            run,
            conversation,
            line: line.trim().to_string(),
            received_ms,
        }),
        "check" => Some(BridgeEvent::Check {
            tool_use_id: text(&value, "toolUseId")?,
            check: ToolCheck {
                decision: text(&value, "decision")?,
                rule: text(&value, "rule"),
            },
        }),
        "session_request" => crate::nested::parse(&value).map(BridgeEvent::SessionRequest),
        "end" => Some(BridgeEvent::End {
            run,
            seq,
            conversation,
            received_ms,
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn post(body: &str) -> Vec<u8> {
        format!(
            "POST /event HTTP/1.1\r\nHost: kriyon\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    #[test]
    fn a_partial_reply_is_told_apart_from_every_other_event() {
        assert!(is_partial(br#"{"kind":"partial","text":"Hel"}"#));
        assert!(!is_partial(br#"{"kind":"row"}"#));
        assert!(!is_partial(b"not json"));
    }

    #[test]
    fn reads_a_whole_post_and_waits_for_a_partial_one() {
        let req = post(r#"{"kind":"hello"}"#);
        assert_eq!(parse_request(&req), Request::Post(br#"{"kind":"hello"}"#));
        assert_eq!(parse_request(&req[..req.len() - 3]), Request::Incomplete);
        assert_eq!(
            parse_request(b"POST /event HTTP/1.1\r\nHost"),
            Request::Incomplete
        );
    }

    #[test]
    fn rejects_anything_but_a_bounded_post() {
        assert_eq!(parse_request(b"GET / HTTP/1.1\r\n\r\n"), Request::Rejected);
        assert_eq!(
            parse_request(b"POST / HTTP/1.1\r\nHost: x\r\n\r\n"),
            Request::Rejected,
            "no length"
        );
        let huge = format!(
            "POST / HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY + 1
        );
        assert_eq!(parse_request(huge.as_bytes()), Request::Rejected);
        assert_eq!(parse_request(&vec![b'x'; MAX_HEAD + 1]), Request::Rejected);
    }

    #[test]
    fn a_spool_line_is_one_redacted_json_line_with_the_receive_time() {
        let line = spool_line(b"{\"kind\":\"row\",\n\"text\":\"token=abc\"}", 7).expect("a line");
        assert!(!line.contains('\n'));
        let value: serde_json::Value = serde_json::from_str(&line).expect("JSON");
        assert_eq!(value["receivedMs"], 7);
        assert_eq!(value["text"], "token=[REDACTED]");
        // Redacted by value: a quoted secret with a space can't break the line.
        let line = spool_line(br#"{"text":"password=\"a b\" c"}"#, 7).expect("a line");
        let value: serde_json::Value = serde_json::from_str(&line).expect("still JSON");
        assert_eq!(value["text"], "password=\"[REDACTED]\" c");
        assert_eq!(spool_line(b"[1,2]", 7), None);
        assert_eq!(spool_line(b"not json", 7), None);
    }

    #[test]
    fn each_kind_of_line_becomes_one_event() {
        assert_eq!(
            classify(
                r#"{"kind":"hello","run":"r1","seq":1,"sessionId":"c1","version":"2.1.288","receivedMs":5}"#
            ),
            Some(BridgeEvent::Hello {
                run: "r1".into(),
                seq: 1,
                conversation: Some("c1".into()),
                version: Some("2.1.288".into()),
                received_ms: Some(5),
            })
        );
        let row = r#"{"kind":"row","run":"r1","seq":7,"sessionId":"c1","uuid":"u"}"#;
        assert_eq!(
            classify(row),
            Some(BridgeEvent::Row {
                run: "r1".into(),
                seq: 7,
                conversation: Some("c1".into()),
                line: row.into(),
                received_ms: None,
            })
        );
        assert_eq!(
            classify(
                r#"{"kind":"check","toolUseId":"t1","decision":"allow","rule":"Bash(npm *)"}"#
            ),
            Some(BridgeEvent::Check {
                tool_use_id: "t1".into(),
                check: ToolCheck {
                    decision: "allow".into(),
                    rule: Some("Bash(npm *)".into())
                },
            })
        );
        assert_eq!(
            classify(r#"{"kind":"end","run":"r1","seq":9,"sessionId":"c1"}"#),
            Some(BridgeEvent::End {
                run: "r1".into(),
                seq: 9,
                conversation: Some("c1".into()),
                received_ms: None,
            })
        );
        assert_eq!(classify(r#"{"kind":"turn.start"}"#), None);
        assert!(matches!(
            classify(
                r#"{"kind":"session_request","requestId":"t","initiation":"user_asked","prompt":"P","title":"T"}"#
            ),
            Some(BridgeEvent::SessionRequest(_))
        ));
        assert_eq!(classify("garbage"), None);
    }
}
