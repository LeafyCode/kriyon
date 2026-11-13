/**
 * A paired computer's screen stream, as a remote device draws it: the frames
 * Rust passes on, how one is drawn, and the lines that tell the person what
 * happened. Plain TypeScript with no imports, so the desktop's Other
 * computers view and the phone app (mobile/app) share it.
 */

/** Where a paired computer's link stands, as Rust reports it. */
export type LinkState = "connecting" | "connected" | "lost" | "removed";

/** What one raw screen frame from Rust says (see `screen_frame` in Rust). */
export type ScreenFrame =
  | { bytes: Uint8Array; kind: "output" }
  | {
      bytes: Uint8Array;
      cols: number;
      kind: "screen";
      rows: number;
      skipped: boolean;
    }
  | { kind: "receipt"; written: boolean }
  | { kind: "refused"; reason: number };

/** Read one frame: a kind byte, then its fields. `null` for anything else. */
export function decodeScreenFrame(frame: Uint8Array): ScreenFrame | null {
  const [kind] = frame;
  switch (kind) {
    case 0:
      return { bytes: frame.subarray(1), kind: "output" };
    case 1: {
      if (frame.length < 6) {
        return null;
      }
      const view = new DataView(frame.buffer, frame.byteOffset, frame.length);
      return {
        bytes: frame.subarray(6),
        cols: view.getUint16(1),
        kind: "screen",
        rows: view.getUint16(3),
        skipped: frame[5] === 1,
      };
    }
    case 2:
      return frame.length === 2
        ? { kind: "receipt", written: frame[1] === 1 }
        : null;
    case 3:
      return frame.length === 2 ? { kind: "refused", reason: frame[1] } : null;
    default:
      return null;
  }
}

/** What a remote screen frame needs of the terminal drawing it. */
export interface ScreenTerm {
  reset: () => void;
  resize: (cols: number, rows: number) => void;
  write: (data: Uint8Array) => void;
}

/** Something to tell the person, from a frame that drew nothing new. */
export type ScreenNote =
  | { kind: "skipped" }
  | { kind: "receipt"; written: boolean }
  | { kind: "refused"; reason: number };

/**
 * Draw one frame from the other computer. A new screen replaces what is
 * there, at the other computer's size; output follows on. Returns what to
 * tell the person, if anything.
 */
export function applyScreenFrame(
  term: ScreenTerm,
  frame: ScreenFrame
): ScreenNote | null {
  switch (frame.kind) {
    case "screen":
      term.reset();
      term.resize(frame.cols, frame.rows);
      term.write(frame.bytes);
      return frame.skipped ? { kind: "skipped" } : null;
    case "output":
      term.write(frame.bytes);
      return null;
    default:
      return frame;
  }
}

/** An honest receipt: the bytes reached the session, or that isn't known. */
export function receiptLine(written: boolean): string {
  return written ? "Typed on the other computer." : "Not sure it arrived.";
}

/** Why the other computer refused, by the refusal's number on the wire. */
export function refusalLine(reason: number): string {
  switch (reason) {
    case 2:
      return "This computer may only watch there.";
    case 3:
      return "You don't have control of this session.";
    case 4:
      return "The screen changed before that arrived. Look again, then type.";
    case 6:
      return "A question is showing there. Answer it first.";
    case 11:
      return "That screen is too big to show here.";
    default:
      return "The other computer refused that.";
  }
}

/** The line that says where a paired computer's link stands. */
export function linkLine(state: LinkState): string {
  switch (state) {
    case "lost":
      return "Disconnected, reconnecting. Typing is off.";
    case "removed":
      return "Removed from that computer. Pair again to use it.";
    case "connecting":
      return "Connecting…";
    default:
      return "Connected";
  }
}
