# Past-Session Discovery & Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a folder is open in Kriyon, discover the folder's past Claude Code sessions from disk and let the user resume any of them into a live session.

**Architecture:** Pure discovery logic (path encoding, transcript summarizing, directory scanning) lives in `kriyon-core` and is unit-tested without Tauri. A thin Tauri command resolves `~/.claude/projects/<encoded-cwd>/`, calls the core scanner, and returns a page of `PastSession` records over IPC. The sidebar shows a lazily-fetched, collapsible "Earlier sessions" group per project; clicking a row creates a session row carrying Claude's session id and activates it, which makes the *existing* activation-launch effect run `claude --resume`. No new launch or terminal code.

**Tech Stack:** Rust (`kriyon-core`, `src-tauri`, `rusqlite`-adjacent patterns, `serde`, `tempfile` for tests), TypeScript/React (Zustand store, Vitest), Tauri v2 IPC.

## Global Constraints

- Build on the `dev`/`feat/*` branch only; never commit to `main`/`master`. Current work branch: `feat/session-activity`.
- Conventional commits, small and frequent.
- TDD: write the failing test first, watch it fail, then implement. `pnpm check` must pass before every commit.
- The Rust↔JS IPC boundary is a trust boundary — validate every input that crosses it. `list_past_sessions` takes a frontend-supplied `cwd`; it is used only to *encode* a directory name and *read* files under `~/.claude/projects`, never executed.
- Pure logic lives in `kriyon-core` (unit-testable without Tauri); `src-tauri` stays a thin shell.
- The transcript parser must NEVER hard-error on unknown input — unparseable/unknown lines are skipped.
- A term must appear in `CONTEXT.md` before it becomes a module/type name. **Past session** is added in Task 3 before the `PastSession` type is defined.
- Never hand-format; `pnpm fix` owns formatting/lint. Rust lint via clippy (`pedantic`/`correctness`).
- Design values (colors/spacing) come from `src/theme/tokens.ts` — never hardcode them in the sidebar UI.
- The persisted Claude session id is re-validated against `SAFE_CLAUDE_ID` in `sessionHost.ts` before it reaches a shell command (already implemented; the resume path reuses it).

**Encoding rule (verified against Claude Code 2.1.181 on disk):** the project directory name is the absolute cwd with every character that is not `[A-Za-z0-9]` replaced by `-`. Verified across dots (`.claude`→`-claude`), underscores (`Acme_iOS`→`Acme-iOS`), existing hyphens (preserved), runs of consecutive specials (`/var/folders/__/`→`-var-folders----`), and the leading slash.

---

### Task 1: Core — `encode_project_dir`

**Files:**
- Create: `crates/kriyon-core/src/history.rs`
- Modify: `crates/kriyon-core/src/lib.rs` (add `pub mod history;`)

**Interfaces:**
- Produces: `kriyon_core::history::encode_project_dir(cwd: &str) -> String`

- [ ] **Step 1: Register the module**

In `crates/kriyon-core/src/lib.rs`, add the module declaration in alphabetical order (after `pub mod git;`):

```rust
pub mod history;
```

- [ ] **Step 2: Write the failing test**

Create `crates/kriyon-core/src/history.rs` with only the test module and a stub:

```rust
//! Discovery of a folder's past Claude Code sessions from `~/.claude/projects`.
//!
//! Pure, Tauri-free logic: encode a folder path to its Claude history
//! directory name, summarize a transcript's lines, and scan a directory into a
//! page of past sessions. The `src-tauri` shell only resolves `$HOME` and calls
//! these functions. Like the transcript parser, summarizing is tolerant: an
//! unparseable or unknown line is skipped, never an error.

/// Encode an absolute working directory to the name Claude Code uses for its
/// per-project transcript directory under `~/.claude/projects`.
///
/// Claude replaces every character that is not ASCII alphanumeric with `-`.
/// The mapping is deterministic forward (cwd → dir name) but lossy in reverse,
/// so callers must never try to reverse it; read the true `cwd` from inside a
/// transcript instead. The mapping also neutralizes path traversal: `/` and `.`
/// both become `-`, so no encoded name can contain `..` or escape the projects
/// directory.
#[must_use]
pub fn encode_project_dir(cwd: &str) -> String {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_paths_like_claude_code() {
        let cases = [
            ("/Users/dev/Projects/kriyon", "-Users-dev-Projects-kriyon"),
            ("/Users/dev/Projects/acme-web", "-Users-dev-Projects-acme-web"),
            (
                "/Users/dev/Projects/Acme/app-1/Acme_iOS",
                "-Users-dev-Projects-Acme-app-1-Acme-iOS",
            ),
            (
                "/Users/dev/Projects/BisBig/bisbig/.claude/worktrees/condescending-cohen-7f05c8",
                "-Users-dev-Projects-BisBig-bisbig--claude-worktrees-condescending-cohen-7f05c8",
            ),
            (
                "/private/var/folders/__/xx0000000000000000000000000gn/T",
                "-private-var-folders----xx0000000000000000000000000gn-T",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(encode_project_dir(input), expected, "input: {input}");
        }
    }

    #[test]
    fn encoding_cannot_traverse_outward() {
        // Dots become dashes, so a `..`-bearing cwd can never produce `..`.
        assert!(!encode_project_dir("/a/../b").contains(".."));
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cargo test -p kriyon-core history::tests::encodes_paths_like_claude_code`
Expected: FAIL (panics on `todo!()`).

