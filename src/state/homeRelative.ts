/**
 * The user's home folder shortened to `~`: `/Users/dev/Projects/kriyon` →
 * `~/Projects/kriyon`, anywhere in a path or a command line.
 *
 * A full path spends its width on the home folder and a narrow row cuts off
 * the part it exists to show. Only the real home folder (from the backend, set
 * once at startup) is shortened, and only where a path starts: someone else's
 * `/Users/alice/x`, or `/Volumes/Backup/Users/dev/x`, stays as it is.
 */
let home: RegExp | null = null;

const SPECIAL = /[.*+?^${}()|[\]\\]/g;
const TRAILING_SLASHES = /\/+$/;

/** Remember the home folder; `""` forgets it. */
export function setHomeFolder(path: string): void {
  const root = path.replace(TRAILING_SLASHES, "");
  home = root
    ? new RegExp(
        `(^|[\\s'"=(:])${root.replace(SPECIAL, "\\$&")}(?=/|$|[\\s'"):;])`,
        "g"
      )
    : null;
}

export function homeRelative(text: string): string {
  return home ? text.replace(home, "$1~") : text;
}
