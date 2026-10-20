import { beforeEach, expect, test, vi } from "vitest";
import { WriteQueue } from "./writeQueue.ts";

/**
 * A manual rAF: callbacks are queued, not fired, until `flush()` is called.
 * This lets tests control exactly when a frame "fires".
 */
function fakeRaf() {
  const callbacks = new Map<number, () => void>();
  let nextHandle = 1;
  const raf = (cb: () => void): number => {
    const handle = nextHandle;
    nextHandle += 1;
    callbacks.set(handle, cb);
    return handle;
  };
  const cancelRaf = (handle: number): void => {
    callbacks.delete(handle);
  };
  const fire = (): void => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const cb of pending) {
      cb();
    }
  };
  return { cancelRaf, fire, pending: callbacks, raf };
}

let fake: ReturnType<typeof fakeRaf>;
let write: ReturnType<typeof vi.fn<(bytes: Uint8Array) => void>>;
let onFlush: ReturnType<typeof vi.fn<(bytes: number) => void>>;

beforeEach(() => {
  fake = fakeRaf();
  write = vi.fn<(bytes: Uint8Array) => void>();
  onFlush = vi.fn<(bytes: number) => void>();
});

function makeQueue() {
  return new WriteQueue({
    cancelRaf: fake.cancelRaf,
    onFlush,
    raf: fake.raf,
    write,
  });
}

test("coalesces enqueued chunks into one ordered write per frame", () => {
  const queue = makeQueue();

  queue.enqueue(new Uint8Array([1, 2]));
  queue.enqueue(new Uint8Array([3]));
  queue.enqueue(new Uint8Array([4, 5]));

  // Nothing is written before the frame fires.
  expect(write).not.toHaveBeenCalled();
  expect(onFlush).not.toHaveBeenCalled();

  fake.fire();

  expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0]?.[0]).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  expect(onFlush).toHaveBeenCalledTimes(1);
  expect(onFlush).toHaveBeenCalledWith(5);
});

test("schedules a new frame for enqueues after a flush (one write per frame)", () => {
  const queue = makeQueue();

  queue.enqueue(new Uint8Array([1]));
  fake.fire();
  expect(write).toHaveBeenCalledTimes(1);

  // A fresh enqueue must schedule a new frame, not ride the previous one.
  queue.enqueue(new Uint8Array([2]));
  expect(write).toHaveBeenCalledTimes(1);
  fake.fire();
  expect(write).toHaveBeenCalledTimes(2);
  expect(write.mock.calls[1]?.[0]).toEqual(new Uint8Array([2]));
});

test("an empty-queue flush is a no-op", () => {
  makeQueue();
  // No enqueue: firing any stray frame must not write or report.
  fake.fire();
  expect(write).not.toHaveBeenCalled();
  expect(onFlush).not.toHaveBeenCalled();
});

test("dispose cancels the pending frame and reports queued bytes via onFlush", () => {
  const queue = makeQueue();

  queue.enqueue(new Uint8Array([1, 2, 3]));
  queue.enqueue(new Uint8Array([4]));
  expect(fake.pending.size).toBe(1);

  queue.dispose();

  // Frame is cancelled (drained accounting still stays exact via onFlush).
  expect(fake.pending.size).toBe(0);
  expect(write).not.toHaveBeenCalled();
  expect(onFlush).toHaveBeenCalledTimes(1);
  expect(onFlush).toHaveBeenCalledWith(4);

  // Firing a stray frame after dispose does nothing.
  fake.fire();
  expect(write).not.toHaveBeenCalled();
});

test("dispose with an empty queue does not report", () => {
  const queue = makeQueue();
  queue.dispose();
  expect(onFlush).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
