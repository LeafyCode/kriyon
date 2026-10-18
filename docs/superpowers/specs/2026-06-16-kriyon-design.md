# Kriyon — Design Spec

**Date:** 2026-06-16
**Status:** Draft for review
**Working name:** Kriyon

A lightweight, loosely-coupled desktop GUI that hosts the official `claude` Claude Code CLI, giving it a Claude-Desktop-quality interface (managed output, clean copy, vertical tabbed sessions grouped by project, sidebar progress and notifications) while keeping a real, full-fidelity terminal underneath. Mac-first, cross-platform-capable.

---

## 1. Problem & goals

Working across multiple projects and git worktrees with Claude Code today means juggling terminal tabs with no shared session overview, no notifications when an agent needs input, awkward copy/paste (hard-wrapped line breaks), and raw scrollback as the only output surface.

Kriyon wraps the user's **own, already-authenticated** `claude` CLI in a nicer shell:

- **Goals**
  - Host real interactive Claude Code sessions with full terminal fidelity (zsh and other shells, vim, ssh, REPLs, all ANSI/truecolor).
  - Render a clean **structured ("Studio") view** of the conversation alongside a **Raw** terminal view.
  - Manage many concurrent sessions across multiple projects and git worktrees, grouped in a vertical sidebar.
  - Surface per-session status and progress in the sidebar **without switching tabs**, plus OS notifications when a backgrounded session needs input or finishes.
  - Make copy clean — no broken mid-line wraps — in both views.
  - **Loose coupling:** never break when Claude Code ships a new feature. The terminal always shows everything; the structured view degrades gracefully.
  - Stay strictly within Anthropic's terms.
  - **Stay small.** Favor the simplest thing that works — no speculative abstraction or gold‑plating.

- **Non-goals (v1)**
  - Not a Warp replacement — no general-purpose terminal product surface (command-block workflows, AI autocomplete, marketplace).
  - No diff-review → PR → merge loop (planned v2).
  - No API-key-driven engine (headless/SDK) — designed-for, not built (see §7).
  - No handling of Claude authentication, no credential storage/proxy.
  - No cloud, sync, or multi-user accounts.

---

## 2. Hard constraints (Anthropic terms)

Derived from Anthropic's published terms (sources in Appendix B). These are binding design constraints:

- **BYO official auth only.** The user authenticates themselves via the real `claude` CLI login (Pro/Max subscription OAuth). Kriyon never sees, stores, proxies, or replays credentials or API keys.
- **Subscription OAuth = ordinary interactive use only.** Anthropic licenses subscription OAuth for "ordinary, individual usage" of Claude Code. Programmatically driving Claude (headless `-p`, Agent SDK, batching, background agents) on a *subscription* login falls outside that ordinary use.
  - **Architectural rule:** subscription auth → interactive PTY only. Anything programmatic → requires the user's own **API key** (future lane, §7).
- **Unmodified official binary.** Spawn the genuine `claude` as a child process. No forking, no protocol re-implementation, no network interception.
- **Human-in-the-loop, single-user, ordinary use.** No features that multiply per-account throughput on a subscription (account rotation, scheduling, parallel automation that circumvents limits).
- **Branding.** Product name is **Kriyon** (not "Claude"/"Claude Code"/"Anthropic"). Use nominative descriptors only ("works with the Claude Code CLI"). Ship a prominent **"Not affiliated with, endorsed by, or sponsored by Anthropic"** disclaimer. No Anthropic logos/marks.
- **Local data.** On-disk transcripts read by Kriyon are the user's own local data; keep local, never upload without explicit consent.

In short: Kriyon hosts the user's own authenticated CLI in a GUI and respects the subscription/interactive vs API-key/programmatic boundary.

---

## 3. Core architecture

