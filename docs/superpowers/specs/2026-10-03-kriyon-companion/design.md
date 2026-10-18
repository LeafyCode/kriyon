# Kriyon × Claude Code mods — research and plan

Status: proposal, not started. Date: 2026-10-03. Claude Code checked: v2.1.288.

Sources:
- Claude Code's public mod docs (https://code.claude.com/docs/en/plugins/mods/overview) and the 2.1.288 type file: the exact mod API.
- A map of Kriyon's current code (summarized in section 2).

---

## 1. Verdict per idea

| Idea | Possible? | Needs the mod? | How exact |
|---|---|---|---|
| Accurate session state | Yes | Mod for exact; hooks stay as fallback | Near-exact. Turns, tools, questions, permission prompts and background agents are all pushed as events. Two gaps: no event for *how* the user answered a permission dialog (inferred from the tool running or not), and no "idle" event (inferred from the turn completing). |
| Accurate usage | Yes | **Mostly no.** The status line Kriyon already reads has 5h/7d limits | Exact. The mod adds per-turn tokens and cost. |
| Audit log ("what did Claude do") | Yes | v1 works on hooks; the mod makes it complete | Every tool call, with full input, result, error flag, duration, subagent, and the permission verdict plus the rule that decided it. It links to the exact prompt and transcript row. |
| Structured view back | Yes, in a new and simpler form | Mod for the exact version | Prompt → final answer (`turn.complete.answer`, exact text) → collapsible "what Claude did". No transcript re-rendering. |
| One-click handoff to a new linked session | Yes | Mod for "Claude hands off by itself"; Kriyon owns opening the session | Exact. Claude calls a `kriyon_handoff` tool, and Kriyon opens a new session with the prompt and a "from <parent>" badge. |

"Perfect" is not on offer, for three reasons:
- The mod API is marked **early access**: it "may change between releases without notice".
- An organization can block mods.
- Event ordering is not documented.

So the rule is: **the mod is an accuracy upgrade, never a requirement.** Today's hooks, status-line and
transcript path stay as the fallback, which keeps the AGENTS.md loose-coupling rule.

---

## 2. What Kriyon has today (the parts that matter)

- **State:** hooks write `~/.claude/kriyon/events/<id>.jsonl`. A watcher tails it, `StatusTracker`
  folds it into a status, and the result goes out through `SessionRuntime` → `session-status`
  (ADR-0014, ADR-0027).
- **Usage:** the status-line wrapper → `kriyon-usage.py` → `usage/<id>.json`. The transcript sum is
  the fallback.
  - Known bugs: the transcript sum double-counts, because the same `message.usage` repeats on each
    content block.
  - It drops cache tokens.
  - The sidebar footer never shows `$`.
  - The 1000-event cap drops usage.
- **Status only for watched sessions:** status, usage and asks exist only for the active pane and
  the warm panes. A session not opened since launch has none.
- **Hook install:** on every launch, Kriyon writes its hooks into the global
  `~/.claude/settings.json` and replaces the user's `statusLine` with a wrapper.
  Kriyon does not yet disclose these writes, ask first, or offer an uninstall; this needs fixing,
  and the mod consent work should fix it in the same place.
- **Structured view:** removed by ADR-0019. The headless parser remains. ADR-0019 says bringing it
  back means reopening that ADR.
- **Handoff:** a "Spawn follow-up" dialog already exists.
  - It seeds a deterministic digest prompt and launches `claude "$p"` in a new session (ADR-0005).
  - What's missing: Claude-written handoff prompts still
    need copy-paste.
  - There is no parent link: a follow-up is "an ordinary Session", and the DB has no parent column.
- **Audit:** none. The hook events file is a partial raw log: tool, target ≤200 chars, duration.
  There are no inputs or outputs and no diffs. It is never pruned; 158 MB locally.
- **The seam for a mod:** a new source next to `HookSource` / `UsageSource` in `watcher.rs`, a new
  `WatchSignal` variant, routed via `watch_route.rs`, with facts on `SessionRuntime`.
- **Env pass-through:** ADR-0028 lets `CLAUDE_CODE_PLUGIN_DIRS` through at
  spawn. This plan depends on that fix.

---

## 3. Architecture: the "Kriyon Companion" mod

