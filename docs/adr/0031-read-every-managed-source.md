# ADR 0031 — Read every managed-settings source, once

**Date:** 2026-10-03
**Status:** Accepted
**Amends:** [ADR-0029](0029-status-unavailable-when-hooks-are-off.md)

## Context

ADR-0029's hooks-off check read one managed file,
`/Library/Application Support/ClaudeCode/managed-settings.json`. Claude Code
reads more than that on macOS
([managed-settings](https://code.claude.com/docs/en/managed-settings)):

1. the server-managed cache, `~/.claude/remote-settings.json`;
2. the MDM profile for `com.anthropic.claudecode`, the per-user
   `/Library/Managed Preferences/<user>/` plist before the device-level one;
3. `managed-settings.json` merged with every `managed-settings.d/*.json`
   drop-in, in name order.

By default the first source with a policy key wins and the rest are ignored.
With `managedSourcesBehavior: "merge"` in the highest source, every source
applies: locks such as `disableSideloadFlags` and `allowManagedHooksOnly` take
the strictest value, other keys come from the highest source that sets them.
A `policyHelper` on the applied MDM or file source computes the policy at
launch instead.

The Kriyon Companion needs the same answer for a second question: whether
`claude` will accept a side-loaded plugin folder. Under managed
`disableSideloadFlags` it exits at startup when `CLAUDE_CODE_PLUGIN_DIRS`
names one, so a wrong guess turns a working session into a failed launch.

## Decision

- **One reader.** `src-tauri/src/policy.rs` reads the three sources into
  `kriyon_core::policy::ManagedSources`; the pure `resolve` applies Claude
  Code's precedence and returns a `PolicyRead`: `Known(ManagedPolicy)` or
  `Unknown`. The source paths are injectable (`ManagedLocations`) so tests
  never read the real `/Library` files.
- **Unknown when we can't tell.** A source that exists but can't be read or
  parsed, or a `policyHelper` (Kriyon never runs it), makes the policy
  `Unknown`. A missing source, or one the OS won't let this user read, is
  absent, as it is for `claude` running as the same user.
- **Hooks off** (ADR-0029) now takes the resolved `ManagedPolicy` instead of
  the one file. An unknown policy counts as unset there: Kriyon only says
  "hooks off" when it knows.
- **Side-loading** is `allowed | blocked | unknown`; callers treat `unknown`
  like `blocked` and never inject. `is_sideload_refusal` matches `claude`'s
  exit message so a launch that is refused anyway can stop the injection.
  The built-in guard's `allowManagedModsOnly` is exposed as "mods blocked by
  org".

## Consequences

- Drop-ins, MDM profiles and server-managed settings now count for hooks-off.
  A `--settings` flag is still invisible, and the check still runs at
  session start.
- The server-managed cache's shape is taken to be the settings object;
  a cache Claude Code never applies (wrong provider, gateway off) can still
  make Kriyon think a policy applies. That errs toward not side-loading.
- A per-user plist is found by `$USER`; if it isn't set, only the
  device-level plist is read.
