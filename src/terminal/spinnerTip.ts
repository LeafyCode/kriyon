/**
 * The tip Claude Code shows under its spinner while it works
 * (`  ⎿  Tip: Use /memory to …`), read off the session's own screen so the
 * [Structured view] can show the same one. Claude Code gives a mod no way to
 * see it, and its tips are its own text, so they are never copied into
 * Kriyon: the screen is the one source. Best-effort and pure — a screen that
 * doesn't look like this gives `null`, never an error.
 */

export interface SpinnerTip {
  /** "Tip", or an organisation's own label for its tips. */
  label: string;
  text: string;
}

/** The working line: a spinner glyph, then words ending in "…", then its
 *  status in brackets ("(12s · esc to interrupt)") or nothing. Not `●`/`⏺`,
 *  the bullet of Claude's messages and tool calls, whose text may end in
 *  "…" too. */
const SPINNER = /^\s*[✳✶✻✽✢·*∗]\s+([^…]+…)(?:\s*\(|\s*$)/;

/** The line under it: `  ⎿` then (no-break) spaces, then `Label: text`. */
const TIP = /^ {2}⎿[\s ]+([^:]{1,40}): (.+)$/;

/** A wrapped tip's next row: indented past the `⎿`. */
const CONTINUATION = /^ {5,}(\S.*)$/;

/** The same slot shows the next task of a todo list; that isn't a tip. */
const NOT_TIPS = new Set(["Next"]);

/** The tip under the newest spinner line in `rows` (top to bottom). */
export function spinnerTip(rows: readonly string[]): SpinnerTip | null {
  for (let at = rows.length - 1; at >= 0; at -= 1) {
    if (!SPINNER.test(rows[at] ?? "")) {
      continue;
    }
    const match = TIP.exec(rows[at + 1] ?? "");
    if (!match) {
      return null;
    }
    const label = (match[1] ?? "").trim();
    if (NOT_TIPS.has(label)) {
      return null;
    }
    let text = (match[2] ?? "").trim();
    for (let next = at + 2; next < rows.length; next += 1) {
      const more = CONTINUATION.exec(rows[next] ?? "");
      if (!more) {
        break;
      }
      text = `${text} ${(more[1] ?? "").trim()}`;
    }
    return { label, text };
  }
  return null;
}

/**
 * The task the spinner names while Claude works through a todo list
 * ("Writing the login tests…"), off the newest spinner line. A one-word
 * spinner is Claude Code's filler ("Deliberating…"), so it gives `null`.
 */
export function spinnerTask(rows: readonly string[]): string | null {
  for (let at = rows.length - 1; at >= 0; at -= 1) {
    const match = SPINNER.exec(rows[at] ?? "");
    if (match) {
      const words = (match[1] ?? "").trim();
      return words.includes(" ") ? words : null;
    }
  }
  return null;
}
