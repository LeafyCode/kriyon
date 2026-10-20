# ADR 0047 — In-app updates: Rust checks and installs, and a restart keeps sessions

**Date:** 2026-10-17
**Status:** Accepted. Builds on ADR 0045 (versions) and ADR 0046 (builds and feeds).

## Context

ADR 0046 publishes one [Update feed] per [Update channel] and signs each update file. Phase 7
of the release plan puts the updater in the app: check quietly, show what is new, install only
when asked, let the user pick a channel, and get them back to a calmer channel after they leave
it.

Three facts shape it. First, the architecture rule: network access and process control belong to
the Rust core, not the webview. Second, semver sorts `0.13.0-nightly.…` after `0.13.0-beta.…`, so
the updater's default rule, "only higher versions", strands anyone who moves from nightly to beta
or from beta to stable. Third, Kriyon already has a [Handover] exit made for update restarts: the
[PTY daemon]s keep running and the next launch reattaches, so a restart doesn't have to end a
[Session].

## Decision

- **Rust owns the updater.** `tauri-plugin-updater` is driven from `src-tauri/src/update_rt.rs`
  through five commands (`update_status`, `check_for_update`, `set_update_prefs`, `skip_update`,
  `install_update`). The webview has no updater or process permission in `capabilities/`, so it
  can't call the plugin's own commands. There is no `tauri-plugin-process`: Rust calls
  `request_restart()`.
- **The plugin starts only in builds that carry its config.** Release builds merge
  `tauri.updater.conf.json` (the public key); debug and plain local builds don't, and the plugin
  won't start without a key. Those builds say so in Settings.
- **The feed is fixed per channel**, in `kriyon_core::update::UpdateChannel::feed_url`. The
  webview chooses a channel, an enum, never a URL. For testing, a build made with the
  `local-feed` cargo feature reads `KRIYON_UPDATE_FEED` instead. CI never turns it on.
- **The signature must carry the version** (`requireSignedVersion`). The feed isn't signed, only
  the file is; without this, a feed could pair a high version number with an older, validly
  signed file. It matters more here because the app sometimes accepts a lower version.
- **What is offered** is one pure rule, `kriyon_core::update::offer`, used as the updater's
  version check and again to label the result:
  - newer than the running build: an upgrade;
  - older, while the running build is noisier than the chosen channel: a [Channel step-down].
    There is no stored "just switched" flag. Once the calmer build runs, its channel is the
    chosen one and the rule is "only newer" again, which makes the step-down happen once by
    construction;
  - a step-down more than one minor back: "wait for the channel", with no install;
  - a version noisier than the chosen channel, or of no known shape: nothing;
  - the [Skipped version]: hidden from quiet checks, shown when the user asks.

  The version shapes mirror `channelOf` in `scripts/release-lib.mjs`. Both sides use plain
  semver, so a change to the shapes changes both files.
- **Older builds must read newer data.** Saved data (the `SQLite` stores and the prefs JSON)
  changes only by adding fields within a minor cycle: never rename or remove one. That is what
  lets a step-down go one minor back. Before a step-down, Rust copies every database in the data
  folder to `backups/<running>-<ms>/` with `VACUUM INTO`, which gives a consistent copy while the
  app holds them open. Attachments stay put: no build changes their format. A release that has to
  break this rule must make the step-down rule wait for it.
- **The restart is a [Handover].** Install sets the `Handover` quit intent, then restarts. Live
  sessions keep running under their daemons and the new build reattaches. The dialog doesn't ask
  about sessions; it tells the user when some are mid-turn that they keep running and reconnect.
  This replaces the plan's "a restart ends it" warning, which predates the Handover.
- **Timing.** A quiet check 5 seconds after launch, then every 6 hours, while "Check
  automatically" is on. Changing the channel checks the new feed straight away, so a step-down is
  offered while the user is still in Settings. Rust sends the first result for the new feed as
  `update-channel-answered`, and only that event opens the switch prompt, even when a check that
  was already running has to finish first. Nothing installs without "Install & restart".
- **Prefs live in Rust**: `UpdatePrefs` as JSON in the store's `app_state` table, under `updates`.
  Every field has a default, so builds on either side of a change read each other's prefs.
- **Platform keys.** The updater looks up `darwin-<arch>-app`, then `darwin-<arch>`, where
  `<arch>` is the slice of the universal binary that is running. tauri-action writes both for
  `aarch64` and `x86_64`. Nothing reads `darwin-universal`.

## Consequences

- While the repo is private, the real feeds need a login, so quiet checks fail. The failure is
  kept for Settings and never shown as a prompt. They work once the repo is public (Phase 8).
- Builds older than this one have no updater. Their users download once by hand.
- The update loop is tested on a Mac against a local feed with a `local-feed` build
  (`docs/RELEASING.md`), not only in CI.
- A hook event that fires during the restart is missed. The terminal stays the source of truth,
  and status catches up on the next event.
