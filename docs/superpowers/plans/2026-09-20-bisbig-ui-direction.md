# BisBig UI direction — implementation plan

**Date:** 2026-09-20 · **Branch:** `feat/bisbig-ui` (from `main`) · **Scope:** visual/layout only.

Design source: design mockups, not in this repo (the main screen re-cut on the BisBig product system).

- The main session view — **the target.** One 1440×900 screen: sidebar · session column · Details rail.
- An older Changes-view layout mockup. **Layout reference only** — its palette is the *old*
  warm-grey one; we already ship that layout. Do not copy its colors.

## The rule for this work

**Take the look, not the features.** The canvas was drawn against an imagined app. Kriyon's terminal is
the source of truth (ADR-0019 removed the structured pane). Nothing in this plan adds a command, IPC call,
store field, or Rust change. If a design element needs data we don't already have in a frontend store,
it is dropped, not stubbed.

### In the design, NOT in Kriyon — do not build

| Design element | Why it's out |
|---|---|
| Structured transcript (user/Claude message cards, tool-call cards, inline diff, MCP banner) | ADR-0019 — the pane is the raw `claude` terminal |
| `Structured \| Raw` toggle | same |
| Inline `Allow` / `Deny` approval row | no structured prompts surface |
| Composer chips: permission mode (`Auto ▾`), effort (`● high`) | no such controls; keep only what `PromptBar` has today |
| Sidebar nav `Inbox`, `Projects`, `History` as destinations | no such views (History stays the in-group disclosure) |
| Workspace switcher (`Leafy Code ⌃⌄`) and user footer (avatar / name / email) | no accounts/workspaces |
| Issue key chip (`KRI-12`) in the breadcrumb | no issue tracking |
| `Files` and `Terminal` as header tabs | "All files" stays a tab inside the Changes tree; the terminal stays a bottom dock |
| Details → `Model` row, `This session +2 −4` row, `Weekly limit` bar, `$` cost tile | only render a row if the value is **already** in a store today (check `Inspector.tsx` / `UsageFooter.tsx`); otherwise omit |
| "Why" reasoning callouts + "also running" chips (changes reference canvas) | not features |

### In Kriyon, NOT in the design — must survive, restyled in the same language

View switcher (Studio / Focus / Command / Prompts) + Settings + About, terminal dock + `TerminalToggle`,
Needs-you section, sort/palette/project menus, drag handles, worktree chips, memory chips, Done / older /
inactive / archived folds, `UsageFooter`, `InspectorRail`, ReviewPanel, Activity panels, all of the
Changes view (tree, feed, jump rail, FileViewer + banners, BudgetNotice), composer pills + completion
popover, every overlay (palette, prompt picker/editor, spawn, needs-you, about, confirm, toast, context
menu), pane overlays, error boundaries, tray popover.

## Design language (extracted from the canvas)

**Character:** flat surfaces, hairline borders, no gradients, almost no shadow; depth = small lightness
steps on a cool blue-black. Satoshi for UI, JetBrains Mono for anything machine-ish (counts, branches,
paths, kbd, numbers). Row rhythm **30 / 32 / 46**.

### Color → `ThemeColors` key

