# ADR 0024 — Claude Code's fullscreen rendering: host it correctly, don't force it

**Status:** accepted · 2026-09-20

**Depends on:** [ADR-0004](0004-server-side-screen-snapshot-for-reattach.md) (the
reattach snapshot this breaks) · [ADR-0019](0019-remove-the-structured-pane.md)
(why the transcript pipeline is unaffected) · [ADR-0002](0002-best-effort-background-shell-status.md)
(the same "the terminal is the source of truth" stance)

## Context

Claude Code ships an alternative renderer — [fullscreen
rendering](https://code.claude.com/docs/en/fullscreen) — that draws the CLI on
the terminal's **alternate screen buffer**, the way `vim` and `htop` do. It
keeps only visible messages in its render tree, so memory stays flat however
long the conversation runs, it eliminates the flicker and scroll-jumping that
streaming output causes, and it captures the mouse to do its own selection,
click-to-expand and wheel scrolling.

On paper that is aimed squarely at Kriyon's documented pressure points: DOM
weight, the per-frame write queue, and the backpressure chain behind it
(`docs/perf-audit.md`). Kriyon could opt every session in by putting
`CLAUDE_CODE_NO_FLICKER=1` into the spawned shell's environment.

Two facts reframe the question before any of that matters.

**First, this is not Kriyon's decision to make.** Kriyon hosts *the user's own*
`claude` — that is the whole loose-coupling stance in `AGENTS.md`, and the
reason ADR-0019 deleted the pane that tried to redraw the conversation. The
renderer is a thing the user chooses with `/tui fullscreen` or `/tui default`,
and the CLI persists that choice as the `tui` setting. In the documented
precedence order, `CLAUDE_CODE_NO_FLICKER=1` is checked **above** a saved `tui`
setting — so a Kriyon that sets it silently overrules a user who deliberately
ran `/tui default`, in their own CLI, from a GUI that claims not to own it.

**Second, and decisively: Kriyon already hosts fullscreen sessions today.** The
CLI's own default table starts a session in fullscreen when the user first used
Claude Code on or after 6 May 2026, or — for sessions that don't fetch feature
flags — when the machine's first launch ran v2.1.239 or later. Kriyon does
nothing to opt in, and a large share of its users are already in this mode. The
live question is therefore not "should Kriyon turn this on" but **"is Kriyon
correct when it is already on"**, and reading the seams against the docs says:
not yet, in four specific places.

## Decision

**Kriyon sets no renderer environment variable — not `CLAUDE_CODE_NO_FLICKER`,
not `CLAUDE_CODE_DISABLE_MOUSE`, not `CLAUDE_CODE_SCROLL_SPEED`. The work this
ADR authorises is compatibility: make a fullscreen `claude` render, reattach,
scroll and copy correctly in Kriyon's terminal.** Opting in is revisited only
after that, and only as a Setting that is off by default.

### The four defects, and how each was closed

These were found by reading the seams against the CLI's documentation and
against xterm.js's and `vt100`'s source, not by observation. All four are fixed;
none is yet confirmed against a real fullscreen `claude`, which still wants a
`pnpm smoke` pass.

#### 1. Reattach puts xterm and `claude` in different buffers (ADR-0004) — *fixed*

The daemon repaints a reattaching client from `vt100::Screen::state_formatted()`.
That is exactly two things: `write_contents_formatted` (the visible grid, its
attributes and cursor) and `write_input_mode_formatted` (application keypad,
application cursor, bracketed paste, mouse protocol mode and encoding). The
alternate-screen flag is a *getter* on `vt100::Screen`; it is never serialised.
`state_formatted()` never emits `\x1b[?1049h`.

So on reattach to a fullscreen session, the daemon paints the contents of
`claude`'s **alternate** grid into an xterm sitting in its **normal** buffer.
The screen looks right. Everything downstream of "which buffer am I in" is now
wrong:

- `scrollWithoutMouseTracking` branches on `term.buffer.active.type ===
  "alternate"` to choose between scrolling xterm's scrollback and forwarding
  arrow keys. After a reattach it takes the wrong branch.
- When `claude` eventually exits it emits `\x1b[?1049l` to *leave* a buffer
  xterm never entered, restoring whatever the normal buffer held.
- Every fullscreen repaint accumulates into xterm's normal-buffer scrollback
  rather than being confined to the alternate grid — which gives back exactly
  the flat-memory property that made fullscreen attractive in the first place.

The fix belongs in the daemon, where the fact is known, and is the one defect
this ADR lands with it: `screen_snapshot` now leads every snapshot with DECSET
1049 or DECRST 1049, so a repaint moves the client *out* of the alternate
screen as readily as into it. The switch has to lead, because
`state_formatted()` opens with a clear — emitted after it, the clear and the
contents would land in the buffer being left.

#### 2. The wheel fallback types into the user's prompt — *fixed*

`arrowKeyReport` exists because the alternate buffer has no scrollback, so the
terminal convention for a wheel event in a full-screen app that has *not*
grabbed the mouse is to send arrow keys — which is right for `less`, `man` and
`git log`.

`CLAUDE_CODE_DISABLE_MOUSE=1` — the documented way to keep native text
selection while keeping flicker-free rendering — produces exactly that shape:
alternate buffer, no mouse tracking. But Claude's fullscreen prompt reads a bare
`↑`/`↓` as cursor movement and history navigation; it scrolls on `PgUp`/`PgDn`.
So under that combination Kriyon's wheel would walk the user's prompt history
instead of scrolling the conversation.

No escape sequence says *which program* is on the alternate screen, so anything
here is a heuristic. The one the terminal does expose is **bracketed paste**
(DECSET 2004): an app asks for it because it has somewhere for pasted text to
go, and a pager has nothing to paste into and never asks. Bracketed paste on
therefore means "there is an input line here", which is exactly the case where
the arrow keys are input rather than navigation.

So `readsArrowsAsScroll` gates the translation on bracketed paste being *off*.
Pagers keep the wheel they have always had; an app with a prompt gets a wheel
that does nothing, and the user scrolls with `PgUp`/`PgDn` — which is what
Claude's own documentation tells them to do in this configuration anyway. The
heuristic is chosen for its failure mode: a dead wheel is recoverable, a wheel
that eats a half-written prompt is not.

Sending `PgUp`/`PgDn` instead was the other candidate and is worse on both
sides: a wheel notch becoming half a screen is wrong for Claude, and several
per gesture is wrong for everyone.

#### 3 and 4. ⌘C stops copying, and file links leave the validated seam — *fixed together*

`tryCleanCopy` is gated on `term.hasSelection()`. With mouse capture on, a drag
inside the terminal never becomes an xterm selection — it goes to `claude` —
so `hasSelection()` is always false. Kriyon's logical-line reflow copy
(`cleanCopy.ts`, which rejoins soft-wrapped rows) and its toast are both dead,
and ⌘C in the terminal does nothing at all.

The same capture costs the file-link seam. `registerLinkProvider` +
`openFileToken` route a clicked path through `openPath` / `revealPath`, which
the Rust core re-validates (the trust-boundary rule). A captured click never
reaches the provider, so `claude` opens the path itself and Kriyon's
⌘-click-reveals-in-Finder goes with it. The CLI does defer to the terminal's own
link handler in xterm.js-based terminals, but it detects those by environment
(`TERM_PROGRAM`), and Kriyon's PTY sets none of it.

Both come from one missing option. xterm's escape hatch is
`SelectionService.shouldForceSelection`, and on macOS it reduces to
`event.altKey && options.macOptionClickForcesSelection` — an option that
defaults to **false**. So in Kriyon there was no gesture at all that made a
terminal selection once a TUI enabled mouse tracking; `tryCleanCopy`'s
`hasSelection()` could never be true, and the linkifier's own
`shouldForceSelection` check could never pass.

Turning it on restores both, for the Option-held gesture only: Option+drag
selects and Option+click activates a link, with the mouse report suppressed for
that gesture and nothing else changed. It is also the key Claude Code's own
on-screen hint names for iTerm2 and most terminals — so the hint it prints
inside Kriyon becomes true, which it was not before.

> **Correction (2026-10-03).** The premise that "a captured click never reaches
> the provider" is wrong for xterm 6.1: its `Linkifier` activates on mouseup
> with no check for mouse tracking, so a plain click both reached `claude` and
> opened the link. Kriyon now gates both link handlers on
> `shouldActivateLink` (`src/terminal/links.ts`): with tracking on, only
> Option+click opens a link.
>
> **Correction (2026-10-07).** That gate broke links outright, and is gone.
> Observed in a smoke build: every click on a link in a fullscreen `claude`
> arrived without a modifier, was refused by the gate, and opened nothing. The
> plain click is the gesture users reach for, and `claude` does nothing with a
> click on a link — it leaves links to xterm.js terminals' own handler, and
> lets a plain click open a link itself in Ghostty and Warp. So a plain click
> opens a link again whether or not the app tracks the mouse, and Cmd/Ctrl+click
> reveals a file in Finder. The click still reaches `claude` too; on a link
> that is harmless.

What this does **not** do is make a bare ⌘C copy from a captured app, and
nothing can: xterm.js sends `Ctrl+Shift+C` as `0x03`, indistinguishable from an
interrupt without the kitty keyboard protocol, so translating ⌘C into it would
risk killing the user's turn. ⌘C stays inert with no selection, which is what it
has always been.

### What is *not* at risk

- **The headless transcript pipeline is safe** (ADR-0019). `transcript.rs`
  parses `~/.claude/projects/**/<id>.jsonl`, and activity/ask/status come from
  hook events; neither reads the screen. Usage totals, the unseen-output badge,
  the Needs-you snippet and the handoff prompt all keep working. One thing to
  verify rather than assume: `/tui fullscreen` **relaunches the CLI process**
  mid-session, so Kriyon should confirm the new process re-binds through its
  `SessionStart` hook and that usage totals neither double-count nor reset
  across the relaunch.
- **`installStrayCaretGuard` is low risk, and probably helped.** The macOS
  WebKit freeze needs a *collapsed caret in non-editable content*. Mouse capture
  means a click in the terminal lands in xterm's editable helper textarea, which
  is the bounded case the guard exists to force. Confirm it in smoke; do not
  assume it either way.
- **Wheel scrolling still works when mouse capture is on.** `vt100` *does*
  serialise mouse protocol mode and encoding, and Kriyon's wheel handler already
  forwards one line report per step to a mouse-grabbing TUI. That path is the
  one fullscreen uses.

### `/diff` — defer to the CLI, do not suppress it

In fullscreen, `/diff` opens a panel beside the conversation. It overlaps
Kriyon's Changes view only in the word "diff": Kriyon's view is git-derived
against a captured baseline (ADR-0015) and spans everything in the working tree,
including the user's own edits and other tools'; Claude's panel shows what
Claude changed in this conversation. They answer different questions and there
is no IPC that could make one drive the other.

Kriyon neither suppresses it nor defers to it — it ignores it, which is the same
answer as for every other Claude Code command. Suppressing a command inside the
user's own CLI is precisely the coupling `AGENTS.md` forbids.

### `CLAUDE_CODE_SCROLL_SPEED` specifically

Never set it. `wheelScroll.ts` already normalises a coarse notch and a fine
trackpad delta into line-steps and forwards one report per step. A CLI-side
multiplier applies on top of that, so the two compound.

## Consequences

- **The `tui` setting keeps meaning what it says.** A user who runs
  `/tui default` in a Kriyon session gets the classic renderer, and one who has
  never touched it gets whatever their Claude Code version defaults to.
- **(1) is a daemon change**, so it lands behind the usual caveat from ADR-0004:
  a daemon already running on an old binary keeps its old behaviour until its
  session's daemon restarts. It is also unverified against a real fullscreen
  `claude` — the unit tests pin the escape codes and their order, not the
  round trip through xterm.js.
- **(2) is a heuristic and will be wrong for some app.** An alternate-screen
  program that enables bracketed paste *and* wants arrow keys to scroll loses
  its wheel. Nothing in the protocol distinguishes the two cases, so the trade
  is deliberate and the failure it prefers is the recoverable one.
- **(3) is only half closed.** Option+drag brings the selection back; a bare ⌘C
  over a captured app still does nothing, and cannot be made to.
- **If opting in is ever wanted**, the mechanism is already clean:
  `PtySession::spawn` applies `SpawnSpec.env` *after* the `is_agent_identity_var`
  strip, so a `CLAUDE_CODE_*` variable Kriyon sets deliberately survives while
  an inherited one is still removed. It would be a Setting, off by default, and
  it would still be overruling a `tui` setting Kriyon cannot see — which is why
  it is not the default here.

## Two documentation drifts found while reading this

Both predate this branch and are corrected alongside it, because the fullscreen
reasoning above depends on the daemon's real behaviour:

- **The [Scrollback ring] no longer exists.** ADR-0004 replaced it with the
  `vt100` emulator, but `CONTEXT.md` still defines it as the daemon's "bounded
  (~256 KB) buffer of recent output … replayed on reattach", and a comment in
  `pty.rs` still refers to it.
- **ADR-0004 claims `SCROLLBACK_LEN` is 1000.** The code constructs
  `vt100::Parser::new(INITIAL_ROWS, INITIAL_COLS, 0)` — the emulator keeps no
  scrollback at all, only the visible screen, which is all `state_formatted()`
  serialises anyway.

## Considered and rejected

- **Set `CLAUDE_CODE_NO_FLICKER=1` for every session.** The strongest
  performance story available, and the reason this was investigated. Rejected
  because it overrules the user's own `tui` setting by documented precedence,
  and because it would ship the four defects above to every user at once instead
  of to the subset who already have fullscreen by default.
- **Set `CLAUDE_CODE_NO_FLICKER=1 CLAUDE_CODE_DISABLE_MOUSE=1` together**, to
  keep xterm's selection, ⌘C and the file-link provider. Tempting: it is the
  combination that preserves the most Kriyon behaviour. Rejected for the same
  overruling reason, and because it is the exact combination that triggers
  defect (2) — the wheel would walk the prompt history.
- **`CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1` as the middle ground** (wheel kept,
  clicks off). It fixes the wheel but not ⌘C or the link provider, since the
  mouse is still captured. Same overruling objection.
- **Detect the renderer and adapt.** Kriyon could watch for `?1049h` and change
  its wheel and copy behaviour accordingly. It is a real option for defect (2)
  and worth prototyping — but on its own it is a heuristic about *which
  application* is on the alternate screen, which the escape sequence does not
  say, so it cannot distinguish `claude` from `less`.
