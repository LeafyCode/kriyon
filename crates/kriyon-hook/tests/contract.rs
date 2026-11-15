//! The contract between the hook program and `kriyon_core::hooks`, moved
//! from kriyon-core when the Python scripts became `kriyon-hook` (ADR-0066):
//! each case runs the real binary as Claude Code would, and reads what it
//! recorded back with the parser Kriyon uses.

#![allow(clippy::too_many_lines)]

use kriyon_core::hooks::*;
use serde_json::{json, Value};

fn fields(ev: &HookEvent) -> serde_json::Map<String, Value> {
    match serde_json::to_value(ev).expect("serializes") {
        Value::Object(map) => map,
        other => panic!("not an object: {other}"),
    }
}

/// Run `kriyon-hook event` with `payload` on stdin, as
/// Claude Code would, and return the event line it recorded (if any).
/// Exercises the actual shipped script.
fn run_hook_script(payload: &str) -> Option<HookEvent> {
    let tmp = tempfile::tempdir().expect("tempdir");
    run_hook_script_in(tmp.path(), payload)
}

/// [`run_hook_script`] with `home` as HOME, so a test can inspect the files.
fn run_hook_script_in(home: &std::path::Path, payload: &str) -> Option<HookEvent> {
    run_hook_script_as(home, payload, &[])
}

/// [`run_hook_script_in`] with extra env, as the `claude` firing the hook
/// would set it (`CLAUDE_PID`) and Kriyon's daemon would (`KRIYON_TTY`).
fn run_hook_script_as(
    home: &std::path::Path,
    payload: &str,
    env: &[(&str, &str)],
) -> Option<HookEvent> {
    let tmp = home;
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_kriyon-hook"))
        .arg("event")
        .env("HOME", tmp)
        .env("USERPROFILE", tmp)
        // A test run from a Kriyon terminal inherits the real session's
        // values; each case sets only the ones it means to.
        .env_remove("CLAUDE_PID")
        .env_remove("KRIYON_TTY")
        .envs(env.iter().copied())
        .env("KRIYON_SESSION", "sess-1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write as _;
            child
                .stdin
                .take()
                .expect("stdin")
                .write_all(payload.as_bytes())?;
            child.wait_with_output()
        })
        .expect("run hook script");
    assert!(out.status.success(), "the hook must never fail Claude");
    let text = std::fs::read_to_string(tmp.join(".claude/kriyon/events/sess-1.jsonl")).ok()?;
    parse_hook_line(text.lines().last()?)
}

