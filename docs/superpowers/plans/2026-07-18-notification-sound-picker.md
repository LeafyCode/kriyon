# Notification Sound Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick one macOS notification sound from a small curated set (plus Default and Silent) and preview it, replacing the hardcoded default alert.

**Architecture:** A pure `NotifySound` enum in `kriyon-core` maps a sound id to a bundled filename; `src-tauri` performs the OS calls (attach via `UNNotificationSound(named:)`, preview via `NSSound`). The frontend adds one layout field that rides the exact plumbing the existing `notifyPreference` uses (store → persistence → bridge mirror → Rust `AppState`). Bundled sounds are synthesized by us (no third-party license) and gated behind a user audition before wiring.

**Tech Stack:** Rust (objc2, objc2-app-kit, objc2-user-notifications), Tauri v2, React + Zustand, Vitest, macOS `afconvert`/Python stdlib `wave` for sound synthesis.

## Global Constraints

- **macOS-only feature.** The notification path is `#[cfg(target_os = "macos")]`; this feature inherits that. The non-macOS `notify::show` keeps its current behavior (title/body only).
- **No third-party audio licenses.** The 5 bundled sounds are synthesized by us. Any externally sourced sound must be verified CC0/public-domain with source + license recorded in `src-tauri/sounds/PROVENANCE.md`.
- **User audition gate.** Nothing gets bundled or wired until the user has played and approved the candidate sounds (Task 1).
- **IPC is a trust boundary.** `sound` crosses Rust↔JS as a typed `NotifySound` enum (serde `snake_case`); never a raw path from the frontend.
- **Term registration.** `NotifySound` must be added to `CONTEXT.md` before it becomes a type name (repo rule).
- **Keep it green.** `pnpm check` passes before every commit. Rust commits need `PATH="$HOME/.cargo/bin:$PATH"` prefixed to `git commit` so lefthook's cargo hooks find cargo.
- **Shared worktree.** Stage named files only (`git add <path>`), never `git add -u`/`.`.
- **Format is owned by tooling.** Run `pnpm fix` before committing frontend; never hand-format.
- **Sound file format:** Linear-PCM `.wav`, ≤30s (Apple's cap for notification sounds), mono, small. One format serves both the browser audition and `UNNotificationSound`.
- **Catalog (ids → filenames):** `default`→(system default), `silent`→(no sound), `marimba`→`marimba.wav`, `music_box`→`music_box.wav`, `vibraphone`→`vibraphone.wav`, `kalimba`→`kalimba.wav`, `bell`→`bell.wav`. (Final set, approved at the Task 1 audition — natural modal-synthesis instrument tones.) Enum variants: `Default, Silent, Marimba, MusicBox, Vibraphone, Kalimba, Bell` (serde `snake_case` → `music_box` etc., matching the filenames).

---

### Task 1: Synthesize and audition the candidate sounds (USER GATE)

Produces the approved `.wav` assets every later task references. No app code changes.

**Files:**
- Create: `src-tauri/sounds/marimba.wav`, `music_box.wav`, `vibraphone.wav`, `kalimba.wav`, `bell.wav`
- Create: `src-tauri/sounds/PROVENANCE.md`
- Create (scratch, not committed): a synth script + an audition HTML page under the scratchpad dir

**Interfaces:**
- Produces: five `src-tauri/sounds/<id>.wav` files (mono, 16-bit PCM, ~0.3–0.7s each) with names matching the catalog line in Global Constraints.

- [ ] **Step 1: Write a synth script (scratchpad) using Python stdlib only (no numpy)**

Write to `<scratchpad>/synth_sounds.py`. Each sound is a short enveloped tone/chord so they're distinct by ear. Uses only `wave`, `struct`, `math`.

```python
import math, struct, wave

SR = 44100

def env(i, n, attack=0.01, release=0.25):
    t = i / SR; dur = n / SR
    a = min(1.0, t / attack)
    r = min(1.0, (dur - t) / release)
    return max(0.0, min(a, r))

def render(path, spec, dur=0.5, vol=0.5):
    n = int(SR * dur)
    frames = bytearray()
    for i in range(n):
        s = 0.0
        for (freq, w) in spec:            # spec: list of (hz, weight)
            s += w * math.sin(2 * math.pi * freq * i / SR)
        s *= env(i, n) * vol
        frames += struct.pack("<h", int(max(-1, min(1, s)) * 32767))
    with wave.open(path, "w") as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(SR)
        f.writeframes(bytes(frames))

# Five distinct timbres. Tune to taste before auditioning.
render("src-tauri/sounds/chime.wav",   [(880,0.6),(1320,0.4)], dur=0.55)
render("src-tauri/sounds/ping.wav",    [(1568,1.0)],           dur=0.30)
render("src-tauri/sounds/pop.wav",     [(440,0.7),(660,0.3)],  dur=0.18, vol=0.6)
render("src-tauri/sounds/marimba.wav", [(587,0.7),(1174,0.3)], dur=0.45)
render("src-tauri/sounds/bloop.wav",   [(330,0.8),(494,0.2)],  dur=0.35)
```

- [ ] **Step 2: Generate the files**

Run: `mkdir -p src-tauri/sounds && python3 <scratchpad>/synth_sounds.py && ls -la src-tauri/sounds/`
Expected: five `.wav` files listed, each a few KB to tens of KB.

- [ ] **Step 3: Build the audition page and present it to the user**

Base64-embed each `.wav` as a `data:audio/wav;base64,...` URI in an HTML page with a labelled ▶ play button per sound, and publish it with the Artifact tool (favicon `🔔`). Fallback if the user prefers the terminal: `afplay src-tauri/sounds/chime.wav` (repeat per file).

- [ ] **Step 4: USER GATE — get explicit approval**

Ask the user to play each and approve or request changes. If any sound is rejected, tune its `spec`/`dur` in the script, re-run Step 2, re-present. **Do not proceed to Step 5 until the user approves the set.** If names/count change, update the catalog line in Global Constraints and every task that lists sound ids.

- [ ] **Step 5: Write PROVENANCE.md**

```markdown
# Sound provenance

All notification sounds in this directory are original works synthesized for Kriyon
(see the generator in the plan/spec history). They are owned by the project and carry
**no third-party license** — free to bundle and redistribute in the signed app.

| File | Origin | License |
|------|--------|---------|
| marimba.wav | Synthesized (Kriyon, modal synthesis) | Project-owned, no third-party license |
| music_box.wav | Synthesized (Kriyon, modal synthesis) | Project-owned, no third-party license |
| vibraphone.wav | Synthesized (Kriyon, modal synthesis) | Project-owned, no third-party license |
| kalimba.wav | Synthesized (Kriyon, modal synthesis) | Project-owned, no third-party license |
| bell.wav | Synthesized (Kriyon, modal synthesis) | Project-owned, no third-party license |
```

- [ ] **Step 6: Commit the approved assets**

```bash
git add src-tauri/sounds/marimba.wav src-tauri/sounds/music_box.wav src-tauri/sounds/vibraphone.wav src-tauri/sounds/kalimba.wav src-tauri/sounds/bell.wav src-tauri/sounds/PROVENANCE.md
git commit -m "feat(notify): add synthesized notification sound assets"
```

---

### Task 2: `NotifySound` enum in kriyon-core

**Files:**
- Modify: `crates/kriyon-core/src/status.rs` (add enum + tests near `NotifyPreference`, ~line 145)
- Modify: `CONTEXT.md` (register the term)

**Interfaces:**
- Produces: `kriyon_core::status::NotifySound` (enum, `Copy`, serde `snake_case`, `Default` = `Default` variant) with `pub fn bundled_filename(self) -> Option<&'static str>` and `pub fn is_silent(self) -> bool`.

- [ ] **Step 1: Register the term in CONTEXT.md**

Add a one-line entry under the notifications/terms section (match the file's existing style), e.g.:

```markdown
- **NotifySound** — the user's chosen OS-notification sound (Default, Silent, or one of the bundled sounds). Distinct from **NotifyPreference**, which gates *which* sessions notify.
```

- [ ] **Step 2: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `crates/kriyon-core/src/status.rs`:

```rust
#[test]
fn notify_sound_serializes_snake_case_and_maps_filenames() {
    use NotifySound::{Bell, Default as Def, Kalimba, Marimba, MusicBox, Silent, Vibraphone};
    assert_eq!(serde_json::to_string(&Marimba).expect("ser"), "\"marimba\"");
    assert_eq!(serde_json::to_string(&MusicBox).expect("ser"), "\"music_box\"");
    assert_eq!(NotifySound::default(), Def);
    assert_eq!(Def.bundled_filename(), None);
    assert_eq!(Silent.bundled_filename(), None);
    assert_eq!(Marimba.bundled_filename(), Some("marimba.wav"));
    assert_eq!(MusicBox.bundled_filename(), Some("music_box.wav"));
    assert_eq!(Vibraphone.bundled_filename(), Some("vibraphone.wav"));
    assert_eq!(Kalimba.bundled_filename(), Some("kalimba.wav"));
    assert_eq!(Bell.bundled_filename(), Some("bell.wav"));
    assert!(Silent.is_silent());
    assert!(!Def.is_silent());
    assert!(!Marimba.is_silent());
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `PATH="$HOME/.cargo/bin:$PATH" cargo test -p kriyon-core notify_sound_serializes -- --nocapture`
Expected: FAIL — `cannot find type NotifySound`.

- [ ] **Step 4: Implement the enum**

Add after `NotifyPreference` (~line 145) in `crates/kriyon-core/src/status.rs`:

```rust
/// The user's chosen OS-notification sound. `Default` keeps the system alert;
/// `Silent` posts a banner with no sound; the rest name a `.wav` bundled in the
/// app's Resources root (see `src-tauri/sounds/`). Distinct from
/// [`NotifyPreference`], which gates *which* sessions notify at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum NotifySound {
    /// The macOS default notification sound (current behavior).
    #[default]
    Default,
    /// No sound — banner only.
    Silent,
    Marimba,
    MusicBox,
    Vibraphone,
    Kalimba,
    Bell,
}

impl NotifySound {
    /// The bundled `.wav` filename for this sound, or `None` for `Default`
    /// (system sound) and `Silent` (no sound). The name is what
    /// `UNNotificationSound(named:)` resolves against the app's Resources root.
    #[must_use]
    pub fn bundled_filename(self) -> Option<&'static str> {
        match self {
            NotifySound::Default | NotifySound::Silent => None,
            NotifySound::Marimba => Some("marimba.wav"),
            NotifySound::MusicBox => Some("music_box.wav"),
            NotifySound::Vibraphone => Some("vibraphone.wav"),
            NotifySound::Kalimba => Some("kalimba.wav"),
            NotifySound::Bell => Some("bell.wav"),
        }
    }

    /// Whether this sound means "post the banner with no audible cue".
    #[must_use]
    pub fn is_silent(self) -> bool {
        matches!(self, NotifySound::Silent)
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `PATH="$HOME/.cargo/bin:$PATH" cargo test -p kriyon-core notify_sound_serializes`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/kriyon-core/src/status.rs CONTEXT.md
PATH="$HOME/.cargo/bin:$PATH" git commit -m "feat(core): add NotifySound catalog enum"
```

---

### Task 3: Frontend type, options, layout field, persistence

**Files:**
- Modify: `src/types.ts` (add `NotifySound` union, ~line 37 after `NotifyPreference`)
- Modify: `src/settings/settingsOptions.ts` (add `NOTIFY_SOUND_OPTIONS`)
- Modify: `src/state/layout.ts` (field, default, setter)
- Modify: `src/state/persistence.ts` (`parseNotifySound` + include in `parseLayout`)
- Test: `src/state/persistence.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: TS type `NotifySound = "default" | "silent" | "marimba" | "music_box" | "vibraphone" | "kalimba" | "bell"`; `useLayout` field `layout.notifySound` + `setNotifySound(sound: NotifySound)`; `NOTIFY_SOUND_OPTIONS: readonly SettingOption<NotifySound>[]`.

- [ ] **Step 1: Add the TS union to `src/types.ts`**

After the `NotifyPreference` type:

```typescript
/**
 * The user's chosen OS-notification sound (mirrors Rust `NotifySound`, serde
 * snake_case). `default` is the system alert; `silent` posts a banner with no
 * sound; the rest name a bundled `.wav`.
 */
export type NotifySound =
  | "default"
  | "silent"
  | "marimba"
  | "music_box"
  | "vibraphone"
  | "kalimba"
  | "bell";
```

- [ ] **Step 2: Add options to `src/settings/settingsOptions.ts`**

Import `NotifySound` from `../types.ts` (extend the existing import) and append:

```typescript
export const NOTIFY_SOUND_OPTIONS: readonly SettingOption<NotifySound>[] = [
  { label: "Default", value: "default" },
  { label: "Silent", value: "silent" },
  { label: "Marimba", value: "marimba" },
  { label: "Music box", value: "music_box" },
  { label: "Vibraphone", value: "vibraphone" },
  { label: "Kalimba", value: "kalimba" },
  { label: "Bell", value: "bell" },
];
```

- [ ] **Step 3: Add the layout field, default, and setter in `src/state/layout.ts`**

Extend the `NotifyPreference` import to also import `NotifySound`. In `interface Layout`, after `notifyPreference`:

```typescript
  /** Chosen OS-notification sound, pushed to the backend on change. */
  notifySound: NotifySound;
```

In `DEFAULT_LAYOUT`, after `notifyPreference: "all",`:

```typescript
  notifySound: "default",
```

In `interface LayoutState`, after `setNotifyPreference`:

```typescript
  setNotifySound: (sound: NotifySound) => void;
```

In `useLayout`, next to `setNotifyPreference`:

```typescript
  setNotifySound: (notifySound) =>
    set((state) => ({ layout: { ...state.layout, notifySound } })),
```

- [ ] **Step 4: Write the failing persistence test**

Add to `src/state/persistence.test.ts` (follow the file's existing structure/imports):

```typescript
test("notifySound survives a save/load round-trip", () => {
  const layout = { ...DEFAULT_LAYOUT, notifySound: "marimba" as const };
  const restored = parseLayoutForTest(JSON.stringify(layout));
  expect(restored?.notifySound).toBe("marimba");
});

test("an unknown persisted notifySound falls back to default", () => {
  const restored = parseLayoutForTest(
    JSON.stringify({ ...DEFAULT_LAYOUT, notifySound: "airhorn" })
  );
  expect(restored?.notifySound).toBe("default");
});
```

If `persistence.test.ts` does not already expose `parseLayout` (it is currently module-private), first export it for tests: in `persistence.ts` change `function parseLayout` to `export function parseLayout`, and in the test `import { parseLayout as parseLayoutForTest } from "./persistence.ts";`. If the test file already exercises `parseLayout`, reuse its existing accessor instead of adding a new one.

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm vitest run src/state/persistence.test.ts -t notifySound`
Expected: FAIL — `notifySound` is `undefined` (not yet parsed).

- [ ] **Step 6: Implement `parseNotifySound` and wire it into `parseLayout`**

In `src/state/persistence.ts`, add near `parseNotifyPreference` (import `NotifySound` into the existing `../types.ts` import):

```typescript
const NOTIFY_SOUNDS: readonly NotifySound[] = [
  "default",
  "silent",
  "marimba",
  "music_box",
  "vibraphone",
  "kalimba",
  "bell",
];

/** Validate a persisted notify sound, defaulting to `default`. */
function parseNotifySound(value: unknown): NotifySound {
  return NOTIFY_SOUNDS.includes(value as NotifySound)
    ? (value as NotifySound)
    : "default";
}
```

In the object returned by `parseLayout`, after `notifyPreference: parseNotifyPreference(parsed.notifyPreference),`:

```typescript
    notifySound: parseNotifySound(parsed.notifySound),
```

- [ ] **Step 7: Run tests + fix formatting**

Run: `pnpm vitest run src/state/persistence.test.ts && pnpm fix`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/settings/settingsOptions.ts src/state/layout.ts src/state/persistence.ts src/state/persistence.test.ts
git commit -m "feat(settings): add notifySound layout field and persistence"
```

---

### Task 4: Bridge functions + store→backend mirror

**Files:**
- Modify: `src/ipc/bridge.ts` (add `setNotifySound`, `previewNotifySound`; extend the `NotifySound` import)
- Modify: `src/state/bridgeMirrors.ts` (mirror `notifySound`)
- Test: `src/ipc/bridge.test.ts`

**Interfaces:**
- Consumes: `NotifySound` (Task 3); `useLayout.layout.notifySound` (Task 3).
- Produces: `setNotifySound(sound: NotifySound): Promise<void>` → invoke `"set_notify_sound"` with `{ sound }`; `previewNotifySound(sound: NotifySound): Promise<void>` → invoke `"preview_notify_sound"` with `{ sound }`.

- [ ] **Step 1: Write the failing bridge test**

Add to `src/ipc/bridge.test.ts` (import `setNotifySound`, `previewNotifySound` in the existing bridge import block):

```typescript
test("setNotifySound invokes set_notify_sound with the sound", async () => {
  invoke.mockResolvedValueOnce(undefined);
  await setNotifySound("marimba");
  expect(invoke).toHaveBeenCalledWith("set_notify_sound", { sound: "marimba" });
});

test("previewNotifySound invokes preview_notify_sound with the sound", async () => {
  invoke.mockResolvedValueOnce(undefined);
  await previewNotifySound("bell");
  expect(invoke).toHaveBeenCalledWith("preview_notify_sound", { sound: "bell" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/ipc/bridge.test.ts -t NotifySound`
Expected: FAIL — `setNotifySound is not a function` / import error.

- [ ] **Step 3: Implement the bridge functions**

In `src/ipc/bridge.ts`, after `setNotifyPreference` (~line 683). Extend the type import to include `NotifySound`:

```typescript
/** Set the chosen OS-notification sound (attached to future notifications). */
export function setNotifySound(sound: NotifySound): Promise<void> {
  return invoke("set_notify_sound", { sound });
}

/** Play the given notification sound once, for previewing it in Settings. */
export function previewNotifySound(sound: NotifySound): Promise<void> {
  return invoke("preview_notify_sound", { sound });
}
```

- [ ] **Step 4: Wire the mirror in `src/state/bridgeMirrors.ts`**

Extend the import from `../ipc/bridge.ts` to include `setNotifySound`, and add a third `mirrorToBridge` entry to the `stops` array:

```typescript
    mirrorToBridge(
      useLayout,
      (state) => state.layout.notifySound,
      setNotifySound
    ),
```

Update the doc comment's bullet list to mention the notify-sound mirror alongside the notify-preference one.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/ipc/bridge.test.ts && pnpm fix`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ipc/bridge.ts src/state/bridgeMirrors.ts src/ipc/bridge.test.ts
git commit -m "feat(ipc): mirror notifySound to backend + preview bridge"
```

---

### Task 5: Rust — attach the chosen sound to notifications

**Files:**
- Modify: `src-tauri/src/lib.rs` (`AppState.notify_sound` field; register `set_notify_sound`)
- Modify: `src-tauri/src/commands.rs` (`set_notify_sound` command)
- Modify: `src-tauri/src/notify.rs` (`show` gains a `sound` param; set content sound from it)
- Modify: `src-tauri/src/status_rt.rs` (read `notify_sound`, pass to `show`)
- Modify: `src-tauri/tauri.conf.json` (bundle the sound files at the Resources **root**)

**Interfaces:**
- Consumes: `kriyon_core::status::NotifySound` (Task 2); bundled `.wav` files (Task 1).
- Produces: command `set_notify_sound(sound: NotifySound)`; `notify::show(app, session_id, title, subtitle, body, sound: NotifySound)`; `AppState.notify_sound: Mutex<NotifySound>`.

- [ ] **Step 1: Add the `AppState` field**

In `src-tauri/src/lib.rs`, in `struct AppState`, after the `notify_pref` field (~line 59):

```rust
    /// The user's chosen OS-notification sound, attached to each posted
    /// notification. Defaults to `NotifySound::Default` (the system alert).
    pub notify_sound: Mutex<kriyon_core::status::NotifySound>,
```

(`AppState` derives `Default`, and `NotifySound` derives `Default` = `Default` variant, so `AppState::default()` needs no change.)

- [ ] **Step 2: Add the `set_notify_sound` command**

In `src-tauri/src/commands.rs`, after `set_notify_preference` (~line 898):

```rust
/// Set the user's chosen OS-notification sound. Attached to notifications
/// posted after this call; does not affect already-delivered ones.
///
/// # Errors
/// Infallible today; returns `Result` for command-signature uniformity.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn set_notify_sound(
    state: tauri::State<'_, AppState>,
    sound: kriyon_core::status::NotifySound,
) -> Result<(), String> {
    *state.notify_sound.lock() = sound;
    Ok(())
}
```

- [ ] **Step 3: Register the command**

In `src-tauri/src/lib.rs`, in the `invoke_handler` list after `commands::set_notify_preference,` (~line 256):

```rust
            commands::set_notify_sound,
```

- [ ] **Step 4: Thread `sound` into `notify::show` (macOS)**

In `src-tauri/src/notify.rs`, change the macOS `show` signature and the sound line. Import the enum at the top of the macOS-gated imports:

```rust
#[cfg(target_os = "macos")]
use kriyon_core::status::NotifySound;
```

Signature (add a trailing param):

```rust
pub fn show<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    session_id: &str,
    title: &str,
    subtitle: &str,
    body: &str,
    sound: NotifySound,
) {
```

Replace the hardcoded sound line (was `content.setSound(Some(&UNNotificationSound::defaultSound()));`) with:

```rust
    // Silent → no sound; Default → the system alert; a bundled sound → the
    // `.wav` at the app's Resources root, resolved by name by macOS (which
    // then governs playback under Do Not Disturb / Focus).
    match sound.bundled_filename() {
        _ if sound.is_silent() => {}
        Some(filename) => {
            content.setSound(Some(&UNNotificationSound::soundNamed(&NSString::from_str(
                filename,
            ))));
        }
        None => content.setSound(Some(&UNNotificationSound::defaultSound())),
    }
```

- [ ] **Step 5: Update the non-macOS `show` signature**

In the `#[cfg(not(target_os = "macos"))]` `show`, add the trailing param so callers compile cross-platform (it is unused off-macOS):

```rust
pub fn show<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    _session_id: &str,
    title: &str,
    _subtitle: &str,
    body: &str,
    _sound: kriyon_core::status::NotifySound,
) {
```

- [ ] **Step 6: Pass the stored sound at the call site**

In `src-tauri/src/status_rt.rs`, read the sound before the `notify::show` call (~line 134) and pass it. Add before the `crate::notify::show(` call:

```rust
    let sound = *state.notify_sound.lock();
```

And extend the call:

```rust
    crate::notify::show(
        app,
        &session_id.0,
        &content.title,
        &content.subtitle,
        &content.body,
        sound,
    );
```

- [ ] **Step 7: Bundle the sounds at the Resources root**

In `src-tauri/tauri.conf.json`, inside `"bundle"`, add a `resources` map that places each file at the Resources **root** (not a subfolder — `UNNotificationSound(named:)` only finds files at the bundle/Resources top level). Verify the exact map syntax against current Tauri v2 docs (context7: Tauri `bundle > resources`) before finalizing:

```json
    "resources": {
      "sounds/marimba.wav": "marimba.wav",
      "sounds/music_box.wav": "music_box.wav",
      "sounds/vibraphone.wav": "vibraphone.wav",
      "sounds/kalimba.wav": "kalimba.wav",
      "sounds/bell.wav": "bell.wav"
    },
```

- [ ] **Step 8: Verify Rust compiles and core tests pass**

Run: `PATH="$HOME/.cargo/bin:$PATH" cargo build -p kriyon-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test -p kriyon-core`
Expected: builds clean (clippy pedantic is enforced at commit); tests PASS. Fix any clippy warnings the commit hook would reject.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/commands.rs src-tauri/src/notify.rs src-tauri/src/status_rt.rs src-tauri/tauri.conf.json
PATH="$HOME/.cargo/bin:$PATH" git commit -m "feat(notify): attach the chosen sound to notifications"
```

---

### Task 6: Rust — preview command via NSSound

**Files:**
- Modify: `src-tauri/Cargo.toml` (add `objc2-app-kit` with `NSSound`; add `NSURL` to `objc2-foundation` if the file-URL initializer is used)
- Modify: `src-tauri/src/commands.rs` (`preview_notify_sound` command)
- Modify: `src-tauri/src/lib.rs` (register `preview_notify_sound`)

**Interfaces:**
- Consumes: `NotifySound` (Task 2); bundled `.wav` files + resource bundling (Tasks 1, 5).
- Produces: command `preview_notify_sound(app, sound: NotifySound)`.

- [ ] **Step 1: Add the AppKit dependency**

In `src-tauri/Cargo.toml`, near the other `objc2-*` deps:

```toml
objc2-app-kit = { version = "0.3", features = ["NSSound"] }
```

Verify the crate version pairs with the pinned `objc2 = "0.6"` / `objc2-foundation = "0.3"` (context7 or docs.rs). `NSBeep` is a free function in `objc2-app-kit`; confirm it is exported without an extra feature.

- [ ] **Step 2: Implement `preview_notify_sound` (macOS)**

In `src-tauri/src/commands.rs`, add a macOS-gated command. It resolves the bundled resource path via Tauri's resolver and plays it with `NSSound`; `Default` → `NSBeep()`; `Silent` → no-op. Dispatch on the main thread per AppKit convention (use `app.run_on_main_thread`).

```rust
/// Play the given notification sound once, for previewing in Settings.
/// Bundled sounds play their `.wav`; `Default` plays the system beep; `Silent`
/// does nothing. macOS-only; a no-op elsewhere.
///
/// # Errors
/// Returns an error string if the bundled resource cannot be resolved or the
/// sound fails to initialize.
#[cfg(target_os = "macos")]
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn preview_notify_sound(
    app: tauri::AppHandle,
    sound: kriyon_core::status::NotifySound,
) -> Result<(), String> {
    use kriyon_core::status::NotifySound;
    use objc2_app_kit::{NSBeep, NSSound};
    use objc2_foundation::NSString;
    use tauri::Manager as _;

    if sound.is_silent() {
        return Ok(());
    }
    let Some(filename) = sound.bundled_filename() else {
        // Default: no bundled file — approximate the system alert.
        app.run_on_main_thread(|| unsafe { NSBeep() })
            .map_err(|e| e.to_string())?;
        return Ok(());
    };

    let path = app
        .path()
        .resolve(filename, tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("resolve {filename}: {e}"))?;
    let path_str = path.to_string_lossy().into_owned();

    app.run_on_main_thread(move || {
        let ns_path = NSString::from_str(&path_str);
        // SAFETY: `initWithContentsOfFile:byReference:` takes a valid NSString
        // path; `byReference: true` lets AppKit stream from disk.
        let sound = unsafe { NSSound::initWithContentsOfFile_byReference(NSSound::alloc(), &ns_path, true) };
        if let Some(sound) = sound {
            unsafe { sound.play() };
        } else {
            eprintln!("kriyon: preview_notify_sound could not load {path_str}");
        }
    })
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Off-macOS the preview is a no-op (no notification-sound feature there).
#[cfg(not(target_os = "macos"))]
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn preview_notify_sound(
    _app: tauri::AppHandle,
    _sound: kriyon_core::status::NotifySound,
) -> Result<(), String> {
    Ok(())
}
```

Note: verify the exact `NSSound` initializer name and signature against `objc2-app-kit` docs.rs (it may be `initWithContentsOfFile_byReference` or require a `MainThreadMarker`-free path). Adjust the `unsafe` call to match the generated binding.

- [ ] **Step 3: Register the command**

In `src-tauri/src/lib.rs`, in the `invoke_handler` list after `commands::set_notify_sound,`:

```rust
            commands::preview_notify_sound,
```

- [ ] **Step 4: Verify it builds**

Run: `PATH="$HOME/.cargo/bin:$PATH" cargo build -p kriyon-tauri`
Expected: builds clean; no clippy-pedantic rejections.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/commands.rs src-tauri/src/lib.rs
PATH="$HOME/.cargo/bin:$PATH" git commit -m "feat(notify): add NSSound preview command"
```

---

### Task 7: Settings UI — sound picker + preview button

**Files:**
- Modify: `src/settings/SettingsView.tsx` (new row in the Notifications group)
- Test: `src/settings/SettingsView.test.tsx`

**Interfaces:**
- Consumes: `NOTIFY_SOUND_OPTIONS` (Task 3); `useLayout` `notifySound`/`setNotifySound` (Task 3); `previewNotifySound` (Task 4); `tokens` (theme).

- [ ] **Step 1: Write the failing component tests**

Add to `src/settings/SettingsView.test.tsx`. Mock the bridge so the preview button can be asserted without a Tauri runtime:

```typescript
import { vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({
  previewNotifySound: vi.fn(() => Promise.resolve()),
}));

// ...existing imports include: import { previewNotifySound } from "../ipc/bridge.ts";

test("the sound control reflects and updates the store", () => {
  render(<SettingsView />);
  fireEvent.change(screen.getByLabelText("Notification sound"), {
    target: { value: "marimba" },
  });
  expect(useLayout.getState().layout.notifySound).toBe("marimba");
});

test("the preview button plays the selected sound", () => {
  useLayout.setState({
    layout: { ...DEFAULT_LAYOUT, notifySound: "bell" },
  });
  render(<SettingsView />);
  fireEvent.click(screen.getByRole("button", { name: "Preview notification sound" }));
  expect(previewNotifySound).toHaveBeenCalledWith("bell");
});

test("the preview button is disabled for Silent", () => {
  useLayout.setState({
    layout: { ...DEFAULT_LAYOUT, notifySound: "silent" },
  });
  render(<SettingsView />);
  expect(
    screen.getByRole("button", { name: "Preview notification sound" })
  ).toBeDisabled();
});
```

Note: if mocking the whole bridge module breaks other tests in the file, instead `vi.spyOn` the imported `previewNotifySound`, or move these into a dedicated `SettingsView.sound.test.tsx`. Keep existing tests green.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/settings/SettingsView.test.tsx -t sound`
Expected: FAIL — no `Notification sound` control / no preview button.

- [ ] **Step 3: Implement the sound row**

In `src/settings/SettingsView.tsx`: extend imports to include `NOTIFY_SOUND_OPTIONS` from `./settingsOptions.ts` and `previewNotifySound` from `../ipc/bridge.ts`; read `notifySound`/`setNotifySound` from `useLayout`. Add a styled `<select>` + preview `<button>` (tokens for color/spacing — never hardcode). Add the row to the existing **Notifications** `SettingGroup`, below the OS-notifications row:

```tsx
const selectStyle: CSSProperties = {
  background: tokens.color.chrome.window,
  border: `1px solid ${tokens.color.line.base}`,
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.primary,
  fontFamily: tokens.font.sans,
  fontSize: "13px",
  padding: `${tokens.space.xs} ${tokens.space.sm}`,
};

const previewButtonStyle: CSSProperties = {
  background: "transparent",
  border: `1px solid ${tokens.color.line.base}`,
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.primary,
  cursor: "pointer",
  fontSize: "13px",
  padding: `${tokens.space.xs} ${tokens.space.sm}`,
};
```

Control markup (a small flex wrapper so the select and ▶ sit together):

```tsx
<div style={{ alignItems: "center", display: "flex", gap: tokens.space.sm }}>
  <select
    aria-label="Notification sound"
    onChange={(event) =>
      setNotifySound(event.target.value as NotifySound)
    }
    style={selectStyle}
    value={notifySound}
  >
    {NOTIFY_SOUND_OPTIONS.map((option) => (
      <option key={option.value} value={option.value}>
        {option.label}
      </option>
    ))}
  </select>
  <button
    aria-label="Preview notification sound"
    disabled={notifySound === "silent"}
    onClick={() => {
      void previewNotifySound(notifySound);
    }}
    style={previewButtonStyle}
    type="button"
  >
    ▶ Preview
  </button>
</div>
```

Wrap in a `SettingRow` with `label="Notification sound"` and `hint="Plays when a session needs you or finishes. ▶ to preview."`. Import `NotifySound` from `../types.ts` for the cast. Verify `tokens.radius.sm` exists; if the token set differs, use the nearest existing radius token (never a literal).

- [ ] **Step 4: Run tests + typecheck + format**

Run: `pnpm vitest run src/settings/SettingsView.test.tsx && pnpm fix && pnpm check`
Expected: PASS / green.

- [ ] **Step 5: Commit**

```bash
git add src/settings/SettingsView.tsx src/settings/SettingsView.test.tsx
git commit -m "feat(settings): notification sound picker with preview"
```

---

### Task 8: Smoke-verify in the isolated build (Risk 1 + Risk 3)

Validates the two things unit tests can't: the bundled sound actually fires on a real notification (Resources-root resolution), and preview plays — in a signed/bundled app that does not collide with the user's production Kriyon.

**Files:** none (verification only).

- [ ] **Step 1: Build the isolated smoke app**

Use an isolated smoke build (`pnpm smoke`: distinct bundle identifier via `--config src-tauri/tauri.smoke.conf.json`, UUID-keyed daemons, unset APPLE creds). Build the bundled app so `UNNotificationSound` runs against a real `Contents/Resources`.

- [ ] **Step 2: Verify preview**

Open Settings, pick each non-silent sound, click ▶ Preview, confirm each plays and is distinct; confirm ▶ is disabled for Silent.

- [ ] **Step 3: Verify the delivered notification uses the chosen sound**

Set the sound to e.g. `Marimba`. Trigger a real notification (background a session until it blocks/finishes, or replay hook events to drive a status transition while unfocused). Confirm the OS notification plays `marimba.wav`, not the default alert. Repeat with `Silent` (banner, no sound) and `Default` (system alert).

- [ ] **Step 4: If the bundled sound does NOT play (Risk 1 realized)**

The file is likely nested under `Contents/Resources/<subdir>/` instead of the root. Inspect the built `.app` (`ls "<app>/Contents/Resources/"`); fix the `tauri.conf.json` `resources` map so the `.wav` files land at the Resources root, rebuild, and re-verify. Do not mark the feature done until the chosen sound fires.

- [ ] **Step 5: Final green + finish**

Run: `pnpm check` and `PATH="$HOME/.cargo/bin:$PATH" cargo test`. Then use `superpowers:finishing-a-development-branch` to decide merge/PR.

---

## Self-review notes

- **Spec coverage:** catalog + licensing (Task 1, 2, 3), audition gate (Task 1 Step 4), preview via NSSound + NSBeep (Task 6), notification attach via UNNotificationSound (Task 5), one-sound-for-all (single field, Task 3), persistence fallback (Task 3), IPC-typed enum (Tasks 2/5/6), CONTEXT.md term (Task 2), Risk 1 Resources-root (Tasks 5/8), Risk 2 NSBeep (Task 6), Risk 3 signing (Task 8). All covered.
- **Verify-before-code flags:** exact `objc2-app-kit` `NSSound` initializer binding, `NSBeep` export, and Tauri `bundle.resources` map syntax are each called out for doc verification in-task (per the repo's "verify library APIs" rule) rather than assumed.
- **Cross-task type consistency:** `NotifySound` ids identical across Rust enum (snake_case), TS union, options, persistence allowlist, and bundled filenames (`<id>.wav`).
