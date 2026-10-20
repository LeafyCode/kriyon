# Kriyon Companion — implementation plan

Spec: `docs/superpowers/specs/2026-10-03-kriyon-companion/design.md`. Its **section 8** is the
latest set of decisions and wins over the earlier sections. The research notes beside it hold the
detail (storage, CPU, accuracy and fallback). Mod API details come from Claude Code's public mod
docs (https://code.claude.com/docs/en/plugins/mods/overview). The mod API types are not
vendored here (they are Anthropic's); Claude Code writes them into any `CLAUDE_CODE_PLUGIN_DIRS`
folder at load, under `.claude-plugin/types/`.

Approved UI: design **A** (Activity tab in the side panel) and design **C** (Structured view with a
folded "What Claude did" under each reply).

## Spike results (2026-10-03, Claude Code 2.1.288)

- A folder named by `CLAUDE_CODE_PLUGIN_DIRS` loads in an interactive session and its
  `hooks/hooks.json` can hold **both** classic command hooks (`"hooks": {...}`) and a mod
  (`"modules": [...]`). `claude plugin validate` accepts the mix. The command hooks fired
  (`SessionStart`) and inherited the session env; the mod ran and `$.session.version()` answered.
- A plugin **cannot** supply `statusLine`: a `settings.json` in the plugin folder was ignored. A
  `--settings` flag can, but Kriyon types the launch command into a shell the user also uses, so a
  flag would miss hand-typed `claude`. Decision: the status-line wrapper stays a **global** write,
  shown and switchable on the welcome screen and in Settings, with a real restore. Without it,
  usage falls back to the mod's `session.measure` (when on) and the transcript sum.
- Claude Code writes `.claude-plugin/types/` into the plugin folder at load. The folder must stay
  writable and any integrity check must skip that subfolder.

## Shape

- **Companion folder** `~/.claude/kriyon/companion/<app-version>/`, written by Kriyon from files
  embedded in `kriyon-core` (like `HOOK_SCRIPT`). Plugin name `kriyon-companion`. It carries
  Kriyon's classic hooks always, and the mod module only when the user turned the mod on.
- **Spawn**: when the welcome consent is given and policy allows side-loading, `create_session`
  adds the folder to `CLAUDE_CODE_PLUGIN_DIRS` (appending to a user value with `:`), and Kriyon's
  hook entries are removed from `~/.claude/settings.json` so events are not doubled. When
  side-loading is blocked (or unknown), Kriyon falls back to the global hook write — only with
  consent.
- **Activity store** `activity.db` (rusqlite, WAL, STRICT) next to `kriyon.db`. FTS5 search was
  left out on purpose (YAGNI, ADR-0032): the tab filters by kind and flags; add it with a search box. The
  hook spool (`events/<id>.jsonl`) feeds it; ingest runs in one transaction with the spool cursor.

## Slices (each usable alone; one branch, one PR)

| # | Slice | Notes |
|---|---|---|
| 0 | Review inherited commits (e613295, 5e9adce, aeec722, 5ba9d9d) | Fix what the reviews find |
| 1 | Lock down + activity store | 0700/0600; hook redaction + caps; `activity.db`; ingest; 30 d + 500 MB pruning; delete all / per session; status seed from the store on resume |
| 2 | Welcome + integration settings | Companion folder; env injection; consent screen (Cancel quits); Settings → Claude Code integration with switches and restore |
| 3 | Company-policy detection | All managed sources; `policyHelper` = unknown; never inject under `disableSideloadFlags`; watch for its exit message; replaces ADR-0029's one-file read |
| 4 | Activity log (design A) | Turn-grouped steps, filter chips, flags, detail dialog, link edits to the Changes view |
| 5 | Companion mod | Opt-in, read-only; socket → ptyd → JSONL; heartbeat; one status chip |
| 6 | Structured view (design C) | Only while the companion is active; rows from `session.append`; backfill by `parentUuid`; ADR superseding 0019 |
| 7 | CPU + memory | `pidrusage` CPU time with `mach_timebase_info`; two samples keyed by (pid, start); detached processes; one total |
| 8 | Handoff integration | Detect `/…handoff…` and `*handoff*.md` writes from hooks; card; reuse `spawnFollowUpSession`; `parent_session_id` + badge; path validated in Rust |
| 9 | Legal copy | Disclaimer; site copy; "uses your own Claude plan"; ADR on credentials and the CLI; ask which LICENSE |

Hard rules: anything that spends the user's plan needs a fresh click labelled "uses your plan" (no
timers, no auto-continue); every mod-fed feature falls back without the mod; parsers never
hard-fail; pure logic in `kriyon-core`; IPC only through `src/ipc/bridge.ts`; design values only
from `src/theme/tokens.ts`.
