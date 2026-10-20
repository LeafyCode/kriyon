# Clickable links & file paths — design

**Date:** 2026-07-10
**Status:** Approved, ready for planning
**Branch:** feat/bug-fixes-3 (feature work; may split to its own `feat/` branch during planning)

## Problem

Claude prints file paths (`src/foo.ts:42`, PDFs, images, HTML pages) and web URLs as
plain text. In Kriyon this text appears in two surfaces — the **xterm terminal** (raw
output) and the **structured view** (reconstructed React blocks). Today none of it is
clickable. The user wants to click a path/URL and have the file or link open.

## Goal

Make paths and URLs clickable in **both** surfaces. Behaviour on click:

- **Plain click** → open in the default app (Preview for images/PDFs, browser for
  HTML/URLs, etc.).
- **Cmd-click** → reveal the file in Finder.
- **Web URLs** always open in the browser (http/https only).

## Non-goals (YAGNI)

- Jumping an editor to `file.ts:42`. Line/column suffixes are stripped; opening the
  default app can't target a line. Editor-at-line integration is a separate, larger
  feature.
- In-app preview of files. We hand off to the OS default app.
- Non-http URL schemes (mailto:, custom protocols). Only http/https are treated as
  web links.

## Current state (from codebase research)

**Already present:**
- `tauri-plugin-opener` registered (`src-tauri/src/lib.rs:139`), `opener:default`
  capability granted, and `openExternalUrl(url)` in `src/ipc/bridge.ts:316` — but only
  the About panel uses it.
- `@xterm/addon-web-links@0.12.0` is an installed dependency (`package.json:15`) but is
  never imported or loaded.
- `tauri-plugin-shell` registered + `shell:allow-open` granted, but unused.
- Session cwd/project path is resolvable in Rust via `project_path_by_id` /
  `SpawnPlan` cwd (`src-tauri/src/commands.rs`).

**Missing:**
- No link detection in the terminal (`src/terminal/Terminal.tsx`) — no `WebLinksAddon`,
  no `registerLinkProvider`.
- No link detection in the structured view. `Text.tsx` `renderInline` only handles
  `**bold**` and `` `code` ``. File paths in `Tool.tsx` / `Diff.tsx` / `Code.tsx` render
  as plain `<span>`s.
- No Rust command / bridge helper to open or reveal a **local file** (only web URLs).
- Opener capability lacks `opener:allow-open-path` and `opener:allow-reveal-item-in-dir`.

## Architecture

### 1. Path resolution & validation — pure logic in `kriyon-core`

A pure, unit-testable resolver (no Tauri) that the thin command calls. Given a raw
candidate string and a base cwd, it produces a validated action or rejects.

Responsibilities:
- Strip trailing `:line` and `:line:col` suffixes.
- Expand a leading `~` to the home directory.
- Resolve relative paths against the session cwd; leave absolute paths as-is.
- Canonicalize the result.
- Require the target to exist on disk.
- For **open**: enforce an **extension allowlist** so a clicked path can't launch an
  executable/app. Allowlist covers viewable/document/code types:
  pdf; png, jpg, jpeg, gif, svg, webp, bmp, ico, avif; html, htm; md, txt, markdown;
  json, yaml, yml, toml, csv; and common code extensions (ts, tsx, js, jsx, rs, py, go,
  sh, css, …). Anything not on the list is rejected for open.
- For **reveal**: no allowlist — revealing only selects the item in Finder, so any
  existing path is safe.

This is the trust boundary. The resolver returns a typed result; the command never
passes an unvalidated frontend string to the OS.

### 2. Rust command `open_path` — thin shell in `src-tauri/src/commands.rs`

```
open_path(session_id: Option<String>, path: String, action: OpenAction) -> Result<()>
// OpenAction = Open | Reveal
```

- Looks up the session's cwd/project path (via the existing session store /
  `project_path_by_id`) when `session_id` is provided; falls back to home otherwise.
- Delegates to the `kriyon-core` resolver for stripping/resolving/validating.
- On success: `Open` → opener plugin `open(path)`; `Reveal` → opener
  `reveal_item_in_dir(path)`.
- On rejection (missing file, disallowed extension, bad input): returns `Err` — the
  frontend treats it as a silent no-op (optionally a toast later).

