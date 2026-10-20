import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm } from "@xterm/xterm";
import { registerScreenText } from "./screenText.ts";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { reportDrained, resizePty, writeStdin } from "../ipc/bridge.ts";
import { useLayout } from "../state/layout.ts";
import { terminalTheme } from "../theme/terminalTheme.ts";
import { themeById } from "../theme/themes/index.ts";
import { tokens } from "../theme/tokens.ts";
import { showToast } from "../ui/Toast.tsx";
import { copySelection, type TerminalLike } from "./cleanCopy.ts";
import { linkTarget, matchPaths, openLinkTarget } from "./links.ts";
import {
  isCopyChord,
  isNewlineChord,
  isReservedAppChord,
  isSplitChord,
  NEWLINE_SEQUENCE,
} from "./reservedChords.ts";
import {
  attachTerminal,
  ensureSession,
  registerSizeSync,
} from "./sessionHost.ts";
import {
  arrowKeyReport,
  foldLineSteps,
  isFineScroll,
  readsArrowsAsScroll,
} from "./wheelScroll.ts";
import { WriteQueue } from "./writeQueue.ts";

const OSC_SHELL_INTEGRATION = 133;
const OSC_CLIPBOARD = 52;
const RESIZE_DEBOUNCE_MS = 75;
const SCROLLBACK_LINES = 5000;
/**
 * Lines scrolled per discrete mouse-wheel notch. xterm's default (1) feels
 * sluggish; 3 gives a Warp-like snappy notch. This applies ONLY to a coarse
 * mouse wheel — a fine trackpad delta is mapped by pixel distance instead (see
 * `wheelScroll`), so the trackpad no longer inherits this multiplier (which made
 * it fly off).
 */
const LINES_PER_NOTCH = 3;
/**
 * Pixels of trackpad travel per scrolled line, ≈ the cell height (`fontSize`
 * 13 × `lineHeight` 1.2). A fine wheel delta is accumulated and converted to
 * whole line-steps at this rate, so a trackpad scrolls one line per line-height
 * of finger movement — natural, not amplified.
 */
const WHEEL_LINE_PX = 16;
const COPY_TOAST = "Copied — clean, no line breaks";
/**
 * Cap on WebGL context re-creation attempts after a context loss. WKWebView
 * limits live WebGL contexts (~16), so we retry a bounded number of times then
 * stay on the DOM renderer rather than thrashing toward that limit.
 */
const WEBGL_REATTACH_CAP = 2;
const WEBGL_REATTACH_DELAY_MS = 1000;

function ignore(promise: Promise<unknown>): void {
  promise.catch(() => {
    // Intentionally ignore IPC errors for fire-and-forget calls.
  });
}

/**
 * Inline TS mirror of `kriyon-core`'s OSC 133 block state machine. Records
 * `A`/`B`/`C`/`D` markers keyed by absolute buffer line so a command's output
 * range can be recovered for "copy output". Tolerant of missing markers.
 */
interface OscBlock {
  commandLine: number;
  exit: number | undefined;
  outputEnd: number;
  outputStart: number;
}

class OscBlocks {
  private commandLine: number | undefined;
  private outputStart: number | undefined;
  readonly blocks: OscBlock[] = [];

  promptStart(line: number): void {
    this.commandLine = line;
  }

  commandStart(line: number): void {
    this.commandLine ??= line;
  }

  outputStartAt(line: number): void {
    this.outputStart = line;
  }

  /** Parse and apply a raw OSC 133 payload (`"A"`, `"B"`, `"C"`, `"D[;n]"`). */
  feed(data: string, line: number): void {
    if (data === "A") {
      this.promptStart(line);
    } else if (data === "B") {
      this.commandStart(line);
    } else if (data === "C") {
      this.outputStartAt(line);
    } else if (data === "D" || data.startsWith("D;")) {
      const code = data.startsWith("D;")
        ? Number.parseInt(data.slice(2), 10)
        : Number.NaN;
      this.commandEnd(line, Number.isNaN(code) ? undefined : code);
    }
  }

  commandEnd(line: number, exit: number | undefined): void {
    if (this.commandLine === undefined && this.outputStart === undefined) {
      return;
    }
    const commandLine = this.commandLine ?? line;
    this.blocks.push({
      commandLine,
      exit,
      outputEnd: line,
      outputStart: this.outputStart ?? commandLine,
    });
    this.commandLine = undefined;
    this.outputStart = undefined;
  }
}