| Key (`src/theme/themes/base.ts`) | Now | BisBig |
|---|---|---|
| `chromeWindow`, `chromeContent`, `bg` | `#1A1B1F` / `#1C1D22` / `#17181C` | `#0d1017` (window = content; one flat plane) |
| `chromeSidebar`, `chromeInspector`, `chromeRail` | `#17181C` | `#0f131c` |
| `chromeTitlebarTop` | `#1E1F24` | `#0d1017` (no gradient — see Phase 1) |
| `chromeOverlay`, `raisedTop`, `raisedBottom` | `#232429` / `#232429` / `#202126` | `#161b26` / `#10141d` / `#10141d` (flat card) |
| `promptCard` | white 3.5% | `#10141d` |
| `blockWell` | black 28% | `#12161f` |
| `chip` | — | `#161b26` |
| `lineSoft` / `lineBase` / `lineStrong` | white 5/6/8% | `#161b26` / `#1c212c` / `#232937` |
| `border` | white 6% | `#1f2531` (card border) |
| `inkBright` … `inkGhost` | `#F0F1F4` → `#55585F` | `#f2f5fa`, `#eceff5`, `#aab3c5`, `#79839a`, `#5c677d`, `#525d72`, `#525d72` (bright, primary, secondary, muted, dim, faint, ghost) |
| `surface1/2/3` | white 3.5/4.5/5.5% | white 3 / 4 / 5% — active sidebar row uses `surface3`→ 6%: set `surface3` = `rgba(255,255,255,0.06)` |
| `surfaceHover` / `surfaceActive` | 8 / 9% | 4% / 6% |
| input fill (search box) | — | `#1a2030` — reuse `surfaceActive`? **No**: add nothing; use `blockWell`-family key already closest, or add one key `inputWell` if and only if two+ call sites need it |
| `statusRunning` / `Ink` / `Soft` | `#4CC38A` … | `#3fb950` / `#3fb950` / `rgba(63,185,80,0.12)` |
| `statusWaiting` / `Soft` / `Wash` | `#E0A32E` … | `#d29922` / `rgba(210,153,34,0.12)` / `rgba(210,153,34,0.08)`; waiting **ink** is `#e3b341` (check whether a key exists; `statusMeta` may need it) |
| `statusDone` | `#4CC38A` | `#3fb950` (but Done rows render quiet: `✓` + `inkFaint` text) |
| `statusIdle` / `Soft` | `#85888F` | `#525d72` / `rgba(255,255,255,0.05)`; idle ink `#79839a` |
| `statusError` / `del` | `#F0909E` | `#f0716f`; `diffDelInk` `#ff9a98`; `delSoft` `rgba(240,113,111,0.12)` |
| `add` / `diffAddInk` / `addSoft` | `#6FCF97` … | `#3fb950` / `#3fb950` / `rgba(63,185,80,0.12)` |
| `scrim` | `rgba(10,10,14,0.55)` | `rgba(5,7,12,0.6)` |

**Accent — new `steel` theme** (design uses `oklch(… 225)`; themes must be hex because `applyTheme`
derives `--kr-accent-rgb` from hex and `themes.test.ts` requires parseable hex):

| Key | oklch in canvas | hex |
|---|---|---|
| `accent` (fills: Send, logo tile, Allow) | `oklch(0.55 0.11 225)` | `#007ea2` |
| hover of accent fill | `oklch(0.60 0.11 225)` | `#138db1` |
| `accentBright` (tab underline, active-row bar, progress) | `oklch(0.72 0.11 225)` | `#49b3d8` |
| `accentInk` (text on accent tint) | `oklch(0.85 0.08 225)` | `#93d9f5` |
| `onAccent` | — | `#ffffff` |

Hexes are computed conversions — eyeball them against the canvas in the running app and nudge if needed.

**Leave alone:** the whole `syntax` block, `codeWell`, `editor*` keys (pinned by
`themes.test.ts`), `traffic`, `pill.*` hues, xterm ANSI colors, `projectColor` hues.

### Non-color tokens (`src/theme/tokens.ts`)

| Token | Now | BisBig |
|---|---|---|
| `font.sans` | system stack | `'Satoshi', -apple-system, system-ui, sans-serif` |
| `font.mono` | JetBrainsMono Nerd Font … | unchanged |
| `radius` | sm 5 · md 7 · lg 9 · xl 12 · pill 20 | sm **4** (chips/kbd 3–4) · md **6** (rows, buttons, inputs) · lg **8** (cards) · xl 12 (dialogs) · pill **9999px** |
| `gradient.titlebar/raised/accent` | gradients | flat: publish single-color "gradients" (`linear-gradient(c, c)`) from `applyTheme` so call sites don't change, or swap call sites to `background` colors — pick whichever is fewer edits; keep `applyTheme.test.ts` invariant (concrete hex, no `var(`) |
| `shadow.raised` | `0 1px 3px …` | `none` (flat). Keep `pop` / `toast` / `window` for true overlays |
| base type | 13px | 13px / 1.45 body; **12.5px** row text; **11–11.5px** mono meta; section labels **9.5px · 700 · 0.14em · uppercase · `inkFaint`** |