Web URLs continue to use the existing `openExternalUrl` (http/https only), not
`open_path`.

### 3. Bridge helpers — `src/ipc/bridge.ts`

Add `openPath(path, { sessionId })` and `revealPath(path, { sessionId })` alongside
`openExternalUrl`. Both no-op outside Tauri, matching the existing helper's pattern.

### 4. Capabilities — `src-tauri/capabilities/default.json`

Add `opener:allow-open-path` and `opener:allow-reveal-item-in-dir`.

### 5. Structured view (reliable surface)

- **Known-path blocks** — `Tool.tsx` `target`, `Diff.tsx` `file`, `Code.tsx` `file`:
  wrap the path in a shared `<FileLink path sessionId>` component. Click → `openPath`;
  Cmd-click → `revealPath` (branch on `e.metaKey`).
- **Assistant prose** — `Text.tsx` `renderInline`: extend the inline matcher so that
  - http/https URLs become clickable (→ `openExternalUrl`), and
  - paths **inside `` `backtick` `` code spans** become file links (→ `<FileLink>`).
  Matching only backtick spans (not bare prose) avoids false positives; Claude almost
  always backticks paths.

### 6. Terminal (heuristic surface) — `src/terminal/Terminal.tsx`

- Load the installed `WebLinksAddon`, wired so activation calls `openExternalUrl`
  (http/https). Reliable win, slots in beside the existing addons (`FitAddon`,
  `Unicode11Addon`, `WebglAddon`).
- Register a custom `registerLinkProvider` for path-like tokens. It provides links
  (hover underline) by regex; on activate it calls `open_path` (plain) or reveal
  (Cmd-click). Existence/validity is enforced by `open_path`, which no-ops on a miss —
  so the provider can match optimistically without per-hover disk checks. The activate
  handler branches on `event.metaKey` for reveal.

## Data flow

```
terminal text / structured block
   → link detected (WebLinksAddon | registerLinkProvider | FileLink | renderInline)
   → click / Cmd-click
   → bridge (openExternalUrl | openPath | revealPath)
   → Rust command open_path
   → kriyon-core resolver (strip suffix, expand ~, resolve vs cwd, canonicalize,
     exists?, allowlist?)
   → opener plugin open / reveal_item_in_dir
```

## Error handling

- Invalid / missing / disallowed target → command returns `Err`; frontend no-ops
  silently (toast is a possible later enhancement, not required).
- Non-http URL in the terminal/prose → not treated as a web link.
- Outside Tauri (browser QA) → bridge helpers no-op.

## Security (IPC trust boundary)

- Every path crossing JS→Rust is re-resolved and validated in `kriyon-core`; the
  frontend string is never handed to the OS unchecked.
- Canonicalize + require-exists prevents opening arbitrary/constructed paths.
- The canonicalized target is confined to the **known session/project roots**
  (`path_within_roots(&target, &known_roots(store))`, the same allowlist
  `validate_cwd` uses) — for BOTH open and reveal. This blocks `~/.ssh`,
  `/etc/passwd`, and any absolute/`~`-path outside the projects the user is
  working in, while still opening anything inside a session cwd, project path,
  or worktree. (User-approved hardening after a security review flagged the
  unconfined version.)
- Open is additionally gated by a non-executable extension allowlist.
- Web links restricted to http/https (`allowNonHttpProtocols` stays false).

## Testing (TDD)

- **kriyon-core** (pure, no Tauri): suffix stripping (`:42`, `:42:7`), `~` expansion,
  relative-vs-cwd resolution, canonicalization, missing-file rejection, extension
  allowlist accept/reject, reveal bypasses allowlist. Written test-first.
- **Frontend**: URL matcher and backtick-path matcher in the inline renderer; `<FileLink>`
  click vs Cmd-click dispatch.
- **QA**: verify terminal link clicks aren't affected by the known macOS WKWebView
  "two-click" bug (link clicks are handled inside the xterm canvas, expected fine —
  confirm, don't assume). Browser-QA seam covers the structured-view path.

## Open risks

- Terminal path detection is heuristic; the allowlist + require-exists gate keeps
  false-positive clicks harmless (they no-op).
- WKWebView two-click interaction — flagged for QA above.
