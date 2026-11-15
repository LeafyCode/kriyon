//! The hook's output for every recorded payload, against what the Python
//! scripts it replaced wrote for it (`tests/golden/`, recorded process
//! against process while the scripts still existed; ADR-0066).

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn manifest() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

fn run(args: &[&str], home: &Path, payload: &[u8]) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_kriyon-hook"))
        .args(args)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("KRIYON_SESSION", "sess-1")
        .env_remove("CLAUDE_PID")
        .env_remove("KRIYON_TTY")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .expect("runs");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(payload)
        .expect("feeds");
    assert!(child.wait().expect("waits").success(), "never fails Claude");
}

fn fixtures(kind: &str) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(manifest().join("tests/payloads").join(kind))
        .expect("payloads")
        .map(|e| e.expect("entry").path())
        .collect();
    files.sort();
    files
}

#[test]
fn every_hook_payload_is_recorded_as_the_golden_line_says() {
    for fixture in fixtures("event") {
        let stem = fixture
            .file_stem()
            .expect("name")
            .to_string_lossy()
            .to_string();
        let want = std::fs::read_to_string(
            manifest()
                .join("tests/golden/event")
                .join(format!("{stem}.line")),
        )
        .expect("a golden line for every payload");
        let home = tempfile::tempdir().expect("home");
        run(
            &["event"],
            home.path(),
            &std::fs::read(&fixture).expect("payload"),
        );
        let got = std::fs::read_to_string(home.path().join(".claude/kriyon/events/sess-1.jsonl"))
            .ok()
            .and_then(|text| text.lines().last().map(str::to_string))
            .map_or_else(String::new, |line| {
                let at = line.rfind("\"ts\": \"").expect("a time");
                format!("{}\"ts\": \"<time>\"}}", &line[..at])
            });
        assert_eq!(got, want, "{}", fixture.display());
    }
}

#[test]
fn every_status_line_payload_is_kept_as_the_golden_files_say() {
    for fixture in fixtures("usage") {
        let stem = fixture
            .file_stem()
            .expect("name")
            .to_string_lossy()
            .to_string();
        let want: Vec<serde_json::Value> = serde_json::from_str(
            &std::fs::read_to_string(
                manifest()
                    .join("tests/golden/usage")
                    .join(format!("{stem}.files.json")),
            )
            .expect("golden files"),
        )
        .expect("json");
        let home = tempfile::tempdir().expect("home");
        run(
            &["usage", "sess-1"],
            home.path(),
            &std::fs::read(&fixture).expect("payload"),
        );
        for file in want {
            let name = file["file"].as_str().expect("name");
            let got = std::fs::read_to_string(home.path().join(".claude/kriyon").join(name))
                .expect("written");
            assert_eq!(
                got,
                file["text"].as_str().expect("text"),
                "{} {name}",
                fixture.display()
            );
        }
    }
}
