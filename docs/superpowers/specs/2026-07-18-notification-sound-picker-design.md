# Notification sound picker — design

**Date:** 2026-07-18
**Status:** Approved, ready for planning
**Branch:** feat/bug-fixes-4 (feature work; may split to its own `feat/` branch during planning)

## Problem

Kriyon posts a native macOS notification when a background session becomes blocked or
finishes. The sound is hardcoded to the system default alert
(`src-tauri/src/notify.rs:201`: `content.setSound(Some(&UNNotificationSound::defaultSound()))`).
The user wants to choose the notification sound from a small set, and preview
(play) each option before committing to it.

## Goal

- A **Notification sound** setting: the user picks one sound that plays for **all**
  Kriyon notifications.
- A **preview** button next to the picker that plays the selected sound on demand.
- The chosen sound rides the existing notification path and is **governed by macOS**
  (respects Do Not Disturb / Focus modes) — not played out-of-band by us.

## Non-goals (YAGNI)

- **Different sounds per status** (blocked vs. done). One sound for everything.
  Decided with the user.
- **Per-session / per-project sound overrides.** Global only.
- **User-supplied custom sound files.** Only the curated bundled set + Default + Silent.
- **Windows/Linux sound selection.** The notification path is already macOS-only
  (`#[cfg(target_os = "macos")]`); this feature inherits that scope.

## Key research finding (why the design is shaped this way)

`UNNotificationSound(named:)` — the only supported way to attach a custom sound to a
*delivered* notification — **cannot reference `/System/Library/Sounds`**. Per Apple's
docs it searches only the app's main bundle and the app's `Library/Sounds` container.
Consequences:

- Referencing built-in system sounds (Tink, Glass, …) by name works for **preview**
  (`NSSound(named:)` *does* search `/System/Library/Sounds`) but **not** for the real
  notification.
- Bundling copies of Apple's system sound files = redistributing Apple's copyrighted
  audio → licensing risk on a signed/notarized app. Rejected.
- Playing the sound ourselves (silent notification + `NSSound` on post) bypasses Do Not
  Disturb / Focus modes → disrespects the OS. Rejected.
- **Chosen path:** bundle a small set of sounds we own outright, and attach them via
  `UNNotificationSound(named:)` so macOS governs playback.