/// Run the hook script as the foreground process of a fresh terminal — the
/// way the [Owning claude] runs it — via `script(1)`, which gives its child
/// a new pty. `CLAUDE_PID` is that process itself; `KRIYON_TTY` is `tty`
/// (the session's own terminal) or `other_tty` when given.
#[cfg(target_os = "macos")]
fn run_hook_script_on_a_terminal(other_tty: Option<&str>) -> Option<HookEvent> {
    let tmp = tempfile::tempdir().expect("tempdir");
    let payload = tmp.path().join("payload.json");
    std::fs::write(&payload, r#"{"hook_event_name":"Stop","session_id":"c-1"}"#)
        .expect("write payload");
    let tty = other_tty.map_or_else(|| "$(tty)".to_string(), str::to_string);
    let inner = format!(
        "CLAUDE_PID=$$ KRIYON_TTY={tty} exec '{}' event < '{}'",
        env!("CARGO_BIN_EXE_kriyon-hook"),
        payload.display()
    );
    let status = std::process::Command::new("script")
        .args(["-q", "/dev/null", "sh", "-c", &inner])
        .env("HOME", tmp.path())
        .env("USERPROFILE", tmp.path())
        .env("KRIYON_SESSION", "sess-1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .status()
        .expect("run script(1)");
    assert!(status.success(), "the hook must never fail Claude");
    let text =
        std::fs::read_to_string(tmp.path().join(".claude/kriyon/events/sess-1.jsonl")).ok()?;
    parse_hook_line(text.lines().last()?)
}

#[cfg(target_os = "macos")]
#[test]
fn the_hook_script_records_the_claude_holding_the_session_terminal() {
    let ev = run_hook_script_on_a_terminal(None).expect("the owning claude's event");
    assert_eq!(ev.event, "Stop");
}

#[cfg(target_os = "macos")]
#[test]
fn the_hook_script_drops_a_claude_holding_some_other_terminal() {
    // A test script that opens its own pty for a nested `claude`.
    assert!(run_hook_script_on_a_terminal(Some("/dev/ttys999")).is_none());
}

// Reads the session's terminal device; Windows has none and the scripts
// fail open there.
#[cfg(unix)]
#[test]
fn the_hook_script_drops_a_claude_with_no_terminal() {
    // A `claude -p` from a Bash command: Claude Code runs each command in a
    // new session with no controlling terminal. The test process stands in
    // for that `claude`.
    let tmp = tempfile::tempdir().expect("tempdir");
    let pid = std::process::id().to_string();
    let ev = run_hook_script_as(
        tmp.path(),
        r#"{"hook_event_name":"Stop","session_id":"nested"}"#,
        &[("CLAUDE_PID", &pid), ("KRIYON_TTY", "/dev/ttys999")],
    );
    assert!(
        ev.is_none(),
        "a nested claude must not speak for the session"
    );
}

#[test]
fn the_hook_script_records_when_it_cannot_tell_who_fired_it() {
    // A session started before Kriyon set KRIYON_TTY, or a CLI that sets no
    // CLAUDE_PID: fail open, as before.
    let tmp = tempfile::tempdir().expect("tempdir");
    let payload = r#"{"hook_event_name":"Stop","session_id":"c-1"}"#;
    assert!(run_hook_script_as(tmp.path(), payload, &[("CLAUDE_PID", "1")]).is_some());
    assert!(run_hook_script_as(tmp.path(), payload, &[("KRIYON_TTY", "/dev/ttys999")]).is_some());
}

#[test]
fn the_hook_script_records_the_notification_type() {
    // The whole chain in one go: Claude Code's payload → the shipped script →
    // `HookEvent` → the classifier. Drop `notification_type` anywhere along
    // it and every session falls back to guessing from English prose.
    let ev = run_hook_script(
        r#"{"hook_event_name":"Notification","notification_type":"auth_success","message":"Claude Code login successful"}"#,
    )
    .expect("an event line");
    assert_eq!(ev.notification_type.as_deref(), Some("auth_success"));
    assert_eq!(
        notification_kind(ev.notification_type.as_deref(), ev.message.as_deref()),
        NotificationKind::Informational,
    );
}

#[test]
fn the_hook_script_counts_the_lines_a_file_change_made() {
    // Claude Code's own patch, as an Edit returns it.
    let edit = run_hook_script(
        r#"{"hook_event_name":"PostToolUse","tool_name":"Edit","tool_use_id":"t1","tool_input":{"file_path":"/w/a.ts"},"tool_response":{"filePath":"/w/a.ts","structuredPatch":[{"lines":[" a","-b","+c","+d"]},{"lines":["-e"]}]}}"#,
    )
    .expect("an event line");
    assert_eq!((edit.lines_added, edit.lines_removed), (Some(2), Some(2)));
    assert_eq!(
        edit.created, None,
        "only a Write says whether the file is new"
    );

    // A new file has no patch: every line of it is new.
    let write = run_hook_script(
        r#"{"hook_event_name":"PostToolUse","tool_name":"Write","tool_use_id":"t2","tool_input":{"file_path":"/w/b.ts"},"tool_response":{"type":"create","content":"x\ny\nz\n","structuredPatch":[]}}"#,
    )
    .expect("an event line");
    assert_eq!((write.lines_added, write.lines_removed), (Some(3), Some(0)));
    assert_eq!(write.created, Some(true));

    // A command that edited files reports them too.
    let bash = run_hook_script(
        r#"{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_use_id":"t3","tool_input":{"command":"sed -i '' s/a/b/ x y"},"tool_response":{"stdout":"","bashEditDiff":{"files":[{"filePath":"/w/x","hunks":[{"lines":["-a","+b"]}]},{"filePath":"/w/y","hunks":[{"lines":["+b"]}]}]}}}"#,
    )
    .expect("an event line");
    assert_eq!((bash.lines_added, bash.lines_removed), (Some(2), Some(1)));

    let read = run_hook_script(
        r#"{"hook_event_name":"PostToolUse","tool_name":"Read","tool_use_id":"t4","tool_input":{"file_path":"/w/a.ts"},"tool_response":{"type":"text"}}"#,
    )
    .expect("an event line");
    assert_eq!((read.lines_added, read.created), (None, None));
}

#[test]
fn the_hook_script_records_results_as_a_person_reads_them() {
    let result = |tool: &str, response: &str| {
        run_hook_script(&format!(
            r#"{{"hook_event_name":"PostToolUse","tool_name":"{tool}","tool_use_id":"t","tool_input":{{}},"tool_response":{response}}}"#
        ))
        .expect("an event line")
        .result
    };
    assert_eq!(
        result(
            "Bash",
            r#"{"stdout":"found 0 vulnerabilities\nv24","stderr":"warn","interrupted":false}"#
        )
        .as_deref(),
        Some("found 0 vulnerabilities\nv24\nwarn"),
        "the output, not the JSON around it"
    );
    assert_eq!(
        result(
            "Edit",
            r#"{"originalFile":"huge","structuredPatch":[{"lines":[" a","-b","+c"]}]}"#
        )
        .as_deref(),
        Some(" a\n-b\n+c")
    );
    assert_eq!(
        result(
            "WebFetch",
            r#"{"url":"https://x","code":200,"result":"page text"}"#
        )
        .as_deref(),
        Some("page text")
    );
    // A long output keeps its start and its end, where the summary is.
    let long = format!("start{}end", "x".repeat(10_000));
    let kept =
        result("Bash", &serde_json::json!({ "stdout": long }).to_string()).expect("a result");
    assert!(
        kept.starts_with("start") && kept.ends_with("end"),
        "{kept:.40}"
    );
    assert!(kept.chars().count() < 4100);
}

#[test]
fn the_hook_script_names_the_files_a_command_changed() {
    let ev = run_hook_script(
        r#"{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_use_id":"t","tool_input":{"command":"cat > src/a.js"},"tool_response":{"stdout":"","bashEditDiff":{"files":[{"filePath":"/w/src/a.js","hunks":[{"lines":["+x"]}]}]}}}"#,
    )
    .expect("an event line");
    assert_eq!(ev.changed_files, Some(vec!["/w/src/a.js".to_string()]));

    // An install rewrites node_modules: that's the package, not the project.
    let install = run_hook_script(
        r#"{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_use_id":"t","tool_input":{"command":"npm i lodash"},"tool_response":{"stdout":"","bashEditDiff":{"files":[{"filePath":"/w/node_modules/.package-lock.json","hunks":[{"lines":["+a","+b"]}]},{"filePath":"/w/.git/index","hunks":[{"lines":["+c"]}]},{"filePath":"/w/package.json","hunks":[{"lines":["+d"]}]}]}}}"#,
    )
    .expect("an event line");
    assert_eq!(
        install.changed_files,
        Some(vec!["/w/package.json".to_string()])
    );
    assert_eq!(
        (install.lines_added, install.lines_removed),
        (Some(1), Some(0))
    );
}

#[test]
fn the_hook_script_sums_up_what_a_command_or_search_found() {
    let outcome = |tool: &str, input: &str, response: &str| {
        run_hook_script(&format!(
            r#"{{"hook_event_name":"PostToolUse","tool_name":"{tool}","tool_use_id":"t","tool_input":{input},"tool_response":{response}}}"#
        ))
        .expect("an event line")
        .outcome
    };
    let bash = |stdout: &str| {
        outcome(
            "Bash",
            r#"{"command":"pnpm test"}"#,
            &serde_json::json!({ "stdout": stdout }).to_string(),
        )
    };
    // The summary sits at the end of a long run, past any cap.
    let noise = "ok\n".repeat(5000);
    assert_eq!(
        bash(&format!(
            "{noise} Test Files  9 passed (9)\n      Tests  43 passed (43)\n"
        ))
        .as_deref(),
        Some("43 passed")
    );
    assert_eq!(
        bash("Tests  2 failed | 41 passed (43)").as_deref(),
        Some("2 failed")
    );
    // Cargo prints one line per test binary: they add up.
    assert_eq!(
        bash("test result: ok. 200 passed; 0 failed; 0 ignored\ntest result: ok. 12 passed; 0 failed;").as_deref(),
        Some("212 passed")
    );
    assert_eq!(
        bash("== 3 failed, 10 passed in 0.2s ==").as_deref(),
        Some("3 failed")
    );
    // Node's own test runner.
    assert_eq!(
        bash("ℹ tests 3\nℹ suites 0\nℹ pass 3\nℹ fail 0\n").as_deref(),
        Some("3 passed")
    );
    assert_eq!(
        bash("# tests 3\n# pass 2\n# fail 1\n").as_deref(),
        Some("1 failed")
    );
    assert_eq!(bash("hello").as_deref(), None);
    // A run where every test failed has no "passed" anywhere.
    assert_eq!(
        bash(" Test Files  1 failed (1)\n      Tests  2 failed (2)\n").as_deref(),
        Some("2 failed")
    );
    assert_eq!(
        bash("===== 2 failed in 0.10s =====").as_deref(),
        Some("2 failed")
    );
    assert_eq!(
        bash("Tests:       2 failed, 2 total").as_deref(),
        Some("2 failed")
    );
    assert_eq!(
        bash("Tests:       41 passed, 41 total").as_deref(),
        Some("41 passed")
    );
    // Output that only mentions passing is not a test run.
    assert_eq!(
        bash("hooks.rs:1188: Some(\"43 passed\")\nfix: 3 passed tests").as_deref(),
        None
    );
    // One command running several runners adds them all up.
    assert_eq!(
        bash(
            "      Tests  10 passed (10)\nℹ pass 5\nℹ fail 0\ntest result: ok. 7 passed; 0 failed;"
        )
        .as_deref(),
        Some("22 passed")
    );
    assert_eq!(
        bash("      Tests  1 failed | 9 passed (10)\ntest result: ok. 7 passed; 0 failed;")
            .as_deref(),
        Some("1 failed")
    );
    assert_eq!(
        outcome(
            "Grep",
            r#"{"pattern":"x"}"#,
            r#"{"mode":"files_with_matches","numFiles":6,"filenames":[]}"#
        )
        .as_deref(),
        Some("6 files")
    );
    assert_eq!(
        outcome(
            "Glob",
            r#"{"pattern":"*.rs"}"#,
            r#"{"numFiles":1,"filenames":["a.rs"]}"#
        )
        .as_deref(),
        Some("1 file")
    );
}

#[test]
fn the_hook_script_records_the_background_work_a_stop_leaves_running() {
    // Claude Code 2.1.283's own `Stop` payload. Only id + type are kept, so
    // a long agent description can never bloat or truncate the line.
    let ev = run_hook_script(
        r#"{"hook_event_name":"Stop","stop_hook_active":false,"background_tasks":[{"id":"ac049aa2d97e68b55","type":"subagent","status":"running","description":"Map the parser edge cases","agent_type":"general-purpose"},{"id":"b7","type":"shell","status":"running","description":"sleep 25","command":"sleep 25"}]}"#,
    )
    .expect("an event line");
    let kriyon_core::hook_signal::HookSignal::TurnEnded(end) =
        kriyon_core::hook_signal::classify(&ev)
    else {
        panic!("a Stop ends the turn");
    };
    assert_eq!(end.in_flight.background_agents(), Some(1));
    let tasks = ev.background_tasks.expect("the list");
    assert_eq!(tasks[0].id, "ac049aa2d97e68b55");
    assert_eq!(tasks[1].kind, "shell");
}

#[test]
fn the_hook_script_reads_which_launch_started_a_subagent() {
    let home = tempfile::tempdir().expect("tempdir");
    let sub = home.path().join("proj/s1/subagents");
    std::fs::create_dir_all(&sub).expect("subagents dir");
    std::fs::write(
        sub.join("agent-a7.meta.json"),
        r#"{"agentType":"Explore","description":"Map it","toolUseId":"toolu_9"}"#,
    )
    .expect("sidecar");
    let transcript = home.path().join("proj/s1.jsonl");
    let payload = |agent: &str| {
        serde_json::json!({
            "hook_event_name": "PreToolUse", "tool_name": "Read", "tool_use_id": "t",
            "agent_id": agent, "agent_type": "Explore",
            "transcript_path": transcript, "tool_input": {"file_path": "/w/a"},
        })
        .to_string()
    };
    let ev = run_hook_script_in(home.path(), &payload("a7")).expect("an event line");
    assert_eq!(ev.launched_by.as_deref(), Some("toolu_9"));
    let unknown = run_hook_script_in(home.path(), &payload("zz")).expect("an event line");
    assert_eq!(
        unknown.launched_by, None,
        "no sidecar: nothing, and no failure"
    );
    let sneaky = run_hook_script_in(home.path(), &payload("../../x")).expect("an event line");
    assert_eq!(sneaky.launched_by, None, "an id is a name, never a path");
}

#[test]
fn the_hook_script_records_which_agent_a_background_launch_started() {
    // A background `Agent` returns at once with the launched agent's id —
    // the same id its own tool events carry. The response is a launch
    // receipt, not the agent's answer, so it is not recorded as the result.
    let ev = run_hook_script(
        r#"{"hook_event_name":"PostToolUse","tool_name":"Agent","tool_use_id":"toolu_1","tool_input":{"subagent_type":"general-purpose","description":"Survey"},"tool_response":{"isAsync":true,"status":"async_launched","agentId":"a5bb20474b9c0c0bd","description":"Survey","prompt":"a very long prompt"}}"#,
    )
    .expect("an event line");
    assert_eq!(ev.launched_agent_id.as_deref(), Some("a5bb20474b9c0c0bd"));
    assert_eq!(ev.result, None);
}

#[test]
fn the_hook_script_marks_a_background_launch_even_without_its_id() {
    // Still a launch receipt, not the agent's answer: recorded as a launch
    // with no id rather than as a finished agent.
    let ev = run_hook_script(
        r#"{"hook_event_name":"PostToolUse","tool_name":"Agent","tool_use_id":"toolu_1","tool_response":{"isAsync":true,"status":"async_launched","agent_id":7}}"#,
    )
    .expect("an event line");
    assert_eq!(ev.launched_agent_id.as_deref(), Some(""));
    assert_eq!(ev.result, None);
}

#[test]
fn the_hook_script_redacts_every_shared_case() {
    // The same cases pin `crate::redact`, so the two halves can't drift.
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../kriyon-core/scripts/redaction-cases.json"
    ))
    .expect("cases");
    for case in cases {
        let payload = json!({
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": { "command": case["in"] },
        });
        let ev = run_hook_script(&payload.to_string()).expect("an event line");
        assert_eq!(
            ev.command.as_deref(),
            case["out"].as_str(),
            "input: {}",
            case["in"]
        );
    }
}