### 3.1 Shape

```
claude (in Kriyon's PTY)
  └─ kriyon-companion mod  ── $.http.fetch(socketPath) ──▶  kriyon-ptyd (per session, already exists)
       read-only observer                                     appends ~/.claude/kriyon/bridge/<id>.jsonl
       + 1 tool, 1 command                                    serves command queue back to the mod
                                                               │
Kriyon app ◀── existing Tailer/watcher (new BridgeSource) ─────┘
```

- **Why the ptyd and not the app:** the ptyd already lives exactly as long as the session and
  survives app crashes (ADR-0022). Events are never lost while the app restarts, and the app reuses
  the existing tail-a-JSONL machinery.
- **Socket path:** it must be ≤ ~100 bytes. Use `<run>/<id>.b` (shorter than the daemon's
  `<id>.sock`, so it fits whenever the daemon's socket does) and verify the length.
- **No direct file writes from the mod:** `$.fs.write` rewrites the whole file and has no append, so
  the ptyd writes the log.
- **Fire and forget:** every hook does `void $.http.fetch(...)` and then `return next(e)`. It never
  awaits on the hot path. Hooks have a 10 s budget, all mods share one worker thread, and a blocking
  mod is unloaded.
- **Gating:** the mod no-ops unless `KRIYON_SESSION` is set *and* the ptyd socket answers. Nested
  `claude -p` processes inherit the env var; they tag their events with their own session id, and
  the existing main-session lock filters them.

### 3.2 What the mod listens to (read-only, always `next(e)`)

| Purpose | Events / calls |
|---|---|
| Turns | `turn.start {text, turnId}`, `turn.complete {answer, durationMs, isAborted, usage, reason}`, `turn.step` |
| Tools | `tool.call` (wraps the whole call: input → result, `isError`, `isReadOnly`, `tool_use_id`, `agentId`) |
| Permission | `tool.check` → `decision` + `rule`; `classic.PermissionRequest` = dialog shown |
| Questions / plan | in-flight `tool.call` for `AskUserQuestion` / `ExitPlanMode` |
| Agents | `agent.spawn`, `$.agent.list()`, `background_tasks` on `classic.Stop` |
| Lifecycle | `session.start`, `session.end {reason, resume.id}` (`/clear` = end with reason `clear`), `session.compact` |
| Usage | `session.measure` (pushed after each turn and on each rate-limit point), `$.session.usage()` |
| Linking | `session.append` (row `uuid` = transcript uuid), `prompt_id` on classic events |
| Heartbeat | on start, plus `$.session.version()` |

### 3.3 What the mod adds (writes; each one is user-triggered)

- **Tool `kriyon_handoff({prompt, title, worktree?})`**, via `$.tool.register`. Claude calls it when
  you say "hand this off". The mod forwards it to Kriyon. Kriyon opens the new session.
- **Command `/handoff`**. It uses `$.model.fork({prompt})` to write the handoff over the session's
  own cached transcript, which is cheap, then forwards it as above.
- **Command channel from Kriyon** (e.g. "continue here": `$.command.run({command:'clear'})` then
  `$.prompt.submit`). It runs only on an explicit click in Kriyon.
  - **Spike needed:** the mod has no timers. Pick either long-polling the ptyd with
    `$.http.fetch`, or a helper process started with `$.process.spawn` whose stdout is the command
    stream.

### 3.4 Hard rules for the mod (written into its ADR and checked in CI)

- Never return a decision from `tool.check` / `tool.call`, never rewrite prompts or results, and
  never auto-approve.
- No network: only the local Unix socket.
- Store nothing outside `~/.claude/kriyon/`.
- **CI check on reach:** CI runs `claude plugin validate` and compares the reported events and API
  calls with a checked-in list. Any new reach fails the build until reviewed. The same list feeds the
  consent screen, so what users see is what the code does.
- `claude plugin test` headless tests sit in CI next to `pnpm check`.

---

## 4. Install and consent (transparent, user-controlled)

### 4.1 How it loads

- **Recommended:** Kriyon injects `CLAUDE_CODE_PLUGIN_DIRS=<companion dir>` into the env of
  *Kriyon's own* sessions only.
  - Nothing is written to the user's Claude settings, and plain `claude` outside Kriyon is
    untouched.
  - Claude lists it as `kriyon-companion@inline` in `/plugin`, so users can see it from Claude's
    side too.
  - If the user already sets `CLAUDE_CODE_PLUGIN_DIRS`, append to it, never replace (verify the list
    separator).
- **Files:**
  - The mod ships inside the app bundle.
  - On launch, Kriyon copies it to `~/.claude/kriyon/companion/<app-version>/` and checks a hash.
  - It is never a symlink: the code that runs must be the code that was reviewed. Community mods get
    this wrong.
  - It updates only with Kriyon itself, and release notes list companion changes.
- **Rejected:** installing it as a normal plugin through a marketplace. That writes to the user's
  global Claude config and would load in every `claude`, which goes against ADR-0024's "don't set CLI
  behaviour for the user". Keep it as a documented manual option for org users (see the blocked case
  below).

