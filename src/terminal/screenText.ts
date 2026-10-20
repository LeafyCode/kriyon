/**
 * The rows a session's terminal shows right now, as text, for the few things
 * Kriyon reads off the screen (the [Structured view]'s spinner tip, an open
 * [CLI dialog]). Each mounted terminal registers a reader for its session; a
 * session with none mounted reads as no rows.
 */

type Reader = () => string[];

const readers = new Map<string, Reader>();

/** Register `read` as the screen of `sessionId`; returns the unregister. */
export function registerScreenText(
  sessionId: string,
  read: Reader
): () => void {
  readers.set(sessionId, read);
  return () => {
    if (readers.get(sessionId) === read) {
      readers.delete(sessionId);
    }
  };
}

/** The rows `sessionId`'s terminal shows, top to bottom; none if unmounted. */
export function screenText(sessionId: string): string[] {
  try {
    return readers.get(sessionId)?.() ?? [];
  } catch {
    return [];
  }
}