#[test]
fn the_hook_script_records_the_tool_input_redacted_and_capped() {
    let ev = run_hook_script(
        r#"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"x","env":{"API_TOKEN":"abc"},"nested":["password=hunter2"]}}"#,
    )
    .expect("an event line");
    let input: Value = serde_json::from_str(ev.input.as_deref().expect("input")).expect("JSON");
    assert_eq!(input["env"]["API_TOKEN"], "[REDACTED]", "secret-named key");
    assert_eq!(input["nested"][0], "password=[REDACTED]", "secret shape");

    let long = "a".repeat(5000);
    let payload = json!({"hook_event_name":"PreToolUse","tool_input":{"content": long}});
    let ev = run_hook_script(&payload.to_string()).expect("an event line");
    assert!(ev.input.expect("input").chars().count() <= 2001, "capped");
}

#[test]
fn the_hook_script_records_the_prompt_redacted_and_capped() {
    let payload = json!({
        "hook_event_name": "UserPromptSubmit",
        "prompt": format!("use token=abc {}", "x".repeat(3000)),
    });
    let ev = run_hook_script(&payload.to_string()).expect("an event line");
    let prompt = ev.prompt.expect("prompt");
    assert!(prompt.starts_with("use token=[REDACTED] "));
    assert!(prompt.chars().count() <= 1001, "capped");
}

