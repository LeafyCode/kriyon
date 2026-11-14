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