- [ ] **Step 4: Implement `encode_project_dir`**

Replace the `todo!()` body:

```rust
#[must_use]
pub fn encode_project_dir(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p kriyon-core history::`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add crates/kriyon-core/src/lib.rs crates/kriyon-core/src/history.rs
git commit -m "feat(core): encode a folder path to its Claude history dir name"
```

---

### Task 2: Core — `parse_session_summary`

**Files:**
- Modify: `crates/kriyon-core/src/history.rs`

**Interfaces:**
- Consumes: `kriyon_core::transcript::parse_title` (existing — extracts `aiTitle` from an `ai-title` line).
- Produces:
  - `kriyon_core::history::PastSessionSummary { title: Option<String>, preview: Option<String>, cwd: Option<String>, git_branch: Option<String>, version: Option<String>, message_count: u32 }`
  - `kriyon_core::history::parse_session_summary<'a>(lines: impl Iterator<Item = &'a str>) -> PastSessionSummary`

- [ ] **Step 1: Write the failing test**

Append to the `tests` module in `crates/kriyon-core/src/history.rs`:

```rust
#[test]
fn summarizes_a_transcript() {
    let lines = [
        r#"{"type":"user","cwd":"/work/repo","gitBranch":"main","version":"2.1.181","message":{"role":"user","content":"first prompt\nsecond line"}}"#,
        r#"{"type":"ai-title","aiTitle":"An early title","sessionId":"x"}"#,
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}"#,
        r#"{"type":"ai-title","aiTitle":"The latest title","sessionId":"x"}"#,
        "not json at all",
        r#"{"type":"user","message":{"role":"user","content":"a later prompt"}}"#,
    ];
    let s = parse_session_summary(lines.into_iter());
    assert_eq!(s.title.as_deref(), Some("The latest title"), "last ai-title wins");
    assert_eq!(s.preview.as_deref(), Some("first prompt"), "first user line only");
    assert_eq!(s.cwd.as_deref(), Some("/work/repo"));
    assert_eq!(s.git_branch.as_deref(), Some("main"));
    assert_eq!(s.version.as_deref(), Some("2.1.181"));
    assert_eq!(s.message_count, 3, "user + assistant + user; meta/junk excluded");
}

#[test]
fn summary_tolerates_empty_and_missing_fields() {
    let s = parse_session_summary(std::iter::empty());
    assert_eq!(s.title, None);
    assert_eq!(s.preview, None);
    assert_eq!(s.cwd, None);
    assert_eq!(s.message_count, 0);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p kriyon-core history::tests::summarizes_a_transcript`
Expected: FAIL (`parse_session_summary`/`PastSessionSummary` not found — does not compile).

- [ ] **Step 3: Implement the type and function**

Add to `crates/kriyon-core/src/history.rs` (above the `tests` module). Note `use` lines go at the top of the file:

```rust
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::transcript::parse_title;

/// The fields a past session carries *in its transcript content* — everything
/// not derivable from the filesystem. The id, last-active time, and total are
/// supplied by the directory scan (see [`PastSession`]).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PastSessionSummary {
    /// The last `ai-title` seen (Claude updates it through the session).
    pub title: Option<String>,
    /// First line of the first `user` message — a title fallback / preview.
    pub preview: Option<String>,
    /// The true working directory, read from the transcript (never decoded
    /// from the directory name).
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub version: Option<String>,
    /// Count of conversation lines (`user`/`assistant`) — a rough size signal.
    pub message_count: u32,
}

/// Extract the first non-empty text line from a `user` line's message content,
/// trimmed. Content is either a bare string or an array of blocks; we take the
/// first `text` block. Returns `None` for tool-result-only user lines.
fn first_user_line(value: &Value) -> Option<String> {
    let content = value.get("message")?.get("content")?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .find(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .and_then(|b| b.get("text").and_then(Value::as_str))
            .map(str::to_string)?,
        _ => return None,
    };
    let first = text.lines().next().unwrap_or("").trim();
    if first.is_empty() {
        None
    } else {
        Some(first.to_string())
    }
}