**Metrics:** header rows **46px**; nav/sidebar/input rows **30px**; key-value + list rows **32px** with a
`lineSoft`-ish bottom hairline (`#141926`); pills 22px; chips 24px; primary button 28px; icon buttons
26×26 r6; status dots 6–7px; project swatch 8×8 r2; sidebar **236px** default; Details **280px**.

**Font files:** Satoshi Regular/Medium/Bold `.woff2` (Fontshare, free for commercial use — record the
license file next to them). Put in `public/fonts/`, add three `@font-face` blocks in `src/App.css` next
to the JetBrains ones (`font-display: block`, self-hosted — no network fonts). Source: Fontshare download.
The tray document
(`tray.html`) needs the same faces — check how it gets `App.css`.

## Screen-by-screen adaptation

### A. Shell — the title bar goes away

Design has **no global title bar**: traffic lights sit in the sidebar's top 46px strip; the main column
starts with its own 46px header. Today `Shell.tsx` has a 48px `TitleBar` (logo, wordmark, sidebar toggle ·
view `Segmented` · TerminalToggle, Search ⌘K, ⚙, ⓘ, inspector toggle).

New shell = `row[ Sidebar | main column | Details ]`, full height. Everything in `TitleBar` is rehomed:

| TitleBar item | New home |
|---|---|
| Logo + "Kriyon" wordmark | Sidebar **brand block** (30px accent tile r8 holding the existing `logo-mark.svg` — keep the real mark, not the canvas's `>_`; wordmark 14px/700; **no** subtitle, **no** switcher chevrons) |
| View switcher Studio/Focus/Command/Prompts | Sidebar **nav rows** (30px, icon + label + mono count): `Sessions` (studio; count = open sessions), `Command center` (count = needs-you, amber like the canvas's Inbox `1`), `Prompts`. `Focus` = an icon button in the sidebar's top strip (it *is* "hide the chrome"). Active row: `surface` 5% fill + bright ink + 500 |
| Search ⌘K | the sidebar search box (see B) |
| ⚙ Settings, ⓘ About | sidebar footer, beside the usage totals (`UsageFooter` already has the Settings button) |
| Sidebar toggle `◧` | sidebar top strip, right-aligned. When collapsed, it reappears at the left of the main header |
| TerminalToggle | right end of the main **tab row** (where the canvas has `Structured\|Raw`) |
| Inspector toggle `◨` | Details header (expanded) / `InspectorRail` (collapsed) — as the canvas draws it |

Hard constraints (from `Shell.tsx` comments + `docs/perf-audit.md`):

- `SessionBody` stays **mounted once and display-toggled**; the center column's tree position must not
  change between modes — a remount disposes every xterm. Restructure *around* it.
- The sidebar must now be visible in Command / Prompts / Settings too (nav lives there). Lift
  `SidebarPanel` out of `SessionBody` to `Shell` level so it persists across views; `SessionBody` keeps
  center + inspector. In `focus`, the sidebar slot renders `FocusRail` instead.
- **Traffic lights:** `trafficLightPosition {x:19,y:25}` was tuned for a 48px bar; for a 46px strip use
  `y: 23`-ish (`src-tauri/tauri.conf.json` — config only, no Rust). The 96px left clearance moves from
  the title bar to: sidebar top strip (always), `FocusRail` top (46px spacer), and the **main header's
  left padding when the sidebar is collapsed**.
- `data-tauri-drag-region` must be on every element in the top 46px band: sidebar top strip, main
  header, Details header, and the headers of Command/Prompts/Settings. Buttons inside opt out as today.
- `FocusRail` (64px): 46px light-clearance spacer, project tiles (r8, flat, `line` border; active =
  accent tint), bottom cluster gains view tiles (Sessions/Command/Prompts icons) since the switcher is
  gone, then `⌘K`.
- Keep `data-testid="app-shell"` 100vw×100vh (`Shell.test.tsx:316`).

### B. Sidebar (`src/sidebar/*`)

Top→bottom: **top strip** (46px; lights clearance + Focus + collapse buttons) → **brand block** →
**search box** → **nav rows** → `NeedsYouSection` → `PROJECTS` section label → project groups → folds →
**footer**.

- **Search box** = the existing "Filter sessions…" input, restyled to the canvas box (30px, `#1a2030`
  fill, `lineBase` border, r6, lucide `Search` 12px, 12.5px placeholder). Its right end gets a `⌘K`
  kbd chip that is a button → `openPalette`. Sort + `+` buttons move to the `PROJECTS` label row
  (right-aligned, hover-revealed like header actions). Behavior and labels unchanged.
- **Section label** `PROJECTS`: 9.5px/700/0.14em `inkFaint`, padding `22px 18px 6px`. Reuse the same
  style for every section label app-wide (sidebar, Details, Settings, tray) — one shared style object.
- **ProjectHeader**: 30px, r6 hover, `▾/▸` 9px chevron `inkFaint`, **8×8 r2 project swatch**
  (`projectColor`), name 500 `inkSecondary` (collapsed group: `inkMuted`), rollup dot 6px, mono count
  11px `inkDim`. Hover actions unchanged, 26px r6 icon buttons.
- **SessionRow**: 30px (meta line keeps its second line where it exists — do not drop the meta chips;
  let those rows grow to ~46px), padding-left 26px, r6, 12.5px title.
  - running: 7px filled green dot, title `inkSecondary`
  - idle: 7px **hollow** ring (1.5px `inkFaint`), title `inkMuted`
  - done: `✓` 10px `inkFaint`, title `inkFaint` (quiet)
  - waiting: amber dot, title `inkPrimary`, **row wash** amber 8% (hover 12%), trailing `Waiting` label
    10.5px/500 `#e3b341`
  - active: fill white 6% + title `inkBright` 500 + **2px accent-bright bar** at left:10px, inset 8px
    top/bottom, r2
  - sleeping / resuming / error: keep glyphs, recolor to the new ramp
- `NeedsYouSection`, folds (`N done`, `N older · history`, inactive, Archived), `EarlierSessions`:
  same 30px row + label styles. Menus (`SortMenu`, `PaletteMenu`, `ProjectMenu`, `SessionActionsMenu`)
  via `anchoredMenuSurfaceStyle`: `chromeOverlay` fill, `border`, r8, 30px items r6.
- **Footer** (`UsageFooter`): top hairline, padding `12px 14px`; totals in mono; Settings + About icon
  buttons right. No avatar.

### C. Main column header (`src/layout/SessionHeader.tsx`)

Two 46px rows, each with a bottom hairline, padding `0 20px`:

1. **Breadcrumb row.** Left: `Sessions` (`inkMuted`) `/` **18px project tile** (r4, project color at
   ~35% alpha, first letter 10px/700) + project name 500 `/` session title (`inkSecondary`, ellipsis).
   Right: **status pill** (22px, r-pill, soft status fill, 6px dot, 11.5px/500 — Running / Waiting for
   you → keep today's label strings / Done / Idle / Error), `⎇ branch` mono 11px `inkMuted`, `⋯`
   26px icon button (keep inert as today).
2. **Tab row.** Left: **underline tabs** replacing the `Segmented` — `Session` (= today's Raw) and
   `Changes` + mono count (= today's "N changes" chip, folded into the tab). Active: `inkBright` 500 +
   2px `accentBright` bottom border; inactive `inkMuted`, hover `inkSecondary`. Right: `TerminalToggle`,
   composer-reveal if applicable.
   - Tab **labels change** ("Files & Changes | Raw" → "Changes | Session") — update tests and the
     `CONTEXT.md` / `FEATURES.md` wording. Keep `aria`/testids and the `transcriptView` values.
   - Build the underline tabs as a variant of `src/ui/Segmented.tsx` (`variant="underline"`), not a new
     component — same props, same keyboard behavior.

### D. Session pane (terminal) — `App.tsx` `SessionPane`, `src/theme/terminalTheme.ts`

Terminal background follows `chromeContent` → `#0d1017` automatically; foreground `inkPrimary`
`#eceff5`; cursor `accentBright`. ANSI untouched. Pane padding `20px 24px 8px` like the canvas
transcript. Restyle `SessionLoadingOverlay`, `SessionResumeFailedOverlay` (card: `#10141d`, `border`,
r8; buttons per G).

### E. Composer (`src/layout/PromptBar.tsx`, `src/completion/CompletionPopover.tsx`)

Wrapper padding `8px 24px 20px`. Box: `#10141d`, `border` 1px, r8, focus-within border `#323b4e`
(→ `lineStrong`-plus; add no token unless reused). Placeholder 13px `inkFaint`. Footer: left = existing
`Session ▾` chip styled as canvas chip (24px, r4, `#161b26`, `border`, 12px `inkSecondary`) + usage meta;
right = `Save prompt`, `Prompts ⌘⇧P` as ghost chips, `↵` kbd (mono 10px, `#262c3a` border, r3), **Send**
(28px, r6, accent fill, white 12.5px/500, hover accent-hover). "Send ↵" text is asserted in tests — keep
the accessible name. Mode chip, highlight pills, reveal strip, completion popover: new surfaces/radii only.

### F. Details rail (`src/inspector/*`)

- Width **272 → 280** (`INSPECTOR_WIDTH`). Fill `chromeInspector`, left hairline.
- New **46px header**: `Details` 500 + `◨` collapse button (moves from the title bar).
- Body padding `16px 18px`, sections 22px apart, section labels per B.
- Section order to match the canvas: **Session → Changes → Usage → Review → Activity**.
- **Key-value rows** (shared style in `inspector/chrome.tsx`): 32px, label 12.5px `inkMuted`, value
  12.5px `inkPrimary` (mono 11px for branch/dir/sync), bottom hairline `#141926` except last.
  - Session: add a **Status** row (dot + label from `statusMeta` — data already in the store), then
    Branch / Started / Directory. `Model` only if already available.
  - Changes: Uncommitted / Sync (+ `ChangedFilesList` below, 32px rows).
  - Usage: `Context window` + mono %, **4px bar** (`#1a2030` track, `accentBright` fill; amber when the
    existing tone says so), two **stat tiles** (`#12161f`, `border`, r8, padding `10px 12px`, value 16px
    mono, caption 11px `inkMuted`) — tokens / this session, as today.
- `InspectorRail` (46px), `ReviewPanel`, `ActivitySection` + panels, empty state: same row/label/tile
  vocabulary. `CollapsibleSection` chevron → 9px `inkFaint`.

### G. Shared primitives — do this once, early

There is no shared Button/Input/Badge today (~150 ad-hoc style objects). Do **not** build a component
library (YAGNI), but add one module of **style recipes** the restyle converges on —
`src/theme/recipes.ts` (pure `CSSProperties` builders from `tokens`):
`sectionLabel`, `row30`, `kvRow`, `iconButton`, `button("primary" | "secondary" | "ghost" | "danger")`,
`chip`, `kbd`, `pill(status)`, `card`, `inputBox`, `statTile`. Each screen's pass replaces its bespoke
objects with these. `Kbd.tsx`, `Segmented.tsx`, `CollapsibleSection.tsx`, `Overlay.tsx`,
`ConfirmDialog.tsx`, `ContextMenu.tsx`, `AnchoredMenu.tsx`, `Toast.tsx`, `ErrorBoundary.tsx` adopt them first.

Buttons from the canvas: primary = accent fill, white, r6, 500; secondary = transparent, `#232937`
border, `inkSecondary`; heights 24 (inline) / 28 (composer, dialogs). Danger = `del` ink + `delSoft` fill.

**Icons:** replace scattered text glyphs (`◧ ◨ ⚙ ⓘ ⌕ ⋯ ▸ ▾ ✦ ✓ ✗ ⏳`) with lucide equivalents at
12–14px, stroke 1.75 — keep every `aria-label`/`title`. Keep `⎇`, `↵`, `⌘K` text (they are type, in mono).

### H. Changes view (`src/changes/*`)

Layout already matches the reference canvas (tree 236 · feed · jump rail 26) — **recolor only**:

- `SummaryBar`: 46px (from ~54), hairline bottom, no tinted background; pulse stays (accent tint).
- `FileTreePane` tabs `Changed | All files`: small `Segmented` in the canvas's inset style (`#12161f`
  track, `lineBase` border, r6, 22px items r4, active white 6%).
- Tree rows 30px r6; dir labels mono 10.5px `inkFaint`; `NEW` badge green soft; `+N −M` mono 10–11px.
- `DiffFileCard`: `#10141d`, `lineBase` border, **r8**, header 32px with `#161b26` bottom hairline, mono
  path 11–12px. `DiffHunk`: mono 11.5px / 1.7; add row `addSoft` + `#3fb950`; del row `delSoft` +
  `#ff9a98`; context `inkFaint`; well `#0d1017`. (Syntax token colors untouched — note added-line *ink*
  vs shiki tokens: keep today's precedence.)
- `JumpRail` dots: active `accentBright` + 3px accent ring, viewed `inkGhost`, unseen `inkFaint`.
- `FileViewer` header + all banners (`CloseGuard`, `SwitchGuard`, `SaveError`, `StaleOnDisk`,
  `MissingOnDisk`, `Notice`), `BudgetNotice`: the canvas's amber banner recipe — 34px, r6, amber 10%
  fill, amber 18% border, 6px dot, `#e3b341` text; error variant in `del`. `CodeEditor` chrome: gutter /
  active line stay as they are; only the surrounding frame changes.
- "My edits only" switch: track `#1a2030`, on = accent.
- `FileBrowserTree` draft row, inline errors, refusal banner, `ContextMenu`: recipes from G.

### I. Terminal dock (`src/layout/TerminalDock.tsx`, `src/terminal/*`)

Top hairline, tab strip as inset segmented (H), 24px pane headers mono 11px, split handles 1px
`lineBase`, empty state + "Shell exited — Restart" with G buttons. Terminal bg = `chromeContent`.

### J. Full views — `CommandCenter`, `PromptsView`, `SettingsView`

Now render to the right of the persistent sidebar. Each gets the same **46px header row** (title 500,
right-aligned controls, hairline, drag region) and a `20px 24px` body.

- Command center: needs-you rail rows = the amber waiting row recipe; standing rows 32px with dot + label.
- Prompts: search = `inputBox`; rows 46px with hairlines; `PromptRowActions` = icon buttons.
- Settings: groups = section label + card (`#10141d`, `border`, r8) of 46px `SettingRow`s with hairlines;
  `Segmented` inset style; `<select>` + Preview as `inputBox` / secondary button. **Theme picker gains
  `Steel`** (see Phase 1).

### K. Overlays

`Overlay` scrim new `scrim`, keep `blur(8px)`. Panels: `chromeOverlay` `#161b26`, `border`, **r12**,
`shadow.pop`. Palette / PromptPicker: search row 46px with hairline, result rows 32–36px r6, active
white 6% (+ optional 2px accent bar), `kind` label mono 10.5px, `esc` = `kbd`. `SpawnDialog` mode cards:
`card` recipe, selected = accent border + accent 8% fill. `ConfirmDialog`: detail lines in `blockWell`,
buttons per G. `About`, `NeedsYouOverlay`, `PromptEditor`, `Toast` (`#161b26`, `border`, r8,
status-colored 6px dot), `CompletionPopover`, `ContextMenu`.

### L. Tray popover (`src/tray/TrayPanel.tsx`, `tray.html`)

Same tokens flow in automatically; then: header accent tile r8, section labels, rows 30/46, footer
actions as ghost buttons, Degraded/Empty states with G buttons. Ensure Satoshi loads in the tray document.

## Phases (each ends green: `pnpm fix` → `pnpm check`, one or more conventional commits)

TDD applies to behavior. For pure restyle, the "test first" step is: update the style-assertion test to
the new expectation, watch it fail, then restyle. Prefer asserting **token identity**
(`tokens.color.x`) over literals so the next palette change is free.

**Phase 0 — groundwork.** Branch `feat/bisbig-ui`. ADR `docs/adr/0023-bisbig-visual-direction.md`
(flat cool chrome, Satoshi, steel default, title bar removed / nav in sidebar, what was deliberately not
taken). Add to `CONTEXT.md` *before* using as names: **Brand block**, **Nav row**, **Details rail**
(alias of Inspector — decide: keep `Inspector` in code, "Details" is only the visible label),
**Style recipe**, **Steel** theme.

**Phase 1 — tokens & theme (biggest visual win, smallest diff).**
`base.ts` chrome values; new `themes/steel.ts` + registry, `DEFAULT_THEME_ID = "steel"` (persisted
explicit ids keep working via `themeById`); radius/font/shadow/gradient tokens; Satoshi `@font-face`;
`App.css` scrollbar + selection tints. Tests: `themes.test.ts` (ids, default, labels — syntax pin must
still pass untouched), `tokens.test.ts`, `applyTheme.test.ts`, `terminalTheme.test.ts`.
Update `docs/kriyon-palette.html` `:root` to mirror the new `darkChrome` (it's documented as a mirror).
→ Run the app (`skill: run`) and screenshot: every screen should already read "BisBig-ish".

**Phase 2 — recipes + primitives (G).** `src/theme/recipes.ts` with unit tests; convert `src/ui/*`.

**Phase 3 — shell restructure (A).** The only structurally risky phase. Remove `TitleBar`; lift the
sidebar to `Shell`; sidebar top strip / brand / nav; rehome every control; drag regions; traffic-light
position; `FocusRail`. Tests: `Shell.test.tsx` (view switching now via nav rows; keep role/name queries
working — nav rows are `button`s or a `tablist` with the same accessible names "Studio"→**decide**: keep
the accessible names `Studio/Focus/Command/Prompts` even if visible labels read Sessions/Command
center/Prompts? **No — rename both and update tests**; visible and accessible names must match),
`App.test.tsx`, `CollapsePanel.test.tsx`. Verify in the real app: xterm sessions survive every view
switch (no remount), window drags from all three header zones, lights don't overlap content with the
sidebar collapsed and in Focus.

**Phase 4 — sidebar (B).** `Sidebar.test.tsx` is the highest-risk test file (18 style assertions: active
row bg `:308`, status dot `:529`, waiting wash `:826/:957`, grip width `:1113`, error ink `:1674`, memory
chip `:1727`).

**Phase 5 — header + tabs + composer (C, E).** `Segmented` underline variant (+ test), label rename
fallout, `PromptBar.test.tsx`.

**Phase 6 — Details rail (F).** `Inspector.test.tsx`, `ChangedFilesList.test.tsx`, activity panel tests.

**Phase 7 — Changes view + terminal dock (H, I).** `ChangesView/DiffHunk/JumpRail/DiffFeed/FileViewer/
fileIcon/TerminalWorkspace/TerminalDock` tests.

**Phase 8 — full views, overlays, tray (J, K, L).**

**Phase 9 — sweep.** `grep` for leftovers: hard-coded hex/rgba outside `src/theme/`, old radii literals
(`"9px"`, `"7px"`, `"5px"`), `tokens.gradient.`, text glyph icons, `fontWeight: 600` where the canvas
uses 500/700 (Satoshi has no 600 face — **map every 600 → 500 or 700**, or the browser synthesizes it).
Update `FEATURES.md` § Appearance (themes list, Satoshi, "title bar carries the mark" → sidebar),
`CONTEXT.md` entries, website screenshots are out of scope (note in PR). Full manual pass with
`skill: run` over every surface in the inventory below; reduced-motion still respected; AA contrast
check on `inkFaint` `#525d72` over `#0d1017` (≈2.9:1 — **fails AA for text**: use it only for
decorative glyphs/placeholders as the canvas does; anything that must be read uses `inkMuted` `#79839a`
or brighter. FEATURES.md promises AA).

## Surface checklist (nothing may be left in the old look)

Shell · FocusRail · Sidebar (filter, nav, NeedsYou, ProjectHeader, SessionRow all statuses, meta chips,
folds, EarlierSessions, ArchivedGroup, UsageFooter, ResizeHandle, InlineRename, Sort/Palette/Project/
SessionActions menus, inline worktree-remove confirm) · SessionHeader · SessionPane + Loading /
ResumeFailed overlays · App empty state · PromptBar (+ mode chip, pills, reveal strip) ·
CompletionPopover · Inspector (+ rail, ChangedFilesList, ReviewPanel/FileBlock/MergeResult/ArchiveOffer,
Activity/Agents/Tasks/Background, empty) · ChangesView (SummaryBar, BudgetNotice ×2, FileTreePane,
FileBrowserTree + draft/error/refusal/context menu, DiffFeed, DiffFileCard expanded/collapsed, DiffHunk,
JumpRail, FileViewer + 6 banners + discard confirm, ReadOnlyFileView, CodeEditor frame, empty/loading/
error) · TerminalDock / Workspace / TabPaneGrid / PaneView (+ dead shell, empty) · CommandCenter ·
PromptsView · SettingsView · CommandPalette · PromptPicker · PromptEditor · SpawnDialog · NeedsYouOverlay ·
About · ConfirmDialog (6 adapters) · QuitConfirm · Toast ×2 · ContextMenu · ErrorBoundary fallbacks ×4 ·
Tray (grouped, compact, degraded, empty).

## Invariants — break none of these

- Frontend only. No IPC/Rust/store-shape changes (one exception: `trafficLightPosition` in
  `tauri.conf.json`).
- Colors/spacing only via `src/theme/tokens.ts` (+ recipes). New `ThemeColors` keys only when ≥2 call
  sites need them; every key must be added to `types.ts`, `base.ts`, and flows through `applyTheme`.
- ADR-0007 seam: module-level style objects, `var(--kr-*)`, no ThemeProvider. xterm reads the concrete
  theme.
- Keep every `data-testid`, `aria-label`, keyboard shortcut, and `data-tauri-drag-region`.
- Display-toggle, never unmount: `SessionBody`, panes, dock, PromptBar (`suppressed`), Changes sub-views.
- Syntax/editor palette pinned — don't touch.
- `pnpm fix` formats; never hand-format. `pnpm check` before every commit. Commit messages via file
  (heredocs get lost in compound commands).

## Open decisions (defaults chosen above — change here if the user says otherwise)

1. **Nav mapping:** Sessions / Command center / Prompts as sidebar nav rows; Focus as a top-strip icon;
   Settings + About in the footer.
2. **Default theme becomes Steel**; Indigo / Cool blue / Teal / Graphite remain selectable on the new chrome.
3. **Tab labels** become `Session` / `Changes` (from `Raw` / `Files & Changes`).
4. **Details** is the visible label; code keeps `Inspector`.
5. Brand block uses the real logo mark on the accent tile, not the canvas's `>_`.
