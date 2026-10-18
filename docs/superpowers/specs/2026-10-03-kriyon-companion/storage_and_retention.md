# Activity log: storage and retention

Researched 2026-10-03. Read-only; no repo code changed.

## Recommendation (TL;DR)

- **Engine: keep SQLite via rusqlite** (already a dependency). Put the activity log in a **separate file**, `activity.db`, next to `kriyon.db`. Use WAL, STRICT tables, FTS5 for search, and `auto_vacuum=INCREMENTAL`.
- **Keep the Python hook writing JSONL**, but treat it as a short-lived **spool**, not the archive. The app already tails it. Ingest it into SQLite, then **delete** the spool once the session has no live process and is fully ingested. Never truncate it in place.
- **Retention defaults:** 30 days (Claude Code's own default) plus a 500 MB size cap. Prune on startup and every 6 h. Never prune live sessions.
- **Lockdown:** dirs `0700` and files `0600`, matching Claude Code's own `~/.claude/projects`. Redact secrets in the hook before writing. Cap stored payloads. No SQLCipher; rely on FileVault, as Claude Code does.
- **"Delete all activity"** = close the connection and delete `activity.db*` plus the spool directory. Also offer a per-session delete.

## 1. Industry practice for local dev-tool logs

| Tool | What it keeps | Retention / pruning | Perms / encryption |
|---|---|---|---|
| Claude Code (`~/.claude/projects/<p>/<s>.jsonl`, tool-results, file-history, …) | Full transcript: every message, tool call and tool result | Age sweep by `cleanupPeriodDays`: **default 30, min 1, `0` rejected**. `history.jsonl` and `stats-cache.json` are kept until deleted. `claude purge <path>` [--dry-run] prints a plan, then deletes one project's data after confirmation. | Docs: "Transcripts and history are not encrypted at rest. OS file permissions are the only protection." Known token patterns are redacted only on `/feedback` upload. Local check: `~/.claude/projects` is `drwx------`; transcripts and `history.jsonl` are `-rw-------`. [claude-directory docs](https://code.claude.com/docs/en/claude-directory), [data-usage](https://code.claude.com/docs/en/data-usage) |
| VS Code | Per-launch log folders | `LogsDataCleaner` runs 10 s after start and keeps the **current + 9 newest** session folders. [source](https://github.com/microsoft/vscode/blob/main/src/vs/code/electron-utility/sharedProcess/contrib/logsDataCleaner.ts) | Plaintext; `state.vscdb` is SQLite (local file `0644`) |
| Cursor | VS Code fork; chat state in `state.vscdb` (SQLite) | Inherits VS Code log cleanup; no documented chat retention | Plaintext |
| JetBrains | `idea.log` | Size rotation: `idea.log.limit` **10 MB**, `idea.log.count` **12** files. [YouTrack IJPL-1770](https://youtrack.jetbrains.com/issue/IJPL-1770), [docs](https://www.jetbrains.com/help/idea/troubleshooting-materials.html) | Plaintext |
| GitHub Desktop | Daily log files | `MaxRetainedLogFiles = 14`; prunes the oldest. [source](https://github.com/desktop/desktop/blob/development/app/src/main-process/desktop-file-transport.ts) | Plaintext |
| Warp | Blocks/history/session restore in `warp.sqlite` (macOS: `~/Library/Group Containers/2BBY89MBSN.dev.warp/.../warp.sqlite`) | No age prune documented | Plaintext SQLite. [file locations](https://docs.warp.dev/terminal/settings/file-locations/) |
| zsh on macOS | `~/.zsh_history` | Count cap: `/etc/zshrc` sets `HISTSIZE=2000`, `SAVEHIST=1000` | Local file `0600`/`0700` |

**Takeaways**
- Bounded retention is normal. It is either **age-based** (Claude Code: 30 d), **count-based** (VS Code: 10 sessions; GitHub Desktop: 14 files; zsh: 1000 lines) or **size-based** (JetBrains: 10 MB × 12).
- Owner-only file modes are the baseline: Claude Code uses `0700`/`0600`.
- Encryption at rest is **not** standard for local dev tools. They all rely on FileVault plus file modes.
- Redaction is best-effort. Claude Code redacts only on upload. Warp's redaction "can't reliably catch every credential".
- The best "delete" UX: Claude Code's `claude purge` shows a plan, supports `--dry-run`, and asks to confirm.

**Kriyon-specific exposure (measured locally)**
- Home dir is `drwxr-x---` (group `staff`, which every local user is in).
- `~/.claude` and `~/.claude/kriyon/events` are `0755`. Event files are `0644`.
- So **other local accounts can read every logged command and tool result.** Claude Code's own transcripts in the same tree are `0600`.
- Size: 165 MB, 72,171 lines, 247 files, all from the last 13 days (about 12 MB/day).
  - PostToolUse lines are 120 MB of that. The `result` field alone is 77 MB.

**macOS encryption options, if ever wanted**
- rusqlite features `bundled-sqlcipher` or `bundled-sqlcipher-vendored-openssl`, with the key held in Keychain.
- Little real gain: any process running as the same user can ask for the Keychain item or read process memory. It also adds a crypto build dependency.
- Skip it. Document "plaintext, protected by file modes + FileVault", the same stance Claude Code takes.

## 2. Storage engine comparison (data pulled 2026-10-03 from crates.io / GitHub)

| Engine | Latest | Health | Fit for event log + search + small relational data |
|---|---|---|---|
| **SQLite / rusqlite** | rusqlite **0.40.2** (2026-08-08), libsqlite3-sys 0.38.2. Released 0.40.2 bundles SQLite **3.53.2**; master bundles **3.53.4**. Upstream SQLite latest is **3.53.4** (2026-07-24); 3.53.3/3.53.4 fix 3.53.0 regressions. Kriyon's lock has rusqlite 0.40.1 / libsqlite3-sys 0.38.1 (bundled 3.53.2). | rusqlite: MIT, 4.4k★, 171 open issues+PRs, active (push 2026-09-25), ~74 M recent downloads (libsqlite3-sys). SQLite itself: decades of maturity and testing. | **Best.** Transactions, WAL, STRICT, FTS5 compiled into `bundled` (`-DSQLITE_ENABLE_FTS5`, JSON1, RTREE in [build.rs](https://github.com/rusqlite/rusqlite/blob/v0.40.2/libsqlite3-sys/build.rs)), incremental vacuum. Already in the binary, so zero added size. |
| libSQL | crate 0.9.30 (0.10.0-pre.4, 2026-06-02) | Turso's README says the [Turso rewrite "replaces libSQL as our intended direction"](https://github.com/tursodatabase/turso). Effectively maintenance mode. | Fork of SQLite; adds nothing Kriyon needs (no sync/replication need) |
| Turso (ex-"Limbo"; `limbo` crate frozen at 0.0.22, 2025-06) | `turso` **0.8.1** stable / 0.8.2-pre.2 (2026-10-02) | Very active, 24.5k★, **1,073** open issues+PRs. README: "**we have not yet reached 1.0** … some features are explicitly marked experimental … keep independent backups". libSQL README still calls Turso "beta". | Promising (async, concurrent writes) but pre-1.0. Not conservative. |
| DuckDB (`duckdb` 1.10506.0, 2026-09-30) | Active, backed by DuckDB Labs | OLAP columnar engine. Poor at many tiny transactional inserts. Bundled build is tens of MB and slow to compile. | Overkill. Could read Parquet/JSONL ad hoc, but that's not needed. |
| redb (4.3.0, 2026-10-02) | Very clean issue tracker (3 open); README: "Stable and maintained", stable file format. **Mostly one maintainer** (cberner). | Pure-Rust ACID key-value store. No SQL, no FTS, no secondary indexes; you'd hand-roll them. |
| fjall (3.1.11, 2026-10-02) | Active, 41 open; small, mostly one maintainer | LSM key-value store, good for append-heavy writes, but no query layer or FTS |
| sled (0.34.7 stable from **2021**; 1.0.0-alpha.124) | Last push 2026-04. README: "**if reliability is your primary constraint, use SQLite. sled is beta**" | Reject. |
| LMDB / heed (0.22.1, 2026-04-07) | Meilisearch-backed, 51 open | Mature C engine (memory-mapped, fixed map size). Key-value only; FTS and pruning are DIY. |
| SurrealDB embedded (3.3.0, 2026-09-28) | Active, 698 open; **BSL 1.1** licence | Heavy dependency tree and big binary. Licence friction. Reject. |

**Verdict:** SQLite via rusqlite.
- It is the only option that is mature, already shipped in Kriyon, and gives relational queries, full-text search and transactions without extra code.
- Bump to **rusqlite 0.40.2** now. Pick up the next release when it bundles SQLite 3.53.4 (master has it) to get the 3.53.3/3.53.4 regression fixes.
- `rusqlite_migration` 2.6.0 (2026-05-28) is available, but a hand-rolled `PRAGMA user_version` ladder is enough (YAGNI).

## 3. What Kriyon does today

**Store (`kriyon.db`)**
- `src-tauri/src/lib.rs:296-300`: opens `kriyon.db` under `app_data_dir` = `~/Library/Application Support/com.leafycode.kriyon` (dir `0755`, db `0644`).
- `src-tauri/src/store.rs:140-158`: `Connection::open` with **no pragmas**.
  - Live DB reports `journal_mode=delete`, `auto_vacuum=0`, `user_version=0`.
- `store.rs:161-199`: schema is `projects`, `sessions`, `app_state`, `prompts`. No activity or usage tables.
- `store.rs:213-232`: migrations are `ALTER TABLE ADD COLUMN`, swallowing "duplicate column". No `user_version`.
- `store.rs:333-337`: `delete_session` deletes only the DB row. Its `events/<id>.jsonl` and `usage/<id>.json` are **orphaned**.
- **No pruning anywhere.**

**Hook (`crates/kriyon-core/scripts/kriyon-hook.py`)**
- `:38-39`: `result` capped at 4000 chars.
- `:41-46`: `target` capped at 200.
- `:86`: **`command` stored uncapped and unredacted**.
- `:110-113`: `os.makedirs` and `open(..., "a")` use the default umask, giving `0755`/`0644`. There is no rotation or redaction.

**Usage (`~/.claude/kriyon/kriyon-usage.py`)**
- Overwrites `usage/<id>.json` atomically (tmp + `os.replace`).
- **Keeps no history**, so "usage history" needs new storage.

**Watcher and seeding**
- `src-tauri/src/watcher.rs:37-115`: `Tailer` is offset-based.
  - **It does not handle a file shrinking or being replaced.** After a truncate, `offset > len` and it reads 0 bytes forever. A truncate-after-ingest design would silently stop live status.
- `watcher.rs:140-152`: `HookSource` seeks to EOF on subscribe.
- `watcher.rs:842-888`: creates `events/` and `usage/` and watches the directory with `notify`.
- `src-tauri/src/status_rt.rs:214-229`: the seed replays the last **256 KiB** of the events file.
  - That is the only historical read. Beyond the tail, the 165 MB is write-only today.

## 4. Proposed scheme

### 4.1 Files and modes

- `~/Library/Application Support/com.leafycode.kriyon/activity.db` (+ `-wal`, `-shm`)
  - Set the data dir to `0700` and the files to `0600`: set `umask(0o077)` before open, or `chmod` after.
- A separate DB from `kriyon.db` because:
  - `auto_vacuum` can only be chosen before the first table exists (otherwise a full `VACUUM` is needed).
  - Heavy churn stays away from small config data.
  - "Delete all activity" becomes a file delete.
  - Backups of `kriyon.db` stay small.
- `~/.claude/kriyon/` and `events/`, `usage/`, `run/`: `0700`. Spool files: `0600`.
  - The app chmods existing ones at startup.
  - The hook creates with `os.open(path, os.O_WRONLY|os.O_APPEND|os.O_CREAT, 0o600)` and `os.makedirs(base, mode=0o700)`.

### 4.2 Pragmas (run on every open)

```sql
PRAGMA journal_mode = WAL;          -- persistent; readers never block the writer
PRAGMA synchronous = NORMAL;        -- WAL-safe vs app crash; may lose last txn on power loss (fine: best-effort log)
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA journal_size_limit = 67108864;  -- cap WAL file at 64 MB after checkpoints
PRAGMA secure_delete = FAST;        -- zero freed content in-page so "delete" actually erases (cheap)
-- once, on a fresh file, before CREATE TABLE:
PRAGMA auto_vacuum = INCREMENTAL;
```

Schema version: `PRAGMA user_version` ladder (v1 = below).

### 4.3 Schema sketch (STRICT)

```sql
CREATE TABLE sessions (                 -- mirror of kriyon.db session id (no cross-db FK)
  id TEXT PRIMARY KEY,                  -- KRIYON_SESSION
  project_path TEXT, title TEXT,
  first_ms INTEGER NOT NULL, last_ms INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0     -- exempt from pruning
) STRICT;

CREATE TABLE turns (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  claude_session_id TEXT,
  started_ms INTEGER NOT NULL, ended_ms INTEGER,
  prompt_preview TEXT,                  -- redacted, <= 300 chars
  end_reason TEXT                       -- stop | stop_failure:<error> | interrupted
) STRICT;
CREATE INDEX turns_session ON turns(session_id, started_ms);

CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id INTEGER REFERENCES turns(id) ON DELETE CASCADE,
  tool_use_id TEXT UNIQUE,              -- pairs Pre/Post; makes ingest idempotent
  agent_id TEXT,                        -- subagent attribution
  tool_name TEXT NOT NULL,
  kind TEXT NOT NULL,                   -- read|edit|bash|web|agent|mcp|install|other
  target TEXT,                          -- path / command summary (redacted, <=200)
  input_json TEXT,                      -- redacted, capped (e.g. 2 KB)
  result_preview TEXT,                  -- redacted, capped (e.g. 1 KB; spool keeps 4 KB)
  status TEXT NOT NULL,                 -- running|ok|error
  started_ms INTEGER NOT NULL, ended_ms INTEGER, duration_ms INTEGER
) STRICT;
CREATE INDEX tool_calls_session ON tool_calls(session_id, started_ms);
CREATE INDEX tool_calls_started ON tool_calls(started_ms);   -- pruning

CREATE TABLE usage_samples (            -- only when values change, at most 1 per 10 s
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts_ms INTEGER NOT NULL, model TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, used_pct REAL,
  PRIMARY KEY (session_id, ts_ms)
) STRICT, WITHOUT ROWID;

CREATE TABLE state_changes (            -- working / needs-you / done / error history
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts_ms INTEGER NOT NULL, state TEXT NOT NULL,
  PRIMARY KEY (session_id, ts_ms, state)
) STRICT, WITHOUT ROWID;

CREATE TABLE ingest_cursor (            -- per spool file
  session_id TEXT PRIMARY KEY, dev INTEGER, ino INTEGER, offset INTEGER NOT NULL
) STRICT;

CREATE VIRTUAL TABLE tool_calls_fts USING fts5(
  target, input_json, result_preview,
  content='tool_calls', content_rowid='id', tokenize='trigram'   -- trigram: substring search on paths/commands
);
-- + standard AFTER INSERT/DELETE/UPDATE triggers to keep the FTS index in sync (needed so pruning removes index rows)
```

**Volume control**
- Do not store full results in the DB. Today's `result` field is 77 MB of 165 MB.
- A 1 KB preview plus FTS is enough. The full output stays in Claude's own transcript, which Claude Code prunes.

### 4.4 Ingest pipeline (hook stays JSONL)

**Why the hook should not write SQLite directly**
- Hooks are synchronous; PreToolUse blocks the tool.
- Parallel tool calls start concurrent Python processes. SQLite allows one writer, so lock waits would **block Claude**. The hook's contract is "Never blocks Claude" (`kriyon-hook.py:3`).
- Python's `sqlite3` uses whichever SQLite the system Python links. That means version skew, and schema migrations coupled to the deployed script version.
- An `O_APPEND` single `write()` of one line is effectively atomic on APFS. The Tailer already tolerates a torn last line (`watcher.rs:104-112`).

**Flow**
1. **Hook**
   - Redact first. Use an ordered regex list: `sk-ant-…`, `sk-…`, `ghp_/gho_/github_pat_`, `AKIA…`, `xox[bp]-`, `-----BEGIN … PRIVATE KEY-----`, `Bearer …`, `(?i)(password|secret|token|api[_-]?key)\s*[=:]\s*\S+`, and URL basic-auth `://user:pass@`.
   - Then cap `command` (currently uncapped).
   - Append with mode `0600`.
   - Redaction is best-effort; say so in the UI.
2. **App**
   - The existing `HookSource` poll already reads new lines.
   - Also hand them to an `ActivityIngest` that writes **one transaction per poll batch** and updates `ingest_cursor` (dev, ino, offset) in the same transaction. This gives exactly-once ingest after a crash, and `tool_use_id UNIQUE` + `INSERT … ON CONFLICT DO UPDATE` makes it idempotent.
   - Pure mapping (hook line → rows, kind classification, redaction) goes in `crates/kriyon-core`. SQLite I/O goes in `src-tauri`.
3. **Spool cleanup**
   - Delete `events/<id>.jsonl` and `usage/<id>.json` only when all of these hold:
     - (a) the cursor is at EOF;
     - (b) the session has no live process (same daemon check used by `daemon_rt.rs:395-402`);
     - (c) the file is idle for more than 1 h.
   - **Never truncate in place.** It races with concurrent appends, and `Tailer` can't recover from a shrink.
   - On resume, the hook recreates the file. Because seeding (`status_rt.rs:222`) then has no history, either seed status from `state_changes` or accept an empty seed for ended sessions. This is a decision to make.
4. **Usage history**: on each `UsageSource` change, insert a `usage_samples` row (deduped and rate-limited). No hook change needed.

### 4.5 Pruning job

Runs on a background thread at startup (after 10 s, like VS Code) and every 6 h.

```text
cutoff = now - retention_days (default 30, min 1, user-settable; mirrors cleanupPeriodDays)
loop: DELETE FROM sessions WHERE last_ms < cutoff AND pinned = 0 AND id NOT IN (live ids) LIMIT 500  -- cascades
      (needs a subquery/rowid form; rusqlite bundled lacks DELETE…LIMIT) — repeat until 0, short txns
size cap (default 500 MB): while (page_count - freelist_count) * page_size > cap:
      delete the oldest non-live, non-pinned session
PRAGMA incremental_vacuum(2000);       -- return freed pages, bounded work per run
PRAGMA wal_checkpoint(TRUNCATE);
PRAGMA optimize;                        -- cheap stats refresh (recommended on close / periodically)
INSERT INTO tool_calls_fts(tool_calls_fts) VALUES('optimize') -- weekly at most
```

Also sweep orphaned spool and usage files whose session no longer exists in `kriyon.db`. That fixes the `delete_session` leak (`store.rs:333`), and the `delete_session` command should do the same immediately.

### 4.6 Migrating the existing 165 MB of JSONL

Do this once, in the background, on the first launch with v1 of `activity.db`:
1. `chmod` the dirs to `0700` and the files to `0600`. This alone closes the `staff`-group read exposure.
2. For each `events/*.jsonl` whose mtime is within retention:
   - stream-parse with `kriyon_core::hooks::parse_hook_line`;
   - redact (old lines are unredacted);
   - insert in batched transactions.
   - Malformed lines are skipped, never fatal (AGENTS.md "never hard-error").
3. Record completion in `ingest_cursor`, then apply the §4.4 cleanup rule. Live sessions keep their spool; the cursor continues from EOF.
4. Older-than-retention files: delete without importing.

### 4.7 Tamper / lockdown stance

- Goal: **privacy from other local users**, using modes, FileVault, and plaintext like Claude Code.
- Not a goal: integrity against same-user processes. Anything running as the user can rewrite the DB or the hook script; hash chains or signing add nothing there.
- Consistent with "transcript-derived data is best-effort" (AGENTS.md). Record it as an ADR.

### 4.8 UX

**Settings → Activity**
- Retention days (default 30) and size cap (default 500 MB). Show current DB size.
- **"Delete all activity…"**: show a plan dialog with session count, size and paths. On confirm:
  - stop ingest;
  - close the connection;
  - delete `activity.db`, `-wal` and `-shm`, plus all spool files for non-live sessions;
  - reopen empty.
- Per-session "Delete activity" in the session context menu.
- Optional "Pause activity logging" toggle: the app skips ingest. The hook still spools for live status, and the spool is cleaned as above.

## Sources

- Claude Code application data, retention, plaintext, purge: https://code.claude.com/docs/en/claude-directory (fetched 2026-10-03); https://code.claude.com/docs/en/data-usage
- VS Code LogsDataCleaner: https://github.com/microsoft/vscode/blob/main/src/vs/code/electron-utility/sharedProcess/contrib/logsDataCleaner.ts
- GitHub Desktop log pruning: https://github.com/desktop/desktop/blob/development/app/src/main-process/desktop-file-transport.ts
- JetBrains log rotation: https://youtrack.jetbrains.com/issue/IJPL-1770 ; https://www.jetbrains.com/help/idea/troubleshooting-materials.html
- Warp storage: https://docs.warp.dev/terminal/settings/file-locations/
- SQLite releases: https://sqlite.org/changes.html (3.53.4, 2026-07-24)
- rusqlite bundled flags: https://github.com/rusqlite/rusqlite/blob/v0.40.2/libsqlite3-sys/build.rs ; crates.io API for all crate versions/dates
- Turso maturity statement: https://github.com/tursodatabase/turso (README FAQ) ; libSQL README: https://github.com/tursodatabase/libsql
- sled warning: https://github.com/spacejam/sled (README "known issues")
- redb status: https://github.com/cberner/redb (README)
- SurrealDB licence (BSL 1.1): https://github.com/surrealdb/surrealdb/blob/main/LICENSE
