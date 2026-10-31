import type { FileEntry } from "../ipc/bridge.ts";

/**
 * The Files view's search: how the project-wide matches `listFiles` returns
 * are ordered for a person looking for one file.
 *
 * The backend only filters (case-insensitive, anywhere in the path) and sorts
 * folders first, alphabetically — the right order for `@`-mention
 * completion, the wrong one for "find me Button.tsx". Here a match in the
 * file's own name beats a match in a folder above it, the closer the name is
 * to the query the higher it sits, and among equals the shallower path wins:
 * the order an editor's quick-open gives.
 */

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Lower is better: 0 the name is the query, 1 the name starts with it,
 * 2 the name contains it, 3 only a folder above it matched. */
function score(entry: FileEntry, needle: string): number {
  const name = baseName(entry.path).toLowerCase();
  if (name === needle) {
    return 0;
  }
  if (name.startsWith(needle)) {
    return 1;
  }
  return name.includes(needle) ? 2 : 3;
}

/** `entries` in the order the search shows them — see the module doc. */
export function rankFileMatches(
  entries: readonly FileEntry[],
  query: string
): FileEntry[] {
  const needle = query.trim().toLowerCase();
  return entries
    .map((entry) => ({ entry, rank: score(entry, needle) }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.entry.path.length - b.entry.path.length ||
        a.entry.path.localeCompare(b.entry.path)
    )
    .map(({ entry }) => entry);
}

/** Where `query` sits in `name` as `[start, end)`, for highlighting — or
 * `undefined` when the name itself doesn't contain it (a folder matched). */
export function matchRange(
  name: string,
  query: string
): [number, number] | undefined {
  const needle = query.trim().toLowerCase();
  const at = needle === "" ? -1 : name.toLowerCase().indexOf(needle);
  return at === -1 ? undefined : [at, at + needle.length];
}