/** Decode the base64 payload from an OSC 52 `"<selection>;<base64>"` string. */
function decodeOsc52(data: string): string | undefined {
  const base64 = data.slice(data.lastIndexOf(";") + 1);
  if (!base64) {
    return;
  }
  try {
    return new TextDecoder().decode(
      Uint8Array.from(atob(base64), (c) => c.codePointAt(0) ?? 0)
    );
  } catch {
    // Not valid base64: there is nothing to copy.
  }
}

/**
 * On ⌘/Ctrl+C with a live selection, copy the logical-line-reflowed text
 * (not the raw wrapped grid) and toast. Returns `true` when it handled the copy
 * so the caller tells xterm to skip its default handling.
 */
function tryCleanCopy(
  event: KeyboardEvent,
  term: { hasSelection?: () => boolean }
): boolean {
  // Platform-aware: ⌘C on mac, Ctrl+C elsewhere. On mac Ctrl+C must never be
  // eaten here — with a leftover selection it silently stopped SIGINT-ing the
  // foreground process.
  if (!(isCopyChord(event) && term.hasSelection?.() === true)) {
    return false;
  }
  const clean = copySelection(term as unknown as TerminalLike);
  if (!clean) {
    return false;
  }
  try {
    ignore(
      navigator.clipboard.writeText(clean).then(() => {
        showToast(COPY_TOAST);
      })
    );
  } catch {
    // Clipboard access denied; fall through to default handling.
  }
  return true;
}

/**
 * Wheel line-steps for a terminal whose app has NOT grabbed the mouse. In the
 * normal buffer this scrolls xterm's scrollback. In the alternate buffer
 * (less, man, git log) there is no scrollback to scroll — the terminal
 * convention is arrow keys per line-step, in the DECCKM-appropriate form.
 * Without that branch the wheel was simply dead in any full-screen app that
 * doesn't grab the mouse.
 *
 * Unless the app has an input line, where those arrows are what the user is
 * typing into rather than a way to move the screen — see
 * {@link readsArrowsAsScroll}. There the wheel does nothing, which is the
 * lesser of the two wrongs.
 */
function scrollWithoutMouseTracking(
  term: XTerm,
  sessionId: string,
  steps: number
): void {
  if (term.buffer.active.type === "alternate") {
    if (!readsArrowsAsScroll(term.modes)) {
      return;
    }
    const report = arrowKeyReport(
      steps < 0,
      term.modes.applicationCursorKeysMode
    ).repeat(Math.abs(steps));
    ignore(writeStdin(sessionId, new TextEncoder().encode(report)));
    return;
  }
  term.scrollLines(steps);
}

/**
 * Whether activating a scoped terminal may steal keyboard focus: only when
 * focus already sits inside the enclosing `[data-terminal-focus-scope]` (the
 * user clicked a tab or pane in that workspace). A sidebar project-switch —
 * focus outside the scope — must not yank focus into the dock. No scope
 * ancestor means unscoped: keep the historical always-focus behavior.
 */
function scopeOwnsFocus(container: HTMLElement | null): boolean {
  const scope = container?.closest("[data-terminal-focus-scope]");
  if (!scope) {
    return true;
  }
  const focused = document.activeElement;
  return (
    focused !== null && focused !== document.body && scope.contains(focused)
  );
}

