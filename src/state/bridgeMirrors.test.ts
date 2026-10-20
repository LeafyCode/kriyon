import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  setFocusedSession,
  setNotifyPreference,
  setNotifySound,
} from "../ipc/bridge.ts";
import { installBridgeMirrors } from "./bridgeMirrors.ts";
import { DEFAULT_LAYOUT, useLayout } from "./layout.ts";
import { useSessions } from "./sessions.ts";

vi.mock("../ipc/bridge", () => ({
  setFocusedSession: vi.fn(() => Promise.resolve()),
  setAutoSleep: vi.fn(() => Promise.resolve()),
  setMemoryBudget: vi.fn(() => Promise.resolve()),
  setNotifyPreference: vi.fn(() => Promise.resolve()),
  setNotifySound: vi.fn(() => Promise.resolve()),
}));

const mockedPref = vi.mocked(setNotifyPreference);
const mockedFocus = vi.mocked(setFocusedSession);
const mockedSound = vi.mocked(setNotifySound);
const stops: Array<() => void> = [];

beforeEach(() => {
  vi.clearAllMocks();
  useLayout.setState({ layout: DEFAULT_LAYOUT });
  useSessions.setState({ activeSessionId: null });
});

afterEach(() => {
  while (stops.length > 0) {
    stops.pop()?.();
  }
});

test("installBridgeMirrors pushes both current values immediately", () => {
  stops.push(installBridgeMirrors());
  expect(mockedPref).toHaveBeenCalledWith("all");
  expect(mockedFocus).toHaveBeenCalledWith(null);
  expect(mockedSound).toHaveBeenCalledWith("default");
});

test("installBridgeMirrors pushes on every notify-sound change", () => {
  stops.push(installBridgeMirrors());
  mockedSound.mockClear();

  useLayout.getState().setNotifySound("bell");
  expect(mockedSound).toHaveBeenCalledWith("bell");
});

test("installBridgeMirrors pushes on every notify-preference change", () => {
  stops.push(installBridgeMirrors());
  mockedPref.mockClear();

  useLayout.getState().setNotifyPreference("only_blocked");
  expect(mockedPref).toHaveBeenCalledWith("only_blocked");

  useLayout.getState().setNotifyPreference("none");
  expect(mockedPref).toHaveBeenCalledWith("none");
});

test("installBridgeMirrors mirrors the active session to the backend", () => {
  stops.push(installBridgeMirrors());
  mockedFocus.mockClear();

  useSessions.setState({ activeSessionId: "s-42" });
  expect(mockedFocus).toHaveBeenCalledWith("s-42");
});

test("installBridgeMirrors ignores changes that leave a mirrored value unchanged", () => {
  stops.push(installBridgeMirrors());
  mockedPref.mockClear();

  // A non-preference layout change must not re-push the preference.
  useLayout.getState().setView("focus");
  expect(mockedPref).not.toHaveBeenCalled();
});

test("the teardown unsubscribes every mirror", () => {
  const stop = installBridgeMirrors();
  stop();
  mockedPref.mockClear();
  mockedFocus.mockClear();
  mockedSound.mockClear();

  useLayout.getState().setNotifyPreference("none");
  useLayout.getState().setNotifySound("bell");
  useSessions.setState({ activeSessionId: "s-99" });
  expect(mockedPref).not.toHaveBeenCalled();
  expect(mockedFocus).not.toHaveBeenCalled();
  expect(mockedSound).not.toHaveBeenCalled();
});
