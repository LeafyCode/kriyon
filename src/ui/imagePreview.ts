import { useEffect, useState } from "react";
import { attachmentPreview } from "../ipc/bridge.ts";

/**
 * Object URLs for admitted image [Attachment]s, read once each through the
 * backend (the only one allowed to open the file). Bounded: past
 * {@link MAX_CACHED} the oldest URL is revoked, so a long session's history
 * doesn't pin every picture in memory.
 */

const MAX_CACHED = 48;

const cache = new Map<string, Promise<string | null>>();

function load(path: string): Promise<string | null> {
  const hit = cache.get(path);
  if (hit !== undefined) {
    // Refresh its place as the newest.
    cache.delete(path);
    cache.set(path, hit);
    return hit;
  }
  const next = attachmentPreview(path)
    .then((bytes) => URL.createObjectURL(new Blob([bytes])))
    .catch(() => {
      cache.delete(path);
      return null;
    });
  cache.set(path, next);
  while (cache.size > MAX_CACHED) {
    const [oldest] = cache.keys();
    if (oldest === undefined) {
      break;
    }
    const gone = cache.get(oldest);
    cache.delete(oldest);
    gone?.then((url) => url && URL.revokeObjectURL(url)).catch(() => undefined);
  }
  return next;
}

/** The URL to draw `path`'s image from: `undefined` while loading, `null`
 *  when it can't be shown (gone, not admitted, not an image). */
export function useImagePreview(path: string): string | null | undefined {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setUrl(undefined);
    load(path)
      .then((next) => {
        if (alive) {
          setUrl(next);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [path]);
  return url;
}
