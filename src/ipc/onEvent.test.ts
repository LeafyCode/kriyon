import { describe, expect, it, vi } from "vitest";
import { onEvent, stopAll } from "./onEvent.ts";

describe("onEvent", () => {
  it("delivers updates and unlistens on cleanup", async () => {
    const unlisten = vi.fn();
    let emit: ((u: number) => void) | undefined;
    const subscribe = (cb: (u: number) => void) => {
      emit = cb;
      return Promise.resolve(unlisten);
    };
    const seen: number[] = [];

    const stop = onEvent(subscribe, (u) => seen.push(u));
    await Promise.resolve(); // let the subscription promise resolve

    emit?.(42);
    expect(seen).toEqual([42]);

    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("unlistens immediately when cleanup precedes the subscription resolving", async () => {
    const unlisten = vi.fn();
    let resolve: ((fn: () => void) => void) | undefined;
    const subscribe = () =>
      new Promise<() => void>((r) => {
        resolve = r;
      });

    const stop = onEvent(subscribe, () => {
      // no-op
    });
    stop(); // cleanup runs before the subscription resolves
    resolve?.(unlisten);
    await Promise.resolve();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("swallows a failed subscription", async () => {
    const stop = onEvent(
      () => Promise.reject(new Error("no runtime")),
      () => {
        // no-op
      }
    );
    await Promise.resolve();
    expect(stop).not.toThrow();
  });
});

describe("stopAll", () => {
  it("runs every cleanup", () => {
    const a = vi.fn();
    const b = vi.fn();
    stopAll([a, b])();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
