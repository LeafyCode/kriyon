import type { ScreenFrame } from "../state/remoteHosts.ts";

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
