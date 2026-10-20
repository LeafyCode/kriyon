# Composer completions — live slash commands, @ mentions, mode hints

**Date:** 2026-07-07
**Status:** Approved design, ready for implementation plan
**Branch:** `feat/composer-completions`

## Goal

Give the Kriyon composer (`src/layout/PromptBar.tsx`) the same input affordances the
real `claude` TUI offers, sourced **live** — never hardcoded:

- `/` — slash-command suggestions (built-in + custom + plugin + skill), with descriptions
  and argument hints, fuzzy filter, keyboard navigation.
- `@` — file/folder mentions from the session cwd (respecting `.gitignore`) plus
  `@agent-<name>` subagent mentions.
- `!` / `#` — lightweight **mode-hint chips** (bash / add-to-memory). No popover — there is
  nothing to enumerate; the raw text already reaches the PTY and claude interprets it.

The composer already pipes raw text to the PTY, so all of these prefixes already *function*
when typed and sent. This feature adds the **suggestion/affordance UI** on top, with data
pulled live from the installed `claude` CLI.

## Why "live" is mostly-but-not-fully achievable (research findings)

`claude` v2.1.202, installed at `~/.local/bin/claude` (versions under
`~/.local/share/claude/versions/<ver>`), a bun-compiled native binary — built-in commands are
baked in, not exposed as any manifest.

The one structured, documented, non-scraping live source is the **stream-json `system/init`
message**:

```
claude -p "x" --output-format stream-json --verbose --max-turns 1
```

The first `{"type":"system","subtype":"init"}` object (SDK type `SDKSystemMessage`) contains:

- `slash_commands: string[]` — command **names only** (verified live: 344 entries; includes
  built-ins like `clear`/`compact`/`context`, custom `.md` commands, plugin commands, and
  bundled skills).
- `agents: string[]` — subagent names (for `@agent-<name>`).
- `plugins: {name, path}[]`, `skills: string[]`, `claude_code_version: string`, `cwd`, …

Verified behavior on this machine:

- Init is emitted at session setup, **after** hook lifecycle events and **before** any model
  turn. Reading stdout until the init line and then killing the child pays ~no model cost.
- The init `slash_commands` list **omits interactive-only built-ins** by design (docs:
  "only commands that work without an interactive terminal are dispatchable"): `/help`,
  `/model`, `/resume`, `/login`, `/logout`, `/status`, `/cost`, `/mcp`, `/doctor`, `/vim`,
  `/memory`, `/hooks`, `/permissions`, `/export`, `/ide`, `/terminal-setup`.
- The payload has **no descriptions** — names only.
- `--bare` is **unusable**: it skips plugin/skill loading and collapses the list to 33
  built-in/bundled entries (custom + plugin commands vanish). Full probe required.
- `--debug`'s `api,hooks` filter is a debug-category filter, **not** a hook-disable knob.
  There is no granular "skip only hooks" flag, so the full probe runs SessionStart hooks
  (adds latency).

**Conclusion — the live/static split:**

| Data | Source | Live? |
|---|---|---|
| Command **names** (built-in, custom, plugin, skill) | probe `slash_commands` | ✅ live, version-tracked |
| Agent names | probe `agents` | ✅ live |
| Descriptions / argument-hints for custom/plugin/user commands | read `.md`/`SKILL.md` frontmatter | ✅ live |
| Descriptions for **built-in** commands | static name→description map | ⚠️ annotated |
| The ~13 interactive-only built-ins (name + desc) | static supplement | ⚠️ annotated |
| `@` file/folder completions | filesystem walk of cwd | ✅ live |

Only built-in **descriptions** and the interactive-only built-in **entries** are static. Every
name that the popover shows for custom/plugin/skill commands, and the entire built-in name set
that the installed version actually exposes, is live.

## Architecture

Respecting `AGENTS.md`: Rust core owns all process/fs access; pure logic lives in
`kriyon-core` (unit-testable without Tauri); the React frontend is a thin UI that only calls
Tauri commands through `src/ipc/bridge.ts`.

### Data model (`kriyon-core`)

```
struct SlashCommand {
    name: String,              // "clear", "commit", "frontend:build" (namespaced)
    description: Option<String>,
    argument_hint: Option<String>,
    source: CommandSource,     // Builtin | User | Project | Plugin { plugin } | Skill | Bundled
}

struct AgentRef { name: String }   // "Explore", "feature-dev:code-architect"

struct FileEntry { path: String, is_dir: bool }   // path relative to cwd
```

### `kriyon-core::completion` (pure, tested)

