/**
 * Paths as the OS writes them. On macOS only `/` separates; a Windows path
 * ({@link isWindowsPath}) may use either.
 * A backslash is a legal character in a macOS file name, so it only counts as
 * a separator in a path that is recognisably a Windows one.
 */

const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/(?!\/))/;
const ANY_SEPARATOR = /[\\/]/;

/**
 * Whether `path` is a Windows one: a drive path (`C:\`, `c:/`) or a network
 * share (`\\server\share`, or `//server/share` as git writes it). The one
 * rule every frontend path helper uses.
 */
export function isWindowsPath(path: string): boolean {
  return WINDOWS_PATH.test(path);
}

function separators(path: string): RegExp | string {
  return isWindowsPath(path) ? ANY_SEPARATOR : "/";
}

/** The path's non-empty segments, outermost first. */
export function pathSegments(path: string): string[] {
  return path.split(separators(path)).filter((segment) => segment !== "");
}

/** The last segment of a path (`/a/b/c` → `c`, `C:\a\b` → `b`), or the path. */
export function pathBasename(path: string): string {
  return pathSegments(path).pop() ?? path;
}

/** Everything before the last separator, or `""` when there is none. */
export function pathDirname(path: string): string {
  const windows = isWindowsPath(path);
  const cut = windows
    ? Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
    : path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : "";
}
