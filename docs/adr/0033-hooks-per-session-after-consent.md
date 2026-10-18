# ADR 0033 — Kriyon's hooks load per session, and only after consent

**Date:** 2026-10-03
**Status:** Accepted
**Relates to:** [ADR-0024](0024-claude-fullscreen-rendering.md), [ADR-0031](0031-read-every-managed-source.md)

## Context

On every launch Kriyon merged its hooks into the global `~/.claude/settings.json`
and replaced the user's `statusLine` with a wrapper — silently, with no way to
undo it. The hooks are env-gated, but they still ran (a Python start per event)
in every `claude` on the Mac, raced Claude's own writes to that file, broke
dotfile-managed setups, and went against ADR-0024's "don't set CLI behaviour for
the user".

A spike on Claude Code 2.1.288 showed that a folder named in
`CLAUDE_CODE_PLUGIN_DIRS` loads as a plugin in an interactive session, and that
its `hooks/hooks.json` can hold classic command hooks (and a mod module) side by
side. A plugin can't supply a `statusLine`: a `settings.json` in the folder is
ignored.

## Decision

- **Consent first.** A welcome screen says plainly what Kriyon adds. Nothing is
  written before "Continue"; "Cancel" quits. Settings → "What Kriyon adds to
  Claude Code" switches each part and removes everything.
- **Hooks per session.** Kriyon writes the `kriyon-companion` plugin to
  `~/.claude/kriyon/companion/<version>/` and adds it to `CLAUDE_CODE_PLUGIN_DIRS`
  in its own sessions' shells (appended to the user's value, `:`-separated). Its
  old hook entries are removed from `settings.json`, so the file holds none.
- **Fallback, with the same consent.** When the org forbids side-loading
  (`disableSideloadFlags`) or Kriyon can't read the policy (ADR-0031), the hooks go
  in `settings.json` as before. If `claude` refuses the folder anyway (its exit
  message appears in the terminal), Kriyon records that, never injects it again,
  moves the hooks to `settings.json` and says so.
- **Status line stays global, as an opt-in.** Live usage needs the wrapper in
  `settings.json`. Kriyon saves the user's whole `statusLine` object first and
  puts it back when the switch goes off.
- Not the marketplace route: installing the plugin normally would load it in
  every `claude` on the Mac, the very thing this removes.

## Consequences

- Plain `claude` outside Kriyon no longer runs Kriyon's hooks.
- Sessions already running when the user agrees keep the old setup until their
  `claude` restarts; a shell started before consent has no companion folder in
  its env.
- A hook turned off in Kriyon's own Settings shows as "Status unavailable · hooks
  off in Kriyon settings" (ADR-0029's wording).
