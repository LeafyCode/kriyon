# Session persistence & restoration — design

**Date:** 2026-06-17
**Status:** Accepted

## Problem

When Kriyon is closed and reopened, a session is only half-restored:

1. **Terminal does not restore.** A restored session opens a *plain shell* — by
   design today (`ui.ts`: restored sessions "must NOT relaunch"). The user loses
   the live `claude` conversation in the PTY.
2. **Studio view duplicates.** Reopening replays the transcript on top of state
   that the clear-on-remount hack does not reliably reset, so messages stack.
3. **Sidebar shows no real title.** The title is the cwd basename, set once at
   creation; it never reflects what the session is about.

## Root facts (verified against Claude Code 2.1.x)

- `claude --resume <id>` reloads the prior conversation and **appends to the same**
  `~/.claude/projects/<enc-cwd>/<id>.jsonl`. So resuming restores *both* the
  terminal and the Studio view, and keeps one canonical transcript per session.
- The `--session-id` bug (#20612) does **not** apply to resume: it only bit a
  *fresh externally-supplied* id. Resuming a **Claude-generated** id is reliable
  (ADR 0003 already learns that id from hook events).
- Resume must run **from the session's directory** (or a worktree of the same
  repo). Kriyon already spawns the PTY in the session's `cwd`, so this holds.
- Claude writes its session title into the transcript as
  `{"type":"ai-title","aiTitle":"…","sessionId":"…"}` and updates it as the
  session evolves. There is no separate summary file. (Present in 164 local
  projects → reliable.)
- Every transcript conversation line carries a stable `uuid`.

## Design

### 1. Persist Claude's session id

`SessionId` (Kriyon's launch UUID, names the hook/usage sidecar files) stays the
key for everything Kriyon owns. We additionally persist Claude's own id as the
**Claude session id** so the session can be resumed across restarts.

- Add `claude_session_id TEXT` (nullable) to the `sessions` table (migrated with
  `ALTER TABLE … ADD COLUMN`, ignoring "duplicate column" on existing DBs).
- `SessionRow` (Rust + TS) and `UiSession` gain `claudeSessionId`.
- The watcher already learns Claude's id from the first hook event carrying
  `session_id`. When it does, the backend emits a `session-claude-id`
  `{ sessionId, claudeSessionId }` event. The frontend stores it on the
  `UiSession`; the existing debounced persistence upserts it. No new write path.

### 2. Stable Studio-event ids + dedupe (kills duplication, makes resume safe)

Each emitted Studio event gets a stable id `"<line-uuid>:<block-index>"`.

- New transport type `StudioEvent { id, …StructuredEvent }` (serde `flatten`),
  produced by `transcript::parse_studio_events(line)`. `StructuredEvent` and
  `parse_line` are unchanged (the many parser tests stay green).
- The `watch_transcript` channel sends `StudioEvent`.
- The store dedupes by `id` (a per-session seen-set) and the Studio view keys on
  it. Re-tailing the same file from offset 0 — which is exactly what `--resume`
  causes — is now idempotent, regardless of remounts or double-subscribes.
- `clearEvents` on (re)mount stays as a cheap reset; dedupe is the correctness
  guarantee. The `StudioView` effect gains a cleanup that ignores a stale
  subscription's late events.

### 3. Session title from `ai-title`

- `transcript::parse_title(line)` extracts `aiTitle` from an `ai-title` line
  (returns `None` otherwise). `ai-title` stays out of the `StructuredEvent`
  stream (it is meta, not a conversation block).
- When the title changes, the backend emits `session-title`
  `{ sessionId, title }`. The frontend sets `UiSession.title`; persistence
  upserts it. The cwd basename remains the fallback until the first title lands.

### 4. Resume on first view (lazy)

Replace the `pendingAutostart` mechanism with **activation-launch**: a session
launches `claude` exactly once per run, the first time its view becomes the
active one — including the session that is active on startup (which is precisely
the one the user wants restored).

- `ensureSession` only creates the PTY (idempotent), no `claude` launch.
- `launchClaude(sessionId, plan)` writes the launch command once per run, chained
  on PTY readiness:
  - `claudeSessionId` present → `KRIYON_SESSION=<id> claude --resume <claude-id>`
  - otherwise → `KRIYON_SESSION=<id> claude` (new session)
- An effect watching `activeSessionId` resolves the plan from the `UiSession` and
  calls `launchClaude`. Freshly-created sessions (auto-activated on create) take
  the "new" path — so `pendingAutostart` / `markAutostart` / `consumeAutostart`
  are removed.

## Non-goals (v1)

- **Stale-transcript pre-check.** If a resumed transcript was pruned
  (`cleanupPeriodDays`), `claude --resume` prints its own "No conversation found"
  message in the terminal; the user can start fresh. A pre-flight existence check
  would need either a fragile re-derivation of Claude's path encoding or another
  persisted column, for a rare, visible, recoverable case. Deferred.
- **Manual rename.** Titles are auto (`ai-title`); no rename UI.

## Testing

- `parse_title`: extracts `aiTitle`; `None` for non-title lines; tolerant of junk.
- `parse_studio_events`: id is `uuid:index`; stable across calls; multi-block
  lines get distinct ids.
- store: round-trips `claude_session_id`; migration adds the column.
- watcher: emits a title and a claude-id from the right signals.
- store (Vitest): `appendEvent` dedupes by id; re-appending is a no-op.
- The exact production duplication trigger is confirmed by reproducing against
  the running app after the dedupe lands.
