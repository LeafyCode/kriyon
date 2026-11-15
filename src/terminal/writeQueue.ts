/**
 * Coalesces PTY output chunks and flushes them to xterm once per animation
 * frame. Batching matters for two reasons: it caps writes at one per frame
 * (instead of one per backend chunk), and — because the merged buffer preserves
 * byte order exactly — it keeps xterm's DEC-2026 synchronized-output framing
 * intact. Each flush reports the byte count via `onFlush` so the Rust reader's
 * drained accounting (its output gate) stays accurate. A hidden window gets no
 * frames, so nothing flushes until it shows again; Rust keeps reading the
 * session meanwhile and catches this queue up after (ADR-0059).
 */
export interface WriteQueueOptions {
  /** Cancel a scheduled frame. Defaults to `cancelAnimationFrame`. */
  cancelRaf?: (handle: number) => void;
  /** Total bytes written this flush — used to report drained bytes upstream. */
  onFlush?: (bytes: number) => void;
  /** Schedule a frame. Injected in tests; defaults to `requestAnimationFrame`. */
  raf?: (cb: () => void) => number;
  /** Sink for the merged frame, e.g. `term.write`. */
  write: (bytes: Uint8Array) => void;
}

export class WriteQueue {
  private readonly write: (bytes: Uint8Array) => void;
  private readonly onFlush: ((bytes: number) => void) | undefined;
  private readonly raf: (cb: () => void) => number;
  private readonly cancelRaf: (handle: number) => void;

  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private handle: number | undefined;

  constructor(opts: WriteQueueOptions) {
    this.write = opts.write;
    this.onFlush = opts.onFlush;
    this.raf = opts.raf ?? requestAnimationFrame.bind(globalThis);
    this.cancelRaf = opts.cancelRaf ?? cancelAnimationFrame.bind(globalThis);
  }

  /** Queue a chunk and schedule a flush if one is not already pending. */
  enqueue(bytes: Uint8Array): void {
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
    if (this.handle === undefined) {
      this.handle = this.raf(() => this.flush());
    }
  }

  private flush(): void {
    this.handle = undefined;
    if (this.pending.length === 0) {
      return;
    }
    const merged = new Uint8Array(this.pendingBytes);
    let offset = 0;
    for (const chunk of this.pending) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.pending = [];
    this.pendingBytes = 0;
    this.write(merged);
    this.onFlush?.(merged.length);
  }

  /**
   * Cancel any pending frame. Bytes still queued are discarded (the terminal is
   * going away) but still reported via `onFlush` so the Rust drained counter
   * stays exact and the Rust output gate does not hold output for nothing.
   */
  dispose(): void {
    if (this.handle !== undefined) {
      this.cancelRaf(this.handle);
      this.handle = undefined;
    }
    if (this.pendingBytes > 0) {
      this.onFlush?.(this.pendingBytes);
    }
    this.pending = [];
    this.pendingBytes = 0;
  }
}
