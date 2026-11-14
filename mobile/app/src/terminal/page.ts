/**
 * The terminal page inside the phone's web view: xterm.js, the same
 * terminal as the desktop, drawing a session's stream with the desktop's
 * own code (remote/remoteScreen.ts) and terminal colours. Built into one
 * HTML string by scripts/terminal-page.mjs; never imported by the app.
 *
 * The app talks to it through `window.kriyon` (frames as base64, typing on
 * or off, light or dark); it answers through React Native's message channel (what was
 * typed, a note to show, ready).
 */
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import {
  applyScreenFrame,
  decodeScreenFrame,
} from "../../../../src/remote/remoteScreen.ts";
import { terminalTheme } from "../../../../src/theme/terminalTheme.ts";
import { steel } from "../../../../src/theme/themes/steel.ts";
import { steelLight } from "../../../../src/theme/themes/steelLight.ts";
import type { PageMessage } from "./protocol.ts";

declare global {
  interface Window {
    kriyon: {
      frame: (base64: string) => void;
      /** The phone's light or dark setting, and the screen's background. */
      theme: (mode: "dark" | "light", background: string) => void;
      typing: (on: boolean) => void;
    };
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

function post(message: PageMessage): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify(message));
}

function fromBase64(base64: string): Uint8Array {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let at = 0; at < text.length; at += 1) {
    bytes[at] = text.charCodeAt(at);
  }
  return bytes;
}

const term = new Terminal({
  // The proposed API, for the Unicode 11 widths below.
  allowProposedApi: true,
  convertEol: false,
  disableStdin: true,
  fontFamily: "Menlo, monospace",
  fontSize: 12,
  scrollback: 1000,
  theme: terminalTheme(steel),
});
// Character widths as the computer's terminal measures them (Unicode 11),
// so wide symbols and emoji land in the same columns.
term.loadAddon(new Unicode11Addon());
term.unicode.activeVersion = "11";
const host = document.getElementById("terminal");
if (host) {
  term.open(host);
}
term.onData((data) => post({ data, type: "input" }));

window.kriyon = {
  frame: (base64) => {
    const frame = decodeScreenFrame(fromBase64(base64));
    if (!frame) {
      return;
    }
    const note = applyScreenFrame(
      {
        reset: () => term.reset(),
        resize: (cols, rows) => term.resize(cols, rows),
        write: (bytes) => term.write(bytes),
      },
      frame
    );
    if (note) {
      post({ note, type: "note" });
    }
  },
  theme: (mode, background) => {
    term.options.theme = {
      ...terminalTheme(mode === "light" ? steelLight : steel),
      background,
    };
    document.body.style.background = background;
  },
  typing: (on) => {
    term.options.disableStdin = !on;
    // The keyboard comes up with control, and goes with it.
    if (on) {
      term.focus();
    } else {
      term.blur();
    }
  },
};

post({ type: "ready" });
