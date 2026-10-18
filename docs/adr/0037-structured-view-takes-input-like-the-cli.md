# ADR 0037 — The Structured view takes input the way the CLI does

**Date:** 2026-10-07
**Status:** Accepted
**Amends:** [ADR-0035](0035-structured-view-from-the-companion.md) (its "Read-only" bullet)

## Context

ADR-0035 made the Structured view read-only: replies were typed in the
terminal. In practice the composer already sits under it, so people use it as
a chat view and expect what any chat app has: stop a turn, attach files and
screenshots, see them, copy a reply. The terminal is still the source of
truth, so every one of these has to go through the CLI's own input — never
around it.

We drove a real `claude` 2.1.292 in a PTY to pin down its behaviour:

- **Esc** right after a prompt is sent (before any reply) puts the prompt back
  in the CLI's input and writes no `[Request interrupted by user]` row. Esc
  during a reply stops it, writes that row, and sends any queued message.
- **An image path in a bracketed paste** (`ESC[200~…ESC[201~`, what a terminal
  sends for a dropped file) becomes `[Image #N]`; Claude sees the picture.
  Backslash-escaped spaces work. A path typed without the paste stays text.
  An 8 MB image takes about 400 ms to be read.
- **`@"path with spaces"`** attaches a file; Claude Code reads it itself.
- The transcript keeps a meta row `[Image: source: <path>]` per image.

## Decision

- **Esc stops a turn from the composer or the view** by writing `ESC` to the
  PTY, as a key press. A Stop button does the same.
- **A prompt Claude never started is put back in the composer.** After Esc,
  if the composer sent that prompt and the turn has no reply, no steps and no
  interrupt row, the composer gets the text and attachments back and the
  CLI's own copy is cleared with Ctrl+U, so the two never hold it twice.
- **Attachments go in the way the terminal takes them** (`kriyon_core::attachment`):
  images as a bracketed paste of the path, other files and folders as an `@`
  mention, then Enter after each image has had time to be read.
- **Rust admits every attachment path.** Paths come only from the native
  picker, the clipboard, a drop on the window, a pasted image Kriyon saved, or
  an image the transcript recorded. The frontend names an attachment by an
  admitted path; a preview or send of anything else is refused.
- **Pasted images are saved** owner-only under the app's data folder and kept
  30 days, so history can still preview them.
- **Warn, don't block,** on an image the API is likely to refuse (over 8000 px)
  or a format Claude can't see (HEIC, TIFF, …).

- **Pictures Claude can't see are converted.** The API takes only PNG, JPEG,
  GIF and WebP, and the CLI attaches nothing else as a picture. HEIC, HEIF and
  AVIF become JPEG and TIFF, BMP and SVG become PNG, with macOS's `sips`; the
  copy is attached and the user told. A failed conversion attaches the file
  with a caution.
- **Esc ends the working status.** Claude Code fires no hook for an
  interrupt, so after an Esc (from Kriyon or typed in the terminal) the
  frontend reads what the CLI kept and, once it shows the turn stopped, tells
  the backend (`note_interrupted`), which ends `Running`.
- **The reply streams.** `session.append` hands a reply block only once it is
  whole, and the bridge spool is read every 3 s. The companion gains one
  hook, `turn.step`: it passes every chunk on unchanged (the same object) and
  posts a snapshot of the main agent's text at most every 250 ms. The daemon
  keeps only the newest such [Partial reply], in its own file beside the
  spool, and says on every reply that it does (`X-Kriyon-Bridge: 2`); the mod
  streams only to a daemon that says so, so an older daemon's spool never
  fills with them. While Claude works the view reads the partial every 300 ms
  and the turns every 1.2 s, each read pulling the newest rows in first.

## Consequences

- Input needs no mod API and no new process: it is keystrokes the user could
  type. Streaming widens the companion's footprint by one read-only hook,
  `turn.step` (`claude plugin validate` lists it).
- If a CLI release changes how it treats a pasted path or Esc, the composer
  degrades to what the terminal would do with the same keys.
- The restore check can misjudge in a race (a reply starting in the same
  instant); the worst case is a prefilled composer the user can clear. An
  Esc waits for a message still being typed, so it never lands inside one.
- The companion folder is named by app version only, so a dev or smoke
  build with the same version rewrites the installed app's `companion.js`.
  That is safe by design: the mod streams only to a daemon that sends
  `X-Kriyon-Bridge: 2`, and every other pairing (old mod, new daemon or the
  reverse) just doesn't stream. Revisit if the bridge protocol ever changes
  in a way an older daemon can't ignore.
