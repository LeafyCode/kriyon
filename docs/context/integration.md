# Hooks, Companion and activity

How Claude Code tells Kriyon what it is doing: hooks, the Companion bridge and the activity log.

Part of the Kriyon glossary. The index and the naming rule are in [`CONTEXT.md`](../../CONTEXT.md).

- **Status** (`SessionStatus`) — `idle | running | waiting | done | error`, with a one-line
  progress summary alongside it. Derived only from Claude Code hook events; a session no hook has
  fired for yet reads `idle`.
- **Hooks off** (`HooksOff`) — a settings file (`disableAllHooks: true` after precedence, or
  managed `allowManagedHooksOnly`) stops Kriyon's hooks and status line for a [Session], so its
  [Status] and usage can't be known. Checked at each session start; the row says "Status
  unavailable" and the command center reads `unknown` instead of a guessed `idle` (ADR-0029).
- **Integration** (`integration`) — everything Kriyon adds to Claude Code: its hooks (by the
  [Hook route]), the [Status-line] wrapper, and the companion mod (on by default, ADR-0042). Nothing is written until
  the welcome screen's consent; Settings → "What Kriyon adds to Claude Code" switches each part
  and removes it all. _Avoid_: install, setup.
- **Integration prefs** (`IntegrationPrefs`) — the user's consent and switches for the
  [Integration], saved in `kriyon.db`, plus Kriyon's own sticky finding that the org refused the
  [Companion folder]. _Avoid_: hook settings.
- **Hook route** (`HookRoute`) — where Kriyon's hooks are installed: `plugin` (the [Companion
  folder], loaded only in Kriyon's sessions; the user's settings hold none), `settings`
  (`~/.claude/settings.json`, env-gated — the fallback when [Side-loading] is blocked or unknown),
  or `off`. _Avoid_: install mode.
- **Companion folder** — `~/.claude/kriyon/companion/<version>/`, the `kriyon-companion` plugin
  Kriyon writes and names in `CLAUDE_CODE_PLUGIN_DIRS` for its own sessions (appended to the
  user's value). Holds Kriyon's command hooks, and the companion mod once the user turns it on.
  Never a symlink; Claude Code writes `.claude-plugin/types/` into it at load. _Avoid_: plugin dir.
- **Kriyon Companion** (`kriyon-companion`, `companion.js`) — the read-only mod (on by default) in the
  [Companion folder]. It forwards what a session does (kept rows, turn starts and ends, which rule
  allowed a tool) to Kriyon over the [Companion bridge]. Never answers for a hook, changes,
  approves or blocks anything, registers a tool, or calls a model. _Avoid_: Claude plugin, bridge
  mod.
- **Companion bridge** — the per-session Unix socket (`<run>/<id>.b`, named to the mod in
  `KRIYON_BRIDGE_SOCKET`) the session's [PTY daemon] serves; each `POST` is one event, redacted and
  appended to the [Bridge spool]. The daemon outlives an app crash, so nothing is lost.
- **Owning claude** (`TerminalSeat::owns_session`, `KRIYON_TTY`) — the one `claude` whose hook
  events, status line and companion posts count for a [Session]: the process leading the
  foreground group of the session's PTY. A `claude` started from inside the session (a Bash
  command, a test script) inherits the session's env but not its terminal, so whatever it sends
  is dropped (ADR-0039). _Avoid_: main claude, outer claude.
- **Bridge spool** — `~/.claude/kriyon/bridge/<id>.jsonl`, one line per companion event, with
  the daemon's receive time. Ingested into the [Activity store] like the [Hook spool] (runs, rows
  for the [Structured view], permission checks), then cleaned up the same way. Nothing reads the
  file directly. _Avoid_: mod log.
- **Companion state** (`CompanionState`) — one session's companion, as its header chip shows it:
  `off | blocked | needsRestart | starting | on | silent`. `on` once the mod has spoken; `silent`
  when hooks fire but the mod never did (Claude Code too old, or mods off there). Every
  companion-fed feature falls back to hooks when it isn't `on`.
- **Hook spool** — the per-[Session] JSONL file (`~/.claude/kriyon/events/<id>.jsonl`) Kriyon's
  hook script appends one line to per Claude Code hook event. Short-lived input, not an archive:
  the app tails it for live [Status] and ingests it into the [Activity store]. Owner-only
  (`0600` files, `0700` folders), like Claude Code's own transcripts. _Avoid_: events log.
