# Session Resume: Correct Status + Loading Overlay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A resumed session no longer lingers in "working" state, and a loading overlay covers the terminal from launch until the resumed Claude is up and idle.

**Architecture:** The hook-events tailer seeks to end-of-file on (re)subscribe, so a resumed session ingests only *live* hook events — never a previous run's stale trailing `Running`. The first live `SessionStart` from the resumed Claude both fixes the status (→ Idle) and is emitted to the frontend as `session-ready`, which dismisses a per-session loading overlay. A `booting` flag in the store drives the overlay, with a 20s timeout fallback.

**Tech Stack:** Rust (Tauri v2 backend, `notify` watcher), TypeScript + React + Zustand (frontend), vitest (frontend tests), cargo test (Rust tests).

## Global Constraints

- Design values come from `src/theme/tokens.ts` — never hardcode colors/spacing/blur/z. Reuse existing keyframes in `src/App.css` (`kr-fade-up`, `kr-pulse`, `kr-shimmer`); `prefers-reduced-motion` is already handled globally there.
- The Rust↔JS IPC boundary is a trust boundary — payload structs are typed and `camelCase` via serde `rename_all`.
- The transcript parser/tailer must never hard-error — tolerant parsing only.
- Only the **hook-events** tailer seeks to EOF. The **transcript** tailer keeps offset 0 (Studio view still replays the full conversation; its stable-id dedup handles re-reads).
- Conventional commits, small and frequent. `pnpm check` must pass before every commit. Never hand-format — `pnpm fix` owns formatting.
- Run on the current branch `feat/session-activity`; never commit to `main`.

---

## File Structure

**Backend (Rust)**
- `src-tauri/src/watcher.rs` — add `Tailer::at_end`; `HookSource::new` uses it. (modify)
- `src-tauri/src/commands.rs` — emit `session-ready` on the live `SessionStart` hook; add `ReadyPayload`. (modify)

**Frontend (TypeScript/React)**
- `src/types.ts` — no change needed (SessionRow stays the persisted shape; `booting` lives only on `UiSession`).
- `src/state/sessions.ts` — add `booting` to `UiSession`, `markBooting`/`markReady` actions, clear `booting` in `applyStatus`, default in `idleSession`. (modify)
- `src/ipc/bridge.ts` — add `ReadyUpdate` + `onSessionReady`. (modify)
- `src/state/backendListeners.ts` — wire `onSessionReady` → `markReady`. (modify)
- `src/terminal/sessionHost.ts` — `launchClaudeOnce` returns `boolean`. (modify)
- `src/ui/SessionLoadingOverlay.tsx` — the overlay component. (create)
- `src/ui/SessionLoadingOverlay.test.tsx` — overlay tests. (create)
- `src/App.tsx` — mark booting on launch, 20s timeout, render overlay. (modify)

**Tests touched**
- `src-tauri/src/watcher.rs` (inline `#[cfg(test)]`) — `Tailer::at_end` + history-skip integration. (modify)
- `src/state/sessions.test.ts` — `booting` transitions; update `makeSession`. (modify)
- `src/terminal/sessionHost.test.ts` — `launchClaudeOnce` return value. (modify)

---

## Task 1: `Tailer::at_end` (skip pre-existing file content)

**Files:**
- Modify: `src-tauri/src/watcher.rs` (add method on `Tailer`, ~after line 49; tests in the `#[cfg(test)]` module ~line 627)
- Test: `src-tauri/src/watcher.rs` (inline)

**Interfaces:**
- Produces: `Tailer::at_end(path: PathBuf) -> Tailer` — a tailer whose `offset` starts at the current file size (0 if the file is absent), so `poll`/`poll_lines` return only content appended after construction.

- [ ] **Step 1: Write the failing tests**

Add to the `mod tests` block in `src-tauri/src/watcher.rs` (the `user_line` helper already exists there):