/// Fold a transcript's lines into a [`PastSessionSummary`]. Tolerant: a line
/// that does not parse as JSON, or that carries no recognized field, is
/// skipped. The last `ai-title` wins; the first `user` line becomes the
/// preview; `cwd`/`gitBranch`/`version` take their first seen value.
#[must_use]
pub fn parse_session_summary<'a>(lines: impl Iterator<Item = &'a str>) -> PastSessionSummary {
    let mut summary = PastSessionSummary::default();
    for line in lines {
        if let Some(title) = parse_title(line) {
            summary.title = Some(title);
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if summary.cwd.is_none() {
            if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
                summary.cwd = Some(cwd.to_string());
            }
        }
        if summary.git_branch.is_none() {
            if let Some(branch) = value.get("gitBranch").and_then(Value::as_str) {
                summary.git_branch = Some(branch.to_string());
            }
        }
        if summary.version.is_none() {
            if let Some(version) = value.get("version").and_then(Value::as_str) {
                summary.version = Some(version.to_string());
            }
        }
        match value.get("type").and_then(Value::as_str) {
            Some("user") => {
                summary.message_count += 1;
                if summary.preview.is_none() {
                    summary.preview = first_user_line(&value);
                }
            }
            Some("assistant") => summary.message_count += 1,
            _ => {}
        }
    }
    summary
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p kriyon-core history::`
Expected: PASS (all history tests).

- [ ] **Step 5: Lint and commit**

```bash
cargo clippy -p kriyon-core --all-targets -- -D warnings
git add crates/kriyon-core/src/history.rs
git commit -m "feat(core): summarize a transcript into past-session metadata"
```

---

### Task 3: Core — `PastSession`, `PastSessionPage`, `list_past_sessions_in_dir`

**Files:**
- Modify: `crates/kriyon-core/src/history.rs`
- Modify: `crates/kriyon-core/Cargo.toml` (add `tempfile` dev-dependency)
- Modify: `CONTEXT.md` (add the **Past session** glossary term)

**Interfaces:**
- Consumes: `parse_session_summary`, `PastSessionSummary` (Task 2).
- Produces:
  - `kriyon_core::history::PastSession { claude_session_id: String, last_active_ms: i64, summary: PastSessionSummary }`
  - `kriyon_core::history::PastSessionPage { items: Vec<PastSession>, total: usize }`
  - `kriyon_core::history::list_past_sessions_in_dir(dir: &std::path::Path, limit: usize) -> std::io::Result<PastSessionPage>`

- [ ] **Step 1: Add the glossary term (must precede the type name)**

In `CONTEXT.md`, add this entry near the **Session** / **Claude session id** entries:

```markdown
- **Past session** (`PastSession`) — a session discovered from a folder's
  on-disk Claude history (`~/.claude/projects/<encoded-cwd>/<id>.jsonl`) that
  Kriyon does not yet track. Carries the [Claude session id] (the file stem),
  a last-active time, and a summary (title, preview, cwd, branch). Ephemeral:
  shown in the sidebar's "Earlier sessions" group and never persisted until the
  user resumes it, at which point it becomes a normal [Session]. _Avoid_: old
  session, history entry.
```

- [ ] **Step 2: Add the `tempfile` dev-dependency to the core crate**

In `crates/kriyon-core/Cargo.toml`, add (create the section if absent):

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 3: Write the failing test**

Append to the `tests` module in `crates/kriyon-core/src/history.rs`:

```rust
use std::fs;

fn write_transcript(dir: &std::path::Path, name: &str, body: &str) {
    fs::write(dir.join(name), body).expect("write transcript");
}

#[test]
fn lists_past_sessions_newest_first_respecting_limit() {
    let dir = tempfile::tempdir().expect("tempdir");
    // Three transcripts plus a non-jsonl file that must be ignored.
    write_transcript(
        dir.path(),
        "aaaa.jsonl",
        "{\"type\":\"user\",\"cwd\":\"/w\",\"message\":{\"content\":\"oldest\"}}\n",
    );
    write_transcript(
        dir.path(),
        "bbbb.jsonl",
        "{\"type\":\"user\",\"cwd\":\"/w\",\"message\":{\"content\":\"middle\"}}\n{\"type\":\"ai-title\",\"aiTitle\":\"Middle\"}\n",
    );
    write_transcript(
        dir.path(),
        "cccc.jsonl",
        "{\"type\":\"user\",\"cwd\":\"/w\",\"message\":{\"content\":\"newest\"}}\n",
    );
    write_transcript(dir.path(), "notes.txt", "ignore me");

    // Force a strict mtime ordering: aaaa < bbbb < cccc.
    let base = std::time::SystemTime::now();
    set_mtime(dir.path(), "aaaa.jsonl", base - std::time::Duration::from_secs(30));
    set_mtime(dir.path(), "bbbb.jsonl", base - std::time::Duration::from_secs(20));
    set_mtime(dir.path(), "cccc.jsonl", base - std::time::Duration::from_secs(10));

    let page = list_past_sessions_in_dir(dir.path(), 2).expect("scan");
    assert_eq!(page.total, 3, "total counts all .jsonl files, ignoring notes.txt");
    assert_eq!(page.items.len(), 2, "limit honored");
    assert_eq!(page.items[0].claude_session_id, "cccc", "newest first");
    assert_eq!(page.items[0].summary.preview.as_deref(), Some("newest"));
    assert_eq!(page.items[1].claude_session_id, "bbbb");
    assert_eq!(page.items[1].summary.title.as_deref(), Some("Middle"));
}

#[test]
fn missing_dir_is_an_empty_page_not_an_error() {
    let page = list_past_sessions_in_dir(std::path::Path::new("/no/such/dir"), 10)
        .expect("missing dir must not error");
    assert_eq!(page.total, 0);
    assert!(page.items.is_empty());
}

/// Set a file's mtime via the `filetime`-free `fs::File::set_modified` API.
fn set_mtime(dir: &std::path::Path, name: &str, when: std::time::SystemTime) {
    let file = fs::File::options()
        .write(true)
        .open(dir.join(name))
        .expect("open for mtime");
    file.set_modified(when).expect("set mtime");
}
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cargo test -p kriyon-core history::tests::lists_past_sessions`
Expected: FAIL (`list_past_sessions_in_dir`/`PastSession` not found — does not compile).

- [ ] **Step 5: Implement the types and the scanner**

Add to `crates/kriyon-core/src/history.rs` (above the `tests` module). Add `use std::path::Path;` and `use std::time::UNIX_EPOCH;` to the file's `use` block:

```rust
/// One discovered [Past session]: filesystem-derived identity plus the
/// transcript-derived [`PastSessionSummary`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PastSession {
    /// Claude Code's own session id — the transcript file's name stem, and the
    /// argument to `claude --resume`.
    pub claude_session_id: String,
    /// File mtime in epoch milliseconds — when the session was last active.
    pub last_active_ms: i64,
    #[serde(flatten)]
    pub summary: PastSessionSummary,
}