- **Activity log** — the per-[Session] record of what Claude did: one turn per prompt (grouped by
  Claude Code's `prompt_id`), each holding its [Activity step]s. Built from hooks, so it works
  without the companion; what it can't see (the rule that allowed a step, calls blocked by managed
  hooks) is said, not guessed. Kept in the [Activity store]. _Avoid_: audit log, history.
- **Activity step** (`ActivityStep`) — one tool call in the [Activity log]: kind, target, status,
  timing, which agent, [Step flags], and on demand its redacted input, a result preview and what
  allowed it. Merged by `tool_use_id`, so a start and its end make one step whatever order they
  land in. _Avoid_: event, row.
- **Step flags** (`activity_log::flags`) — the things about an [Activity step] worth a second
  look: installed something, deleted or rewrote history, used the internet, touched a file outside
  the project, touched a secret file. Known by command and path shape only. _Avoid_: warnings.
- **Activity store** (`ActivityStore`, `activity.db`) — the SQLite file the [Hook spool] is
  ingested into, one transaction per read together with the spool position. Keeps 30 days and at
  most 500 MB (oldest sessions go first, a live one never), plus the recent spool lines each
  session's status seed needs once its spool is cleaned up. _Avoid_: activity DB, log database.
- **Activity tab** (`ActivityTab`) — the [Details rail]'s second tab, beside "Details": the
  active [Session]'s [Activity log] as a turn-grouped timeline, newest first, with filter chips
  (All · Changes · Commands · Needs a look) and a [Step detail] dialog per step. Read-only;
  refreshed on `activity-changed`. Not the live [Session activity] section, which stays on the
  Details tab. _Avoid_: audit tab, history tab.
- **Step detail** (`StepDetailDialog`) — the dialog an [Activity step] opens: its full redacted
  input, result preview, what allowed it, timing and agent, plus "Open in Changes" for an edit.
- **Spool cursor** (`SpoolCursor`) — where ingest stopped in one [Hook spool]: device, inode and
  byte offset, saved in the same transaction as the lines it covers, so each line is applied once.
  A different inode or a shorter file means a new spool, read from its start.
- **Seed lines** — the last 600 [Hook spool] lines the [Activity store] keeps per session, so a
  resumed session's [Status] seed still has history once its spool is cleaned up.
- **Refusal watch** (`RefusalWatch`) — the scan of a session's PTY output for `claude` refusing
  the [Companion folder] at startup (managed `disableSideloadFlags`). The message must open a line;
  on a match Kriyon stops injecting the folder and moves its hooks to the settings route, until the
  user tries the plugin again in Settings.
- **Redaction** (`redact`) — best-effort removal of known secret shapes (API keys, tokens, private
  keys, `password=` values, URL passwords) from text Kriyon stores. Runs in the hook script before a
  line reaches the [Hook spool] and again at ingest; both halves share one case file. A secret in a
  shape it doesn't know is kept, and the UI says so. _Avoid_: masking, sanitizing.
- **Managed source** (`ManagedSource`, `ManagedSources`) — one place an organization delivers
  Claude Code's managed settings on macOS, ranked highest first: the server-managed cache
  (`~/.claude/remote-settings.json`), the MDM profile (`com.anthropic.claudecode` under
  `/Library/Managed Preferences`), and the file source (`managed-settings.json` merged with its
  `managed-settings.d/*.json` drop-ins). Each is absent, unreadable, or present.
- **Managed policy** (`ManagedPolicy`, `PolicyRead`) — the few managed keys Kriyon acts on, resolved
  across the [Managed source]s the way Claude Code does (first source with a policy key wins,
  unless `managedSourcesBehavior: "merge"`). The read is `Unknown` when a source exists but can't be
  read, or a `policyHelper` would compute the policy at launch. Feeds [Hooks off] and
  [Side-loading] (ADR-0031).
- **Side-loading** (`SideloadPolicy`) — loading a plugin folder that isn't installed, via
  `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS`. Managed `disableSideloadFlags` makes `claude` exit
  at startup when it sees one. `allowed | blocked | unknown`; callers treat `unknown` as `blocked`
  and never inject the companion folder.
- **Hook signal** (`HookSignal`) — what one Claude Code hook event *means*, decided once by
  `classify`: session started or ended, prompt submitted, a tool call (its phase, and whether the
  [Main agent] or a [Subagent] made it), a permission request, a classified notification, or the
  [Main turn] ending (with its [In-flight work]). Every fold — [Status], [Session activity], the
  [Pending ask], the [Main session lock] — matches on it rather than on raw event names, so a
  turn-end or subagent rule can't mean different things to different folds. _Avoid_: hook
  kind, event type.
