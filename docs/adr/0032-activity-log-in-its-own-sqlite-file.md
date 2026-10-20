# ADR 0032 — The activity log lives in its own SQLite file, fed by the hook spool

**Date:** 2026-10-03
**Status:** Accepted

## Context

Kriyon's hook script appended every Claude Code hook event to
`~/.claude/kriyon/events/<id>.jsonl`. Nothing ever read those files past their
last 256 KiB, nothing deleted them (about 12 MB a day; 165 MB on one Mac after
two weeks), they held commands and tool output unredacted, and they were `0644`
under `0755` folders, so any other local account could read them.

The Activity tab needs those events kept, searchable by session and turn, and
bounded.

## Decision

- **Store:** a separate `activity.db` (rusqlite, `STRICT` tables, WAL,
  incremental auto-vacuum, `secure_delete = FAST`) next to `kriyon.db`. Separate,
  because auto-vacuum must be chosen before the first table, heavy churn stays
  away from config data, and "delete all" is cheap.
- **Feed:** the hook keeps writing JSONL — now a short-lived *spool*. Hooks run
  synchronously and in parallel; writing SQLite from them would make Claude wait
  on a lock. The app reads each spool from a saved position and applies the new
  lines in one transaction that also saves the new position, so a crash never
  loses or doubles a line. Steps merge by `tool_use_id`, turns by `prompt_id`.
- **Cleanup:** a spool is deleted once fully read, quiet for an hour, and its
  session has no live process. Never truncated in place. The tailer that drives
  live status now starts over when its file is replaced.
- **Status after cleanup:** the store keeps each session's last 600 spool lines,
  and the status seed replays those when the spool is gone, so a resumed session
  starts from its last known state.
- **Retention:** 30 days (Claude Code's own default) and 500 MB, oldest sessions
  first, never a live one. Checked 10 s after launch and every 6 hours.
- **Privacy:** folders `0700`, files `0600`; the hook redacts known secret shapes
  and caps every field before writing, and ingest redacts again. Plaintext,
  protected by file modes and FileVault — the same stance Claude Code takes for
  its transcripts. Encryption at rest would add a crypto dependency and protect
  nothing from a process running as the same user.
- **Not now:** full-text search (FTS5). The log is bounded per session and the
  tab filters by kind and flags; add it when a search box is built.

## Consequences

- The Activity tab works for every session, opened or not, with or without the
  companion.
- Deleting a session also deletes its activity, spool and usage snapshot.
- Redaction is best-effort; the UI says so.

## Amendment (2026-10-03): the companion's spool is ingested too

The [Bridge spool] (ADR-0034) was first read ad hoc by three commands, each
with its own tail size and its own ordering — one decided "is the companion
on?" in arrival order, against the mod's numbering. It is now ingested into
`activity.db` exactly like the hook spool (saved position, one transaction):

- `companion_runs` — one row per `claude` process (run), its conversation and
  version, and whether it ended. An end is final for its run whatever arrives
  after it; "on" means the conversation's newest run hasn't ended.
- `bridge_rows` — the rows the Structured view shows, ordered by run then the
  mod's number.
- `tool_checks` — each tool call's permission check, joined to its step when
  read, so "allowed by" lasts as long as the step (not as long as the spool).

Each app instance ingests and cleans up only the sessions in its own store; a
dev build beside the installed app never takes the other's spools.
