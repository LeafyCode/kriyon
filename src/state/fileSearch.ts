/**
 * The Files view's search highlighting. Ranking lives in Rust
 * (`kriyon_core::file_search`), where it runs over every match before the
 * result cut.
 */

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
