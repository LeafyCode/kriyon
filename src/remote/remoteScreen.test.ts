import { expect, test, vi } from "vitest";
import { applyScreenFrame, receiptLine, refusalLine } from "./remoteScreen.ts";

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
