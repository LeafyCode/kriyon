import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  HeartbeatUpdate,
  StatusUpdate,
  UsageUpdate,
} from "../ipc/bridge.ts";
import {
  onFocusSession,
  onSessionActivity,
  onSessionClaudeId,
  onSessionHandoff,
  onSessionHeartbeat,
  onSessionReady,
  onSessionStatus,
  onSessionTitle,
  onSessionUsage,
} from "../ipc/bridge.ts";
import { installSessionListeners } from "./backendListeners.ts";
import { useCommandCenter } from "./commandCenter.ts";
import {
  installCommandCenterListeners,
  statusChangeAt,
} from "./commandCenterListeners.ts";

/** An unlisten no-op the mocked subscribers resolve to. */
function noop(): void {
  // Nothing to unlisten in the test double.
}

vi.mock("../ipc/bridge", () => ({
  onSessionStatus: vi.fn(() => Promise.resolve(noop)),
  onSessionUsage: vi.fn(() => Promise.resolve(noop)),
  onSessionActivity: vi.fn(() => Promise.resolve(noop)),
  onSessionTitle: vi.fn(() => Promise.resolve(noop)),
  onSessionClaudeId: vi.fn(() => Promise.resolve(noop)),
  onSessionHandoff: vi.fn(() => Promise.resolve(noop)),
  onSessionReady: vi.fn(() => Promise.resolve(noop)),
  onSessionHeartbeat: vi.fn(() => Promise.resolve(noop)),
  onFocusSession: vi.fn(() => Promise.resolve(noop)),
  onSessionResources: vi.fn(() => Promise.resolve(noop)),
  onSessionSleeping: vi.fn(() => Promise.resolve(noop)),
  onSessionHooksOff: vi.fn(() => Promise.resolve(noop)),
  onWorkingTreeChanged: vi.fn(() => Promise.resolve(noop)),
  onPlanLimits: vi.fn(() => Promise.resolve(noop)),
}));

const stops: Array<() => void> = [];

beforeEach(() => {
  vi.clearAllMocks();
  useCommandCenter.setState({ lastSeenMs: {}, lastChangeMs: {} });
});

afterEach(() => {
  while (stops.length > 0) {
    stops.pop()?.();
  }
});

/** Capture the callback handed to a mocked `on…` subscriber. */
function captured<T>(fn: { mock: { calls: unknown[][] } }): (u: T) => void {
  return fn.mock.calls[0]?.[0] as (u: T) => void;
}

test("onSessionHeartbeat feeds recordHeartbeat with the watcher time", async () => {
  stops.push(installCommandCenterListeners());
  await Promise.resolve();

  const cb = captured<HeartbeatUpdate>(
    onSessionHeartbeat as unknown as { mock: { calls: unknown[][] } }
  );
  cb({ sessionId: "s1", lastSeenMs: 12_345 });

  expect(useCommandCenter.getState().lastSeenMs.s1).toBe(12_345);
});

test("a status event records both a status change and liveness", async () => {
  stops.push(installCommandCenterListeners());
  await Promise.resolve();

  const before = Date.now();
  const cb = captured<StatusUpdate>(
    onSessionStatus as unknown as { mock: { calls: unknown[][] } }
  );
  cb({ sessionId: "s1", status: "waiting", summary: "blocked" });

  const cc = useCommandCenter.getState();
  expect(cc.lastChangeMs.s1).toBeGreaterThanOrEqual(before);
  expect(cc.lastSeenMs.s1).toBeGreaterThanOrEqual(before);
});

test("a usage event proves liveness via recordSeen", async () => {
  stops.push(installCommandCenterListeners());
  await Promise.resolve();

  const before = Date.now();
  const cb = captured<UsageUpdate>(
    onSessionUsage as unknown as { mock: { calls: unknown[][] } }
  );
  cb({
    sessionId: "s1",
    snapshot: {
      contextWindowSize: null,
      inputTokens: null,
      model: null,
      outputTokens: null,
      sessionId: null,
      usedPercentage: null,
    },
  });

  expect(useCommandCenter.getState().lastSeenMs.s1).toBeGreaterThanOrEqual(
    before
  );
  // No status change was recorded by a usage event.
  expect(useCommandCenter.getState().lastChangeMs.s1).toBeUndefined();
});

// Keep the other subscribers wired (smoke: the listeners install cleanly).
test("activity, title, claude-id, ready, handoff, and focus subscribers are installed", async () => {
  stops.push(installSessionListeners());
  await Promise.resolve();

  expect(onSessionActivity).toHaveBeenCalled();
  expect(onSessionTitle).toHaveBeenCalled();
  expect(onSessionClaudeId).toHaveBeenCalled();
  expect(onSessionReady).toHaveBeenCalled();
  expect(onSessionHandoff).toHaveBeenCalled();
  expect(onFocusSession).toHaveBeenCalled();
});

test("a launch replay reports when it happened, not now", () => {
  // The bug this guards: the seed emits a status for every session at launch.
  // Stamping those "now" told the recency projection that every session had
  // just been active, so the age-based "N older" fold could never fire again
  // after a restart — nothing was ever old enough.
  const threeDaysAgo = "2026-07-17T09:15:00.000Z";
  expect(
    statusChangeAt({
      lastEventAt: threeDaysAgo,
      seeded: true,
      sessionId: "s1",
      status: "idle",
      summary: "",
    })
  ).toBe(Date.parse(threeDaysAgo));

  // A replay with no usable timestamp records nothing at all, so the fold
  // falls back to the session's createdAt rather than to "now".
  for (const lastEventAt of [undefined, null, "not-a-date"]) {
    expect(
      statusChangeAt({
        lastEventAt,
        seeded: true,
        sessionId: "s1",
        status: "idle",
        summary: "",
      })
    ).toBeNull();
  }

  // A live update is happening now.
  const live = statusChangeAt({
    seeded: false,
    sessionId: "s1",
    status: "running",
    summary: "",
  });
  expect(live).toBeGreaterThan(Date.now() - 5000);
});