#[cfg(unix)]
#[test]
fn the_hook_script_writes_owner_only_files() {
    use std::os::unix::fs::PermissionsExt as _;
    let home = tempfile::tempdir().expect("tempdir");
    run_hook_script_in(home.path(), r#"{"hook_event_name":"Stop"}"#).expect("an event line");
    let mode = |p: &str| {
        std::fs::metadata(home.path().join(p))
            .expect("exists")
            .permissions()
            .mode()
            & 0o777
    };
    assert_eq!(mode(".claude/kriyon/events"), 0o700);
    assert_eq!(mode(".claude/kriyon/events/sess-1.jsonl"), 0o600);
}

#[test]
fn the_hook_script_records_the_stop_failure_error() {
    let ev = run_hook_script(
        r#"{"hook_event_name":"StopFailure","error":"rate_limit","error_details":"429"}"#,
    )
    .expect("an event line");
    assert_eq!(ev.event, "StopFailure");
    assert_eq!(ev.error.as_deref(), Some("rate_limit"));
}

#[test]
fn the_hook_script_records_stop_hook_active() {
    // Drop the re-entry flag anywhere along the chain and the
    // duplicate-announcement guard silently never engages.
    let ev = run_hook_script(r#"{"hook_event_name":"Stop","stop_hook_active":true}"#)
        .expect("an event line");
    assert_eq!(ev.event, "Stop");
    assert_eq!(ev.stop_hook_active, Some(true));
}

#[test]
fn the_hook_script_and_hook_event_agree_on_every_field() {
    // The contract between the two halves: a maximal Claude Code payload
    // through the shipped script must fill every `HookEvent` field. A key
    // renamed on one side only reads as None here instead of silently in
    // production. Two payloads, because a background launch receipt and an
    // agent's answer are mutually exclusive.
    let answered = run_hook_script(
        r#"{"hook_event_name":"PostToolUse","session_id":"s","transcript_path":"/t.jsonl","tool_name":"Agent","tool_use_id":"toolu_1","agent_id":"a1","agent_type":"Explore","duration_ms":12,"message":"m","notification_type":"idle_prompt","error":"rate_limit","stop_hook_active":false,"background_tasks":[{"id":"a1","type":"subagent","status":"running"}],"prompt":"p","cwd":"/w","prompt_id":"p1","permission_mode":"default","source":"user","tool_input":{"subagent_type":"Explore","description":"d","run_in_background":true,"command":"ls","questions":[{"question":"q"}],"plan":"step one"},"tool_response":{"content":[{"type":"text","text":"answer"}]}}"#,
    )
    .expect("an event line");
    let launched = run_hook_script(
        r#"{"hook_event_name":"PostToolUse","tool_name":"Agent","tool_use_id":"toolu_2","tool_response":{"isAsync":true,"status":"async_launched","agentId":"a2"}}"#,
    )
    .expect("an event line");
    // A file change and a search fill what a step shows beside it.
    let written = run_hook_script(
        r#"{"hook_event_name":"PostToolUse","tool_name":"Write","tool_use_id":"toolu_3","tool_response":{"type":"create","content":"x","structuredPatch":[]}}"#,
    )
    .expect("an event line");
    let found = run_hook_script(
        r#"{"hook_event_name":"PostToolUse","tool_name":"Grep","tool_use_id":"toolu_4","tool_response":{"numFiles":2}}"#,
    )
    .expect("an event line");
    let edited = run_hook_script(
        r#"{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_use_id":"toolu_5","tool_response":{"stdout":"","bashEditDiff":{"files":[{"filePath":"/w/a","hunks":[]}]}}}"#,
    )
    .expect("an event line");
    // A subagent's own event, with the sidecar naming its launch.
    let home = tempfile::tempdir().expect("tempdir");
    std::fs::create_dir_all(home.path().join("p/s/subagents")).expect("dir");
    std::fs::write(
        home.path().join("p/s/subagents/agent-a1.meta.json"),
        r#"{"toolUseId":"toolu_1"}"#,
    )
    .expect("sidecar");
    let sub = run_hook_script_in(
        home.path(),
        &serde_json::json!({
            "hook_event_name": "PreToolUse", "tool_name": "Read", "tool_use_id": "toolu_6",
            "agent_id": "a1", "transcript_path": home.path().join("p/s.jsonl"),
        })
        .to_string(),
    )
    .expect("an event line");
    let others = [
        fields(&launched),
        fields(&written),
        fields(&found),
        fields(&edited),
        fields(&sub),
    ];
    for (key, value) in &fields(&answered) {
        assert!(
            !value.is_null() || others.iter().any(|o| !o[key].is_null()),
            "no payload fills HookEvent::{key} — the script and the struct disagree"
        );
    }
}

#[test]
fn the_usage_script_and_usage_snapshot_agree_on_every_field() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let payload = br#"{"session_id":"s","model":{"display_name":"Claude"},"context_window":{"used_percentage":12.5,"context_window_size":200000,"total_input_tokens":10,"total_output_tokens":20}}"#;
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_kriyon-hook"))
        .args(["usage", "sess-1"])
        .env("HOME", tmp.path())
        .env("USERPROFILE", tmp.path())
        .stdin(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write as _;
            child.stdin.take().expect("stdin").write_all(payload)?;
            child.wait_with_output()
        })
        .expect("run usage script");
    assert!(out.status.success(), "the capture must never fail Claude");
    let text = std::fs::read_to_string(tmp.path().join(".claude/kriyon/usage/sess-1.json"))
        .expect("a snapshot");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = |p: &str| {
            std::fs::metadata(tmp.path().join(p))
                .expect("exists")
                .permissions()
                .mode()
                & 0o777
        };
        assert_eq!(mode(".claude/kriyon/usage"), 0o700);
        assert_eq!(mode(".claude/kriyon/usage/sess-1.json"), 0o600);
    }
    let snap = parse_usage_snapshot(&text).expect("parses");
    let value = serde_json::to_value(&snap).expect("serializes");
    for (key, field) in value.as_object().expect("an object") {
        assert!(!field.is_null(), "UsageSnapshot::{key} never filled");
    }
}