export function Terminal({
  active = true,
  cwd,
  onEscape,
  onSplitChord,
  scopedFocus = false,
  sessionId,
}: {
  active?: boolean;
  cwd: string;
  /** Told of a plain Esc press after it goes to the terminal as usual — the
   *  Claude terminal uses it to learn that Claude was stopped. */
  onEscape?: () => void;
  /** When set, ⌘/Ctrl+D splits (Warp-style) instead of reaching the shell.
   *  Opt-in so only Project terminals intercept it — the Claude terminal, and
   *  Ctrl+D/EOF everywhere, are untouched. */
  onSplitChord?: () => void;
  /** Restrict focus-stealing on activation to when focus is already inside the
   *  terminal's `[data-terminal-focus-scope]` ancestor. Dock terminals opt in;
   *  the Claude session terminal keeps the always-focus behavior. */
  scopedFocus?: boolean;
  sessionId: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | undefined>(undefined);
  const webglRef = useRef<WebglAddon | undefined>(undefined);
  const webglAttemptsRef = useRef(0);
  const webglReattachPendingRef = useRef(false);
  // Kept current so the mount-once key handler calls the latest callback.
  const onSplitChordRef = useRef(onSplitChord);
  onSplitChordRef.current = onSplitChord;
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  // Fit xterm to its container and push the resulting geometry to the pty.
  // Held in a ref so the `active` effect can re-sync when a hidden pane (which
  // measures nothing) finally gets a real box. Set in the mount effect.
  const syncSizeRef = useRef<(() => void) | undefined>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: effect runs once on mount; the terminal lifecycle is self-contained.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;

    // Every link click lands here, whichever detector found the link: a URL
    // opens in the browser, a file in its default app, and Cmd/Ctrl+click
    // reveals the file in Finder.
    //
    // This holds while an app tracks the mouse too. A fullscreen `claude`
    // gets the same click, but does nothing with a click on a link — it
    // leaves links to the terminal (ADR-0024) — so the plain click the user
    // reaches for has to open it here.
    const followLink = (event: MouseEvent, raw: string) => {
      const target = linkTarget(raw);
      if (target) {
        openLinkTarget(cwd, target, event.metaKey || event.ctrlKey);
      }
    };

    // `allowProposedApi` is required by the unicode11 addon below; without it
    // `loadAddon(new Unicode11Addon())` throws and (absent a boundary) blanks
    // the whole app.
    const term = new XTerm({
      allowProposedApi: true,
      convertEol: false,
      fontFamily: tokens.font.mono,
      fontSize: 13,
      lineHeight: 1.2,
      // OSC 8 hyperlinks. Claude Code recognises xterm.js (it answers
      // XTVERSION) and leaves its links to the terminal as OSC 8 — URLs and
      // `file://` paths. xterm's default handler is a `confirm()` and
      // `window.open`, which does nothing in the webview, and refuses
      // `file://` outright; `linkTarget` decides what is safe to open.
      linkHandler: {
        activate: followLink,
        allowNonHttpProtocols: true,
      },
      // The escape hatch out of an app that has grabbed the mouse. Without it
      // xterm's `shouldForceSelection` is unconditionally false on macOS, so
      // once a TUI enables mouse tracking there is no gesture left that makes
      // a *terminal* selection: ⌘C has nothing to copy (`tryCleanCopy` is
      // gated on `hasSelection`).
      //
      // Option+drag now selects and Option+click activates a link, with the
      // mouse report suppressed for that gesture only — which is also the key
      // Claude Code's own on-screen hint names for iTerm2 and most terminals,
      // so the hint it prints inside Kriyon becomes true (ADR-0024).
      macOptionClickForcesSelection: true,
      scrollback: SCROLLBACK_LINES,
      // Claude-style TUIs clear the screen with ED2/ED3 on every repaint;
      // without this, cleared content is dropped instead of scrolled out
      // (xterm.js #5745) and scrollback reconstruction loses lines.
      scrollOnEraseInDisplay: true,
      theme: terminalTheme(themeById(useLayout.getState().layout.themeId)),
    });
    termRef.current = term;
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";

    const fit = new FitAddon();
    term.loadAddon(fit);

    term.open(container);
    fit.fit();

    // Web URLs → default browser (http/https only).
    term.loadAddon(new WebLinksAddon(followLink));

    // File paths → open in default app, or reveal in Finder (`followLink`).
    // Detection lives in `links.ts`; the backend re-validates and refuses a
    // non-existent / non-openable path.
    term.registerLinkProvider({
      provideLinks(lineNumber, callback) {
        const line = term.buffer.active.getLine(lineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        const links = matchPaths(line.translateToString(true)).map((m) => ({
          range: {
            start: { x: m.start + 1, y: lineNumber },
            end: { x: m.end, y: lineNumber },
          },
          text: m.token,
          activate: (event: MouseEvent) => followLink(event, m.token),
        }));
        callback(links.length > 0 ? links : undefined);
      },
    });

    const oscBlocks = new OscBlocks();

    const currentLine = (): number => {
      const active = term.buffer?.active;
      return (active?.baseY ?? 0) + (active?.cursorY ?? 0);
    };

    term.parser.registerOscHandler(OSC_SHELL_INTEGRATION, (data: string) => {
      oscBlocks.feed(data, currentLine());
      return true;
    });

    term.parser.registerOscHandler(OSC_CLIPBOARD, (data: string) => {
      const text = decodeOsc52(data);
      if (text !== undefined) {
        try {
          ignore(navigator.clipboard.writeText(text));
        } catch {
          // Clipboard access can be denied; best-effort only.
        }
      }
      return true;
    });

    // Clean-copy override: on Cmd/Ctrl+C with a live selection, copy the
    // logical-line-reflowed text instead of the raw wrapped grid.
    term.attachCustomKeyEventHandler?.((event: KeyboardEvent) => {
      if (tryCleanCopy(event, term)) {
        return false;
      }
      if (
        event.type === "keydown" &&
        event.key === "Escape" &&
        !(event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
      ) {
        // Not consumed: the CLI still gets its Esc.
        onEscapeRef.current?.();
      }
      // Shift+Enter opens a newline instead of submitting: xterm would send the
      // same bare CR as plain Enter, so we send ESC CR ourselves — the sequence
      // Claude's /terminal-setup installs in other terminals.
      if (isNewlineChord(event)) {
        event.preventDefault();
        ignore(
          writeStdin(sessionId, new TextEncoder().encode(NEWLINE_SEQUENCE))
        );
        return false;
      }
      // ⌘/Ctrl+D splits a Project terminal (Warp-style). Opt-in via a callback,
      // so the Claude terminal never intercepts it. Ctrl+D/EOF is unaffected —
      // only the ⌘/Ctrl+D chord with no Shift is caught, and we preventDefault
      // so nothing reaches the shell or the browser.
      if (onSplitChordRef.current && isSplitChord(event)) {
        event.preventDefault();
        onSplitChordRef.current();
        return false;
      }
      // App-reserved chords (⌘⇧P, ⌘K, ⌘⇧K) must reach the window keydown
      // listeners that open the overlays; returning false makes xterm ignore
      // the event so it propagates instead of being intercepted while the
      // terminal is focused.
      if (isReservedAppChord(event)) {
        return false;
      }
      return true;
    });

    // One wheel path for both scroll surfaces. We fully own scrolling so the mouse
    // and the trackpad get different treatment: a coarse mouse notch scrolls a
    // fixed LINES_PER_NOTCH (snappy), while a fine trackpad delta is folded from
    // pixels into whole line-steps at the cell height (natural, not amplified) —
    // fixing the trackpad flying at the old fixed ×3. The resulting line-steps are
    // applied to xterm's scrollback, or, when a TUI has grabbed the mouse
    // (Claude's CLI, vim), forwarded to it as that many line-mode wheel reports.
    // Synthetic clones are tracked so they pass straight through to xterm/the app.
    const synthetic = new WeakSet<WheelEvent>();
    const wheelAccum = { remainder: 0 };
    term.attachCustomWheelEventHandler?.((event: WheelEvent): boolean => {
      if (synthetic.has(event)) {
        return true;
      }
      const direction = Math.sign(event.deltaY);
      if (direction === 0) {
        return true;
      }
      const fine = isFineScroll({
        deltaMode: event.deltaMode,
        deltaY: event.deltaY,
        wheelDeltaY: (event as WheelEvent & { wheelDeltaY?: number })
          .wheelDeltaY,
      });
      const steps = fine
        ? foldLineSteps(wheelAccum, event.deltaY, WHEEL_LINE_PX)
        : direction * LINES_PER_NOTCH;
      if (steps === 0) {
        return false; // a trackpad delta still accumulating: swallow, don't scroll
      }

      if (term.modes.mouseTrackingMode === "none") {
        scrollWithoutMouseTracking(term, sessionId, steps);
        return false;
      }
      // A mouse-grabbing TUI understands only discrete line reports; forward one
      // per line-step so trackpad and wheel drive it at the same rate as scrollback.
      const { target } = event;
      const reportDir = Math.sign(steps);
      for (let i = 0; i < Math.abs(steps); i += 1) {
        const clone = new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: event.clientX,
          clientY: event.clientY,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          deltaY: reportDir,
        });
        synthetic.add(clone);
        target?.dispatchEvent(clone);
      }
      return false;
    });

    // The pty lifecycle lives in `sessionHost`, not this component: it creates
    // the session once per id (idempotent across StrictMode/remounts) and only
    // closes it when the session is removed from the store. Here we just ensure
    // it exists and attach this terminal to its output stream; on unmount we
    // detach without tearing down the pty.
    // Fit to the container and tell the pty the real geometry. The pty is born
    // at a default size; without this the pty stays narrow while xterm renders
    // wide, garbling full-screen TUIs like Claude's. Re-runs on activation (a
    // hidden pane measures nothing) and after the session is ready (the pty
    // doesn't exist yet at mount, so an early push would be dropped).
    const syncSize = (): void => {
      // A hidden pane (`display: none` on an ancestor — how every backgrounded
      // session, project and tab is parked) measures 0x0, and its
      // ResizeObserver fires on the way out. FitAddon does not decline an
      // unmeasurable container: it reads the parent's `height: auto`, coerces
      // the NaN to 0, and clamps to its 2x1 floor. Fitting here would reflow
      // xterm to 2 columns (shredding the scrollback) and push a 2x1 pty
      // resize, whose SIGWINCH kills the running child. Skip while unmeasured;
      // the `active` effect re-syncs the real geometry when the pane is shown.
      if (container.clientHeight === 0 || container.clientWidth === 0) {
        return;
      }
      fit.fit();
      ignore(resizePty(sessionId, term.cols, term.rows));
    };
    syncSizeRef.current = syncSize;

    // Registered (not chained on this call's promise) so a pty revived by a
    // later ensureSession — e.g. the activation retry after a failed creation —
    // also gets the terminal's real geometry pushed.
    const unregisterSizeSync = registerSizeSync(sessionId, syncSize);
    // What's on screen, as text, for the spinner tip the Structured view
    // reads off it.
    const unregisterScreenText = registerScreenText(sessionId, () => {
      const buffer = term.buffer.active;
      const rows: string[] = [];
      // The CLI's live screen (`baseY`), not wherever the user scrolled back
      // to: a dialog or spinner is drawn there either way.
      for (let y = 0; y < term.rows; y += 1) {
        rows.push(
          buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? ""
        );
      }
      return rows;
    });
    ignore(
      ensureSession(sessionId, cwd, () =>
        showToast("Could not start the session", "error")
      )
    );
    // Coalesce PTY output into one write per frame; each flush reports the byte
    // count so the backend reader's drained accounting (back-pressure) is exact.
    const queue = new WriteQueue({
      onFlush: (bytes) => ignore(reportDrained(sessionId, bytes)),
      write: (bytes) => term.write(bytes),
    });
    const detach = attachTerminal(sessionId, (bytes) => queue.enqueue(bytes));

    term.onData((data) => {
      ignore(writeStdin(sessionId, new TextEncoder().encode(data)));
    });

    const observer = new ResizeObserver(() => {
      if (resizeTimer !== undefined) {
        clearTimeout(resizeTimer);
      }
      resizeTimer = setTimeout(syncSize, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (resizeTimer !== undefined) {
        clearTimeout(resizeTimer);
      }
      webglRef.current?.dispose();
      webglRef.current = undefined;
      // Dispose the queue before detaching/closing the term: it cancels the
      // pending frame and reports any still-queued bytes so drained stays exact.
      queue.dispose();
      detach();
      unregisterSizeSync();
      unregisterScreenText();
      term.dispose();
      termRef.current = undefined;
      syncSizeRef.current = undefined;
    };
  }, []);

  // WKWebView caps the number of live WebGL contexts (~16), so only the
  // active terminal holds one. Toggling `active` adds/removes the addon while
  // leaving the xterm instance and PTY session untouched.
  useEffect(() => {
    const term = termRef.current;
    if (!term) {
      return;
    }

    /**
     * Create the WebGL addon and route its context-loss through a bounded
     * re-attach: a lost context disposes the addon, then (if still active and
     * attempts remain) schedules exactly one re-create. Past the cap we stay on
     * the DOM renderer rather than thrash toward the WKWebView context limit.
     */
    const attachWebgl = (): void => {
      const t = termRef.current;
      if (!t || webglRef.current) {
        return;
      }
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          webglRef.current = undefined;
          if (
            active &&
            webglAttemptsRef.current < WEBGL_REATTACH_CAP &&
            !webglReattachPendingRef.current
          ) {
            webglReattachPendingRef.current = true;
            setTimeout(() => {
              webglReattachPendingRef.current = false;
              webglAttemptsRef.current += 1;
              attachWebgl();
            }, WEBGL_REATTACH_DELAY_MS);
          }
        });
        t.loadAddon(webgl);
        webglRef.current = webgl;
      } catch {
        // Fall back to the default DOM/canvas renderer.
      }
    };

    if (active) {
      if (!scopedFocus || scopeOwnsFocus(containerRef.current)) {
        term.focus();
      }
      // The pane was just shown: it now has a real box, so re-fit and push the
      // geometry to the pty (a hidden pane measured nothing at mount).
      syncSizeRef.current?.();
      webglAttemptsRef.current = 0;
      attachWebgl();
    } else {
      // A hidden terminal (the Structured view's dialog detour over) must
      // not keep taking keys nobody can see.
      if (
        term.textarea !== undefined &&
        term.textarea === document.activeElement
      ) {
        term.blur();
      }
      if (webglRef.current) {
        webglRef.current.dispose();
        webglRef.current = undefined;
      }
    }
  }, [active, scopedFocus]);

  // xterm paints to a canvas, so CSS variables can't restyle it — push the
  // new concrete colors when the user switches themes.
  const themeId = useLayout((state) => state.layout.themeId);
  useEffect(() => {
    const term = termRef.current;
    if (term?.options) {
      term.options.theme = terminalTheme(themeById(themeId));
    }
  }, [themeId]);

  return <div ref={containerRef} style={{ height: "100%", width: "100%" }} />;
}