```rust
#[test]
fn at_end_reads_only_lines_appended_after_construction() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("e.jsonl");
    fs::write(&path, format!("{}\n", user_line("old"))).expect("seed history");

    let mut tailer = Tailer::at_end(path.clone());
    assert!(
        tailer.poll().is_empty(),
        "pre-existing lines must be skipped"
    );

    let mut f = fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("open append");
    f.write_all(format!("{}\n", user_line("new")).as_bytes())
        .expect("append");
    drop(f);

    assert_eq!(
        tailer.poll(),
        vec![StructuredEvent::Prompt {
            text: "new".to_string()
        }]
    );
}

#[test]
fn at_end_on_missing_file_starts_at_zero() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("missing.jsonl");
    let mut tailer = Tailer::at_end(path.clone());
    assert!(tailer.poll().is_empty(), "no file yet");
    fs::write(&path, format!("{}\n", user_line("first"))).expect("create");
    assert_eq!(
        tailer.poll(),
        vec![StructuredEvent::Prompt {
            text: "first".to_string()
        }]
    );
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml at_end`
Expected: FAIL — `no function or associated item named 'at_end' found for struct 'Tailer'`.

- [ ] **Step 3: Implement `Tailer::at_end`**

In `src-tauri/src/watcher.rs`, add this method inside `impl Tailer` (right after the existing `new`, before `path`):

```rust
    /// Create a tailer positioned at the current end of `path`, so only lines
    /// appended *after* construction are read. Used for the hook-events file on
    /// a (re)subscribe: historical lines describe a process that no longer
    /// exists and must not drive live status or activity. A missing file starts
    /// at offset 0 (it behaves exactly like [`Self::new`] until written).
    #[must_use]
    pub fn at_end(path: PathBuf) -> Self {
        let offset = std::fs::metadata(&path).map_or(0, |m| m.len());
        Self {
            path,
            offset,
            partial: String::new(),
        }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml at_end`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/watcher.rs