- `parse_frontmatter(md: &str) -> FrontmatterMeta` — extract `description`, `argument-hint`
  from a command/skill markdown file. Tolerant: missing frontmatter → `None`s, never errors.
- `BUILTIN_COMMANDS: &[BuiltinCommand]` — the static map. Two roles:
  1. Supplies **descriptions** for built-in names the probe returns.
  2. Supplies the **interactive-only built-ins** the probe omits (name + description).
  Each entry flags `interactive_only: bool` so the supplement step knows which to add even
  when absent from the live list.
- `merge_commands(live_names, frontmatter_by_name, builtins) -> Vec<SlashCommand>` — the core
  logic: for each live name, attach a description (frontmatter first, else builtin map);
  append interactive-only builtins not already present; dedup by name; stable sort
  (built-ins first, then alphabetical, or match claude's ordering — TBD in plan, pick one
  and test it).
- `fuzzy_rank(items, query) -> Vec<Ranked>` — optional; may live frontend-side instead
  (decide in plan). Prefer one implementation, tested.

### Tauri commands (`src-tauri/src/commands.rs`)

- `list_slash_commands(cwd: String) -> Result<CommandCatalog>`
  - `CommandCatalog { commands: Vec<SlashCommand>, agents: Vec<AgentRef>, claude_version: String, degraded: bool }`.
  - **Probe path:** spawn
    `claude -p "x" --output-format stream-json --verbose --max-turns 1 --no-session-persistence --no-chrome`
    in `cwd`, with `KRIYON_SESSION` removed from the child env (hook-pollution gotcha).
    Read stdout line-by-line; on the first `subtype == "init"` object, capture
    `slash_commands` / `agents` / `claude_code_version`, then **kill the child**. Hard
    **timeout (default 15s)**; on timeout/spawn-error/parse-failure → fallback path with
    `degraded = true`.
  - **Enrichment:** resolve each live name to a source file when one exists
    (`~/.claude/commands/**`, `<cwd>/.claude/commands/**`, enabled plugin `commands/` +
    `skills/*/SKILL.md`, plus plugin cache dirs), read frontmatter for description +
    argument-hint. Reuse the existing `commands_dir_for` logic (`commands.rs:845-944`) and the
    plugin-dir enumeration the importer already uses.
  - **Merge** via `kriyon-core::completion::merge_commands` with the static built-in map.
  - **Fallback path (no probe):** glob custom/plugin/skill `.md`/`SKILL.md` for names +
    descriptions, plus the full static built-in map. Complete enough to be useful; misses
    only bundled binary skills. Marked `degraded`.
- `list_files(cwd: String, query: String) -> Result<Vec<FileEntry>>`
  - Walk from `cwd` with the `ignore` crate (respects `.gitignore`/`.ignore`, skips `.git`).
    Filter by `query` (path substring / basename fuzzy), cap results (e.g. 50), dirs before
    files, stable order. Validate `cwd` is inside the session's known root (IPC trust
    boundary — never walk an arbitrary caller-supplied path).

Verify current library APIs against docs before coding (context7): the `ignore` crate and
Tauri command signatures.

### Caching & warmup

- `list_slash_commands` result cached **per (cwd, claude_version)** in a frontend store
  (`src/state/completions.ts`), TTL-less within a session; manual refresh action clears it.
- **Warmup:** call `list_slash_commands(cwd)` on session creation (fire-and-forget) so the
  catalog is ready before the first `/`. Never blocks the composer; if not ready when `/` is
  typed, show a tiny loading row and populate on arrival.
- `list_files` is cheap → called per query, **debounced** (~120ms). Not cached beyond the
  in-flight request.

### Frontend (thin UI)

- **`src/completion/useCompletion.ts`** — trigger detection + state machine driven by the
  textarea value + caret position:
  - `/` menu active only when the caret is in a leading `/token` (slash at input start,
    matching claude — not mid-sentence).
  - `@` menu active when the caret is in an `@token` at a word boundary; queries both files
    (`list_files`) and agents (from the cached catalog), agents shown when the token matches
    an agent name, inserted as `@agent-<name>`.
  - `!` / `#` at input start → `mode: "bash" | "memory"`, no popover.
  - Exposes `{ open, kind, items, activeIndex, query }` and `accept()/dismiss()/move()`.
- **`src/completion/CompletionPopover.tsx`** — popover anchored to the textarea caret/box,
  rendering command rows (name · description · argument-hint) or file/agent rows. Purely
  presentational; driven by the hook.
- **`src/completion/filter.ts`** — client-side fuzzy filter/highlight (single implementation,
  tested) for the already-fetched slash list. Files are filtered server-side by query.
