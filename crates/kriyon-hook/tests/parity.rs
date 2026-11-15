//! The Rust hook against the Python one it replaces (ADR-0066): every
//! recorded payload, fed to both as Claude Code would (a process, stdin, the
//! same HOME and environment), records the same line, byte for byte but the
//! time. Each Python output is kept as a golden file
//! (`tests/golden/`, written with `KRIYON_WRITE_GOLDEN=1`), so the check
//! outlives the Python script.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The Python the old scripts ran under.
const PYTHON: &str = if cfg!(windows) { "python" } else { "python3" };

fn fixtures(kind: &str) -> Vec<PathBuf> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/payloads")
        .join(kind);
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .expect("payloads")
        .map(|entry| entry.expect("entry").path())
        .filter(|path| path.extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort();
    files
}

/// Run `program args` with `payload` on stdin and `home` as HOME, as the
/// session `sess-1`'s own `claude` would (no terminal check to make).
fn run(program: &Path, args: &[&str], home: &Path, payload: &[u8]) -> Vec<u8> {
    let mut child = Command::new(program)
        .args(args)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("KRIYON_SESSION", "sess-1")
        .env_remove("CLAUDE_PID")
        .env_remove("KRIYON_TTY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("runs");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(payload)
        .expect("feeds");
    let out = child.wait_with_output().expect("waits");
    assert!(
        out.status.success(),
        "{} never fails Claude",
        program.display()
    );
    out.stdout
}

fn hook_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_kriyon-hook"))
}

/// The line `program` records for `payload`, its time blanked.
fn recorded(script: Option<&Path>, payload: &[u8]) -> Option<String> {
    let home = tempfile::tempdir().expect("home");
    match script {
        Some(script) => run(
            Path::new(PYTHON),
            &[&script.display().to_string()],
            home.path(),
            payload,
        ),
        None => run(&hook_bin(), &["event"], home.path(), payload),
    };
    let text =
        std::fs::read_to_string(home.path().join(".claude/kriyon/events/sess-1.jsonl")).ok()?;
    let line = text.lines().last()?.to_string();
    let at = line.rfind("\"ts\": \"")?;
    Some(format!("{}\"ts\": \"<time>\"}}", &line[..at]))
}

fn golden(kind: &str, fixture: &Path, suffix: &str) -> PathBuf {
    let name = fixture
        .file_stem()
        .expect("a name")
        .to_string_lossy()
        .to_string();
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(kind)
        .join(format!("{name}{suffix}"))
}

fn python_available() -> bool {
    Command::new(PYTHON)
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success())
}

#[test]
fn every_hook_payload_is_recorded_as_the_python_hook_recorded_it() {
    let script_dir = tempfile::tempdir().expect("dir");
    let script = script_dir.path().join("kriyon-hook.py");
    std::fs::write(&script, kriyon_core::hooks::HOOK_SCRIPT).expect("script");
    let write = std::env::var_os("KRIYON_WRITE_GOLDEN").is_some();
    assert!(python_available(), "the parity check needs {PYTHON}");
    for fixture in fixtures("event") {
        let payload = std::fs::read(&fixture).expect("payload");
        let python = recorded(Some(&script), &payload);
        let rust = recorded(None, &payload);
        assert_eq!(rust, python, "{}", fixture.display());
        if write {
            let path = golden("event", &fixture, ".line");
            std::fs::create_dir_all(path.parent().expect("dir")).expect("dir");
            std::fs::write(path, python.unwrap_or_default()).expect("golden");
        }
    }
}

