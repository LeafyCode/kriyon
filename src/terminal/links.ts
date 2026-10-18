/**
 * The one place the terminal, the Changes view and the Structured view agree on
 * what a clickable link or file path is, and how a click acts on it.
 *
 * Detection entry points, deliberately different because their inputs are:
 *   - `looksLikePath` tests a Markdown link's target (loose: a slash or a
 *     short extension is enough — the author meant it as a link).
 *   - `matchPaths` scans raw terminal output (strict: a token must contain a
 *     `/` so prose like "e.g." never becomes a link).
 *   - `findLinks` scans prose for URLs and `matchPaths` paths together.
 * All share the segment/extension/line-suffix rules below, so they can't drift.
 *
 * The frontend stays loose on purpose: the Rust `open_path` command re-validates
 * and refuses anything that is not a real, openable file within a known root.
 */

import { openExternalUrl, openPath, revealPath } from "../ipc/bridge.ts";
import { commandFailure, failureMessage } from "../ipc/failures.ts";
import { useOutsideOpen } from "../state/outsideOpen.ts";
import { showToast } from "../ui/Toast.tsx";

/** A path segment char: word chars plus the punctuation real paths use. */
const SEG = String.raw`[\w.@+-]`;
/** A trailing `:line` or `:line:col` (ascii digits), as Claude prints refs. */
const LINE_SUFFIX = String.raw`(?::\d+(?::\d+)?)?`;
/** Short file extension: 1-8 alphanumerics after a dot. */
const FILE_EXT_RE = /\.[A-Za-z0-9]{1,8}$/;
/** All ascii digits (for the line-suffix check). */
const ALL_DIGITS_RE = /^\d+$/;

/**
 * A path token in free text: optional `~/`, `./`, `../` or `/` prefix, at least one
 * `/`-separated segment, a short extension, and an optional line suffix.
 * Global so `matchPaths` can scan a whole line. Reused across calls — safe
 * because `String.prototype.matchAll` operates on a clone, not `lastIndex`.
 */
const PATH_TOKEN_RE = new RegExp(
  String.raw`(?:~\/|\.{1,2}\/|\/)?(?:${SEG}+\/)+${SEG}+\.[A-Za-z0-9]{1,8}${LINE_SUFFIX}`,
  "g"
);

/** A Claude Code mention of a path with spaces: `@"/my notes/a.pdf"`. */
const QUOTED_MENTION_RE = /@"([^"\n]+)"/g;
/** The head of an unquoted `@path` mention: the `@` is Claude Code's, not the path's. */
const MENTION_HEAD_RE = /^@(?=[~./\w])/;

const URL_HEAD_RE = /^https?:\/\//i;
/** An http(s) URL in prose: up to whitespace or a char that can't sit in one. */
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'`]+/gi;
/** Sentence punctuation a prose URL is usually followed by, not part of. */
const URL_TRAILING_CHAR_RE = /[.,;:!?)\]}*_]/;
/** A `#heading` or `#L4-L9` anchor on a Markdown link to a file. */
const FRAGMENT_RE = /#.*$/;
const FILE_URL_HEAD_RE = /^file:/i;
/** Any `scheme://` — a link Kriyon neither browses to nor resolves as a file. */
const OTHER_SCHEME_RE = /^[A-Za-z][\w+.-]*:/;

/** Strip a trailing `:line` or `:line:col` (each segment all ascii digits) from
 *  a token. Mirrors the core `strip_line_suffix`; unlike a crude `split(":")`
 *  it leaves a non-numeric segment (e.g. `a:b`) intact. */
export function stripLineSuffix(token: string): string {
  let s = token;
  for (let i = 0; i < 2; i += 1) {
    const colon = s.lastIndexOf(":");
    if (colon < 0) {
      break;
    }
    const tail = s.slice(colon + 1);
    if (tail.length === 0 || !ALL_DIGITS_RE.test(tail)) {
      break;
    }
    s = s.slice(0, colon);
  }
  return s;
}

/** Whether a Markdown link's target reads as a file path. Loose: a slash or a
 *  short extension is enough, since the author made it a link. Rejects spans with whitespace, and URLs — a
 *  URL has a slash but is not a file (it must open in the browser, not resolve
 *  against cwd). */
export function looksLikePath(text: string): boolean {
  const bare = stripLineSuffix(text);
  if (bare.includes(" ") || isUrl(bare)) {
    return false;
  }
  return bare.includes("/") || FILE_EXT_RE.test(bare);
}

/** One path token found in a line: its text and its `[start, end)` offsets. */
export interface PathMatch {
  end: number;
  start: number;
  token: string;
}