git commit -m "feat(watcher): add Tailer::at_end to skip pre-existing file content"
```

---

## Task 2: Hook source seeks to EOF on subscribe (don't replay history)

**Files:**
- Modify: `src-tauri/src/watcher.rs` — `HookSource::new` (line ~122-127)
- Test: `src-tauri/src/watcher.rs` (inline integration test)

**Interfaces:**
- Consumes: `Tailer::at_end` (Task 1), existing `spawn_session_watch` signature `(dirs, session_id, on_status, on_transcript, on_usage, on_activity, on_title, on_claude_id)`.
- Produces: behavior — `spawn_session_watch` delivers no `on_status` for hook lines already in the events file at subscribe time; it delivers `on_status` for lines appended afterward.

- [ ] **Step 1: Write the failing integration test**

Add to the `mod tests` block in `src-tauri/src/watcher.rs`:

```rust
/// On resume, the events file already holds a previous run's trailing line. The
/// watch must NOT replay it as status (that is the stale-"working" bug); only
/// events appended after subscribe count.
#[test]
fn hook_source_skips_history_then_streams_live() {
    let root = tempfile::tempdir().expect("tempdir");
    let events_dir = root.path().join("events");
    let usage_dir = root.path().join("usage");
    let tasks_dir = root.path().join("tasks");
    fs::create_dir_all(&events_dir).expect("mkdir events");

    // A previous run's trailing "Running" line, present before we subscribe.
    let events_file = events_dir.join("sess-1.jsonl");
    fs::write(&events_file, "{\"event\":\"UserPromptSubmit\"}\n").expect("seed history");

    let (status_tx, status_rx) = mpsc::channel();
    let dirs = WatchDirs {
        events: &events_dir,
        usage: &usage_dir,
        tasks: &tasks_dir,
    };
    let watcher = spawn_session_watch(
        &dirs,
        &SessionId("sess-1".to_string()),
        move |ev| {
            let _ = status_tx.send(ev);
        },
        |_| {},
        |_| {},
        |_| {},
        |_| {},
        |_| {},
    )
    .expect("spawn ok");

    // Give the initial drain a chance to (wrongly) deliver the historical line.
    std::thread::sleep(Duration::from_millis(250));
    assert!(
        status_rx.try_recv().is_err(),
        "historical hook lines must not be delivered as status"
    );

    // A live event appended after subscribe IS delivered.
    let mut f = fs::OpenOptions::new()
        .append(true)
        .open(&events_file)
        .expect("open append");
    f.write_all(b"{\"event\":\"Stop\"}\n").expect("append live");
    drop(f);

    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut got: Option<HookEvent> = None;
    while std::time::Instant::now() < deadline {
        if let Ok(ev) = status_rx.recv_timeout(Duration::from_millis(150)) {
            got = Some(ev);
            break;
        }
    }
    drop(watcher);

    assert_eq!(
        got.map(|e| e.event),
        Some("Stop".to_string()),
        "live events appended after subscribe must be delivered"
    );
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml hook_source_skips_history_then_streams_live`
Expected: FAIL — the assertion `historical hook lines must not be delivered` fails, because `HookSource::new` still uses `Tailer::new` (offset 0) and replays the seeded line.

- [ ] **Step 3: Switch `HookSource` to seek to EOF**

In `src-tauri/src/watcher.rs`, change `HookSource::new` (around line 122):

```rust
impl HookSource {
    fn new(path: PathBuf) -> Self {
        // Seek to EOF: a resume reopens an append-only events file that still
        // holds the previous run's lines. Those describe a process that no
        // longer exists, so they must not drive live status/activity. Only
        // events from the freshly (re)launched claude — appended after this —
        // count. The transcript tailer deliberately does NOT do this.
        Self {
            events: Tailer::at_end(path),
        }
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml hook_source_skips_history_then_streams_live`
Expected: PASS.

- [ ] **Step 5: Run the full watcher test module (no regressions)**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib watcher`
Expected: PASS. Note: `spawn_session_watch_streams_status_transcript_and_usage` and `spawn_session_watch_emits_activity_snapshots` write their events file *after* the watch starts, so EOF-seek does not affect them.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/watcher.rs
git commit -m "fix(watcher): seek hook tailer to EOF so resume ignores stale history"
```

---

## Task 3: Emit `session-ready` on the live `SessionStart` hook

**Files:**
- Modify: `src-tauri/src/commands.rs` — `watch_transcript` `on_status` closure (line ~212-216) and a new payload struct (near the other payload structs, ~line 312)

**Interfaces:**
- Consumes: existing `watch_transcript`, `tauri::Emitter` (already imported in the function).
- Produces: a Tauri event `session-ready` with payload `{ sessionId: string }`, fired once per live `SessionStart`.

- [ ] **Step 1: Add the payload struct**

In `src-tauri/src/commands.rs`, add alongside `ClaudeIdPayload` (after the `ClaudeIdPayload` struct, ~line 319):

```rust
/// Payload for the `session-ready` event: the (Kriyon) session id whose
/// (resumed or freshly started) Claude has fired its first live `SessionStart`
/// hook and is therefore up and idle. Drives dismissing the loading overlay.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadyPayload {
    session_id: String,
}
```

- [ ] **Step 2: Emit it from `on_status`**

In `watch_transcript`, replace the existing `on_status` closure (lines ~212-216):

```rust
    let app_status = app.clone();
    let id_status = id.clone();
    let on_status = move |event: kriyon_core::hooks::HookEvent| {
        crate::status_rt::note_hook_event(&app_status, &id_status, &event);
    };
```

with:

```rust
    let app_status = app.clone();
    let id_status = id.clone();
    let on_status = move |event: kriyon_core::hooks::HookEvent| {
        // The hook tailer seeks to EOF on subscribe, so any SessionStart seen
        // here is live: the (resumed) claude has booted and is idle. Signal the
        // frontend to dismiss the loading overlay.
        if event.event == "SessionStart" {
            let _ = app_status.emit(
                "session-ready",
                ReadyPayload {
                    session_id: id_status.0.clone(),
                },
            );
        }
        crate::status_rt::note_hook_event(&app_status, &id_status, &event);
    };
```

(`app_status`/`id_status` are already cloned and moved into this closure; we reuse them — the `emit` borrows `app_status` before `note_hook_event` does.)

- [ ] **Step 3: Build + clippy to verify it compiles cleanly**

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: PASS, no warnings.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(commands): emit session-ready on the live SessionStart hook"
```

> Verification note: this Tauri glue is exercised end-to-end in Task 8's manual check (restart the app and watch the overlay dismiss when Claude finishes resuming).

---

## Task 4: `booting` flag + `markBooting`/`markReady` in the store

**Files:**
- Modify: `src/state/sessions.ts` (UiSession ~line 14, idleSession ~line 31, SessionsState ~line 41, actions, applyStatus ~line 151)
- Test: `src/state/sessions.test.ts` (helper ~line 9, new tests)

**Interfaces:**
- Produces:
  - `UiSession.booting: boolean`
  - `markBooting(id: string): void` — sets `booting` true (no-op if already true / unknown id)
  - `markReady(id: string): void` — sets `booting` false (no-op if already false / unknown id)
  - `idleSession(row)` returns `booting: false`
  - `applyStatus` also clears `booting`

- [ ] **Step 1: Update the test helper and write failing tests**

In `src/state/sessions.test.ts`, add `booting: false` to `makeSession` (line ~9-21):

```ts
function makeSession(id: string, createdAt: number): UiSession {
  return {
    booting: false,
    claudeSessionId: null,
    createdAt,
    cwd: "",
    id,
    projectId: "default",
    status: "idle",
    summary: "",
    title: id,
    worktreePath: null,
  };
}
```

Then add these tests (anywhere after the `beforeEach`):

```ts
test("markBooting sets booting true; markReady clears it", () => {
  const s = useSessions.getState();
  s.addSession(makeSession("s1", 1));

  s.markBooting("s1");
  expect(useSessions.getState().sessions.s1?.booting).toBe(true);

  s.markReady("s1");
  expect(useSessions.getState().sessions.s1?.booting).toBe(false);
});

test("markBooting / markReady ignore unknown sessions", () => {
  const s = useSessions.getState();
  s.markBooting("ghost");
  s.markReady("ghost");
  expect(useSessions.getState().sessions.ghost).toBeUndefined();
});

test("applyStatus clears booting (a live status means claude is up)", () => {
  const s = useSessions.getState();
  s.addSession(makeSession("s1", 1));
  s.markBooting("s1");

  s.applyStatus("s1", "running", "Working…");
  expect(useSessions.getState().sessions.s1?.booting).toBe(false);
  expect(useSessions.getState().sessions.s1?.status).toBe("running");
});

test("idleSession defaults booting to false", () => {
  const session = idleSession({
    claudeSessionId: null,
    createdAt: 1,
    cwd: "",
    id: "s1",
    projectId: "default",
    title: "s1",
    worktreePath: null,
  });
  expect(session.booting).toBe(false);
});
```

Add `idleSession` to the import at the top of the test file:

```ts
import { badgeCount, idleSession, type UiSession, useSessions } from "./sessions.ts";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/state/sessions.test.ts`
Expected: FAIL — `markBooting`/`markReady` are not functions; `booting` is `undefined`.

- [ ] **Step 3: Implement in `src/state/sessions.ts`**

(a) Add `booting` to the interface (line ~14):

```ts
export interface UiSession {
  /** True from launch until the (resumed) claude is up; drives the loading overlay. */
  booting: boolean;
  claudeSessionId: string | null;
  createdAt: number;
  cwd: string;
  id: string;
  projectId: string;
  status: SessionStatus;
  summary: string;
  title: string;
  worktreePath: string | null;
}
```

(b) Default it in `idleSession` (line ~31):

```ts
export function idleSession(row: SessionRow): UiSession {
  return { ...row, booting: false, status: "idle", summary: "" };
}
```

(c) Declare the actions in `SessionsState` (alongside the other `apply*`/`mark*` members, keep alphabetical-ish ordering near the existing ones):

```ts
  markBooting: (id: string) => void;
  markReady: (id: string) => void;
```

(d) Add the action implementations (next to `applyClaudeId` in the store body):

```ts
  markBooting: (id) =>
    set((state) => {
      const session = state.sessions[id];
      if (!session || session.booting) {
        return state;
      }
      return {
        sessions: { ...state.sessions, [id]: { ...session, booting: true } },
      };
    }),

  markReady: (id) =>
    set((state) => {
      const session = state.sessions[id];
      if (!session || !session.booting) {
        return state;
      }
      return {
        sessions: { ...state.sessions, [id]: { ...session, booting: false } },
      };
    }),
```

(e) Clear `booting` in `applyStatus` — change the returned session object (line ~165-169):

```ts
      return {
        processing,
        sessions: {
          ...state.sessions,
          [id]: { ...session, booting: false, status, summary },
        },
      };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/state/sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm persistence excludes `booting` (no code change)**

`src/state/persistence.ts` `persist()` builds the `upsertSession` payload from an explicit field list (no `booting`), so the flag is structurally excluded from the persisted `SessionRow`. Nothing to change — just confirm by reading lines ~80-92.

- [ ] **Step 6: Commit**

```bash
git add src/state/sessions.ts src/state/sessions.test.ts
git commit -m "feat(state): add booting flag with markBooting/markReady actions"
```

---

## Task 5: `onSessionReady` bridge + listener wiring

**Files:**
- Modify: `src/ipc/bridge.ts` (after `onSessionClaudeId`, ~line 183)
- Modify: `src/state/backendListeners.ts` (imports line ~1, `installSessionListeners` line ~54)

**Interfaces:**
- Consumes: `markReady` (Task 4).
- Produces: `ReadyUpdate { sessionId: string }`; `onSessionReady(cb): Promise<() => void>` subscribing to the `session-ready` event; a listener entry mapping it to `markReady`.

- [ ] **Step 1: Add the bridge subscription**

In `src/ipc/bridge.ts`, after `onSessionClaudeId` (line ~183):

```ts
/** A session-ready signal: the (resumed) Claude has booted and is idle. */
export interface ReadyUpdate {
  sessionId: string;
}

/**
 * Subscribe to backend `session-ready` events, fired when the (resumed or
 * freshly started) Claude has emitted its first live `SessionStart` hook.
 * Returns a promise resolving to an unlisten function.
 */
export function onSessionReady(
  cb: (u: ReadyUpdate) => void
): Promise<() => void> {
  if (!hasTauri()) {
    return Promise.resolve(() => {
      // No Tauri runtime (browser QA): nothing to unlisten.
    });
  }
  return listen<ReadyUpdate>("session-ready", (event) => cb(event.payload));
}
```

- [ ] **Step 2: Wire the listener**

In `src/state/backendListeners.ts`, add `onSessionReady` to the import block (line ~1-7):

```ts
import {
  onSessionActivity,
  onSessionClaudeId,
  onSessionReady,
  onSessionStatus,
  onSessionTitle,
  onSessionUsage,
} from "../ipc/bridge.ts";
```

Then add an entry to the `stops` array in `installSessionListeners` (after the `onSessionClaudeId` entry, ~line 72-75):

```ts
    installBackendListener({
      subscribe: onSessionReady,
      apply: (state, u) => state.markReady(u.sessionId),
    }),
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS (no type errors). This confirms the new `onSessionReady`/`ReadyUpdate` line up with `markReady`.

- [ ] **Step 4: Commit**

```bash
git add src/ipc/bridge.ts src/state/backendListeners.ts
git commit -m "feat(ipc): subscribe to session-ready and clear booting on it"
```

---

## Task 6: `launchClaudeOnce` returns whether it launched

**Files:**
- Modify: `src/terminal/sessionHost.ts` (signature + body, line ~110-130)
- Test: `src/terminal/sessionHost.test.ts`

**Interfaces:**
- Produces: `launchClaudeOnce(sessionId, claudeSessionId): boolean` — `true` only on the call that actually launches (first call for a live host), `false` otherwise (already launched, or no host).

- [ ] **Step 1: Write the failing test**

Add to `src/terminal/sessionHost.test.ts`:

```ts
test("launchClaudeOnce returns true on the launching call, false thereafter", async () => {
  ensureSession("ret1", "/work", noop);
  expect(launchClaudeOnce("ret1", null)).toBe(true);
  expect(launchClaudeOnce("ret1", "claude-abc")).toBe(false);
  await flush();
  disposeSession("ret1");
});

test("launchClaudeOnce returns false when there is no host", () => {
  expect(launchClaudeOnce("never-created", null)).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/terminal/sessionHost.test.ts`
Expected: FAIL — `launchClaudeOnce` currently returns `undefined`, so `.toBe(true)` fails.

- [ ] **Step 3: Change the signature and add returns**

In `src/terminal/sessionHost.ts`, update `launchClaudeOnce` (line ~110-130):

```ts
export function launchClaudeOnce(
  sessionId: string,
  claudeSessionId: string | null
): boolean {
  const host = hosts.get(sessionId);
  if (!host || host.launched) {
    return false;
  }
  host.launched = true;

  const resumable = claudeSessionId && SAFE_CLAUDE_ID.test(claudeSessionId);
  const command = resumable
    ? `KRIYON_SESSION=${sessionId} claude --resume ${claudeSessionId}\r`
    : `KRIYON_SESSION=${sessionId} claude\r`;

  host.ready
    .then(() => writeStdin(sessionId, new TextEncoder().encode(command)))
    .catch(() => {
      // Fire-and-forget: the shell queues input; a failed write is non-fatal.
    });

  return true;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/terminal/sessionHost.test.ts`
Expected: PASS (all existing tests plus the two new ones).

- [ ] **Step 5: Commit**

```bash
git add src/terminal/sessionHost.ts src/terminal/sessionHost.test.ts
git commit -m "feat(terminal): launchClaudeOnce returns whether it launched"
```

---

## Task 7: `SessionLoadingOverlay` component

**Files:**
- Create: `src/ui/SessionLoadingOverlay.tsx`
- Test: `src/ui/SessionLoadingOverlay.test.tsx`

**Interfaces:**
- Produces: `SessionLoadingOverlay({ resuming }: { resuming: boolean })` — an absolutely-positioned (`inset: 0`) overlay with `data-testid="session-loading-overlay"`. Copy is "Resuming session…" when `resuming`, else "Starting Claude…". The caller decides *whether* to render it (based on `session.booting`); the component only renders the visual.

- [ ] **Step 1: Write the failing test**

Create `src/ui/SessionLoadingOverlay.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { SessionLoadingOverlay } from "./SessionLoadingOverlay.tsx";

test("shows the resuming copy when resuming", () => {
  render(<SessionLoadingOverlay resuming={true} />);
  expect(screen.getByTestId("session-loading-overlay")).toBeInTheDocument();
  expect(screen.getByText("Resuming session…")).toBeInTheDocument();
});

test("shows the starting copy for a fresh launch", () => {
  render(<SessionLoadingOverlay resuming={false} />);
  expect(screen.getByText("Starting Claude…")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/ui/SessionLoadingOverlay.test.tsx`
Expected: FAIL — cannot resolve `./SessionLoadingOverlay.tsx` (module does not exist yet).

- [ ] **Step 3: Implement the component**

Create `src/ui/SessionLoadingOverlay.tsx` (reuses the `Thinking` shimmer/pulse idiom and `tokens`; overlay fill + blur are tokenized; z sits below modals/toast):

```tsx
import type { CSSProperties } from "react";
import { tokens } from "../theme/tokens.ts";

const overlayStyle: CSSProperties = {
  alignItems: "center",
  animation: "kr-fade-up 0.2s ease both",
  backdropFilter: tokens.blur.overlay,
  backgroundColor: tokens.color.glass.window,
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.md,
  inset: 0,
  justifyContent: "center",
  position: "absolute",
  WebkitBackdropFilter: tokens.blur.overlay,
  zIndex: tokens.z.sticky,
};

const glyphStyle: CSSProperties = {
  animation: "kr-pulse 1.4s ease-in-out infinite",
  color: tokens.color.accent,
  fontSize: "10px",
  lineHeight: 1,
};

// Travelling light-band over the label — the same "thinking" shimmer used in the
// Studio view, so the loading state reads as part of the same family.
const labelStyle: CSSProperties = {
  WebkitBackgroundClip: "text",
  animation: "kr-shimmer 2.2s linear infinite",
  backgroundClip: "text",
  backgroundImage: `linear-gradient(90deg, ${tokens.color.ink.dim} 0%, ${tokens.color.ink.bright} 50%, ${tokens.color.ink.dim} 100%)`,
  backgroundPosition: "200% center",
  backgroundSize: "200% auto",
  color: "transparent",
  fontFamily: tokens.font.sans,
  fontSize: "14px",
};

/**
 * Covers a session's content while the (resumed or freshly started) Claude
 * boots, until the backend's `session-ready` signal (or the App's timeout
 * fallback) clears `booting`. The caller renders this only while `booting`.
 */
export function SessionLoadingOverlay({ resuming }: { resuming: boolean }) {
  return (
    <div data-testid="session-loading-overlay" style={overlayStyle}>
      <span style={glyphStyle}>●</span>
      <span style={labelStyle}>
        {resuming ? "Resuming session…" : "Starting Claude…"}
      </span>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/ui/SessionLoadingOverlay.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/SessionLoadingOverlay.tsx src/ui/SessionLoadingOverlay.test.tsx
git commit -m "feat(ui): add SessionLoadingOverlay for the resume window"
```

---

## Task 8: Wire booting + timeout + overlay into App

**Files:**
- Modify: `src/App.tsx` (launch effect ~line 71-79, per-session wrapper ~line 96-123, imports)

**Interfaces:**
- Consumes: `markBooting` (Task 4), `launchClaudeOnce` returning `boolean` (Task 6), `SessionLoadingOverlay` (Task 7), `session.booting` (Task 4).
- Produces: the active session shows the overlay while `booting`; a 20s timeout force-clears `booting` so the overlay can never hang.

- [ ] **Step 1: Update imports**

In `src/App.tsx`, add the overlay import (near the other `./ui` import) and confirm `launchClaudeOnce` is already imported from `./terminal/sessionHost.ts` (it is):

```ts
import { SessionLoadingOverlay } from "./ui/SessionLoadingOverlay.tsx";
```

- [ ] **Step 2: Mark booting on launch, with a 20s timeout fallback**

Replace the launch-on-view effect (lines ~71-79):

```tsx
  // Launch (or resume) a session the first time it is viewed — including the one
  // active on startup, which is the session the user wants restored. Resuming
  // relies on its persisted Claude session id; a brand-new session has none and
  // starts fresh. `launchClaudeOnce` is idempotent per session.
  useEffect(() => {
    if (!activeSessionId) {
      return;
    }
    const { sessions: current, markBooting, markReady } =
      useSessions.getState();
    const session = current[activeSessionId];
    if (!session) {
      return;
    }
    const launched = launchClaudeOnce(activeSessionId, session.claudeSessionId);
    if (!launched) {
      return;
    }
    markBooting(activeSessionId);
    // Fallback: if the resumed claude never fires SessionStart (e.g. claude not
    // installed, or a version that doesn't hook it), the overlay must not hang.
    const id = activeSessionId;
    const timer = setTimeout(() => markReady(id), BOOT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [activeSessionId]);
```

Add the constant near the top of the file (after the imports, before `ignore`):

```tsx
/** Force-dismiss the loading overlay this long after launch if no ready signal arrives. */
const BOOT_TIMEOUT_MS = 20_000;
```

- [ ] **Step 3: Render the overlay in the per-session wrapper**

In the per-session `map` (lines ~95-124), make the outer wrapper `position: relative` and render the overlay while `booting`. Replace the wrapper `<div>` opening and add the overlay as its first child:

```tsx
            return (
              <div
                key={session.id}
                style={{
                  display: isActive ? "block" : "none",
                  height: "100%",
                  position: "relative",
                }}
              >
                {session.booting ? (
                  <SessionLoadingOverlay
                    resuming={session.claudeSessionId !== null}
                  />
                ) : null}
                <div
                  style={{
                    display: showRaw ? "block" : "none",
                    height: "100%",
                  }}
                >
                  <Terminal
                    active={isActive && showRaw}
                    cwd={session.cwd}
                    sessionId={session.id}
                  />
                </div>
                <div
                  style={{
                    display: showRaw ? "none" : "block",
                    height: "100%",
                  }}
                >
                  <StudioView sessionId={session.id} />
                </div>
              </div>
            );
```

- [ ] **Step 4: Typecheck + lint + full test suite**

Run: `pnpm check`
Expected: PASS — types compile, lint clean, all Rust + frontend tests green.

- [ ] **Step 5: Manual end-to-end verification**

Run the app (`pnpm tauri dev`), start a session, let Claude reply once, then **quit and relaunch the app**. Confirm:
1. On relaunch the active session shows the **loading overlay** ("Resuming session…").
2. The sidebar dot is **idle/grey**, not a pulsing "working" dot, during the resume.
3. When Claude finishes restoring, the overlay **disappears** (driven by `session-ready`), and the conversation is visible in the terminal.
4. Start a brand-new session: the overlay shows "Starting Claude…" briefly, then clears.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx
git commit -m "feat(app): show loading overlay during the session resume window"
```

---

## Self-Review

**Spec coverage:**
- Seek hook tailer to EOF → Tasks 1-2. ✓
- Emit `session-ready` on live `SessionStart` → Task 3. ✓
- Transcript tailer unchanged (offset 0) → enforced by only touching `HookSource::new` in Task 2; called out in Global Constraints. ✓
- `booting` flag, transient, excluded from persistence → Task 4 (incl. Step 5 confirmation). ✓
- `markBooting`/`markReady`; `applyStatus` clears booting defensively → Task 4. ✓
- `launchClaudeOnce` returns boolean → Task 6. ✓
- `onSessionReady` bridge + listener → Task 5. ✓
- Overlay component reusing Thinking idiom + tokens, copy variants → Task 7. ✓
- App wiring: mark booting on launch, 20s timeout, render overlay per-session → Task 8. ✓
- Fresh-start vs resume copy; reduced-motion (global) → Task 7/8. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows the assertion and the run command with expected result.

**Type consistency:** `markBooting`/`markReady` (Task 4) match the listener `apply` and App calls (Tasks 5, 8). `ReadyUpdate.sessionId` (bridge, Task 5) ↔ `ReadyPayload { session_id }` with serde `rename_all = "camelCase"` (Task 3). `launchClaudeOnce` boolean return (Task 6) ↔ `if (!launched)` in App (Task 8). `SessionLoadingOverlay({ resuming })` (Task 7) ↔ `resuming={session.claudeSessionId !== null}` (Task 8). `Tailer::at_end` (Task 1) ↔ `HookSource::new` (Task 2).