/// Run the usage script under a temp `HOME`, with `sid` as Kriyon's session
/// id (empty: a `claude` outside Kriyon), returning that `HOME`.
fn run_usage_script(sid: &str, payload: &[u8]) -> tempfile::TempDir {
    run_usage_script_as(sid, payload, &[])
}

/// [`run_usage_script`] with extra env, as the `claude` rendering the
/// status line would set it (`CLAUDE_PID`) and Kriyon's daemon would
/// (`KRIYON_TTY`).
fn run_usage_script_as(sid: &str, payload: &[u8], env: &[(&str, &str)]) -> tempfile::TempDir {
    let tmp = tempfile::tempdir().expect("tempdir");
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_kriyon-hook"))
        .args(["usage", sid])
        .env("HOME", tmp.path())
        .env("USERPROFILE", tmp.path())
        .env_remove("KRIYON_SESSION")
        .envs(env.iter().copied())
        .stdin(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write as _;
            child.stdin.take().expect("stdin").write_all(payload)?;
            child.wait_with_output()
        })
        .expect("run usage script");
    assert!(out.status.success(), "the capture must never fail Claude");
    tmp
}

const LIMITS_PAYLOAD: &[u8] = br#"{"session_id":"claude-1","rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1738425600},"seven_day":{"used_percentage":41.2,"resets_at":1738857600}}}"#;

