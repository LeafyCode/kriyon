# Structured-view accuracy, mods-off fallback, cost and terms

Date: 2026-10-03. Claude Code checked: 2.1.288 (installed here). Read-only research; nothing installed.

Shorthand:
- **DTS Lnnnn** = the `claude-code.d.ts` type file shipped in Claude Code 2.1.288, not in this repo (line numbers of the file as saved now, 15,845 lines). Public mod docs: https://code.claude.com/docs/en/plugins/mods/overview.
- **Docs** = `https://code.claude.com/docs/en/<page>` (fetched today as `.md`).
- **Local** = checked on this Mac (claude 2.1.288, no managed settings present).

---

## A. Structured view: can it be accurate?

### A.1 What each source gives

| Need | (1) Settings hooks only | (2) Mod events | (3) Transcript JSONL |
|---|---|---|---|
| User prompt | `UserPromptSubmit.prompt`, pastes expanded. **Also fires for `/loop`, scheduled tasks, background-subagent reports, cross-session messages** with no origin field, so "You:" can be wrong ([hooks#userpromptsubmit](https://code.claude.com/docs/en/hooks#userpromptsubmit)). Images: not in the hook. | `prompt.submit` gives `text` plus `origin.kind` (composer / task-notification / peer / plugin…) and `attachments` (image kind and MIME, no bytes) (DTS L8779-8810, L8960-8992). `session.append` door `prompt` gives the stored row, image blocks inline. | User row; `promptSource`/`origin` keys; image blocks as base64. |
| Intermediate assistant text (between tool calls) | **Only `MessageDisplay`**: every streamed assistant text message, in line batches, with `turn_id` and `message_id` (not joinable to transcript ids). Display-only; **Claude Code holds each batch until the hook returns** (10 s default), so a command hook adds visible typing lag in the terminal. Main thread only in practice; tool-only messages don't fire it ([hooks#messagedisplay](https://code.claude.com/docs/en/hooks#messagedisplay)). Nothing else in hooks gives it. | `session.append` fires **once per stored row, including each response block** (text, thinking, tool_use), with `uuid` = transcript uuid, `door`, `origin`, `agentId` (DTS L4227-4239, L10539-10612). `turn.step` result `answer` = visible text of each model request (DTS L13472-13500). | Assistant rows, one content block per row. |
| Tool calls | `PreToolUse` (input), `PostToolUse` (structured `tool_response`, `duration_ms`), `PostToolUseFailure`, `PostToolBatch` (serialized result as the model saw it). Parallel `PostToolUse` fire **concurrently** ([hooks#posttoolbatch](https://code.claude.com/docs/en/hooks#posttoolbatch)). | `tool.call` wraps the whole call, typed input + result + `isError`, `agentId`; `tool.check` verdict + rule (mod docs). | `tool_use` / `tool_result` blocks, `toolUseResult` structured record. |
| Final reply | `Stop.last_assistant_message`. **Stop does not fire on user interrupt**; API errors fire `StopFailure` whose field holds the error string ([hooks#stop](https://code.claude.com/docs/en/hooks#stop)). | `turn.complete {answer, reason: answer/aborted/refusal/error, isAborted, usage}`; `answer` = "final visible text this turn ('' if none)" (DTS L13254-13330). | Last assistant text row of the turn. |
| Thinking | No. | `turn.step` thinking chunks are "what the person sees of it live" (DTS L13529-13537). | Block present, **text empty**: Local: 46/46 thinking blocks in a recent transcript had empty `thinking`. Default `showThinkingSummaries: false` → "the Anthropic API redacts thinking blocks" ([settings-reference#showthinkingsummaries](https://code.claude.com/docs/en/settings-reference#showthinkingsummaries)). With it on you get a *summary*, never raw thinking. `thinkingDurationMs` is recorded. |
| Images | No bytes. | `session.append` rows keep media blocks ("Media blocks may be dropped or moved, not changed", DTS L10604-10609); `$.session.messages({as:'api'})` "Media inline" (DTS L491-513). | base64 image blocks. |
| Subagent output | `SubagentStop.last_assistant_message` + `agent_transcript_path`; tool hooks carry `agent_id`. | Every event carries `agentId`; `session.append` rows of subagent conversations; `$.session.messages({agentId})` (DTS L2902-2938, L11188-11210). | Separate files under `<session>/subagents/` (Local: 198 such dirs). |
| `/compact` | `PreCompact`/`PostCompact` (`compact_summary`). | `session.compact` (trigger, tokens before/after); `session.append` door `compaction`, notice `compact_boundary` (DTS L4251-4263, L10518-10530, L10585-10592). | `system` row subtype `compact_boundary`; pre-compact rows stay in the file. |
| `/clear` | `SessionEnd` + `SessionStart{source:'clear'}` with new `session_id`. | `session.end{reason:'clear'}`, no `session.start` (mod docs). | New transcript file. |
| Interrupted turn | Nothing at turn level (Stop skipped). `PostToolUseFailure.is_interrupt` for some tools. | `turn.complete.reason:'aborted'`; tool row `isInterrupted` (DTS L9855-9862). | "Interrupted" user marker row. |
| `/rewind`, edit-and-resend | **Nothing.** | **No rewind event** (grep of DTS for rewind/checkpoint: none). `session.append` input does **not** carry parent links ("Not on `e`… parent links", DTS L10532-10537). Only after-the-fact: `$.session.messages()` shrinks. | Yes, as a **tree**: old branch rows stay; new rows point back via `parentUuid`. Local: 6 of 150 recent transcripts have a parent with ≥2 user children. Kriyon's parser reads file order and ignores `parentUuid` (`crates/kriyon-core/src/transcript.rs`, only `isSidechain` at L309), so it would show abandoned branches. |
| Resumed session | `SessionStart{source:'resume'}`. Old history not replayed. | `session.append` fires only for rows **being stored**, so resumed history never arrives as events; `$.session.messages()` = newest 4,096, **after normalization (compaction summary in place of what it replaced)** (DTS L491-499). | Full history (resume keeps the file; `--fork-session` / `/branch` = new id, `source:'fork'`). |
| Ordering | Separate processes per hook; parallel PostToolUse race; Kriyon's events file is in **completion order**, not event order. | No documented cross-event order (events docs define only chain order: [events#the-order-mods-run-in](https://code.claude.com/docs/en/plugins/mods/events#the-order-mods-run-in)). `session.append` is "before it is stored", so call order ≈ storage order for one conversation (inference). **`void $.http.fetch` fire-and-forget posts can arrive out of order** → the mod must stamp a monotonic `seq`. | Append order + `parentUuid` DAG. Written **asynchronously, may lag** the in-memory conversation ([hooks#common-input-fields](https://code.claude.com/docs/en/hooks#common-input-fields)). Staff: "not a stable interface" (#91870). |

### A.2 Verdict

- **Without a mod: mostly, not exactly.**
  - Hooks alone can't do it. The only source of intermediate text is `MessageDisplay`, which blocks the terminal's rendering per batch and can't be joined to the transcript. Prompts also mix in non-user origins.
  - **Hooks plus the transcript can**, if the transcript reader becomes tree-aware (`parentUuid`, follow the live leaf, `subagents/`, `compact_boundary`). The transcript is the most *complete* source; its problems are lag, an unstable format, and the tree shape.
- **With a mod: yes for live turns, with gaps.** The source is `session.append`: exact stored rows, block by block, `uuid` = transcript uuid, `agentId`, image blocks.
  - Hook it as `const r = await next(e); void post({seq, ...r}); return r`. Posting **after** `next` gives the row *as stored*, after any other mod rewrote it. The wait doesn't count against the 10 s budget.
  - Use `turn.start` / `turn.complete` for turn boundaries, `reason` and usage; `prompt.submit.origin` to label who sent a prompt; and `tool.call` for duration and verdict.
  - Backfill (resume, mod loaded late after the trust prompt, `/reload-plugins`, a worker crash) from the transcript, joined by `uuid`.
- **Not reconstructable from any source:** raw thinking (show a stub: "Thought for 12s"); rewinds as a live event (detect them in the transcript by `parentUuid` or by `messages()` shrinking); calls blocked by managed `PreToolUse` (invisible to a user mod).
- **Ordering:** the guarantee is to be built, not assumed. Use the mod `seq` within one process, and the transcript `parentUuid` chain as the canonical order once it is written. Group parallel tool calls under their assistant row by `tool_use_id`, not by arrival.

### A.3 Showing gaps honestly (UI)

- Per turn, a source chip: **Live** (mod rows) / **From transcript** (backfill or no mod) / **Partial** (hooks only: prompt, tools and final reply, no in-between text).
- Inline markers, never silent:
  - "Thinking hidden by Claude Code · 12s"
  - "Interrupted"
  - "API error: rate limit"
  - "Compacted here: earlier turns summarized for Claude, still shown below from the transcript"
  - "Rewound: N later messages were discarded" (collapsed, greyed)
  - "Started by /loop", "Background agent report", or "Message from another session" instead of "You"
  - "Image (png)" placeholder when bytes weren't kept
  - "Subagent: <type>" collapsed group
  - "Before Kriyon connected: loaded from transcript"
- A header state: "Companion off: in-between text may be missing or late." Always "Open in terminal" to jump to the source of truth.

### A.4 ADR-0019 failure modes vs the new source

| ADR-0019 / history failure | New design |
|---|---|
| "Second-best at its own job" next to a live terminal (ADR-0019 L17-29) | **Not solved by data.** It needs a reading the terminal can't give: collapse tools, search, copy a turn, jump across turns. The new ADR must argue this. |
| Cost: 14 block kinds, prompt-echo reconciliation, resume-hint machine (L26-30) | Avoided: prompt arrives as an event, so there is nothing to reconcile. Keep to ~4 row kinds. |
| DOM weight / WebKit freeze (L31-35) | Not avoided by data. Virtualize, mount only for the active pane, and never for warm panes. |
| Transcript format drift (`863f33d`) | Moves to mod-API drift (early access). Smaller typed surface, and `claude plugin validate` can check it per version. |
| Event ring cap dropped history (`347dc2d`, `26759c7`) | Persist rows (ptyd JSONL) and page them in. No in-memory cap on truth. |
| Main-session lock confusion from nested claudes / `/clear` (ADR-0009) | Better: rows carry `agentId`; `/clear` is an explicit event. Nested `claude -p` still inherits the env and loads the mod, so filter by session id. |
| Transcript lag | Avoided for live turns (rows before they are stored). |
| Linear parse of a tree | Must fix in backfill (`parentUuid`). |

---

## B. When the mod won't run: detect and fall back

Managed-settings sources on macOS ([managed-settings](https://code.claude.com/docs/en/managed-settings)):
- **Server-managed:** fetched from claude.ai (Team/Enterprise) or a gateway, cached at `~/.claude/remote-settings.json` ([server-managed-settings](https://code.claude.com/docs/en/server-managed-settings)). It has the highest rank.
- **MDM:** the `com.anthropic.claudecode` managed-preferences domain. Read it with `CFPreferencesCopyAppValue` + `CFPreferencesAppValueIsForced`. On disk it is normally `/Library/Managed Preferences/[<user>/]com.anthropic.claudecode.plist` (standard macOS, inferred). `defaults read` alone isn't enough.
- **File:** `/Library/Application Support/ClaudeCode/managed-settings.json` + `managed-settings.d/*.json` (merged) + `managed-mcp.json`.
- **Precedence:** the first source with a policy key wins (remote > MDM > file), unless `managedSourcesBehavior: "merge"`.
- **`policyHelper`:** an executable whose output replaces the source. Kriyon can't evaluate it without running it, so treat it as **unknown**.
- **Malformed source:** Claude refuses to start.
- **Local:** none of these exist on this Mac; `claude doctor` says "Organization policy: not applicable to Pro and Max accounts".

**Gap in today's code:** ADR-0029 (`docs/adr/0029…` L35-40) reads only `managed-settings.json`. It misses the drop-ins, MDM, the remote cache and `policyHelper`. The preflight should reuse one reader for all five.

| Reason the mod doesn't run | Before launch | After launch | Fallback |
|---|---|---|---|
| **`disableSideloadFlags`** (managed): **claude exits 1** when `CLAUDE_CODE_PLUGIN_DIRS` names a folder; "the error says to unset the variable" ([settings-reference#disablesideloadflags](https://code.claude.com/docs/en/settings-reference#disablesideloadflags)). Message starts `--plugin-dir is disabled by your organization's managed settings (disableSideloadFlags)` ([mods/admin](https://code.claude.com/docs/en/plugins/mods/admin)). | Read all managed sources. If the key is true **or unknown** (policyHelper, unreadable source), **don't inject**. Candidate probe (spike, unverified): `CLAUDE_CODE_PLUGIN_DIRS=<dir> claude plugin list --json`. Exit 1 + "disableSideloadFlags" = blocked; `kriyon-companion@inline` listed = OK. Local, no session. | PTY shows the error and claude's exit; the shell survives. Match the string, set a sticky per-machine "blocked by org" flag, never inject again until the policy changes. | Hooks + status line + transcript. Offer "restart session" (the env var is in that shell). |
| **`allowManagedModsOnly`** (built-in guard option) | **Not reportable** by `claude plugin test` (docs say so). Read `pluginConfigs["cc-plugin-sec-default@builtin"].options.allowManagedModsOnly` in managed sources. | No heartbeat. Debug log / dim transcript line `mods are limited to your organization's by policy (allowManagedModsOnly)` ([mods/troubleshoot](https://code.claude.com/docs/en/plugins/mods/troubleshoot)). | Same fallback; chip "Blocked by organization". |
| **Org policy mod refuses it** (`plugin.register` → `refused by <guard>: …`, e.g. for `process.spawn`/`http.fetch`) | No. | No heartbeat; "refused by" line. | Same. Keep the mod's reach small to lower the odds. |
| **`disableAllHooks`** (any scope) / **`allowManagedHooksOnly`** (managed). **These also kill Kriyon's settings hooks and status line**, so the fallback is dead too ([settings-reference#disableallhooks](https://code.claude.com/docs/en/settings-reference#disableallhooks), [#allowmanagedhooksonly](https://code.claude.com/docs/en/settings-reference#allowmanagedhooksonly)). | ADR-0029 reader (extend it to all sources). `claude plugin test` in an empty dir prints `hooks modules are turned off here` and exits 1. | Log `not loaded: disableAllHooks in managed settings` / `only managed plugins and built-in plugins run`. | **Transcript only.** "Status unavailable" (ADR-0029); the structured view is "From transcript"; usage from the transcript sum. |
| **Remote kill switch** | `claude plugin test` → `hooks modules are turned off in this process`. Local: it printed `no hooks module to load` in 0.1 s and exited 0. | `hooks modules are turned off for installed plugins in this process`. | Hooks path. |
| **Claude < 2.1.287** (2.1.280-286: plugin loads, module off; < 2.1.280: env var ignored) | `claude --version` (cache it per binary path + mtime). | `$.session.version()` in the heartbeat. | Don't inject; "Update Claude Code". |
| **Untrusted workspace**: no mod (and no settings hook) loads until the trust prompt is answered | Best-effort: `~/.claude.json` `projects[<path>].hasTrustDialogAccepted` (undocumented). | Heartbeat **late**, not missing. Start the heartbeat timer after the first hook event or a PTY-idle cue. | Show "waiting for trust", not "blocked". |
| **`--safe-mode`, `--bare` / `CLAUDE_CODE_SIMPLE=1`** | Only if Kriyon builds the command; a user typing flags is invisible. | `--bare` log line `…load no hooks module in this mode (--bare)`. Safe mode also turns off the status line and hooks. | Transcript. |
| **API key / Bedrock / Vertex / Foundry / gateway** | Mods still run. The guard loads only with managed settings or Team/Enterprise. `rateLimits` empty off-subscription; gateway adds `spend_limit` (mod docs). Docs say "nonessential traffic off" refuses mod `$.http.fetch` (admin L78), but DTS L2608-2610 says only built-ins' requests and `auth`-carrying ones. **Conflict: spike the Unix-socket fetch with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`** (common on Bedrock/Vertex). | Heartbeat present but posts fail → mod falls back to the `$.process.spawn` helper transport (not covered by network policy). | Usage shows `$` and context; hide 5h/7d bars. |
| **Mod crash / unload** (shared worker; 3 untraced crashes → all mods off until `/reload-plugins`) | No. | `<mod> was unloaded: it crashed the hooks worker`. **Best signal: settings-hook events still arrive but the bridge is silent for a whole turn → "Companion lost".** | Switch that session to the hooks path mid-session; backfill from the transcript by uuid. |
| **API change in a newer claude** (early access; strict validation refuses a mod it can't read) | On a claude version change: `claude plugin validate <companion dir>`, which runs without a session ([mods/troubleshoot](https://code.claude.com/docs/en/plugins/mods/troubleshoot)). Pin a tested range; outside it, inject but mark "untested". | Heartbeat carries `version`; the mod reports unknown fields; `hook skipped:` lines. | Hooks path. CI runs validate + `claude plugin test` against new releases. |
| Name clash (`another plugin of that name loads first`) | `claude plugin list --json` for `kriyon-companion@*`. | Log line. | Use a unique name. |

**Safe preflight commands** (none start a session or spend tokens):
- `claude --version`
- `claude plugin test` (in an empty dir; no session, sign-in or network: [mods/test](https://code.claude.com/docs/en/plugins/mods/test))
- `claude plugin validate <dir>`
- `claude plugin list --json`
- `claude doctor`: read-only, "without starting a session" ([cli-reference](https://code.claude.com/docs/en/cli-reference)). It shows the policy *source*, not `disableSideloadFlags`.

**Unverified:** whether these subcommands enforce `disableSideloadFlags` when the env var is set. It needs a VM with that managed key.

**After-launch diagnostics:**
- An env-var plugin is a hot-reloaded plugin dir, so refusals show as a dim line in the transcript/terminal.
- For a "Diagnose" button only (not by default), relaunch with `--debug-file <path>` and grep `hooks module kriyon-companion`.

---

## C. Cost and terms

### C.1 Free vs costs tokens

| Free (no model call) | Costs tokens / plan usage |
|---|---|
| Settings `command` hooks that return nothing (Kriyon's) | `$.model.complete`, `$.model.fork`, `$.model.classify` ("These calls use the user's plan or API key": [mods/api](https://code.claude.com/docs/en/plugins/mods/api); DTS L2700-2745). Fork reuses the cache but bills the prefix afresh once it lapses or after `/model` (DTS L2705-2711). |
| Status line: "runs locally and does not consume API tokens" ([statusline](https://code.claude.com/docs/en/statusline)) | `$.prompt.submit`: a full turn. `$.command.run` for commands that call the model (`/compact`, …). `$.session.compact`. `$.agent.spawn`. |
| All observe-only mod events; `$.session.messages()`; `$.agent.list()`; `session.measure` | **`$.tool.register`**: the tool definition rides in every request (small input-token overhead), and registering or re-registering changes the tools prefix (one-time cache miss). Same for `prompt.submit` `context` injection and any `additionalContext`. |
| `$.session.usage()` plain: "The plain call costs nothing" (DTS L2989-2993); `breakdown:'summary'` estimates locally | `usage({breakdown:'full'})`: one token-count API request per tool and memory file (DTS L11736-11742). Not a generation, but real API requests; don't use it on a timer. |

### C.2 Terms

The companion follows these rules, taken from Anthropic's published terms and the Claude Code [legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance) page:

- It runs the user's own installed `claude` and the user's own login. A mod or env-var plugin is a documented extension, not a change to the binary.
- No automated or non-human use of the user's subscription.
- No bundling or altering Claude Code, and no handling of credentials.
- No "Claude Code"/"Anthropic" in feature or logo names, and nothing that suggests endorsement.
- Review Anthropic's current terms before the mod features ship.

**What this means for the current plan:**

1. **Naming (§4.3 card, §4.1):** "Kriyon Companion **for Claude Code**" as a feature title and the "Claude Code integration" settings header sit close to the naming rule. Name the feature "Kriyon Companion". Describe it in plain text: "a plugin that runs inside your Claude Code sessions". Never use Anthropic logos.
2. **Terms review:** check Anthropic's current terms before the mod features are distributed publicly.
3. **Automation (§3.3 command channel, §5.5 "open without asking", "Continue here", §5.6 #1 reminder):** any path where Kriyon submits prompts or runs `/clear`+submit without a fresh human click would be automated use of a subscription login. Rule: **every model-spending action needs a click; no timers, loops or auto-continue.** Relaying a user's answer to `AskUserQuestion` is fine.
4. **`$.model.fork` handoff (§5.5c):** it spends plan usage. Label the button "uses your plan", keep the zero-token digest as the default, and never fork automatically.
5. **Credentials:** the mod must never call `$.session.authorize`, never read `$.env.get` on auth vars, and never touch the Keychain item or `~/.claude/.credentials*`. Kriyon must not set `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` (ADR-0028 only passes the user's own through: fine). Put this in the §3.4 reach check.
6. **Policy circumvention:** never fall back to marketplace-installing or copying into the plugin cache when an org blocks sideloading or user mods. `disableSideloadFlags` exists to stop bypasses. The plan's fallback is already correct; write it down as a rule.
7. **`--plugin-dir` folder protection:** Claude needs approval to edit the companion dir. Good, since it lives under `~/.claude/kriyon/` and Kriyon writes it.

**Auto-writing `~/.claude/settings.json`:** the concerns are trust and correctness:
- It is silent and global: the hooks and the status-line wrapper run in **every** `claude` on the machine. They are env-gated, but they still spawn bash/python per event outside Kriyon. Replacing `statusLine` changes CLI behaviour, against ADR-0024's stance.
- It races Claude's own writes (`/config`, `claude plugin enable` write the same file) and breaks dotfile-managed or symlinked files.
- Endpoint security tools may treat writes to an agent's config file as a persistence pattern and flag them.
- It is dead under `allowManagedHooksOnly` / `disableAllHooks` / `--safe-mode`.

Fix:
- Consent + disclosure + uninstall (plan §4.4).
- Prefer shipping the classic hooks **inside the env-var companion plugin** (plugins can carry `hooks/hooks.json`), which makes them session-only with no global write. Spike whether a plugin can supply `statusLine`.
- Keep the global write only as an opt-in fallback for orgs with `disableSideloadFlags`.
