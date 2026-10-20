# Past-session discovery & resume — design

**Date:** 2026-06-18
**Status:** Accepted

## Problem

When the user opens a folder in Kriyon, they only ever see the sessions they
have already started *through Kriyon*. But Claude Code keeps every past session
for that folder on disk, whether or not Kriyon ever drove it. A user who has
worked in a folder with the `claude` CLI directly — or in an earlier Kriyon
install — has a real history they cannot reach. We should surface those past
sessions and let the user resume any of them.

## Root facts (verified against Claude Code 2.1.181, on disk)

- Claude stores every session for a folder as a JSONL transcript at
  `~/.claude/projects/<encoded-cwd>/<claude-session-id>.jsonl`. The file name
  stem **is** Claude's session id — exactly what `claude --resume <id>` needs.
  (This folder alone has 70 such files.)
- **Encoding rule:** the project directory name is the absolute cwd with every
  character that is not `[A-Za-z0-9]` replaced by `-`. Verified across paths
  containing dots (`.claude` → `-claude`), underscores (`Acme_iOS` →
  `Acme-iOS`), existing hyphens (preserved), and runs of consecutive
  specials (`/var/folders/__/` → `-var-folders----`). The encoding is
  deterministic **forward** (cwd → dir name); it is *lossy in reverse*, so we
  never reverse it.
- Everything we want to show is inside each transcript and read reliably:
  - `cwd` — the true working directory (read from the file, never decoded from
    the dir name).
  - `gitBranch` — the branch the session ran on.
  - `ai-title` — Claude's human title for the session; it is written and
    **updated through the session**, so the *last* one wins.
  - the first `user` message — a preview / title fallback.
  - `version` — the Claude Code version that wrote it.
- File mtime gives a reliable "last active" time; line count gives a rough size.
- A pruned transcript (`cleanupPeriodDays`) is a visible, recoverable case:
  `claude --resume` prints its own "No conversation found". (Same non-goal the
  resume spec already accepts.)

## Scope decisions (agreed)

- **Discovery scope:** only folders the user opens as a Kriyon project. No global
  scan of all of Claude's history. Discovery is on-demand, per folder.
- **Placement:** inline in the sidebar — a collapsed "Earlier sessions" group
  under each project. Load a few most-recent first; "Show more" loads the rest.
- **Resume model:** clicking a past session resumes it into a *live* session
  (creates a Kriyon session row + PTY and runs `claude --resume`). No read-only
  preview in v1.
- **Ephemeral until resumed:** a discovered past session is **not** written to
  the DB. Only on resume does it become a normal persisted `SessionRow`.
- **Dedup:** the list excludes any past session Kriyon already tracks for that
  folder (matched by Claude session id), so nothing shows twice.

## Design

### 1. Core: pure, testable discovery logic (`kriyon-core`)

Per the repo rule that pure logic lives in `kriyon-core`:

- `encode_project_dir(cwd: &str) -> String` — replace every non-`[A-Za-z0-9]`
  character with `-`. This is the single source of truth for locating a folder's
  history directory. It also **neutralizes path traversal**: slashes become
  dashes, so no frontend-supplied cwd can produce `..` or escape the projects
  directory.
- `parse_session_summary(lines: impl Iterator<Item = &str>) -> PastSessionSummary`
  — fold a transcript's lines into:
  - `title: Option<String>` — the **last** `ai-title` seen.
  - `preview: Option<String>` — the first `user` message, first line, trimmed.
  - `cwd: Option<String>`, `git_branch: Option<String>`, `version: Option<String>`
    — first value seen for each.
  - Tolerant of junk: unparseable or unknown lines are skipped, never error
    (same discipline as the Studio transcript parser).

`PastSessionSummary` holds only what the lines carry. The id, last-active time,
and message count come from the filesystem (next section), not the content.

### 2. Backend: the `list_past_sessions` command (`src-tauri`)

```
list_past_sessions(cwd: String, limit: usize) -> Result<PastSessionPage, String>
```

- Resolve `<home>/.claude/projects/<encode_project_dir(cwd)>/`.
- If the directory does not exist → return an empty page (folder never used with
  `claude`). Not an error.
- List `*.jsonl` entries, sort by mtime **descending**, take `limit`.
- For each, stream-parse the file into a `PastSession`:
  - `claudeSessionId` — the file name stem.
  - summary fields from `parse_session_summary`.
  - `lastActive` — file mtime (epoch millis).
  - `messageCount` — count of conversation lines (rough size signal).