### 4.2 Preflight before every spawn (must have)

1. **Claude version** ≥ 2.1.287 (`claude --version`, cached). If lower: don't inject; show "Update
   Claude Code to enable the companion".
2. **Managed setting `disableSideloadFlags`** (read the macOS managed-settings file and MDM sources).
   If it is set, **don't inject**. With that setting on, Claude *exits at startup* when the env var
   is present. That would turn Kriyon into a broken launcher, so this check is not optional.
3. **After spawn:** no heartbeat within ~5 s means the mod is blocked (`allowManagedModsOnly`,
   `disableAllHooks`, an untrusted workspace, or Anthropic's kill switch). Show it quietly as
   "Companion not active in this session" and stay on the fallback path.

### 4.3 Asking the user

**Recommendation: ask once, off until the user says yes.** Don't auto-install, even with a notice:

- The mod is unsandboxed. It sees every prompt and every tool output, and Anthropic's own docs say
  so.
- ADR-0024 already set the precedent: a Setting that changes CLI behaviour is off by default.
- Developers who notice something they didn't approve inside their agent lose trust in the app.

The flow:

1. **One-time card** after the first session ends, or from the Activity tab's empty state:
   - **Title:** "Turn on Kriyon Companion for Claude Code?"
   - **What you get:** exact status, plan limits, a full activity log, one-click handoff.
   - **What it sees:** your prompts, Claude's answers, every tool call and its output, and usage.
     This list is generated from the reach check in §3.4.
   - **Where data goes:** only to Kriyon on this Mac, over a local socket, stored in
     `~/.claude/kriyon/`. Never uploaded.
   - **What it never does:** approve or block tools, change prompts, or run anything on its own.
   - **How it loads:** only inside Kriyon sessions. Your Claude settings are not changed.
   - **Buttons:** [Turn on] [Not now] [View source]. "View source" opens the folder.
2. **Settings → "Claude Code integration"** (new section). It lists everything Kriyon adds to Claude:
   - Hooks in `~/.claude/settings.json`, with an on/off switch and a "Remove from Claude settings"
     button.
   - The status-line wrapper, showing the user's original command and offering "Restore original".
   - The companion mod: on/off and a status of Active, Blocked by organization, Claude too old, or Not
     responding.
   - Activity log retention: 7 / 30 / 90 days / forever, plus "Delete all logs".
3. **Per-session chip** in the session header, for example `◆ Companion`. Hovering it shows its
   status; clicking it opens the settings section.
4. **Existing hooks (debt):** fix the silent `settings.json` write at the same time. Add a first-run
   disclosure ("Kriyon added a hook to Claude Code so it can show status. [Details] [Remove]") and a
   real uninstall path.

---

## 5. Features

### 5.1 Usage: ship without the mod

- **Done by the status line:** it already sends `rate_limits.five_hour/seven_day.used_percentage` and
  `resets_at` (Pro/Max only, after the first reply). Extend `kriyon-usage.py` and `UsageSnapshot`,
  then show "5h: 42% · resets 3:10pm" in the sidebar footer and inspector.
- **Field meaning:** `context_window.total_input_tokens` means *current context*, including cache,
  not a lifetime total. The `UsageSnapshot` doc is right, but the "tokens" card label should say
  "in context".
- **Transcript fallback fixes:**
  - Dedupe by `message.id`.
  - Count cache tokens.
  - Let the footer use the live snapshots, so `$` shows.
- **Mod upgrade:** per-turn tokens and cost (`turn.complete.usage`, and the change in `cost.usd`),
  shown on each turn in the Conversation view (§5.4).
- **Sources to borrow from:**
  - quota-meter's honesty rules: no burn-rate guess until there's enough data, and "resets first"
    when the limit won't be hit.
  - A cold-cache badge: "warm 42m".

### 5.2 Exact state

- Add a `BridgeSource` and treat bridge facts as authoritative over hook inference while the
  heartbeat is alive. Hooks remain the fallback (same `SessionRuntime`, one fold).
- **Waiting, made exact:**
  - `tool.check` → `ask`, then `classic.PermissionRequest`, gives **Waiting · permission** with the
    exact tool and command, e.g. "Approve `npm install stripe`?".
  - An in-flight `AskUserQuestion` gives **Waiting · question** with the question text.
  - `ExitPlanMode` gives **Waiting · plan**.
  - The `tool.call` resolving clears it.
- **Done or not:** `turn.complete` plus no running agents in `$.agent.list()` means Done. This fixes
  ADR-0027's guesswork; `/loop` and cron still need checking.
- **Not a mod issue:** every session should get a backend watch at startup, not just mounted panes.
  That fixes "no status for sessions you haven't opened".
- **Optional and best-effort:** read Claude's own `~/.claude/sessions/<pid>.json` (status
  busy/idle). It is undocumented, but four community mods rely on it. Use it for sessions Kriyon
  didn't launch.

