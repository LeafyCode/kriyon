import { expect, test } from "@jest/globals";
import { KEYS, messageSteps, typedLine } from "./keys.ts";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("the extra keys send what a terminal's keys send", () => {
  expect(KEYS.map((key) => [key.label, key.bytes])).toEqual([
    ["esc", "\u001b"],
    ["tab", "\t"],
    ["↑", "\u001b[A"],
    ["↓", "\u001b[B"],
    ["←", "\u001b[D"],
    ["→", "\u001b[C"],
  ]);
});

test("a typed line goes with Enter", () => {
  expect(text(typedLine("echo hi", false))).toBe("echo hi\r");
  expect(text(typedLine("", false))).toBe("\r");
});

test("with ctrl held, the first letter is its control key and no Enter follows", () => {
  expect(Array.from(typedLine("c", true))).toEqual([3]);
  expect(Array.from(typedLine("D", true))).toEqual([4]);
  expect(text(typedLine("ru", true))).toBe("\u0012u");
});

test("ctrl with nothing typed sends nothing", () => {
  expect(typedLine("", true).length).toBe(0);
});

test("a message is typed, then Enter follows after a beat, as the desktop sends it", () => {
  const steps = messageSteps("run the tests");
  expect(steps.map((step) => [text(step.bytes), step.waitMs])).toEqual([
    ["run the tests", 0],
    ["\r", 80],
  ]);
});

test("a long message goes as one bracketed paste, then Enter", () => {
  const long = "x".repeat(801);
  const [paste, enter] = messageSteps(long);
  expect(text(paste?.bytes ?? new Uint8Array())).toBe(
    `\u001b[200~${long}\u001b[201~`
  );
  expect(text(enter?.bytes ?? new Uint8Array())).toBe("\r");
});

test("nothing typed is only Enter", () => {
  expect(messageSteps("").map((step) => text(step.bytes))).toEqual(["\r"]);
});