- **`src/layout/PromptBar.tsx`** — wire the hook: intercept keydown for ↑/↓ (move),
  Tab/Enter (accept), Esc (dismiss) **only while a menu is open**; otherwise the existing
  Enter=submit / Shift+Enter=newline behavior is unchanged. Accepting inserts at the caret via
  the existing drafts insert-at-caret path (`src/state/drafts.ts`) — accepting **never**
  submits. Render a small mode-hint chip when `kind` is bash/memory.
- **`src/ipc/bridge.ts`** — `listSlashCommands(cwd)`, `listFiles(cwd, query)`.

## Behavior details

- Slash accept inserts `/<name> ` (trailing space) when the command has an `argument-hint`,
  else `/<name>` and closes the menu; leaves the caret ready for args. Submitting is a
  separate explicit action.
- `@` file accept inserts the path relative to cwd (matching what claude expects); `@agent`
  accept inserts `@agent-<name>`.
- Menu closes on: accept, Esc, caret leaving the trigger token, whitespace typed past a
  completed `/command`, or blur.
- `degraded` catalogs render normally; a subtle indicator (e.g. tooltip on the refresh
  affordance) signals the probe didn't run, so a missing bundled skill isn't mistaken for a
  bug.

## Error handling & reliability (this must be stable)

- Probe failures never surface as errors to the user — they fall back to the filesystem+static
  catalog with `degraded=true`.
- Hard timeout on the probe child; always kill the child (no zombie `claude` processes) — kill
  on init-found, on timeout, and on command drop.
- `list_files` on a huge tree: the `ignore` walker + result cap keeps it bounded; the query is
  applied during the walk where possible, and the walk is abandoned once the cap is hit.
- IPC trust boundary: both commands validate `cwd` against the session's known root; no raw
  path from the frontend is walked or spawned-in blindly.
- The probe must not pollute the hooks events file (`KRIYON_SESSION` stripped) nor the user's
  session history (`--no-session-persistence`).

## Testing (TDD — red first)

**Rust (`kriyon-core`, unit):**
- `parse_frontmatter`: full frontmatter, missing frontmatter, partial, malformed → never
  panics.
- `merge_commands`: live name gets frontmatter desc; live built-in name gets static desc;
  interactive-only builtin appended when absent; dedup; ordering.
- Static built-in map covers the documented interactive-only set (a test asserts each of the
  ~13 names is present with a description).

**Rust (`src-tauri`, integration where feasible):**
- Init-line parser extracts `slash_commands`/`agents`/`version` from a captured init fixture
  and ignores preceding `hook_started`/`hook_response` lines.
- Fallback path returns a non-empty catalog with `degraded=true` when the probe binary is
  absent (inject a bogus command path).
- `list_files` respects `.gitignore` and the result cap on a temp dir fixture.

**Frontend (vitest):**
- Trigger detection: `/` only at input start; `@` at word boundaries; `!`/`#` mode; caret
  moving out of token closes menu.
- Fuzzy filter ranking/highlight.
- Keyboard: ↑/↓/Tab/Enter/Esc behavior while open; Enter submits while closed.
- Accept inserts at caret and does not submit.

**Manual / real-app QA:** by the usual real-app and browser QA — drive
the composer, confirm `/`, `@`, `@agent`, `!`, `#` behave, and that a real command sent from
the composer still executes in the PTY.

## Files

- **new** `crates/kriyon-core/src/completion.rs` (+ module wire-up in `lib.rs`)
- `src-tauri/src/commands.rs` — `list_slash_commands`, `list_files` (+ register in the Tauri
  builder / invoke handler)
- `src/ipc/bridge.ts` — `listSlashCommands`, `listFiles`
- **new** `src/completion/useCompletion.ts`, `CompletionPopover.tsx`, `filter.ts`
- **new** `src/state/completions.ts` — cached catalog store + warmup + refresh
- `src/layout/PromptBar.tsx` — wire triggers, popover, mode-hint chip
- `src/theme/tokens.ts` — any new spacing/colors come from tokens (no hardcoded styles)

## Out of scope (v1)

- `!` bash execution completion (shell history) and `#` memory targeting — chips only.
- Image paste / drag-drop (separate feature).
- Slash-command argument *value* completion (e.g. model names for `/model`).
- Live descriptions for bundled binary skills that ship no readable `SKILL.md`.

## Open items to settle in the plan

- Exact command ordering to mirror claude (or a sensible deterministic order) — pick + test.
- Whether fuzzy ranking lives in Rust or frontend (lean frontend for the cached slash list;
  files already filtered server-side).
- Popover anchoring approach for a `<textarea>` caret (mirror-div measurement vs. anchor to
  the input box) — spike during implementation.
