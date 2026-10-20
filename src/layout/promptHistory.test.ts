import { expect, test } from "vitest";
import {
  onFirstLine,
  onLastLine,
  START,
  stepHistory,
} from "./promptHistory.ts";

const entries = ["newest", "older", "oldest"];

test("Up walks back through the history and Down returns to the draft", () => {
  let cursor = START;
  let shown = "my draft";
  const press = (dir: 1 | -1) => {
    const next = stepHistory(cursor, entries, dir, shown);
    if (next) {
      ({ cursor } = next);
      shown = next.text;
    }
    return next;
  };
  expect(press(1)?.text).toBe("newest");
  expect(press(1)?.text).toBe("older");
  expect(press(1)?.text).toBe("oldest");
  expect(press(1)).toBeNull();
  expect(press(-1)?.text).toBe("older");
  expect(press(-1)?.text).toBe("newest");
  expect(press(-1)?.text).toBe("my draft");
  expect(press(-1)).toBeNull();
});

test("no history, nothing to walk", () => {
  expect(stepHistory(START, [], 1, "x")).toBeNull();
});

test("the caret's line decides whether the arrow walks history or moves it", () => {
  expect(onFirstLine("one\ntwo", 2)).toBe(true);
  expect(onFirstLine("one\ntwo", 5)).toBe(false);
  expect(onLastLine("one\ntwo", 5)).toBe(true);
  expect(onLastLine("one\ntwo", 2)).toBe(false);
});
