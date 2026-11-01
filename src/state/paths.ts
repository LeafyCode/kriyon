/** `path` without a trailing slash, so `/repo` and `/repo/` compare equal
 * and joining never produces a doubled separator. */
function withoutTrailingSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/** macOS firmlinks `/tmp`, `/var` and `/etc` into `/private`, so one
 * directory has two equally-real spellings — and the paths Kriyon compares
 * reliably disagree about which to use: `repo_toplevel` is git's
 * `rev-parse --show-toplevel`, which canonicalizes, while a session cwd or a
 * tool's file path is whatever raw path it was given. Anchored, and with the
 * boundary asserted, so `/private/variables` and `/private/mine` (ordinary
 * directories, not firmlink twins) are left alone. */
const MACOS_FIRMLINK_PREFIX = /^\/private(?=\/(?:etc|tmp|var)(?:\/|$))/;

/** One spelling per path, so prefix arithmetic compares like with like.
 * Collapses toward the short form, which makes it direction-agnostic: either
 * operand may be the canonicalized one. */
export function canonicalDir(path: string): string {
  return withoutTrailingSlash(path).replace(MACOS_FIRMLINK_PREFIX, "");
}
