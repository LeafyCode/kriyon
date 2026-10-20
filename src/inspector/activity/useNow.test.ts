import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useNow } from "./useNow.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("re-renders about once per second", () => {
  const { result } = renderHook(() => useNow());
  const first = result.current;
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(result.current).toBeGreaterThan(first);
});

test("two consumers share one interval and stay in sync", () => {
  const a = renderHook(() => useNow());
  const b = renderHook(() => useNow());
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(a.result.current).toBe(b.result.current);
});
