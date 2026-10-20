import { describe, expect, it, vi } from "vitest";
import { createSwrResource, type SwrOutcome } from "./swrResource.ts";

/** Collect the settle outcomes a revalidation reports. */
function collector<T>() {
  const settled: SwrOutcome<T>[] = [];
  return {
    settled,
    handlers: {
      onSettle: (outcome: SwrOutcome<T>) => settled.push(outcome),
    },
  };
}

describe("createSwrResource", () => {
  it("caches a resolved value and serves it via peek", async () => {
    const resource = createSwrResource<number>();
    expect(resource.peek("k")).toBeUndefined();

    await resource.revalidate("k", () => Promise.resolve(7));

    expect(resource.peek("k")).toBe(7);
  });

  it("drops a superseded slow response instead of overwriting a newer one", async () => {
    const resource = createSwrResource<number>();

    let resolveSlow: (value: number) => void = () => {
      // replaced synchronously below
    };
    const slow = resource.revalidate(
      "k",
      () =>
        new Promise<number>((res) => {
          resolveSlow = res;
        }),
      collector<number>().handlers
    );

    // A newer request lands first with the fresh value.
    await resource.revalidate("k", () => Promise.resolve(2));
    expect(resource.peek("k")).toBe(2);

    // The stale slow response now resolves — it must be discarded.
    resolveSlow(1);
    await slow;
    expect(resource.peek("k")).toBe(2);
  });

  it("serves the last cached value when a refetch fails (stale-on-error)", async () => {
    const resource = createSwrResource<number>();
    await resource.revalidate("k", () => Promise.resolve(5));

    const { settled } = collector<number>();
    await resource.revalidate("k", () => Promise.reject(new Error("down")), {
      onSettle: (outcome) => settled.push(outcome),
    });

    expect(settled).toHaveLength(1);
    expect(settled[0]).toEqual({ value: 5, coldFailure: false });
    // The cache is untouched by the failure.
    expect(resource.peek("k")).toBe(5);
  });

  it("admits a cold failure when nothing is cached", async () => {
    const resource = createSwrResource<number>();
    const { settled } = collector<number>();

    await resource.revalidate("k", () => Promise.reject(new Error("down")), {
      onSettle: (outcome) => settled.push(outcome),
    });

    expect(settled[0]).toEqual({ value: undefined, coldFailure: true });
    expect(resource.peek("k")).toBeUndefined();
  });

  it("fires onStart before the fetch and onDone only for the newest request", async () => {
    const resource = createSwrResource<number>();
    const order: string[] = [];

    await resource.revalidate("k", () => Promise.resolve(1), {
      onStart: () => order.push("start"),
      onSettle: () => order.push("settle"),
      onDone: () => order.push("done"),
    });

    expect(order).toEqual(["start", "settle", "done"]);
  });

  it("does not fire onDone for a superseded request", async () => {
    const resource = createSwrResource<number>();
    const done = vi.fn();

    let resolveSlow: (value: number) => void = () => {
      // replaced synchronously below
    };
    const slow = resource.revalidate(
      "k",
      () =>
        new Promise<number>((res) => {
          resolveSlow = res;
        }),
      { onDone: done }
    );
    await resource.revalidate("k", () => Promise.resolve(2));

    resolveSlow(1);
    await slow;
    expect(done).not.toHaveBeenCalled();
  });

  it("notifies every subscriber of a key when a revalidation succeeds", async () => {
    const resource = createSwrResource<number>();
    const one = vi.fn();
    const two = vi.fn();
    resource.subscribe("k", one);
    resource.subscribe("k", two);

    await resource.revalidate("k", () => Promise.resolve(4));

    // Both concurrent consumers of the key get the value — delivery does not
    // depend on which one owns the newest seq.
    expect(one).toHaveBeenCalledWith(4);
    expect(two).toHaveBeenCalledWith(4);
  });

  it("stops delivering to an unsubscribed listener", async () => {
    const resource = createSwrResource<number>();
    const listener = vi.fn();
    const unsubscribe = resource.subscribe("k", listener);
    unsubscribe();

    await resource.revalidate("k", () => Promise.resolve(1));

    expect(listener).not.toHaveBeenCalled();
  });

  it("does not notify subscribers for a superseded response or a failure", async () => {
    const resource = createSwrResource<number>();
    const listener = vi.fn();
    resource.subscribe("k", listener);

    let resolveSlow: (value: number) => void = () => {
      // replaced synchronously below
    };
    const slow = resource.revalidate(
      "k",
      () =>
        new Promise<number>((res) => {
          resolveSlow = res;
        })
    );
    await resource.revalidate("k", () => Promise.resolve(2));
    resolveSlow(1);
    await slow;
    // The superseded slow response never notifies (it also never caches).
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(2);

    // A failure keeps the cache and notifies no one (stale-on-error is served
    // to the caller via onSettle, not pushed to subscribers).
    await resource.revalidate("k", () => Promise.reject(new Error("down")));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("clear() drops the cache and resets the seq-guard", async () => {
    const resource = createSwrResource<number>();
    await resource.revalidate("k", () => Promise.resolve(9));
    expect(resource.peek("k")).toBe(9);

    resource.clear();
    expect(resource.peek("k")).toBeUndefined();
  });
});
