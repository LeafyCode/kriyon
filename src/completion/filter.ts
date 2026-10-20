/** A subsequence match with a rank; lower `score` sorts first. */
interface Ranked<T> {
  first: number;
  item: T;
  score: number;
}

/**
 * Rank `items` by how well `key(item)` fuzzy-matches `query` (case-insensitive
 * subsequence). Prefix matches beat scattered ones; ties break on earliest
 * match then shorter key. Empty query passes everything through unchanged.
 */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  key: (item: T) => string
): T[] {
  const q = query.toLowerCase();
  if (q.length === 0) {
    return items;
  }
  const ranked: Ranked<T>[] = [];
  for (const item of items) {
    const hay = key(item).toLowerCase();
    let qi = 0;
    let first = -1;
    for (let hi = 0; hi < hay.length && qi < q.length; hi += 1) {
      if (hay[hi] === q[qi]) {
        if (qi === 0) {
          first = hi;
        }
        qi += 1;
      }
    }
    if (qi === q.length) {
      // Prefix match (first === 0) gets the strongest boost.
      const score = (first === 0 ? 0 : 1000) + first;
      ranked.push({ item, score, first });
    }
  }
  ranked.sort(
    (a, b) => a.score - b.score || key(a.item).length - key(b.item).length
  );
  return ranked.map((r) => r.item);
}