#[test]
fn a_subagents_launch_is_read_from_its_sidecar_as_python_read_it() {
    let dir = tempfile::tempdir().expect("dir");
    let transcript = dir.path().join("main.jsonl");
    let sidecar_dir = dir.path().join("main").join("subagents");
    std::fs::create_dir_all(&sidecar_dir).expect("dir");
    std::fs::write(
        sidecar_dir.join("agent-ab12.meta.json"),
        r#"{"agentType":"Explore","toolUseId":"toolu_launch"}"#,
    )
    .expect("sidecar");
    let payload = format!(
        r#"{{"hook_event_name":"PreToolUse","agent_id":"ab12","transcript_path":"{}","tool_name":"Read"}}"#,
        transcript.display().to_string().replace('\\', "/")
    );
    let script = dir.path().join("kriyon-hook.py");
    std::fs::write(&script, kriyon_core::hooks::HOOK_SCRIPT).expect("script");
    let python = recorded(Some(&script), payload.as_bytes());
    let rust = recorded(None, payload.as_bytes());
    assert_eq!(rust, python);
    assert!(rust.is_some_and(|line| line.contains(r#""launched_by": "toolu_launch""#)));
}

/// The files the usage capture writes under `home`, by name.
fn usage_files(home: &Path) -> Vec<(String, String)> {
    let mut files = Vec::new();
    for sub in ["usage", "limits"] {
        let dir = home.join(".claude/kriyon").join(sub);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries {
            let path = entry.expect("entry").path();
            let name = format!(
                "{sub}/{}",
                path.file_name().expect("name").to_string_lossy()
            );
            files.push((name, std::fs::read_to_string(&path).expect("reads")));
        }
    }
    files.sort();
    files
}

#[test]
fn every_status_line_payload_is_kept_as_the_python_capture_kept_it() {
    let script_dir = tempfile::tempdir().expect("dir");
    let script = script_dir.path().join("kriyon-usage.py");
    std::fs::write(&script, kriyon_core::hooks::USAGE_SCRIPT).expect("script");
    let write = std::env::var_os("KRIYON_WRITE_GOLDEN").is_some();
    for fixture in fixtures("usage") {
        let payload = std::fs::read(&fixture).expect("payload");
        for sid in ["sess-1", ""] {
            let (py_home, rs_home) = (
                tempfile::tempdir().expect("h"),
                tempfile::tempdir().expect("h"),
            );
            run(
                Path::new(PYTHON),
                &[&script.display().to_string(), sid],
                py_home.path(),
                &payload,
            );
            run(&hook_bin(), &["usage", sid], rs_home.path(), &payload);
            let (python, rust) = (usage_files(py_home.path()), usage_files(rs_home.path()));
            assert_eq!(rust, python, "{} with session {sid:?}", fixture.display());
            if write && sid == "sess-1" {
                let path = golden("usage", &fixture, ".files.json");
                std::fs::create_dir_all(path.parent().expect("dir")).expect("dir");
                let as_json: Vec<serde_json::Value> = python
                    .iter()
                    .map(|(name, text)| serde_json::json!({"file": name, "text": text}))
                    .collect();
                std::fs::write(path, serde_json::to_string_pretty(&as_json).expect("json"))
                    .expect("golden");
            }
        }
    }
}

#[test]
fn the_fallback_status_line_names_the_model_as_python_did() {
    let fallback = "import sys,json\ntry: d=json.load(sys.stdin)\nexcept Exception: d={}\nprint((d.get(\"model\") or {}).get(\"display_name\",\"Claude\"))";
    let home = tempfile::tempdir().expect("home");
    let mut payloads: Vec<Vec<u8>> = fixtures("usage")
        .into_iter()
        .map(|f| std::fs::read(f).expect("payload"))
        .collect();
    payloads.push(b"not json".to_vec());
    payloads.push(br#"{"model":{"display_name":null}}"#.to_vec());
    payloads.push(br#"{"model":{}}"#.to_vec());
    for payload in payloads {
        // Python crashed on a `model` that isn't an object (its status line
        // went blank); the Rust one says "Claude" there instead.
        let mut child = Command::new(PYTHON)
            .args(["-c", fallback])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("runs");
        child
            .stdin
            .take()
            .expect("stdin")
            .write_all(&payload)
            .expect("feeds");
        let out = child.wait_with_output().expect("waits");
        let rust = run(&hook_bin(), &["model"], home.path(), &payload);
        if !out.status.success() {
            assert_eq!(String::from_utf8_lossy(&rust).trim(), "Claude");
            continue;
        }
        let python = out.stdout;
        assert_eq!(
            String::from_utf8_lossy(&rust).replace("\r\n", "\n"),
            String::from_utf8_lossy(&python).replace("\r\n", "\n"),
            "{}",
            String::from_utf8_lossy(&payload)
        );
    }
}
