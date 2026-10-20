# Kriyon — agent rules

Kriyon is a Tauri v2 desktop GUI that hosts the user's own authenticated `claude` CLI in a
real terminal, with a git-derived Changes view beside it. Mac-first.

This file is the one rulebook for every AI tool. Folder rules live in that folder's
`AGENTS.md` (`src/`, `src-tauri/`, `crates/`); read the one for the folder you are changing.
How people work with AI here is in `docs/AI.md`.

## Owned by tools — run them instead of hand-tuning

- **Formatting and JS/TS lint**: Biome + Ultracite (`biome.jsonc`). Run `pnpm fix`.
- **Rust lint**: clippy (`src-tauri/clippy.toml`, `[lints.clippy]`), with `pedantic` and
  `correctness` enforced.
- **Git rules** (protected branches, commit format, unsafe git commands): `lefthook.yml`,
  commitlint and the `.claude/hooks/guard-bash.mjs` hook.

## How we work

- **Understand before changing.** Read the surrounding code and the spec or plan in
  `docs/superpowers/`. Most bugs here come from a second path that skipped an existing rule.
- **Fix the root cause.** A patched symptom comes back in the next feature that takes the same path.
- **Reuse before adding.** Use existing types and helpers, and add an abstraction only when a
  second caller needs it. Every extra layer is one more thing to keep in sync.
- **Test first.** Write the failing test, watch it fail for the right reason, then make it pass.
  The test proves the change does what you meant, not just what you typed.
  → `skill: engineering-workflow`
- **Keep it green.** `pnpm check` passes before every commit. CI runs the same checks, so a red
  local run is a red PR.
- **Small conventional commits on a typed branch off `dev`** (`feat/…`, `fix/…`, `docs/…`),
  merged back by a squash-merged PR whose title becomes the commit. `dev` reaches `main` only
  through a release PR. → `docs/adr/0026-dev-integration-branch.md`
- **Check library APIs against current docs** with the Context7 MCP server (set up in
  `.mcp.json`) before coding against Tauri, xterm, portable-pty, notify, rusqlite, Biome or
  Lefthook. These move fast, and memory of them goes stale.
- **Name things with the glossary.** A term is in `CONTEXT.md` (the index of `docs/context/`)
  before it becomes a module, type or command name, so Rust, the IPC bridge and the frontend
  all use the same word.
- **Record notable decisions as ADRs** in `docs/adr/`, so the reason outlives the conversation.

## Architecture

- **The Rust core owns all OS, process and file access.** The React frontend is a thin UI that
  calls Tauri commands only through `src/ipc/bridge.ts`. One owner keeps the sandbox rules in
  one place.
- **The IPC boundary is a trust boundary.** Commands take typed arguments, validate every
  input, and return `Result`. A path or id from the webview is untrusted until checked.
- **Pure logic lives in `crates/kriyon-core`**, unit-tested without Tauri. `src-tauri` is the
  thin shell around it.
- **The terminal is the source of truth.** What Kriyon reads from Claude's transcript is
  best-effort: usage totals, unseen-output badges, the Needs-you snippet, the handoff prompt.
  The parser turns any line it doesn't know into `StructuredEvent::Unknown`, because Claude
  Code changes its format without notice and a parse error would break a working session.
- **Design values come from `src/theme/tokens.ts`.** One source keeps every theme consistent.

## Agent safety

- **Leave `pnpm tauri dev` to the person.** It opens a window on their screen and fights the
  running app for its sockets. Build and test with `pnpm check`.
- **Keep history and branches intact.** Use `git stash` or a new branch instead of
  `git reset --hard`, and leave branch deletion to the person. Lost work can't be recovered.
- **Review and fix pull requests only when asked.** → `skill: pr-review` (posts comments, never
  edits) or `skill: pr-fix` (your own PR). Both post to GitHub under the person's name.

## Enforced automatically

| Rule | Enforcer |
|---|---|
| No direct commits to `dev`/`main`/`master` | lefthook `protect-base-branches` |
| Conventional commit messages | commitlint (`commit-msg`) |
| No `--no-verify`, force push, `reset --hard`, branch deletion or `tauri dev` from an agent | `.claude/hooks/guard-bash.mjs` (PreToolUse) |
| Format + JS/TS lint | lefthook `frontend-format-lint` (Ultracite) |
| Types compile | lefthook `typecheck` (tsc) |
| Rust format + lint | lefthook `rust-fmt` / `rust-clippy` |
| Tests pass | lefthook `pre-push` + CI |
| Conventional PR titles | `.github/workflows/pr-title.yml` (ADR 0043) |
| Everything above, together | `pnpm check` + `.github/workflows/ci.yml` |