Sources: [UNNotificationSound](https://developer.apple.com/documentation/usernotifications/unnotificationsound),
[NSSound init(named:)](https://developer.apple.com/documentation/appkit/nssound/init(named:)).

## Catalog & licensing

`NotifySound` is a string id with these values:

| id         | Label      | Delivered notification              | Preview           |
|------------|------------|-------------------------------------|-------------------|
| `default`     | Default     | `UNNotificationSound.default`    | `NSBeep()`        |
| `silent`      | Silent      | no sound set (banner only)       | disabled          |
| `marimba`     | Marimba     | bundled `marimba.wav`            | plays the file    |
| `music_box`   | Music box   | bundled `music_box.wav`          | plays the file    |
| `vibraphone`  | Vibraphone  | bundled `vibraphone.wav`         | plays the file    |
| `kalimba`     | Kalimba     | bundled `kalimba.wav`            | plays the file    |
| `bell`        | Bell        | bundled `bell.wav`               | plays the file    |

(Final set, approved at the audition step — natural acoustic-instrument tones.)

**Licensing — safe by construction.** The 5 bundled sounds are **synthesized by us**
(modal synthesis from measured instrument partial ratios, pure-Python at author time),
so there is **no third-party license** — Kriyon owns them. If any sound is better sourced externally, it
must be verified **CC0 / public-domain**, and the source URL + license text recorded in
`src-tauri/sounds/PROVENANCE.md`. Nothing is bundled that has not been confirmed free to
redistribute.

**Audition checkpoint (required by the user).** After the candidate `.caf` files are
generated, present them to the user to play and check — a self-contained HTML page with
embedded audio (data URIs) and a play button per sound, with `afplay <file>` as a
fallback. Bundling and wiring proceed **only after** the user approves the set; any
sound they reject is regenerated first.

## Architecture

The sound-catalog logic is **pure** and lives in `kriyon-core` so it is unit-testable
without Tauri; `src-tauri` only performs the OS calls.

- **`kriyon-core`**: a `NotifySound` enum (serde `snake_case`, matching the TS union),
  with methods:
  - `kind(self) -> NotifySoundKind` (`Silent` | `System` | `Bundled(&'static str)`) — the one
    total resolution every consumer matches on; e.g. `Bundled("marimba.wav")` for bundled
    sounds, `None` for `Default`/`Silent`.
  - `is_silent(self) -> bool`.
  - `Default` for the enum = `NotifySound::Default` (mirrors current behavior).
  Registered as a term in `CONTEXT.md` before it becomes a type name (repo rule).

- **`src-tauri`**:
  - `AppState.notify_sound: Mutex<NotifySound>` (parallels `notify_pref`).
  - `commands::set_notify_sound(state, sound)` — mirror target for the layout field.
  - `commands::preview_notify_sound(app, sound)` — resolves the bundled resource path
    (`app.path().resolve(...)`) and plays it via `NSSound.initWithContentsOfFile(_:byReference:)`
    + `play`; `Default` → `NSBeep()`; `Silent` → no-op. Dispatched on the main thread
    per AppKit convention.
  - `notify::show(...)` gains a `sound: NotifySound` param and sets the content sound
    accordingly (`defaultSound()` / unset / `UNNotificationSound::soundNamed(...)`).
  - `status_rt.rs` reads `*state.notify_sound.lock()` and passes it into `notify::show`.

- **Frontend (thin UI; rides the exact `notifyPreference` path):**
  - `types.ts`: `NotifySound` string union.
  - `settings/settingsOptions.ts`: `NOTIFY_SOUND_OPTIONS` (label + value).
  - `state/layout.ts`: `notifySound` field (default `"default"`), `setNotifySound`.
  - `state/persistence.ts`: `parseNotifySound` (validate against the known set on load),
    included in `parseLayout` + serialization — same shape as `parseNotifyPreference`.
  - `state/bridgeMirrors.ts`: mirror `layout.notifySound` → `setNotifySound`.
  - `ipc/bridge.ts`: `setNotifySound(sound)` and `previewNotifySound(sound)`.
  - `settings/SettingsView.tsx`: a new row in the **Notifications** group — a styled
    native `<select>` (7 options is too wide for `Segmented`; native `<select>` is
    accessible and token-styleable) plus a **▶ preview** button (disabled for `silent`).

- **Assets/config:**
  - `src-tauri/sounds/*.caf` (the 5 files) + `PROVENANCE.md`.
  - `tauri.conf.json` `bundle.resources` includes the sound files, placed at the
    **Resources root** (see Risk 1).

## Data flow

```
SettingsView <select> + ▶
   │                     │
   │ change              │ preview ▶
   ▼                     ▼
useLayout.notifySound   invoke("preview_notify_sound", {sound})
   │        │                     │
   │        │                     └─ Rust: NSSound.play() / NSBeep()
   │        └─ persistence (parseNotifySound → localStorage)
   └─ bridgeMirror → invoke("set_notify_sound", {sound})
                              │
                     AppState.notify_sound ──► notify::show(…, sound)
                                                     │
                                     UNNotificationSound governed by macOS
```

## Error handling

- **Unknown/absent persisted value** → `parseNotifySound` falls back to `"default"`
  (matches how `parseNotifyPreference` defaults). Never throws.
- **Missing/failed bundled file at runtime** (resource not found, decode failure) →
  preview command returns an error string; the notification path falls back to
  `UNNotificationSound.default` rather than posting silently. Both log to stderr,
  consistent with the existing notify tracing.
- **IPC trust boundary** — `sound` crosses Rust↔JS; it is a typed `NotifySound` enum,
  so serde rejects any value outside the known set (no raw path from the frontend).

## Testing (TDD — failing test first)

- `kriyon-core`: `NotifySound` serde round-trips `snake_case`; `bundled_filename` /
  `is_silent` mapping for every variant; default is `Default`.
- `state/persistence.test.ts`: `notifySound` survives save→load; unknown value →
  `"default"`.
- `state/bridgeMirrors` / bridge: changing `notifySound` invokes `set_notify_sound`.
- `SettingsView`: renders the picker with all options; preview button disabled for
  `silent`; selecting an option calls `setNotifySound`.
- **Smoke (isolated build):** the chosen sound actually fires on a real notification,
  and preview plays — validates Risk 1 end-to-end.

## Risks (verify during build, do not assume)

1. **Bundled-file resolution.** `UNNotificationSound(named:)` looks in the main bundle's
   `Contents/Resources`; a subfolder may not resolve. Bundle the `.caf` files at the
   Resources **root** and confirm the sound fires via the isolated smoke build before
   declaring done.
2. **`default` preview fidelity.** `NSBeep()` is representative, not identical to the OS
   default notification tone. Acceptable; revisit UI copy if it reads wrong.
3. **Signing/notarization.** New bundled resources must not break the signed build.
   Verify in the isolated smoke build, not production.