/// A page of past sessions plus the total available, so the UI can offer
/// "Show more".
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PastSessionPage {
    pub items: Vec<PastSession>,
    pub total: usize,
}

/// Scan a Claude project directory for past-session transcripts: list `*.jsonl`
/// files, sort by mtime descending, take `limit`, and summarize each. `total`
/// is the count of all `*.jsonl` files in the directory.
///
/// A missing directory yields an empty page (the folder was never used with
/// `claude`), not an error.
///
/// # Errors
/// Returns the underlying [`std::io::Error`] only for a directory that exists
/// but cannot be read.
pub fn list_past_sessions_in_dir(dir: &Path, limit: usize) -> std::io::Result<PastSessionPage> {
    let read_dir = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PastSessionPage { items: Vec::new(), total: 0 });
        }
        Err(e) => return Err(e),
    };

    // (mtime, path, stem) for every .jsonl file.
    let mut files: Vec<(std::time::SystemTime, std::path::PathBuf, String)> = Vec::new();
    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else {
            continue;
        };
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(UNIX_EPOCH);
        files.push((mtime, path, stem));
    }

    let total = files.len();
    // Newest first.
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.truncate(limit);

    let items = files
        .into_iter()
        .map(|(mtime, path, stem)| {
            let contents = std::fs::read_to_string(&path).unwrap_or_default();
            let summary = parse_session_summary(contents.lines());
            PastSession {
                claude_session_id: stem,
                last_active_ms: system_time_to_millis(mtime),
                summary,
            }
        })
        .collect();

    Ok(PastSessionPage { items, total })
}

