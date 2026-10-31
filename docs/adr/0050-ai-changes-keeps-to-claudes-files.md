# ADR 0050 — AI changes keeps to Claude's files by default, from the Activity log

**Date:** 2026-10-31
**Status:** Accepted. Supersedes the default-off part of ADR 0015.

## Context

The Files view now has three scopes: **AI changes** (the [Session diff] — what changed since the
session started), **All changes** (everything uncommitted) and **Files**. People reading AI
changes expect to see what Claude did. But the session diff also holds every edit the user made
during the session, so their own work showed up as Claude's.

ADR 0015 already had a filter for this, **My edits only** (now **Only Claude's edits**), but kept
it off by default. The record behind it, `touchedFiles`, was not good enough to trust:

- it came only from the live activity stream's main-agent edit tools, so it missed subagents'
  edits and every file a Bash command changed;
- it lived only in memory, so a restart emptied it;
- under macOS's `/tmp` → `/private/tmp` firmlink the path comparison failed and every file
  vanished.

The [Activity log] has since started recording, in SQLite, every step of every session —
subagents included — with the target of each edit and write, and the files each command changed
(the hook keeps the first 20 per command).

## Decision

- **Source.** The Activity log owns the answer. On every refresh, the files it saw Claude change
  in the session (`activity_changed_paths`: finished edits and writes, plus each command's
  changed files) replace `touchedFiles` (`setTouchedFromActivity`). The live stream still adds
  edits as they happen (`touchedLive`): the log takes hook events in every few seconds, so a sync
  keeps a live edit it hasn't seen yet for `LIVE_TOUCH_GRACE_MS` (10 s). Past that the log's
  answer stands, so a failed or denied edit — which the log, counting only finished steps, never
  records — is dropped.
- **Unknown is not empty.** `sessionClaudeFiles` returns `null` while the answer can't be known —
  no repo toplevel yet, the log not answered yet, or recorded paths none of which match the repo
  (a symlinked project path) — and the filter stands down, so "can't tell" never reads as
  "Claude changed nothing".
- **Paths.** `relativizeTouchedPath` compares both sides through `canonicalDir`, the same
  firmlink rule `cwdRelativePath` uses, so `/tmp` sessions keep their files.
- **Default.** **Only Claude's edits** is on unless the user turns it off (`myEditsOnlyOf`). The
  AI changes list, its totals, its empty state and the header's file count all follow it. The
  user's own edits are under All changes.
- **The Inspector is unchanged.** It reviews the whole session, so it narrows only when the user
  turned the filter on explicitly.

## Consequences

- The attribution is per **file**, not per line. A file both Claude and the user edited shows
  under AI changes with both people's lines. The editor's session highlight marks changed lines
  but cannot say who typed them either.
- The hook records at most 20 changed files per command. A command that changes more (a
  formatter over the whole tree, a code generator) is attributed only those 20; the rest show
  under All changes, and under AI changes with the filter off.
- A change made outside any recorded step — a file watcher, a background process Claude started
  and left running — isn't attributed, so it shows only under All changes. With the filter off,
  AI changes shows everything since the session started, as before.
- If the Activity log is unavailable, attribution falls back to the live stream alone, as before.
