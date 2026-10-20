const QUOTED = /^(.*?)"([^"]+)"(.*)$/s;

/** A [Work report]'s summary split around the quoted name of the work
 *  (`Agent "Review" finished`), so the name can stand out. `name` is `null`
 *  when the summary quotes none. */
export function summaryParts(summary: string): {
  after: string;
  before: string;
  name: string | null;
} {
  const match = QUOTED.exec(summary);
  if (match === null) {
    return { after: "", before: summary, name: null };
  }
  return {
    after: match[3] ?? "",
    before: match[1] ?? "",
    name: match[2] ?? "",
  };
}