/// Convert a [`SystemTime`] to epoch milliseconds, clamping pre-epoch times to 0.
fn system_time_to_millis(time: std::time::SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test -p kriyon-core history::`
Expected: PASS (all history tests, including the two new scanner tests).

- [ ] **Step 7: Lint and commit**

```bash
cargo clippy -p kriyon-core --all-targets -- -D warnings
git add CONTEXT.md crates/kriyon-core/Cargo.toml crates/kriyon-core/src/history.rs
git commit -m "feat(core): scan a project dir into a page of past sessions"
```

---

### Task 4: Backend — `list_past_sessions` Tauri command + IPC bridge + TS types

**Files:**
- Modify: `src-tauri/src/hooks.rs` (add a `projects_dir` helper)
- Modify: `src-tauri/src/commands.rs` (add the command)
- Modify: `src-tauri/src/lib.rs` (register the command in `generate_handler!`)
- Modify: `src/types.ts` (add `PastSession`, `PastSessionPage`)
- Modify: `src/ipc/bridge.ts` (add `listPastSessions`)
- Modify: `src/ipc/bridge.test.ts` (add a test)

**Interfaces:**
- Consumes: `kriyon_core::history::{encode_project_dir, list_past_sessions_in_dir, PastSessionPage}` (Tasks 1, 3).
- Produces:
  - Tauri command `list_past_sessions(cwd: String, limit: usize) -> Result<PastSessionPage, String>`
  - TS `listPastSessions(cwd: string, limit: number): Promise<PastSessionPage>`
  - TS types `PastSession`, `PastSessionPage` mirroring the Rust structs.

- [ ] **Step 1: Add the `projects_dir` helper (Rust)**

In `src-tauri/src/hooks.rs`, alongside `events_dir`:

```rust
/// `~/.claude/projects` — where Claude Code writes one transcript directory per
/// project (folder), each holding that folder's session `*.jsonl` transcripts.
#[must_use]
pub fn projects_dir(home: &Path) -> PathBuf {
    home.join(".claude").join("projects")
}
```

- [ ] **Step 2: Write the failing IPC bridge test (TS)**

In `src/ipc/bridge.test.ts`, add a test mirroring the existing `invoke`-mock style used by the other command tests in that file (reuse the file's existing mock/setup):

```ts
it("listPastSessions forwards cwd and limit and returns the page", async () => {
  const page = {
    items: [
      {
        claudeSessionId: "abc",
        lastActiveMs: 1_700_000_000_000,
        title: "A title",
        preview: "first prompt",
        cwd: "/work/repo",
        gitBranch: "main",
        version: "2.1.181",
        messageCount: 12,
      },
    ],
    total: 3,
  };
  invokeMock.mockResolvedValueOnce(page);
  const result = await listPastSessions("/work/repo", 15);
  expect(invokeMock).toHaveBeenCalledWith("list_past_sessions", {
    cwd: "/work/repo",
    limit: 15,
  });
  expect(result).toEqual(page);
});
```

Add `listPastSessions` to the import from `./bridge.ts` at the top of the test file.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run src/ipc/bridge.test.ts`
Expected: FAIL (`listPastSessions` is not exported).

- [ ] **Step 4: Add the TS types**

In `src/types.ts`, after the `SessionRow` interface:

```ts
/**
 * A session discovered from a folder's on-disk Claude history that Kriyon does
 * not yet track (mirrors Rust `PastSession`). Ephemeral — never persisted until
 * the user resumes it. Fields are flattened from the Rust summary via serde.
 */
export interface PastSession {
  claudeSessionId: string;
  lastActiveMs: number;
  title: string | null;
  preview: string | null;
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  messageCount: number;
}

/** A page of past sessions plus the total available (mirrors `PastSessionPage`). */
export interface PastSessionPage {
  items: PastSession[];
  total: number;
}
```

- [ ] **Step 5: Add the bridge function**

In `src/ipc/bridge.ts`, add (near `listSessions`), and add `PastSessionPage` to the `types.ts` import:

```ts
export function listPastSessions(
  cwd: string,
  limit: number
): Promise<PastSessionPage> {
  return invoke("list_past_sessions", { cwd, limit });
}
```

- [ ] **Step 6: Run the bridge test to verify it passes**

Run: `pnpm vitest run src/ipc/bridge.test.ts`
Expected: PASS.

- [ ] **Step 7: Implement the Tauri command (Rust)**

In `src-tauri/src/commands.rs`, add (mirroring how `watch_transcript` resolves `home`):

```rust
/// List the folder's past Claude Code sessions, newest first, up to `limit`.
///
/// Resolves `~/.claude/projects/<encoded-cwd>/` (the encoding replaces every
/// non-alphanumeric character with `-`, which also prevents the frontend-
/// supplied `cwd` from traversing outside the projects directory) and scans it.
/// A folder Claude has never run in yields an empty page, not an error.
///
/// # Errors
/// Returns an error string if `HOME` cannot be resolved or the existing history
/// directory cannot be read.
// Signature is dictated by Tauri's command macro (by-value args).
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn list_past_sessions(
    app: tauri::AppHandle,
    cwd: String,
    limit: usize,
) -> Result<kriyon_core::history::PastSessionPage, String> {
    use tauri::Manager as _;

    let home = app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())
        .or_else(|_| {
            std::env::var("HOME")
                .map_err(|_| "cannot resolve HOME".to_string())
                .map(Into::into)
        })?;
    let dir = crate::hooks::projects_dir(&home).join(kriyon_core::history::encode_project_dir(&cwd));
    kriyon_core::history::list_past_sessions_in_dir(&dir, limit).map_err(|e| e.to_string())
}
```

- [ ] **Step 8: Register the command**

In `src-tauri/src/lib.rs`, add to the `tauri::generate_handler![ ... ]` list (after `commands::list_sessions,` or alongside the other `commands::` entries):

```rust
            commands::list_past_sessions,
```

- [ ] **Step 9: Verify the whole backend + frontend compiles and tests pass**

Run: `cargo build -p kriyon && pnpm vitest run src/ipc/bridge.test.ts`
Expected: the `kriyon` (Tauri) crate builds; bridge test PASS.

- [ ] **Step 10: Lint and commit**

```bash
cargo clippy --all-targets -- -D warnings
git add src-tauri/src/hooks.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src/types.ts src/ipc/bridge.ts src/ipc/bridge.test.ts
git commit -m "feat(ipc): add list_past_sessions command and bridge"
```

---

### Task 5: Frontend — `resumePastSession` action

**Files:**
- Modify: `src/state/actions.ts`
- Create: `src/state/actions.test.ts` (if absent; otherwise modify)

**Interfaces:**
- Consumes: `useSessions` store (`addProject`, `addSession`, `setActiveSession`), `idleSession`, `PastSession` type, `basename` (existing, local to `actions.ts`).
- Produces: `resumePastSession(past: PastSession): void`

- [ ] **Step 1: Write the failing test**

Create/modify `src/state/actions.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { PastSession } from "../types.ts";
import { resumePastSession } from "./actions.ts";
import { useSessions } from "./sessions.ts";

function pastSession(overrides: Partial<PastSession> = {}): PastSession {
  return {
    claudeSessionId: "claude-123",
    lastActiveMs: 1_700_000_000_000,
    title: "Refactor the parser",
    preview: "please refactor",
    cwd: "/work/repo",
    gitBranch: "main",
    version: "2.1.181",
    messageCount: 8,
    ...overrides,
  };
}

describe("resumePastSession", () => {
  beforeEach(() => {
    useSessions.setState({
      activeSessionId: null,
      projects: [],
      sessions: {},
    });
  });

  it("creates a session carrying the Claude id and activates it", () => {
    resumePastSession(pastSession());
    const state = useSessions.getState();

    expect(state.projects).toEqual([
      { color: null, id: "/work/repo", name: "repo", path: "/work/repo" },
    ]);
    const created = Object.values(state.sessions);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      claudeSessionId: "claude-123",
      cwd: "/work/repo",
      projectId: "/work/repo",
      title: "Refactor the parser",
      status: "idle",
    });
    expect(state.activeSessionId).toBe(created[0].id);
  });

  it("falls back to the cwd basename when the past session has no title", () => {
    resumePastSession(pastSession({ title: null }));
    const created = Object.values(useSessions.getState().sessions)[0];
    expect(created.title).toBe("repo");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/state/actions.test.ts`
Expected: FAIL (`resumePastSession` not exported).

- [ ] **Step 3: Implement the action**

In `src/state/actions.ts`, add `PastSession` to the `../types.ts` import and add:

```ts
/**
 * Resume a discovered past session into a live one. Ensures the folder is a
 * project, then creates a session row carrying Claude's own session id and
 * activates it — which makes the activation-launch effect in `App` run
 * `claude --resume <claude-id>`, restoring the terminal and Studio view. The
 * past session's `cwd` is trusted as its working directory (Claude wrote it).
 */
export function resumePastSession(past: PastSession): void {
  const state = useSessions.getState();
  const cwd = past.cwd ?? defaultCwd;
  const name = basename(cwd);
  state.addProject({ color: null, id: cwd, name, path: cwd });
  const id = crypto.randomUUID();
  state.addSession(
    idleSession({
      claudeSessionId: past.claudeSessionId,
      createdAt: Date.now(),
      cwd,
      id,
      projectId: cwd,
      title: past.title ?? name,
      worktreePath: null,
    })
  );
  state.setActiveSession(id);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/state/actions.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/state/actions.ts src/state/actions.test.ts
git commit -m "feat(state): resume a past session into a live session"
```

---

### Task 6: Frontend — sidebar "Earlier sessions" group (lazy fetch, dedup, show more, resume)

**Files:**
- Create: `src/sidebar/EarlierSessions.tsx`
- Create: `src/sidebar/EarlierSessions.test.tsx`
- Modify: `src/sidebar/Sidebar.tsx` (render `EarlierSessions` inside each `ProjectGroup`)

**Interfaces:**
- Consumes: `listPastSessions` (Task 4), `resumePastSession` (Task 5), `PastSession`/`PastSessionPage` types, `useSessions` store (for the dedup set), `tokens` from `src/theme/tokens.ts`.
- Produces: `EarlierSessions({ projectId, projectPath }: { projectId: string; projectPath: string })` React component.

Behavior: collapsed by default. Expanding triggers the first fetch (`limit = INITIAL_LIMIT`). Past sessions whose `claudeSessionId` matches a session Kriyon already tracks for this project are filtered out. "Show more" raises the limit and refetches. Clicking a row calls `resumePastSession`. Discovery state is local component state (ephemeral), never the Zustand store.

- [ ] **Step 1: Write the failing test**

Create `src/sidebar/EarlierSessions.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listPastSessions = vi.fn();
const resumePastSession = vi.fn();
vi.mock("../ipc/bridge.ts", () => ({ listPastSessions }));
vi.mock("../state/actions.ts", () => ({ resumePastSession }));

import { useSessions } from "../state/sessions.ts";
import { EarlierSessions } from "./EarlierSessions.tsx";

function page(items: unknown[], total: number) {
  return { items, total };
}

function past(id: string, title: string) {
  return {
    claudeSessionId: id,
    lastActiveMs: 1_700_000_000_000,
    title,
    preview: null,
    cwd: "/work/repo",
    gitBranch: "main",
    version: "2.1.181",
    messageCount: 4,
  };
}

describe("EarlierSessions", () => {
  beforeEach(() => {
    listPastSessions.mockReset();
    resumePastSession.mockReset();
    useSessions.setState({ sessions: {} });
  });
  afterEach(() => {
    // no-op; state reset in beforeEach
  });

  it("fetches lazily on expand, dedupes tracked sessions, and resumes on click", async () => {
    // One of the two past sessions is already tracked by Kriyon and must be hidden.
    useSessions.setState({
      sessions: {
        live: {
          booting: false,
          claudeSessionId: "tracked",
          createdAt: 1,
          cwd: "/work/repo",
          id: "live",
          projectId: "/work/repo",
          status: "idle",
          summary: "",
          title: "Live",
          worktreePath: null,
        },
      },
    });
    listPastSessions.mockResolvedValueOnce(
      page([past("tracked", "Tracked"), past("fresh", "Fresh one")], 2)
    );

    render(<EarlierSessions projectId="/work/repo" projectPath="/work/repo" />);

    // Not fetched until expanded.
    expect(listPastSessions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /earlier sessions/i }));

    await waitFor(() => expect(listPastSessions).toHaveBeenCalledWith("/work/repo", 15));
    expect(await screen.findByText("Fresh one")).toBeInTheDocument();
    expect(screen.queryByText("Tracked")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Fresh one"));
    expect(resumePastSession).toHaveBeenCalledWith(
      expect.objectContaining({ claudeSessionId: "fresh" })
    );
  });

  it("raises the limit and refetches on Show more", async () => {
    listPastSessions
      .mockResolvedValueOnce(page([past("a", "A")], 30))
      .mockResolvedValueOnce(page([past("a", "A"), past("b", "B")], 30));

    render(<EarlierSessions projectId="/work/repo" projectPath="/work/repo" />);
    fireEvent.click(screen.getByRole("button", { name: /earlier sessions/i }));
    await screen.findByText("A");

    fireEvent.click(screen.getByRole("button", { name: /show more/i }));
    await waitFor(() =>
      expect(listPastSessions).toHaveBeenLastCalledWith("/work/repo", 45)
    );
    expect(await screen.findByText("B")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/sidebar/EarlierSessions.test.tsx`
Expected: FAIL (`EarlierSessions` does not exist).

- [ ] **Step 3: Implement the component**

Create `src/sidebar/EarlierSessions.tsx`. Pull colors/spacing from `tokens`; do not hardcode design values.

```tsx
import { type CSSProperties, useCallback, useMemo, useState } from "react";
import { listPastSessions } from "../ipc/bridge.ts";
import { resumePastSession } from "../state/actions.ts";
import { useSessions } from "../state/sessions.ts";
import { tokens } from "../theme/tokens.ts";
import type { PastSession } from "../types.ts";

/** How many past sessions to load per page — "a few first, then Show more". */
const INITIAL_LIMIT = 15;
const PAGE_STEP = 30;

const toggleStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: tokens.color.ink.muted,
  cursor: "pointer",
  fontFamily: tokens.font.sans,
  fontSize: "11px",
  padding: "5px 8px",
  textAlign: "left",
  width: "100%",
};

const rowStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: tokens.color.ink.secondary,
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  fontFamily: tokens.font.sans,
  gap: "2px",
  padding: "5px 8px",
  textAlign: "left",
  width: "100%",
};

const titleStyle: CSSProperties = {
  fontSize: "13px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const metaStyle: CSSProperties = {
  color: tokens.color.ink.ghost,
  fontSize: "10px",
};

/** Title to show for a past session, with graceful fallbacks. */
function rowLabel(past: PastSession): string {
  if (past.title) {
    return past.title;
  }
  if (past.preview) {
    return past.preview;
  }
  const base = past.cwd?.split("/").filter(Boolean).pop() ?? "session";
  return `${base} — ${new Date(past.lastActiveMs).toLocaleDateString()}`;
}

export function EarlierSessions({
  projectId,
  projectPath,
}: {
  projectId: string;
  projectPath: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [limit, setLimit] = useState(INITIAL_LIMIT);
  const [page, setPage] = useState<{ items: PastSession[]; total: number }>({
    items: [],
    total: 0,
  });
  const [loading, setLoading] = useState(false);

  // Claude session ids Kriyon already tracks for this project — used to hide
  // past sessions that are already live or persisted.
  const sessions = useSessions((state) => state.sessions);
  const trackedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const session of Object.values(sessions)) {
      if (session.projectId === projectId && session.claudeSessionId) {
        ids.add(session.claudeSessionId);
      }
    }
    return ids;
  }, [sessions, projectId]);

  const fetchPage = useCallback(
    async (nextLimit: number) => {
      setLoading(true);
      try {
        const result = await listPastSessions(projectPath, nextLimit);
        setPage(result);
      } catch {
        // Discovery is best-effort; on failure show nothing rather than break
        // the sidebar.
        setPage({ items: [], total: 0 });
      } finally {
        setLoading(false);
      }
    },
    [projectPath]
  );

  const onToggle = useCallback(() => {
    setExpanded((wasExpanded) => {
      const next = !wasExpanded;
      if (next && page.items.length === 0) {
        void fetchPage(INITIAL_LIMIT);
      }
      return next;
    });
  }, [fetchPage, page.items.length]);

  const onShowMore = useCallback(() => {
    const next = limit + PAGE_STEP;
    setLimit(next);
    void fetchPage(next);
  }, [fetchPage, limit]);

  const visible = page.items.filter(
    (item) => !trackedIds.has(item.claudeSessionId)
  );

  return (
    <div data-testid="earlier-sessions">
      <button onClick={onToggle} style={toggleStyle} type="button">
        {expanded ? "▾" : "▸"} Earlier sessions
      </button>
      {expanded ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
          {visible.map((item) => (
            <button
              key={item.claudeSessionId}
              onClick={() => resumePastSession(item)}
              style={rowStyle}
              type="button"
            >
              <span style={titleStyle}>{rowLabel(item)}</span>
              <span style={metaStyle}>
                {new Date(item.lastActiveMs).toLocaleDateString()}
                {item.gitBranch ? ` · ⎇ ${item.gitBranch}` : ""}
              </span>
            </button>
          ))}
          {loading ? <span style={metaStyle}>Loading…</span> : null}
          {!loading && visible.length === 0 ? (
            <span style={metaStyle}>No earlier sessions</span>
          ) : null}
          {!loading && page.items.length < page.total ? (
            <button onClick={onShowMore} style={toggleStyle} type="button">
              Show more
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
```

> **Note on token names:** colors use the real `src/theme/tokens.ts` ramp (`color.ink.muted`, `color.ink.secondary`, `color.ink.ghost`, `font.sans`); font sizes and padding are literal px, matching the existing `Sidebar.tsx` style constants (which hardcode `fontSize`/`padding` px and pull only colors from tokens). Follow that established pattern.

- [ ] **Step 4: Run the component test to verify it passes**

Run: `pnpm vitest run src/sidebar/EarlierSessions.test.tsx`
Expected: PASS (both cases).

- [ ] **Step 5: Render it inside each project group**

In `src/sidebar/Sidebar.tsx`, import the component at the top:

```tsx
import { EarlierSessions } from "./EarlierSessions.tsx";
```

Then, inside `ProjectGroup`, immediately after the live-sessions `<div>` that maps `sessions` (i.e. after the closing `</div>` of the block starting at the `{sessions.map(...)}` container, still inside the outer `data-testid="project-group"` div), add:

```tsx
      <EarlierSessions projectId={project.id} projectPath={project.path} />
```

- [ ] **Step 6: Run the sidebar tests to verify nothing regressed**

Run: `pnpm vitest run src/sidebar`
Expected: PASS (existing sidebar tests + the new component test).

- [ ] **Step 7: Full check and commit**

```bash
pnpm fix
pnpm check
git add src/sidebar/EarlierSessions.tsx src/sidebar/EarlierSessions.test.tsx src/sidebar/Sidebar.tsx
git commit -m "feat(sidebar): show and resume a folder's earlier sessions"
```

---

### Task 7: Manual verification against the running app

**Files:** none (verification only).

- [ ] **Step 1: Build and run**

Run: `pnpm tauri dev`
Open a folder you have used with `claude` before (e.g. this repo — it has 70 transcripts).

- [ ] **Step 2: Verify discovery**

Expand "Earlier sessions" under the project. Expected: a list of past sessions, newest first, titled by their `ai-title` (or first prompt), each showing a date and branch. The currently-live session does not appear twice.

- [ ] **Step 3: Verify "Show more"**

Click "Show more". Expected: more rows load; the button disappears once all `total` sessions are shown.

- [ ] **Step 4: Verify resume**

Click a past session. Expected: a new session activates, the loading overlay shows, and `claude --resume` restores the conversation in both the terminal (Raw) and the Studio view, with no duplicated messages.

- [ ] **Step 5: Verify the empty case**

Open a brand-new folder with no Claude history. Expand "Earlier sessions". Expected: "No earlier sessions", no error.

---

## Self-Review

**Spec coverage:**
- Encoding rule → Task 1. ✓
- `parse_session_summary` (last ai-title wins, preview, cwd/branch/version, tolerant) → Task 2. ✓
- `list_past_sessions` command, sort-by-mtime-desc, limit, total, missing-dir-empty, ignore non-jsonl, traversal-safe → Tasks 3 (core scan + tests incl. missing dir, ignore non-jsonl, mtime order, limit/total) and 4 (command wrapper, traversal-safe via encoding). ✓
- `PastSession` not a `SessionRow`, ephemeral → Tasks 3/4 (distinct types), 6 (local component state). ✓
- Sidebar inline "Earlier sessions", lazy, load-a-few-first + Show more → Task 6. ✓
- Dedup by claudeSessionId → Task 6. ✓
- Resume reuses activation-launch, SAFE_CLAUDE_ID revalidation → Task 5 (action) + existing `launchClaudeOnce`. ✓
- Title fallback chain (title → preview → basename + date) → Task 6 `rowLabel`; resume title fallback → Task 5. ✓
- Glossary obligation for `PastSession` → Task 3 Step 1. ✓
- Error handling (missing dir, junk lines, pruned transcript, dedup of live) → Tasks 2/3 (tolerant parse, empty page), 6 (catch → empty), 7 (manual pruned-transcript via existing resume behavior). ✓
- Testing matrix from spec → Tasks 1–6 each lead with failing tests. ✓

**Placeholder scan:** No TBD/TODO. The one soft spot is `tokens` member names in Task 6 — flagged explicitly with an instruction to substitute real names from `src/theme/tokens.ts` (an inherent fact about an unread file, not an unspecified behavior).

**Type consistency:** `PastSession`/`PastSessionPage` field names (`claudeSessionId`, `lastActiveMs`, `title`, `preview`, `cwd`, `gitBranch`, `version`, `messageCount`, `items`, `total`) are identical across Rust (`#[serde(rename_all = "camelCase")]` + `flatten`), `types.ts`, the bridge test, and the component. `resumePastSession` signature matches its call site in Task 6. `list_past_sessions_in_dir(dir, limit)` and `encode_project_dir(cwd)` signatures match their callers in Task 4.