**Tauri v2: Rust core + React frontend in WKWebView.** Chosen for tiny footprint (~7 MB bundle, ~45 MB idle vs Electron's ~200 MB+) which matters when running many concurrent sessions, native Mac feel, and a solid Rust PTY story. Trade-offs accepted: we own more terminal plumbing (no flagship Tauri terminal to copy), and we manage WKWebView's ~16 WebGL-context ceiling (§8). Visual style is **flat** (solid panels, minimal blur), chosen over the concept's heavy glass for terminal rendering performance in WKWebView.

```
┌──────────────────────────────────────────────────────────────┐
│  React frontend (WKWebView)                                    │
│   Sidebar (projects→sessions)  Center (Studio | Raw)  Inspector│
│   Command palette · prompt bar · status badges · notifications │
└───────────────▲───────────────────────────────▲───────────────┘
   binary batched │ PTY bytes      JSON events    │ structured model
   (flow-controlled)                              │ + status
┌───────────────┴───────────────────────────────┴───────────────┐
│  Rust core                                                     │
│   Session/process manager  │  PTY host (portable-pty)          │
│   Transcript watcher (notify/FSEvents → JSONL parser)          │
│   OSC 133 / OSC 52 parser  │  Status engine                    │
│   Git/worktree service     │  Notification dispatcher          │
│   SQLite (session metadata, layout, project grouping)          │
└───────────────────────────────▲───────────────────────────────┘
                  spawns child │ (unmodified)
                       ┌───────┴────────┐
                       │  claude  (PTY) │  interactive, subscription auth
                       └───────┬────────┘
                  writes JSONL │ ~/.claude/projects/<hash>/<id>.jsonl
                       ┌───────▼────────┐
                       │ watched by Rust│
                       └────────────────┘
```

### 3.1 Components (units with single responsibilities)

**Rust core**

- **Session manager** — lifecycle of a session: spawn `claude` in a PTY at a project/worktree cwd; track session id; resume/continue; teardown (kill + join threads to avoid zombies). Exposes a `SessionEngine` trait so a future API-key engine slots in (§7).
- **PTY host** — `portable-pty`; spawns the shell as a **login shell** (`zsh -l` by default) with `TERM=xterm-256color`, `COLORTERM=truecolor`, and a UTF‑8 locale; one reader thread per session; batches reads (~4–8 ms / N KB) into binary frames; watermark flow control (pause PTY > ~100 KB buffered, resume < ~10 KB); forwards resize (SIGWINCH) on debounced fit.
- **Transcript watcher** — `notify` (FSEvents) watches the session's JSONL file; parses appended lines into a structured event model; emits to frontend. Tolerant parser: unknown line/event types are kept as opaque/generic blocks, never fatal.
- **Shell-integration parser** — handles OSC 133 (command/output region markers → "blocks") and OSC 52 (clipboard). Used for clean copy and per-command grouping. For zsh, Kriyon injects its **own** minimal OSC 133 `precmd`/`preexec` hooks via a temporary `ZDOTDIR` that first sources the user's real `~/.zshrc` (iTerm2/Ghostty/wezterm scripts are not cleanly reusable).
- **Status engine** — fuses three signals into `running | waiting-for-input | done | error`: (a) JSONL event timing/types, (b) OSC 133 command-end + exit code, (c) PTY idle heuristics. Emits status changes for badges/notifications.
- **Git/worktree service** — list projects, branch, dirty count, `git status`/diff stat for the inspector; create/switch/remove worktrees. (Auto‑copying `.env*` files and port hints are deferred — keep it minimal.)
- **Notification dispatcher** — `tauri-plugin-notification`; fires OS notifications only for sessions that are not the focused tab; coalesces noise.
- **Persistence** — SQLite (rusqlite): projects, session metadata, layout (Studio/Focus, expanded groups, active session), per-session settings. PTY scrollback is in-memory/bounded, not persisted in v1.

**React frontend**

- **Terminal view (Raw)** — `@xterm/xterm` 6 + `@xterm/addon-webgl` (+ fit, search, serialize, unicode11, unicode-graphemes, web-links). Custom OSC 52 handler. Renders PTY bytes; full interactivity (keystrokes → PTY stdin).
- **Studio view** — renders the structured model from the transcript watcher: prompt / assistant text / tool calls / file diffs / bash output, matching the concept design's block styles. Best-effort; falls back to "see Raw" for anything it can't structure.
- **Sidebar** — projects (workspaces) → sessions tree (Studio layout) and icon-rail + tab-strip (Focus layout), per the concept. Per-session status dot/badge + short progress summary.
- **Inspector** — git changes, usage (context window %, tokens, cost read from JSONL usage fields), session info.
- **Command palette (⌘K)**, **prompt bar** (sends text to the focused session's PTY stdin), **copy toast**.

### 3.2 IPC

- **PTY stream:** `tauri::ipc::Channel` carrying raw binary `ArrayBuffer` frames (no JSON encoding of terminal bytes), batched, flow-controlled.
- **Structured/status:** regular JSON events (transcript model deltas, status changes, git/usage updates).

---

## 4. Primary data flow

1. User creates a session in a project (cwd) or a worktree → Rust spawns `claude` in a PTY there (subscription auth, inherited from the user's environment).
2. PTY bytes → batched binary → xterm.js **Raw view**. OSC 133 markers → command/output blocks.
3. In parallel, Rust discovers and tails that session's `~/.claude/projects/<hash>/<session-id>.jsonl` → parses into the structured model → **Studio view**. Session-id correlation via the project-hash directory + newest/most-recently-modified JSONL, confirmed against early events.
4. Status engine derives state → sidebar badge + progress summary; OS notification if the session is backgrounded and now needs input or has finished.
5. User can toggle Studio/Raw per session, copy clean from either, jump via ⌘K, and act on git changes in the inspector.

**Why this is loosely coupled:** the Raw terminal is the source of truth and renders *any* Claude Code output verbatim, including future features. The Studio view is a *reconstruction* layered on top — if the JSONL gains new event types, they render generically or are ignored; nothing breaks. We never parse permission-prompt text or depend on the interactive TUI's visual layout.

---

## 5. Clean copy (first-class v1 feature)

"Weird line breaks" happen because naive terminal copy returns the *visual grid* (one row per wrapped display line). Fix, applied in both views:

- **Logical-line reflow** — use xterm.js `buffer.active.getLine(y).isWrapped`: rejoin continuation rows with no `\n`; emit `\n` only at true logical line ends.
- **OSC 133 block-scoped copy** — "copy this command's output" copies the semantic block (between command-start `C` and command-end `D`), not the screen.
- **OSC 52** — honor programmatic clipboard writes from inside the PTY (ssh/tmux copy).
- Studio view copies from the structured model directly (already logical).
- Realizes the concept's "Copied — clean, no line breaks" toast.

Shell-integration markers (OSC 133) are emitted by injecting Kriyon's own `precmd`/`preexec` snippet (zsh first, via a temporary `ZDOTDIR` that sources the user's real config; bash/fish later). Programs that don't understand OSC 133 ignore it safely.

---

## 6. Status, notifications & background awareness

- **Per-session status:** `running | waiting-for-input | done | error | idle`, shown as the sidebar dot/badge (matching concept colors).
- **Progress summary:** a short, derived line per session (e.g. last tool/action or "waiting for your reply") so the user gets the gist without switching tabs.
- **OS notifications:** fired only for non-focused sessions, on transitions to `waiting-for-input` or `done` (and `error`). Coalesced to avoid spam.
- Detection fuses JSONL events + OSC 133 exit codes + PTY idle; no dependence on parsing the interactive prompt text.

---

## 7. Auth boundary & extensibility (designed-in, not built in v1)

The `SessionEngine` trait abstracts how a session is driven:

- **`PtyEngine` (v1):** spawns interactive `claude` in a PTY; subscription auth; structured view from JSONL tail. This is all v1 ships.
- **`ApiEngine` (future):** headless `--output-format stream-json` and/or the Claude Agent SDK; **requires the user's own API key**; structured view is the source of truth. This is the ToS-clean home for automation, headless/background runs, and the future **Codex / meta-harness** ("later, but keep in mind"). A second engine type (e.g. `CodexEngine`) plugs into the same trait + UI.

This keeps the architecture multi-agent-ready without violating the subscription/interactive boundary in §2.

---

## 8. Key risks & mitigations

| Risk | Mitigation |
|---|---|
| JSONL format is only partially documented; may shift | Tolerant parser; unknown types render generically; **terminal is always the fallback**; never block UI on JSONL. |
| WKWebView ~16 WebGL contexts (panes go blank) | Only focused/visible terminals use WebGL; background sessions keep PTY state in Rust and rehydrate xterm on focus (serialize addon); handle `webglcontextlost`. |
| Many sessions → memory | Bounded scrollback (~5–10k lines); backpressure; PTY/session state owned by Rust, not duplicated in JS. |
| Status detection unreliable | Fuse three signals (JSONL + OSC 133 exit + PTY idle); conservative transitions. |
| Session-id ↔ JSONL correlation fragile (path hashing) | Derive from project-hash dir + newest mtime, confirm against early events; re-resolve on resume. |
| Terms change over time | Unmodified binary; subscription-interactive only; API-key boundary for automation; disclaimer; re-check Anthropic's current terms before any launch. |
| No flagship Tauri terminal precedent | Reuse proven primitives (portable-pty, xterm.js WebGL, VS Code's flow-control + PTY-host patterns adapted to Rust). |
| macOS signing: sidecars/entitlements | Sign all sidecars; set entitlements (`disable-library-validation`, dyld env); do not enable App Sandbox (need `~/.claude` access via Dev ID). |

---

## 9. v1 scope summary

**In:** Tauri v2 app; multi-project / multi-session / multi-worktree management; Studio + Raw views; real interactive terminal per session; clean copy (logical-line + OSC 133); sidebar grouping + status + progress summaries; OS notifications; command palette; inspector (git changes / usage / session info); worktree create/switch (minimal — no env auto‑copy/port hints in v1); Studio/Focus layouts; persistence of layout/session metadata; "not affiliated" disclaimer.

**Deferred (v2+):** diff-review → inline-comment → PR → merge loop; API-key `ApiEngine` (headless/SDK) and Codex/meta-harness; containerized/devcontainer isolation; cloud/sync; cross-platform polish (Linux/Windows) beyond "capable".

---

## 10. Recommended tech stack (with current versions)

- **Shell:** Tauri v2 (2.11+), Rust (MSRV 1.77+).
- **PTY:** `portable-pty` 0.9.
- **File watching:** `notify` 8 (FSEvents).
- **Persistence:** `rusqlite`.
- **Git:** `git2` or shell out to `git` (decide in plan).
- **Frontend:** React + TypeScript; `@xterm/xterm` 6.0 + `@xterm/addon-webgl` 0.19 + addon-fit/search/serialize/unicode11/unicode-graphemes/web-links; custom OSC 133 + OSC 52 handlers.
- **Terminal renderer choice (confirmed):** `@xterm/xterm` + WebGL is the best embeddable option for a webview in 2026 — WebGPU is off by default in WKWebView, so WebGL is the ceiling and xterm already hits 60fps on heavy output. WebGPU terminals (Rio/Sugarloaf), libghostty, and native composited views are not‑ready or overkill.
- **Shell:** spawn `zsh -l`; inject OSC 133 via a temporary `ZDOTDIR`; set `TERM`/`COLORTERM`/locale; enable xterm synchronized output to avoid TUI flicker.
- **Tauri plugins:** notification, updater, deep-link, fs (scoped to `~/.claude`), tray.

---

## 11. Decisions & open questions

- **Resolved — Visual style:** flat (solid panels, minimal blur), not the concept's heavy glass — for terminal performance in WKWebView.
- **Resolved — Terminal renderer:** keep `@xterm/xterm` + WebGL (see §10).
- **Resolved — Shell:** zsh first-class (`zsh -l` + injected OSC 133).
- **Resolved — Dev workflow:** single `dev` branch; don't over‑engineer (see §12).
- Open: `git2` vs shelling out to `git` — decide during planning.
- Open: exact per‑session "progress summary" content — refine with real JSONL samples.
- Open: scrollback persistence across restarts — out for v1; revisit.

## 12. Development workflow

- Build Kriyon on a single **`dev`** branch — no per‑task branches or worktrees for our own work.
- Bias to the simplest implementation that meets v1; defer anything not needed now.

---

## Appendix A — Concept design

Source: an early design mockup. Two layouts (Studio: workspaces→sessions sidebar + transcript + inspector; Focus: icon rail + tab strip), structured-vs-raw transcript, command palette, glassy dark macOS-style window, "copy clean, no line breaks" toast. Kriyon recreates this layout and information design, but with a **flat** visual style (minimal blur) rather than the concept's heavy glass (see §11).

## Appendix B — Research sources

**Anthropic terms**
- Claude Code — Legal and compliance: https://code.claude.com/docs/en/legal-and-compliance (OAuth "ordinary use"; SDK→API key; no third-party Claude.ai login / credential routing)
- Usage Policy (eff. 2025-09-15): https://www.anthropic.com/legal/aup
- Commercial Terms (§D.4 no reselling/reverse-engineering/competing use): https://www.anthropic.com/legal/commercial-terms
- Consumer Terms (eff. 2025-10-08): https://www.anthropic.com/legal/consumer-terms
- Trademark Guidelines (eff. 2024-08-01): https://www.anthropic.com/legal/trademark-guidelines

**Claude Code integration surfaces**
- Headless / stream-json: https://code.claude.com/docs/en/headless
- Agent SDK overview (requires `ANTHROPIC_API_KEY`, separate from CLI login): https://code.claude.com/docs/en/agent-sdk/overview
- Hooks: https://code.claude.com/docs/en/hooks
- Sessions / JSONL location `~/.claude/projects/<hash>/<session-id>.jsonl` (partially documented): https://code.claude.com/docs/en/sessions
- MCP: https://code.claude.com/docs/en/mcp
- *Correction to note:* you cannot get an interactive PTY and stream-json from the *same* process — stream-json implies headless `-p` (non-interactive). v1 therefore uses interactive PTY + JSONL tail, not PTY + stream-json.

**Terminal / PTY tech**
- xterm.js v6: https://github.com/xtermjs/xterm.js/releases ; addon-webgl: https://www.npmjs.com/package/@xterm/addon-webgl
- Flow control guide: https://xtermjs.org/docs/guides/flowcontrol/ ; parser hooks: https://xtermjs.org/docs/guides/hooks/
- portable-pty: https://crates.io/crates/portable-pty
- Clean copy (isWrapped / reflow): https://github.com/xtermjs/xterm.js/issues/443 ; OSC 133: https://wezterm.org/shell-integration.html

**Tauri vs Electron**
- Tauri v2 release: https://v2.tauri.app/release/ ; IPC Channel: https://docs.rs/tauri/latest/tauri/ipc/struct.Channel.html
- Electron / node-pty (reference path; VS Code/Tabby/Wave): https://github.com/microsoft/node-pty ; VS Code terminal arch: https://deepwiki.com/microsoft/vscode/6-integrated-terminal

**Prior art**
- Superset (Electron + xterm.js + node-pty, PTY/ANSI): https://github.com/superset-sh/superset
- cmux (native Swift + libghostty, PTY + OSC notify): https://github.com/manaflow-ai/cmux
- Conductor (Tauri + SDK, worktree-per-task, review loop): https://conductor.build
- Claudia/opcode (Tauri + stream-json + JSONL tail): https://github.com/getAsterisk/opcode
- Crystal (Electron, hybrid PTY + stream-json): https://github.com/stravu/crystal
- Vibe Kanban (Rust + React, normalized executors): https://github.com/BloopAI/vibe-kanban
- Warp (Rust + Metal, blocks via OSC 133): https://www.warp.dev/blog/how-warp-works
