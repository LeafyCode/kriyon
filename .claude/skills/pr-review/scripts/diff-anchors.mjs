// Which lines of a pull request will accept an inline comment.
//
// GitHub only accepts a comment on a line that appears in the pull request's
// own diff (base to head) on the RIGHT side. That is true even during an
// incremental round: the review scope may be narrower, but the anchors are
// always judged against the whole pull request.

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * New-side line numbers a patch makes commentable.
 *
 * Walking a hunk: an added line and a context line each take one new-side
 * number; a removed line takes none.
 */
export function linesFromPatch(patch) {
  if (!patch) {
    return [];
  }

  const allowed = [];
  let newLine = 0;

  for (const raw of patch.split("\n")) {
    const hunk = raw.match(HUNK_HEADER);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+")) {
      allowed.push(newLine);
      newLine += 1;
    } else if (raw.startsWith("-") || raw.startsWith("\\")) {
      // a removal, or "no newline at end of file" — no new-side line consumed
    } else {
      allowed.push(newLine);
      newLine += 1;
    }
  }

  return allowed;
}

/** The same, for every file in a pull request: `{ path: [line, ...] }`. */
export function commentableLines(files) {
  return Object.fromEntries(
    files.map((file) => [file.filename, linesFromPatch(file.patch)])
  );
}