#[test]
fn the_usage_script_writes_a_limit_reading_outside_kriyon_too() {
    let home = run_usage_script("", LIMITS_PAYLOAD);
    let text = std::fs::read_to_string(home.path().join(".claude/kriyon/limits/claude-1.json"))
        .expect("a limit reading from a non-Kriyon session");
    let reading = kriyon_core::plan_limits::parse_reading(&text).expect("parses");
    assert_eq!(reading.five_hour.map(|w| w.used_percentage), Some(23.5));
    assert_eq!(reading.seven_day.map(|w| w.resets_at), Some(1_738_857_600));
    assert!(
        !home.path().join(".claude/kriyon/usage").exists(),
        "no usage snapshot outside Kriyon"
    );
}

#[test]
fn the_usage_script_skips_limits_when_claude_sends_none_or_an_unsafe_id() {
    let none = run_usage_script("", br#"{"session_id":"claude-1"}"#);
    assert!(!none.path().join(".claude/kriyon/limits").exists());
    let unsafe_id = run_usage_script(
        "",
        br#"{"session_id":"../x","rate_limits":{"five_hour":{"used_percentage":1,"resets_at":2}}}"#,
    );
    assert!(!unsafe_id.path().join(".claude/kriyon/limits").exists());
    let newline_id = run_usage_script(
        "",
        b"{\"session_id\":\"c\\n\",\"rate_limits\":{\"five_hour\":{\"used_percentage\":1,\"resets_at\":2}}}",
    );
    assert!(!newline_id.path().join(".claude/kriyon/limits").exists());
    let infinite = run_usage_script(
        "",
        br#"{"session_id":"c","rate_limits":{"five_hour":{"used_percentage":1,"resets_at":Infinity}}}"#,
    );
    assert!(!unsafe_id.path().join(".claude/kriyon/limits").exists());
    assert!(!unsafe_id.path().join(".claude/kriyon/x.json").exists());
    assert!(!infinite.path().join(".claude/kriyon/limits").exists());
}

#[test]
fn the_usage_script_survives_odd_shapes_and_still_writes_limits() {
    let home = run_usage_script(
        "sess-1",
        br#"{"session_id":"claude-1","model":"opus","context_window":[1],"rate_limits":{"five_hour":{"used_percentage":7,"resets_at":1738425600}}}"#,
    );
    assert!(home
        .path()
        .join(".claude/kriyon/limits/claude-1.json")
        .exists());
}

// Reads the session's terminal device; Windows has none and the scripts
// fail open there.
#[cfg(unix)]
#[test]
fn the_usage_script_drops_a_nested_claudes_context_but_keeps_its_limits() {
    // A nested interactive `claude` renders a status line too. Its context
    // reading must not replace the session's own, but its plan limits are
    // the account's and still count.
    let pid = std::process::id().to_string();
    let home = run_usage_script_as(
        "sess-1",
        br#"{"session_id":"claude-1","context_window":{"used_percentage":1},"rate_limits":{"five_hour":{"used_percentage":7,"resets_at":1738425600}}}"#,
        &[("CLAUDE_PID", &pid), ("KRIYON_TTY", "/dev/ttys999")],
    );
    assert!(!home
        .path()
        .join(".claude/kriyon/usage/sess-1.json")
        .exists());
    assert!(home
        .path()
        .join(".claude/kriyon/limits/claude-1.json")
        .exists());
}
