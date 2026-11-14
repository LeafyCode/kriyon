/**
 * What the terminal's type field and its extra keys send: the bytes a
 * terminal's own keys would. Rust sends them on as they are.
 */

/** The keys a phone's keyboard lacks, in the order the design shows them. */
export const KEYS: readonly {
  accessibilityLabel: string;
  bytes: string;
  label: string;
}[] = [
  { accessibilityLabel: "Escape", bytes: "\u001b", label: "esc" },
  { accessibilityLabel: "Tab", bytes: "\t", label: "tab" },
  { accessibilityLabel: "Up", bytes: "\u001b[A", label: "↑" },
  { accessibilityLabel: "Down", bytes: "\u001b[B", label: "↓" },
  { accessibilityLabel: "Left", bytes: "\u001b[D", label: "←" },
  { accessibilityLabel: "Right", bytes: "\u001b[C", label: "→" },
];

const utf8 = new TextEncoder();

/**
 * The bytes for `text` typed into the field. Without ctrl it goes with
 * Enter (`\r`). With ctrl held, its first letter becomes that control key
 * (ctrl-C is 3) and the rest follows, with no Enter.
 */
export function typedLine(text: string, ctrl: boolean): Uint8Array {
  if (!ctrl) {
    return utf8.encode(`${text}\r`);
  }
  const [first, ...rest] = Array.from(text);
  if (!first) {
    return new Uint8Array();
  }
  // A letter's control key: its upper case's code, less 64 (`A` is 1).
  const control = first.toUpperCase().charCodeAt(0) % 32;
  return new Uint8Array([control, ...utf8.encode(rest.join(""))]);
}

/** One write to the session, after `waitMs`. */
export interface Step {
  bytes: Uint8Array;
  waitMs: number;
}

/**
 * The most a message is typed in one write; longer, it goes as one
 * bracketed paste, which arrives whole (the desktop's TYPED_MAX_BYTES).
 */
const TYPED_MAX_BYTES = 800;

/**
 * The beat before a message's Enter: in one burst with the text, Claude
 * Code reads the Enter as part of a paste (the desktop's SUBMIT_DELAY_MS).
 */
const SUBMIT_DELAY_MS = 80;

/**
 * The writes that send `text` to Claude as the desktop sends a prompt
 * (kriyon_core::attachment): the text, typed or pasted, then Enter after a
 * beat.
 */
export function messageSteps(text: string): Step[] {
  const enter = utf8.encode("\r");
  if (text === "") {
    return [{ bytes: enter, waitMs: 0 }];
  }
  const typed = utf8.encode(text);
  const bytes =
    typed.length > TYPED_MAX_BYTES
      ? utf8.encode(`\u001b[200~${text}\u001b[201~`)
      : typed;
  return [
    { bytes, waitMs: 0 },
    { bytes: enter, waitMs: SUBMIT_DELAY_MS },
  ];
}