- Return `PastSessionPage { items: Vec<PastSession>, total: usize }`, where
  `total` is the count of `*.jsonl` files in the directory, so the UI can show
  "Show N more".

`PastSession` is a new transport type (Rust + TS in `types.ts`). It is **not** a
`SessionRow`; it is ephemeral discovery data.

> **Glossary obligation:** before `PastSession` becomes a type name, add a
> **Past session** entry to `CONTEXT.md` (a session discovered from a folder's
> on-disk Claude history that Kriyon does not yet track; ephemeral until
> resumed). Per the repo rule, the term lands in `CONTEXT.md` first.

**Why stream-parse whole files, not head/tail tricks:** pagination bounds each
fetch to ~`limit` files; a full streaming line-parse of even a multi-MB JSONL is
milliseconds in Rust. Simpler beats clever (YAGNI). Optimize to a bounded
head+tail read only if profiling ever shows a need.

**Trust boundary:** `cwd` crosses IPC from the frontend. It is used only to
*encode* a directory name and *read* files beneath `~/.claude/projects`; it is
never executed and (per the encoding) cannot traverse outward.

### 3. Frontend: sidebar UX (`src/...`)

- Under each project, after its live sessions, a collapsed **"Earlier sessions"**
  group.
- The fetch is **lazy**: `list_past_sessions(folderPath, limit)` runs only when
  the group is expanded — no scan on startup, none for collapsed projects. First
  fetch uses `limit ≈ 15`; **"Show more"** raises the limit and refetches.
- **Dedup on the frontend:** build the set of `claudeSessionId`s Kriyon already
  tracks for that folder (live + persisted sessions whose `projectId` is the
  folder) and filter them out of the page. The frontend owns the session list,
  so the filter lives there; the backend stays ignorant of Kriyon's rows.
- Each row renders: `title` → else `preview` → else `cwd` basename + date; a
  relative "last active" time; a small branch chip when `gitBranch` is set.

### 4. Frontend: resume (reuses the existing path)

- A new `resumePastSession(past)` action:
  1. `addProject(folder)` (no-op if present),
  2. create a `UiSession`/`SessionRow` with `claudeSessionId = past.claudeSessionId`,
     `title = past.title ?? basename`, `cwd = past.cwd`, `projectId = folder path`,
  3. `setActiveSession(id)`.
- The existing **activation-launch** effect + `launchClaudeOnce` already run
  `KRIYON_SESSION=<id> claude --resume <claude-id>` when a session carrying a
  `claudeSessionId` first becomes active. The loading overlay and the
  dedupe-by-id Studio rendering already handle the restore. **No new launch or
  terminal code.**
- The persisted `claudeSessionId` is re-validated against the existing
  `SAFE_CLAUDE_ID` guard in `sessionHost.ts` before it reaches the shell command
  (it crossed the IPC/store boundary).

## Error handling

- Missing history dir → empty "Earlier sessions" group, no error surfaced.
- Unparseable / unknown transcript lines → skipped (parser never hard-errors).
- A past session with no `ai-title` and no user prompt → title falls back to the
  cwd basename plus its last-active date.
- Pruned transcript on resume → `claude --resume` prints "No conversation found"
  in the terminal; the user can start fresh. (Pre-flight existence check remains
  a non-goal, consistent with the resume spec.)
- A past session that is in fact the currently-live one → removed by dedup.

## Non-goals (v1)

- **Global history browser.** No surfacing of folders never opened in Kriyon.
- **Read-only transcript preview.** Clicking resumes into a live session.
- **Deleting / archiving past transcripts** from Kriyon.
- **Cross-machine / synced history.** Local `~/.claude/projects` only.

## Testing

- core `encode_project_dir`: table test over the verified cases — plain path,
  dots, underscores, existing hyphens, consecutive specials, leading slash.
- core `parse_session_summary`: last `ai-title` wins; preview from first user
  message; cwd/branch/version captured; tolerant of junk and unknown lines;
  missing-title yields `None`.
- command `list_past_sessions`: sorts by mtime desc; respects `limit`; reports
  `total`; empty page for a missing dir; ignores non-`.jsonl` files; encoded
  path cannot escape the projects directory.
- frontend: dedup excludes known `claudeSessionId`s; "Show more" raises the
  limit and refetches; `resumePastSession` creates a row carrying
  `claudeSessionId` and activates it (so the existing resume launch fires).
