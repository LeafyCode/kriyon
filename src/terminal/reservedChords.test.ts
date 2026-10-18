import { expect, test } from "vitest";
import {
  isCopyChord,
  isNewlineChord,
  isReservedAppChord,
} from "./reservedChords.ts";

function ev(over: Partial<Parameters<typeof isReservedAppChord>[0]>) {
  return {
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    key: "",
    metaKey: false,
    shiftKey: false,
    type: "keydown",
    ...over,
  };
}

test("cmd+shift+P is reserved (prompt picker)", () => {
  expect(
    isReservedAppChord(ev({ key: "P", metaKey: true, shiftKey: true }), true)
  ).toBe(true);
});

test("cmd+K is reserved (command palette)", () => {
  expect(isReservedAppChord(ev({ key: "k", metaKey: true }), true)).toBe(true);
});

test("cmd+shift+K is reserved (needs-you overlay)", () => {
  expect(
    isReservedAppChord(ev({ key: "K", metaKey: true, shiftKey: true }), true)
  ).toBe(true);
});

// Regression: reserving the ctrl variants on mac swallowed real shell chords —
// Ctrl+K is readline/zsh kill-to-end-of-line and must reach the shell. The
// palette stays on ⌘K there; ctrl only stands in for ⌘ on platforms without it.
test("on mac, ctrl+K reaches the shell (not reserved)", () => {
  expect(isReservedAppChord(ev({ ctrlKey: true, key: "k" }), true)).toBe(false);
  expect(
    isReservedAppChord(ev({ ctrlKey: true, key: "P", shiftKey: true }), true)
  ).toBe(false);
});

test("on non-mac, ctrl variants are the reserved chords", () => {
  expect(isReservedAppChord(ev({ ctrlKey: true, key: "k" }), false)).toBe(true);
  expect(
    isReservedAppChord(ev({ ctrlKey: true, key: "P", shiftKey: true }), false)
  ).toBe(true);
});

test("plain typing is not reserved", () => {
  expect(isReservedAppChord(ev({ key: "p" }), true)).toBe(false);
  expect(isReservedAppChord(ev({ key: "a", metaKey: true }), true)).toBe(false);
  expect(isReservedAppChord(ev({ key: "p", metaKey: true }), true)).toBe(false);
});

test("keyup is ignored (only keydown reaches the window listeners)", () => {
  expect(
    isReservedAppChord(
      ev({ key: "P", metaKey: true, shiftKey: true, type: "keyup" }),
      true
    )
  ).toBe(false);
});

test("cmd+C is the copy chord on mac", () => {
  expect(isCopyChord(ev({ key: "c", metaKey: true }), true)).toBe(true);
});

// Regression: Ctrl+C with a live selection was hijacked for copy, so it never
// reached the shell as SIGINT — a leftover selection made a running dev server
// impossible to interrupt. On mac, copy is ⌘C alone; Ctrl+C always interrupts.
test("on mac, ctrl+C is never the copy chord (it must SIGINT)", () => {
  expect(isCopyChord(ev({ key: "c", ctrlKey: true }), true)).toBe(false);
});

test("on non-mac, ctrl+C copies (Windows Terminal convention)", () => {
  expect(isCopyChord(ev({ key: "c", ctrlKey: true }), false)).toBe(true);
});

test("copy chord requires keydown and the c key", () => {
  expect(
    isCopyChord(ev({ key: "c", metaKey: true, type: "keyup" }), true)
  ).toBe(false);
  expect(isCopyChord(ev({ key: "v", metaKey: true }), true)).toBe(false);
});

test("shift+enter is the newline chord", () => {
  expect(isNewlineChord(ev({ key: "Enter", shiftKey: true }))).toBe(true);
});

// Plain Enter must stay a submit: xterm's own \r path handles it.
test("enter without shift is not the newline chord", () => {
  expect(isNewlineChord(ev({ key: "Enter" }))).toBe(false);
});

// Other modifiers carry their own meanings (⌘Enter, Ctrl+Enter, and Option+Enter
// which the terminal already sends as ESC CR); only bare Shift is remapped.
test("shift+enter with another modifier is not the newline chord", () => {
  expect(
    isNewlineChord(ev({ altKey: true, key: "Enter", shiftKey: true }))
  ).toBe(false);
  expect(
    isNewlineChord(ev({ ctrlKey: true, key: "Enter", shiftKey: true }))
  ).toBe(false);
  expect(
    isNewlineChord(ev({ key: "Enter", metaKey: true, shiftKey: true }))
  ).toBe(false);
});

// The Enter that confirms an IME candidate is still reported as key "Enter"
// (with Shift on some layouts). It must reach the composition, not be turned
// into a newline — the same trap PromptBar guards.
test("enter during an IME composition is not the newline chord", () => {
  expect(
    isNewlineChord(ev({ isComposing: true, key: "Enter", shiftKey: true }))
  ).toBe(false);
});

test("newline chord requires keydown and the Enter key", () => {
  expect(
    isNewlineChord(ev({ key: "Enter", shiftKey: true, type: "keyup" }))
  ).toBe(false);
  expect(isNewlineChord(ev({ key: "a", shiftKey: true }))).toBe(false);
});
