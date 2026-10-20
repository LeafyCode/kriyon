import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  type CompanionState,
  companionStatus,
  onCompanionChanged,
} from "../ipc/bridge.ts";
import { useIntegration } from "../state/integration.ts";
import { useCompanionStatus } from "./useCompanionStatus.ts";

vi.mock("../ipc/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/bridge.ts")>()),
  companionStatus: vi.fn(),
  onCompanionChanged: vi.fn(),
}));

let changed: ((update: { sessionId: string }) => void) | undefined;

function answer(state: CompanionState): void {
  vi.mocked(companionStatus).mockResolvedValue({ claudeVersion: null, state });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(companionStatus).mockReset();
  vi.mocked(onCompanionChanged).mockImplementation((cb) => {
    changed = cb;
    return Promise.resolve(() => {
      changed = undefined;
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
});

test.each(["on", "off", "blocked"] as const)(
  "a settled companion (%s) is not polled again",
  async (state) => {
    answer(state);
    const { result, unmount } = renderHook(() => useCompanionStatus("s1"));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current?.state).toBe(state);

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(companionStatus).toHaveBeenCalledTimes(1);
    unmount();
  }
);

test("an unsettled companion is polled until it settles", async () => {
  answer("starting");
  const { result, unmount } = renderHook(() => useCompanionStatus("s1"));
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(companionStatus).toHaveBeenCalledTimes(2);

  answer("on");
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(result.current?.state).toBe("on");
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(companionStatus).toHaveBeenCalledTimes(3);
  unmount();
});

test("a settled companion still refreshes on its changed event", async () => {
  answer("on");
  const { result, unmount } = renderHook(() => useCompanionStatus("s1"));
  await act(() => vi.advanceTimersByTimeAsync(0));

  answer("silent");
  await act(async () => {
    changed?.({ sessionId: "s1" });
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(result.current?.state).toBe("silent");
  unmount();
});

test("no session asks nothing", async () => {
  const { result, unmount } = renderHook(() => useCompanionStatus(""));
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(result.current).toBeNull();
  expect(companionStatus).not.toHaveBeenCalled();
  unmount();
});

test("a settled companion is asked again when Settings change", async () => {
  answer("off");
  const { result, unmount } = renderHook(() => useCompanionStatus("s1"));
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(result.current?.state).toBe("off");

  // Turning the companion on makes this running session need a restart, and
  // no post will ever say so.
  answer("needsRestart");
  act(() => {
    useIntegration.setState({
      status: {
        companionDir: null,
        originalStatusLine: null,
        companionAvailable: true,
        plannedReason: "plugin",
        plannedRoute: "plugin",
        prefs: {
          companion: true,
          consented: true,
          liveUsage: true,
          sideloadRefused: false,
          statusHooks: true,
        },
        route: "plugin",
        routeReason: "plugin",
        sideload: "allowed",
      },
    });
  });
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(result.current?.state).toBe("needsRestart");
  unmount();
});
