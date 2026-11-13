import { expect, test, vi } from "vitest";
import {
  applyScreenFrame,
  decodeScreenFrame,
  linkLine,
  mayType,
  noteLine,
  receiptLine,
  refusalLine,
} from "./remoteScreen.ts";

function fakeTerm() {
  return { reset: vi.fn(), resize: vi.fn(), write: vi.fn() };
}

test("a new screen clears, takes the other computer's size, then draws", () => {
  const term = fakeTerm();
  const bytes = new Uint8Array([104]);
  const note = applyScreenFrame(term, {
    bytes,
    cols: 120,
    kind: "screen",
    rows: 40,
    skipped: false,
  });
  expect(term.reset).toHaveBeenCalled();
  expect(term.resize).toHaveBeenCalledWith(120, 40);
  expect(term.write).toHaveBeenCalledWith(bytes);
  expect(note).toBeNull();
});

test("a screen sent because this computer fell behind says it skipped ahead", () => {
  const term = fakeTerm();
  expect(
    applyScreenFrame(term, {
      bytes: new Uint8Array(),
      cols: 80,
      kind: "screen",
      rows: 24,
      skipped: true,
    })
  ).toEqual({ kind: "skipped" });
});

test("output is drawn after what is there", () => {
  const term = fakeTerm();
  const bytes = new Uint8Array([1, 2]);
  expect(applyScreenFrame(term, { bytes, kind: "output" })).toBeNull();
  expect(term.write).toHaveBeenCalledWith(bytes);
  expect(term.reset).not.toHaveBeenCalled();
});

test("receipts and refusals draw nothing and come back as notes", () => {
  const term = fakeTerm();
  expect(applyScreenFrame(term, { kind: "receipt", written: true })).toEqual({
    kind: "receipt",
    written: true,
  });
  expect(applyScreenFrame(term, { kind: "refused", reason: 3 })).toEqual({
    kind: "refused",
    reason: 3,
  });
  expect(term.write).not.toHaveBeenCalled();
});

test("receipts say only what is known", () => {
  expect(receiptLine(true)).toBe("Typed on the other computer.");
  expect(receiptLine(false)).toBe("Not sure it arrived.");
});

test("refusals say why in plain words", () => {
  expect(refusalLine(3)).toBe("You don't have control of this session.");
  expect(refusalLine(4)).toBe(
    "The screen changed before that arrived. Look again, then type."
  );
  expect(refusalLine(6)).toBe("A question is showing there. Answer it first.");
  expect(refusalLine(99)).toBe("The other computer refused that.");
});

test("a screen frame says what to draw", () => {
  expect(decodeScreenFrame(new Uint8Array([0, 104, 105]))).toEqual({
    bytes: new Uint8Array([104, 105]),
    kind: "output",
  });
  expect(decodeScreenFrame(new Uint8Array([1, 1, 44, 0, 2, 1, 120]))).toEqual({
    bytes: new Uint8Array([120]),
    cols: 300,
    kind: "screen",
    rows: 2,
    skipped: true,
  });
  expect(decodeScreenFrame(new Uint8Array([2, 1]))).toEqual({
    kind: "receipt",
    written: true,
  });
  expect(decodeScreenFrame(new Uint8Array([3, 4]))).toEqual({
    kind: "refused",
    reason: 4,
  });
  for (const bad of [[], [1, 0, 80], [9, 1]]) {
    expect(decodeScreenFrame(new Uint8Array(bad))).toBeNull();
  }
});

test("each link state has its line", () => {
  expect(linkLine("lost")).toBe("Disconnected, reconnecting. Typing is off.");
  expect(linkLine("removed")).toBe(
    "Removed from that computer. Pair again to use it."
  );
  expect(linkLine("connecting")).toBe("Connecting…");
  expect(linkLine("connected")).toBe("Connected");
});

test("each note from the stream has its line", () => {
  expect(noteLine({ kind: "skipped" })).toBe(
    "Skipped ahead: this computer fell behind, so it shows the screen as it is now."
  );
  expect(noteLine({ kind: "receipt", written: true })).toBe(receiptLine(true));
  expect(noteLine({ kind: "refused", reason: 3 })).toBe(refusalLine(3));
});

test("typing is on only while connected, as a Controller, holding control", () => {
  expect(mayType("connected", "controller", true)).toBe(true);
  expect(mayType("lost", "controller", true)).toBe(false);
  expect(mayType("connecting", "controller", true)).toBe(false);
  expect(mayType("connected", "viewer", true)).toBe(false);
  expect(mayType("connected", "controller", false)).toBe(false);
  expect(mayType("connected", null, true)).toBe(false);
});