### 5.3 Activity log (the audit feature)

- **What a row is:** one row per tool call, grouped under the user prompt that caused it.
- **Row fields:**
  - time, duration
  - tool, plus a plain label: Read file / Searched / Fetched URL / Ran command / Edited file / Wrote
    file / Ran subagent / MCP call
  - target (path, command, URL)
  - result (exit code, output tail ≤ N KB)
  - error flag
  - which agent (main or a named subagent)
- **How it was allowed:** "you approved", "rule `Bash(npm *)`", "auto mode", or "read-only".
- **Highlights (computed in `kriyon-core`, pure and unit-tested):**
  - **Installed something:** `npm|pnpm|yarn|bun add/install`, `pip install`, `brew install`,
    `cargo add/install`, `go install`, `claude plugin install`, `claude mcp add`, `curl … | sh`.
  - **Destructive:** `rm -rf`, `git reset --hard`, `git push --force`, `git clean`, deleting files
    outside the project.
  - **Outside project:** a read or write outside the session's cwd or worktree.
  - **Network:** WebFetch/WebSearch/curl/wget, with the URLs listed.
  - **Secrets touched:** reads of `.env*`, `*.pem`, `~/.ssh`, `~/.aws`.
  - **"Said tests pass, ran none":** a borrowed idea; flag it when the final answer claims tests
    pass but no test command ran that turn.
- **UI:**
  - A new right-side **Activity** tab per session: a turn-grouped timeline, filters (writes /
    commands / network / installs / flagged), search, and **Export as Markdown**.
  - Clicking an edit opens that file in the Changes view.
  - A per-turn summary line: "Read 12 · Ran 4 · Edited 3 · Installed 1 ⚠".
- **Sources:**
  - v1 (no mod): extend `kriyon-hook.py` to keep `tool_input` and a truncated `tool_response` from
    `PostToolUse`. This works for every user, minus the permission verdict and some linking.
  - v2 (mod): exact `tool.call` data, the verdict and rule, `prompt_id` / `session.append` uuids,
    and aborted calls.
- **Storage:**
  - JSONL per session, written by the ptyd; Kriyon indexes it into SQLite for search.
  - Retention is a setting.
  - Prune the existing events files too: 158 MB today.
  - Redact known secret patterns in stored outputs.
  - It is local only.
