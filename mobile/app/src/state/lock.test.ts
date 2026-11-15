import { expect, test } from "@jest/globals";
import {
  LOCK_AFTER,
  type LockEvent,
  type LockState,
  lockAfterWords,
  lockIsOn,
  nextLock,
  readAppLock,
} from "./lock.ts";

test("the lock is on for a Controller unless the person turned it off, off for a Viewer unless turned on", () => {
  expect(lockIsOn({ afterS: 300, on: null }, true)).toBe(true);
  expect(lockIsOn({ afterS: 300, on: null }, false)).toBe(false);
  expect(lockIsOn({ afterS: 300, on: false }, true)).toBe(false);
  expect(lockIsOn({ afterS: 300, on: true }, false)).toBe(true);
});

test("the kept setting is read, and anything odd in it falls back to not chosen, five minutes", () => {
  expect(readAppLock('{"on":true,"afterS":60}')).toEqual({
    afterS: 60,
    on: true,
  });
  expect(readAppLock('{"on":null,"afterS":900}')).toEqual({
    afterS: 900,
    on: null,
  });
  expect(readAppLock('{"on":"yes","afterS":7}')).toEqual({
    afterS: 300,
    on: null,
  });
  expect(readAppLock("not json")).toEqual({ afterS: 300, on: null });
});

test("each lock time reads in words", () => {
  expect(LOCK_AFTER.map(lockAfterWords)).toEqual([
    "Immediately",
    "After 1 minute",
    "After 5 minutes",
    "After 15 minutes",
  ]);
});

/** The lock after `events`, with the lock on and `afterS` away locking it. */
function after(events: LockEvent[], afterS = 300, on = true): LockState {
  let state: LockState = { awayAtMs: null, locked: false };
  for (const event of events) {
    state = nextLock(state, event, { afterS, on });
  }
  return state;
}

test("the app opens locked, and unlocking opens it", () => {
  expect(after([{ kind: "start" }]).locked).toBe(true);
  expect(after([{ kind: "start" }, { kind: "unlocked" }]).locked).toBe(false);
});

test("back before the time is up stays open; back after it locks", () => {
  const open: LockEvent[] = [{ kind: "start" }, { kind: "unlocked" }];
  expect(
    after([...open, { atMs: 0, kind: "away" }, { atMs: 299_000, kind: "back" }])
      .locked
  ).toBe(false);
  expect(
    after([...open, { atMs: 0, kind: "away" }, { atMs: 300_000, kind: "back" }])
      .locked
  ).toBe(true);
});

test("set to immediately, any time away locks it", () => {
  const open: LockEvent[] = [{ kind: "start" }, { kind: "unlocked" }];
  expect(
    after([...open, { atMs: 0, kind: "away" }, { atMs: 1, kind: "back" }], 0)
      .locked
  ).toBe(true);
});

test("with the lock off, nothing locks", () => {
  expect(
    after(
      [
        { kind: "start" },
        { atMs: 0, kind: "away" },
        { atMs: 3_600_000, kind: "back" },
      ],
      0,
      false
    ).locked
  ).toBe(false);
});

test("away twice counts from the first, and a lock waiting to be undone stays", () => {
  const state = after([
    { kind: "start" },
    { atMs: 0, kind: "away" },
    { atMs: 100_000, kind: "away" },
    { atMs: 300_000, kind: "back" },
  ]);
  expect(state.locked).toBe(true);
});
