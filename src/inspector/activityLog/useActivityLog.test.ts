import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import {
  type ActivityChangedUpdate,
  type ActivityTurn,
  activityStats,
  activityTurns,
  onActivityChanged,
} from "../../ipc/bridge.ts";
import { useActivityLog } from "./useActivityLog.ts";

vi.mock("../../ipc/bridge.ts", () => ({
  activityStats: vi.fn(),
  activityTurns: vi.fn(),
  onActivityChanged: vi.fn(),
}));

const turns = vi.mocked(activityTurns);
const stats = vi.mocked(activityStats);
const subscribe = vi.mocked(onActivityChanged);

let emit: (update: ActivityChangedUpdate) => void = () => undefined;

function turn(id: number): ActivityTurn {
  return {
    endedMs: null,
    endReason: null,
    id,
    prompt: `p${id}`,
    report: null,
    source: "user",
    startedMs: 0,
    steps: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stats.mockResolvedValue({
    retentionDays: 30,
    sessions: 1,
    sizeBytes: 0,
    sizeCapBytes: 0,
  });
  subscribe.mockImplementation((cb) => {
    emit = cb;
    return Promise.resolve(() => undefined);
  });
});

test("loads the session's turns and the store's reach", async () => {
  turns.mockResolvedValue([turn(1)]);
  const { result } = renderHook(() => useActivityLog("s1"));
  await waitFor(() => expect(result.current.turns).toEqual([turn(1)]));
  expect(turns).toHaveBeenCalledWith("s1");
  expect(result.current.stats?.retentionDays).toBe(30);
});

test("reloads on activity-changed for this session only", async () => {
  turns.mockResolvedValue([turn(1)]);
  const { result } = renderHook(() => useActivityLog("s1"));
  await waitFor(() => expect(result.current.turns).toHaveLength(1));
  turns.mockResolvedValue([turn(2), turn(1)]);
  act(() => emit({ sessionId: "other" }));
  expect(turns).toHaveBeenCalledTimes(1);
  act(() => emit({ sessionId: "s1" }));
  await waitFor(() => expect(result.current.turns).toHaveLength(2));
});

test("a slow answer for the previous session never lands", async () => {
  let resolveOld: (value: ActivityTurn[]) => void = () => undefined;
  turns.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOld = resolve;
    })
  );
  turns.mockResolvedValueOnce([turn(9)]);
  const { result, rerender } = renderHook(({ id }) => useActivityLog(id), {
    initialProps: { id: "s1" },
  });
  rerender({ id: "s2" });
  await waitFor(() => expect(result.current.turns).toEqual([turn(9)]));
  await act(async () => {
    resolveOld([turn(1)]);
    await Promise.resolve();
  });
  expect(result.current.turns).toEqual([turn(9)]);
});

test("says why when the log can't be read", async () => {
  turns.mockRejectedValue("the activity log is unavailable");
  const { result } = renderHook(() => useActivityLog("s1"));
  await waitFor(() =>
    expect(result.current.error).toBe("the activity log is unavailable")
  );
});
