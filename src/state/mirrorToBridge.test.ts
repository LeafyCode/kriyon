import { expect, test, vi } from "vitest";
import { create } from "zustand";
import { mirrorToBridge } from "./mirrorToBridge.ts";

interface TestState {
  other: number;
  setOther: (n: number) => void;
  setV: (n: number) => void;
  v: number;
}

function makeStore() {
  return create<TestState>((set) => ({
    other: 0,
    setOther: (other) => set({ other }),
    setV: (v) => set({ v }),
    v: 1,
  }));
}

test("pushes the initial value, then only when the selected value changes", () => {
  const store = makeStore();
  const push = vi.fn().mockResolvedValue(undefined);

  const stop = mirrorToBridge(store, (s) => s.v, push);
  expect(push).toHaveBeenCalledWith(1);

  // An unrelated field change must not push.
  store.getState().setOther(9);
  expect(push).toHaveBeenCalledTimes(1);

  // A real change pushes.
  store.getState().setV(2);
  expect(push).toHaveBeenLastCalledWith(2);
  expect(push).toHaveBeenCalledTimes(2);

  // Setting the same value again must not push.
  store.getState().setV(2);
  expect(push).toHaveBeenCalledTimes(2);

  stop();
});

test("stops pushing after unsubscribe", () => {
  const store = makeStore();
  const push = vi.fn().mockResolvedValue(undefined);

  const stop = mirrorToBridge(store, (s) => s.v, push);
  stop();

  store.getState().setV(42);
  expect(push).toHaveBeenCalledTimes(1); // only the initial push
});