/** Find every clickable path token in a line of raw text (for the terminal). */
export function matchPaths(line: string): PathMatch[] {
  return [...line.matchAll(PATH_TOKEN_RE)].map((m) =>
    withoutMentionHead({
      token: m[0],
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    })
  );
}

/** Every URL and path token in a run of prose, in order. A path inside a URL
 *  is part of the URL, not a second link. */
export function findLinks(text: string): PathMatch[] {
  const urls = [...text.matchAll(URL_IN_TEXT_RE)].map((m) => {
    const token = trimUrl(m[0]);
    const start = m.index ?? 0;
    return { end: start + token.length, start, token };
  });
  // `@"…"` holds one path, spaces and all; the quotes and `@` stay text.
  const quoted = [...text.matchAll(QUOTED_MENTION_RE)].map((m) => {
    const token = m[1] ?? "";
    const start = (m.index ?? 0) + 2;
    return { end: start + token.length, start, token };
  });
  const taken = [...urls, ...quoted];
  const paths = matchPaths(text).filter(
    (p) => !taken.some((u) => p.start < u.end && u.start < p.end)
  );
  return [...taken, ...paths].sort((a, b) => a.start - b.start);
}

/** `@/a/b.pdf` names `/a/b.pdf`: the leading `@` is a Claude Code mention. */
function withoutMentionHead(match: PathMatch): PathMatch {
  if (!MENTION_HEAD_RE.test(match.token)) {
    return match;
  }
  return { ...match, start: match.start + 1, token: match.token.slice(1) };
}

/** Drop the sentence punctuation after a prose URL, but keep a `)` that
 *  closes a `(` inside it (`…/wiki/Rust_(language)`). */
function trimUrl(raw: string): string {
  let url = raw;
  while (URL_TRAILING_CHAR_RE.test(url.slice(-1))) {
    if (url.endsWith(")") && url.split("(").length >= url.split(")").length) {
      break;
    }
    url = url.slice(0, -1);
  }
  return url;
}

/** What a link points at: a page for the browser, or a file token for
 *  {@link openFileToken}. Null for anything else (`mailto:`, `#anchor`, …). */
export type LinkTarget =
  | { kind: "path"; path: string }
  | { kind: "url"; url: string };

/** Read a link target — a Markdown link's `(…)` or an autolinked token. */
export function linkTarget(raw: string): LinkTarget | null {
  if (isUrl(raw)) {
    return { kind: "url", url: raw };
  }
  if (FILE_URL_HEAD_RE.test(raw)) {
    // `URL` drops a `#L4` anchor and a host (`file://localhost/…`, or the
    // machine name `ls --hyperlink` writes); the path is always local.
    try {
      return { kind: "path", path: decodeURIComponent(new URL(raw).pathname) };
    } catch {
      return null;
    }
  }
  const path = raw.replace(FRAGMENT_RE, "");
  if (OTHER_SCHEME_RE.test(stripLineSuffix(path)) || !looksLikePath(path)) {
    return null;
  }
  return { kind: "path", path };
}

/** Whether an inline-split chunk is an http(s) URL. */
export function isUrl(chunk: string): boolean {
  return URL_HEAD_RE.test(chunk);
}

/** A click that opened nothing says why — the backend's reason for a file
 *  (missing, outside the project, a type it won't open), else the error. */
function couldNotOpen(what: string) {
  return (error: unknown) => {
    showToast(`Couldn't open ${what}: ${failureMessage(error)}`, "error");
  };
}

/** Act on a clicked link: a URL opens in the browser, a file in its default
 *  app — or, with `reveal` (Cmd/Ctrl+click), in Finder. */
export function openLinkTarget(
  cwd: string,
  target: LinkTarget,
  reveal: boolean
): void {
  if (target.kind === "url") {
    openExternalLink(target.url);
  } else {
    openFileToken(cwd, target.path, reveal);
  }
}

/** Open a URL in the default browser. */
export function openExternalLink(url: string): void {
  openExternalUrl(url).catch(couldNotOpen(url));
}

/** Act on a clicked file token: open in the default app, or reveal in Finder.
 *  The backend re-validates and refuses a missing / non-openable path. */
export function openFileToken(
  cwd: string,
  token: string,
  reveal: boolean
): void {
  const act = reveal ? revealPath : openPath;
  const openAnyway = () => {
    act(cwd, token, true).catch(couldNotOpen(token));
  };
  act(cwd, token).catch((error: unknown) => {
    // A file outside every project opens only with the user's leave.
    if (commandFailure(error) === "outsideRoots") {
      useOutsideOpen.getState().ask({
        confirm: openAnyway,
        path: token,
        reveal,
      });
      return;
    }
    couldNotOpen(token)(error);
  });
}