- **Known limits (show these in the UI, don't hide them):**
  - Package installs are known only by command pattern.
  - Calls blocked by org-managed hooks are invisible.
  - How the user answered a dialog is inferred, not observed.

### 5.4 Structured view, reborn as a "Conversation" view

- Don't rebuild the 14-block transcript renderer that ADR-0019 removed. Build a much smaller view
  from exact events:
  - **You:** prompt text (`turn.start.text` / `UserPromptSubmit.prompt`).
  - **What Claude did:** collapsed by default, the §5.3 rows for that turn with the per-turn summary
    line.
  - **Claude:** the final answer as markdown (`turn.complete.answer`; without the mod,
    `Stop.last_assistant_message`).
  - Per-turn time, tokens and cost.
- **Why this can work where the old pane failed:**
  - There is no transcript parsing and no prompt-echo reconciliation.
  - Data arrives exact and once per turn.
  - It doesn't try to mirror the terminal; it summarizes it.
- **DOM weight:** virtualize the list and render collapsed turns lazily (this answers ADR-0019's
  WebKit concern).
- **Process:** this needs a new ADR that supersedes ADR-0019, plus a CONTEXT.md term
  ("Conversation view", "Turn record").

### 5.5 One-click handoff into a linked new session

- **Triggers:**
  - (a) Claude calls the `kriyon_handoff` tool, e.g. "write a handoff and continue in a new
    session".
  - (b) `/handoff` in the terminal.
  - (c) Kriyon's existing "Spawn follow-up", which now uses `$.model.fork` to write the prompt
    instead of the deterministic digest. The digest stays as the fallback.
- **Kriyon side:**
  - Reuse `spawnFollowUpSession` and the seed-prompt file. It is already a launch argument, never
    keystrokes (ADR-0005).
  - Show the prompt in the existing Spawn dialog for a one-click confirm. Add a setting to "open
    without asking".
- **Link:**
  - Add a `parent_session_id` column.
  - The new session's row shows `↓ from <parent title>`; clicking it jumps to the parent.
  - The parent shows "handed off → <child>".
  - The parent stays resumable.
  - Needs a CONTEXT.md term ("Handoff link") and an update to the "Follow-up session" entry, which
    currently says there is no parent pointer.
- **"Continue here" variant:**
  - `/clear` and then the prompt, in the same session, through the command channel.
  - Offer it only after the spike in §3.3 proves the channel works.
- **Better prompts:** a handoff should include "Decisions and why", "Gotchas", a tool ledger taken
  from the activity log (not from the model's memory), git/PR state, and any unfinished promises.

### 5.6 More ideas from the community (later, ranked)

1. Specific Needs-you text and one reminder: "Needs input: approve `npm install stripe`", repeated
   once after 5 minutes, with sound only when Kriyon isn't focused.
2. Answer Claude's questions from a native Kriyon card (Switchboard Notch does this). It needs the
   command channel. The answer is the user's choice, relayed, so it is not auto-approval.
3. Group the Changes view by turn: "this turn changed these files". Use `usage().startedAt` as the
   session's baseline time.
4. A Collision guard: warn when two Kriyon sessions edit the same file.
5. Presenting mode: hide `.env` values, tokens and `$` on screen across all sessions.
6. A cold-cache or resume-cost badge next to the handoff button.
7. Detect a crash mid-turn and draft (not send) a pick-up prompt.
8. A mods inventory: list the user's other installed mods with their validated reach, and flag
   unpinned or symlinked ones. This is a security feature no one else has.

---

## 6. Phases

| Phase | Scope | Needs mod |
|---|---|---|
| **0 — No-mod wins** | Integration settings section and disclosure/uninstall for existing hooks; 5h/7d limits from the status line; usage dedupe and cache fixes; watch all sessions at startup; events-file retention; Activity log v1 on hooks | No |
| **1 — Spike (time-boxed)** | A minimal companion in dev. Prove: env loading in Kriyon's PTY; preflight checks; ptyd socket round trip and path length; event order for ask, permission and complete; the `$.tool.register` handoff tool; a working command channel (long-poll vs spawn); mod panes and keys inside xterm.js. Output: an ADR "Kriyon Companion mod" | Yes |
| **2 — Companion + consent** | Ship the mod; consent card; settings status; per-session chip; the CI reach check; exact state; per-turn usage | Yes |
| **3 — Activity log v2 + Conversation view** | Exact audit rows, verdicts and links; the new Conversation view (an ADR superseding ADR-0019) | Yes (v1 fallback) |
| **4 — Linked handoff** | `kriyon_handoff` tool, `/handoff`, parent link and badge, an LLM-written handoff; then "continue here" | Yes |

Phase 0 is valuable on its own and lowers the risk of everything after it. Phase 1 decides whether
phases 2–4 are worth building on an early-access API.

## 7. Open questions to settle in the spike

- The list separator for `CLAUDE_CODE_PLUGIN_DIRS`, and whether appending to a user's value is safe.
- The exact macOS sources for `disableSideloadFlags` (file paths, MDM domain), or a safe preflight
  command.
- Whether a mod can keep a background loop, such as a pending `$.http.fetch` started in
  `session.start`, without being unloaded.
- Whether `$.command.run` accepts `resume` or `branch`.
- Whether `turn.step` / `turn.complete.usage` include subagent spend.
- The order of `tool.check(ask)` vs `classic.PermissionRequest` vs `tool.call` completion in
  practice.
- Whether the API changes between the Claude versions you test (2.1.287 → current). Pin a tested
  range.

---

## 8. Update (2026-10-03, round 3): decisions and corrections

- **Structured view.** It is exact only with the companion mod. The mod's `session.append` gives
  every stored row with its transcript uuid, numbered in order by the mod.
  - Without the mod it can only be close: there is no in-between text from hooks, and the
    transcript is a tree that changes on rewind.
  - Rule: the tab is enabled only while the companion is active. Older history is filled in from
    the transcript and labelled with a chip.
  - Raw thinking is never available, because the API hides it. Show "Thought for Ns".
  - The parser must follow `parentUuid`, not file order.
- **Hooks without touching settings.json.** Ship Kriyon's hooks inside the companion plugin, loaded
  per session through `CLAUDE_CODE_PLUGIN_DIRS`.
  - Writing to the global settings is then only a fallback when side-loading is blocked, and only
    with consent.
  - A welcome screen discloses this on first run. Cancel quits the app.
  - Spike: can a plugin supply `statusLine`? If not, the mod's `session.measure` covers usage.
- **Company policy detection.** Read all managed sources:
  - `managed-settings.json` and the `managed-settings.d/` folder
  - the MDM domain `com.anthropic.claudecode`, through CFPreferences
  - the cached `~/.claude/remote-settings.json`
  - a `policyHelper`, which counts as unknown, so don't inject

  The current hooks-off check, from ADR-0029, reads only the first. After launch, match the
  `disableSideloadFlags` exit message and stop injecting.
- **Mods off.** Detect per reason (version, preflight `claude plugin test`, heartbeat, a silent mod
  while hooks fire). Show one chip state and turn features off cleanly:
  - Structured view: off.
  - Exact state: falls back to hooks.
  - Usage: falls back to the status line and the transcript.
  - Activity log: keeps working from hooks.
  - Handoff: falls back to the digest.
- **Storage.** Keep SQLite (rusqlite, upgrade to 0.40.2).
  - A separate `activity.db`: WAL, incremental vacuum, FTS5 trigram search.
  - The hook keeps appending a JSONL spool (redacted, 0600 / 0700); the app ingests it in one
    transaction with a checkpoint.
  - Retention: 30 days plus a 500 MB cap; delete-all and per-session delete.
  - Fix now: event files are 0644 under 0755 folders, so other local accounts can read every logged
    command. They also grow about 12 MB a day with no cleanup.
- **CPU and memory.** Mods add nothing here; measure at the OS level.
  - Extend `memory.rs`: one `pidrusage` call gives footprint plus CPU time. Convert mach ticks with
    `mach_timebase_info` (Apple Silicon is about 42× off otherwise). Use two samples, keyed by
    (pid, start time).
  - Also count processes that detached from the session (same terminal device, then the
    `KRIYON_SESSION` env marker).
  - Show totals in one place.
- **Cost and terms.**
  - Free: hooks, the status line, mod events, `usage()`, `agent.list()`, `session.messages()`.
  - Uses the plan: `model.*`, `prompt.submit`, `session.compact`, `agent.spawn`. Each needs a fresh
    user click, so no "open without asking" and no auto "continue here".
  - The `kriyon_handoff` tool adds tokens to every request. Make it opt-in, or use `/handoff` only.
  - Naming: "Kriyon Companion"; never brand a feature "Claude Code".
  - Never touch credentials.
  - Review Anthropic's current terms before the mod features ship.
