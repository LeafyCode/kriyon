/**
 * Lazy, singleton syntax highlighter for diff hunks and full-file views.
 *
 * Everything from `shiki` (`@shikijs/core`, `@shikijs/engine-javascript`,
 * `@shikijs/langs`) is reached only through dynamic `import()`, and only from
 * inside `highlightLines`. That keeps shiki out of the app's main bundle:
 * importing this module's exports costs nothing until a caller actually
 * asks to highlight code.
 *
 * A syntax highlighter must never be able to break the view: an unrecognised
 * language, a failed grammar import, or a highlighter that fails to
 * initialise all degrade to plain single-span lines rather than throwing.
 */
import type { HighlighterCore } from "@shikijs/core";
import { tokens } from "../theme/tokens.ts";

/**
 * One token's rendered style. `bold`/`italic` are decoded from shiki's
 * `fontStyle` bitfield — dropping them (as this used to) throws away half of
 * what a real theme expresses: an italic comment and a bold markdown heading
 * are not decoration, they're how those themes separate prose from code.
 */
export type HighlightedLine = Array<{
  bold?: boolean;
  color?: string;
  italic?: boolean;
  text: string;
}>;

const THEME_NAME = "kriyon";

/** shiki's `fontStyle` bitfield (`FontStyle` in `@shikijs/types`, not exported
 * at runtime): 1 = italic, 2 = bold, 4 = underline. `-1` means "not set".
 * Decoded without bitwise operators, which this repo's lint config disallows
 * (`noBitwiseOperators`) — the field only ever carries these low bits, so
 * arithmetic reads them exactly. */
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;

function hasFontStyle(fontStyle: number | undefined, bit: number): boolean {
  if (fontStyle === undefined || fontStyle <= 0) {
    return false;
  }
  return Math.floor(fontStyle / bit) % 2 === 1;
}

/**
 * The one shiki theme, built entirely from `tokens.color.syntax` — never
 * hardcoded colors (see `theme/themes/types.ts` for why that palette is its
 * own block, and `CodeEditor.tsx` for the CodeMirror half reading the same
 * source).
 *
 * The scope list follows VS Code's Default Dark+ in *shape*, not just in
 * colour. That matters more than it sounds: TextMate scopes are matched by
 * prefix and most-specific-wins, so a short list doesn't merely under-colour,
 * it mis-colours. The previous 11-scope version had `keyword` covering both
 * `keyword.control` (flow) and `keyword.operator` (`=`, `+`), so `=` came out
 * the same colour as `return`, while `const` — which is `storage.modifier` in
 * the TypeScript grammar, not `keyword` — fell through to plain foreground.
 * Covering the scopes a real grammar actually emits is the whole difference
 * between "has some colour" and "reads like an editor".
 */
function buildTheme() {
  const { syntax } = tokens.color;
  return {
    name: THEME_NAME,
    settings: [
      // Base foreground: anything no rule below claims. The editor's own ink,
      // not the app's UI ink — borrowing chrome ink here left plain code a
      // different grey from the editor's while making `syntaxConstant` read
      // *brighter* than the text around it.
      { settings: { foreground: tokens.color.editorInk } },

      {
        scope: ["comment", "punctuation.definition.comment"],
        settings: { fontStyle: "italic", foreground: syntax.comment },
      },

      {
        scope: [
          "string",
          "string.quoted",
          "string.template",
          "constant.other.symbol",
          "meta.embedded.assembly",
        ],
        settings: { foreground: syntax.string },
      },
      {
        scope: ["string.regexp", "constant.regexp"],
        settings: { foreground: syntax.regexp },
      },
      {
        scope: [
          "constant.character.escape",
          "punctuation.definition.template-expression",
          "punctuation.section.embedded",
        ],
        settings: { foreground: syntax.stringEscape },
      },

      { scope: ["constant.numeric"], settings: { foreground: syntax.number } },
      {
        scope: ["constant.language", "constant.other", "support.constant"],
        settings: { foreground: syntax.constant },
      },
      // `variable.other.constant` is VIOLET, not the constant ink — the same
      // hue as an accessed property. Folding these two in with
      // `constant.language` above painted most identifiers in a modern TS
      // file the brightest colour in the palette.
      {
        scope: ["variable.other.constant", "variable.other.enummember"],
        settings: { foreground: syntax.property },
      },

      // Control flow reads differently from declaration — the single most
      // recognisable thing about the Dark+ palette.
      {
        scope: [
          "keyword.control",
          "keyword.other.important",
          "punctuation.definition.keyword",
        ],
        settings: { foreground: syntax.keywordFlow },
      },
      {
        scope: [
          "keyword",
          "keyword.other",
          "storage",
          "storage.type",
          "storage.modifier",
          "variable.language",
          "support.type.builtin",
        ],
        settings: { foreground: syntax.keyword },
      },
      // Ordinary operators (`keyword.operator`) stay near-neutral. Without
      // this rule TextMate prefix-matching hands every `=`, `+`, `===`, `=>`
      // and `&&` to the `keyword` rule above — which mattered little under a
      // blue Dark+ keyword and matters enormously under a teal one, where the
      // operators become the loudest thing on a line of TypeScript.
      {
        scope: ["keyword.operator"],
        settings: { foreground: syntax.punctuation },
      },
      // …and the exceptions kept on the keyword hue: the operators that are
      // really words. More specific
      // than the rule above, so they win regardless of order — listed after
      // it anyway, so the pair reads as one decision.
      {
        scope: [
          "keyword.operator.expression",
          "keyword.operator.new",
          "keyword.operator.delete",
          "keyword.operator.ternary",
          "keyword.operator.optional",
          "keyword.operator.module",
          "keyword.operator.instanceof",
        ],
        settings: { foreground: syntax.keyword },
      },

      {
        scope: [
          "entity.name.function",
          "support.function",
          "meta.function-call",
          "variable.function",
          "meta.function-call.generic",
        ],
        settings: { foreground: syntax.function },
      },

      {
        scope: [
          "entity.name.type",
          "entity.name.class",
          "entity.name.namespace",
          "entity.name.scope-resolution",
          "entity.other.inherited-class",
          "support.class",
          "support.type",
          "meta.type.annotation",
          "storage.type.annotation",
        ],
        settings: { foreground: syntax.type },
      },

      {
        scope: [
          "variable",
          "variable.other",
          "variable.parameter",
          "variable.other.object",
          "meta.definition.variable",
          "support.variable",
          "meta.object-literal.key",
          "support.type.property-name",
        ],
        settings: { foreground: syntax.variable },
      },
      // The one split inside the `variable` family: an *accessed* property is
      // violet while the object it hangs off stays near-neutral. Deliberately
      // narrower than "anything property-shaped" — `meta.object-literal.key` and
      // `support.type.property-name` stay in the variable colour above, so a JS
      // object literal's keys and a JSON document's keys are untouched. This
      // rule sits AFTER the variable one and is more specific than
      // `variable.other`, so it wins on both counts.
      {
        scope: ["variable.other.property", "support.variable.property"],
        settings: { foreground: syntax.property },
      },
      // A JSON key is the one property coloured like a keyword
      // (`support.type.property-name.json` → the keyword teal).
      // Narrower than the generic `support.type.property-name` left on the
      // variable ink above, so a JS/CSS property name is unaffected.
      {
        scope: ["support.type.property-name.json"],
        settings: { foreground: syntax.keyword },
      },

      {
        scope: [
          "punctuation",
          "punctuation.separator",
          "punctuation.terminator",
          "meta.brace",
        ],
        settings: { foreground: syntax.punctuation },
      },

      // Markup: tags/attributes shared by html/xml/jsx/vue/svelte.
      { scope: ["entity.name.tag"], settings: { foreground: syntax.tag } },
      {
        scope: [
          "entity.other.attribute-name",
          "entity.other.attribute-name.class",
          "entity.other.attribute-name.id",
        ],
        settings: { foreground: syntax.attribute },
      },

      // Markdown prose, where font style carries as much meaning as colour.
      {
        scope: ["markup.heading", "entity.name.section"],
        settings: { fontStyle: "bold", foreground: syntax.keyword },
      },
      { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
      { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
      {
        scope: ["markup.inline.raw", "markup.fenced_code", "markup.raw"],
        settings: { foreground: syntax.string },
      },
      {
        scope: ["markup.underline.link", "string.other.link"],
        settings: { foreground: syntax.constant },
      },
      {
        scope: ["markup.inserted"],
        settings: { foreground: tokens.color.add },
      },
      {
        scope: ["markup.deleted"],
        settings: { foreground: tokens.color.del },
      },

      // CSS/SCSS selectors and units, which no generic scope above claims.
      {
        scope: ["entity.name.tag.css", "support.type.property-name.css"],
        settings: { foreground: syntax.attribute },
      },
      {
        scope: ["keyword.other.unit"],
        settings: { foreground: syntax.number },
      },
    ],
  };
}

// Every `@shikijs/langs/*` module has this shape (a default-exported grammar
// array); using it as the loader return type keeps `loadLanguage` calls typed
// without a runtime import of shiki's internal `LanguageInput` type.
type GrammarModule = typeof import("@shikijs/langs/typescript");

/**
 * Dynamic-import loaders, one per shiki language id this app supports. Each is
 * its own `import()`, so a repo that only ever opens TypeScript never pays for
 * the other grammars — adding a language here costs nothing until a file of
 * that type is actually shown.
 */
const GRAMMAR_LOADERS: Record<string, () => Promise<GrammarModule>> = {
  bash: () => import("@shikijs/langs/bash"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  go: () => import("@shikijs/langs/go"),
  graphql: () => import("@shikijs/langs/graphql"),
  hcl: () => import("@shikijs/langs/hcl"),
  html: () => import("@shikijs/langs/html"),
  ini: () => import("@shikijs/langs/ini"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  json: () => import("@shikijs/langs/json"),
  jsx: () => import("@shikijs/langs/jsx"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  less: () => import("@shikijs/langs/less"),
  lua: () => import("@shikijs/langs/lua"),
  make: () => import("@shikijs/langs/make"),
  markdown: () => import("@shikijs/langs/markdown"),
  php: () => import("@shikijs/langs/php"),
  proto: () => import("@shikijs/langs/proto"),
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  scss: () => import("@shikijs/langs/scss"),
  sql: () => import("@shikijs/langs/sql"),
  svelte: () => import("@shikijs/langs/svelte"),
  swift: () => import("@shikijs/langs/swift"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  vue: () => import("@shikijs/langs/vue"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
};

/**
 * File extension → shiki language id. Superset of `lang_from_path` in
 * `crates/kriyon-core/src/transcript.rs`: this view shows whatever the user's
 * repo contains, not just what a transcript embeds, and every extension
 * missing from here renders as plain text — which is what a `.yaml`, `.sh`,
 * `.go` or `.sql` file did before.
 */
const EXT_TO_LANG: Record<string, string> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cs: "csharp",
  cpp: "cpp",
  cts: "typescript",
  css: "css",
  cxx: "cpp",
  gql: "graphql",
  graphql: "graphql",
  go: "go",
  h: "c",
  hcl: "hcl",
  hpp: "cpp",
  htm: "html",
  html: "html",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  json5: "jsonc",
  jsonc: "jsonc",
  jsx: "jsx",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  lua: "lua",
  md: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  mts: "typescript",
  php: "php",
  proto: "proto",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sass: "scss",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svelte: "svelte",
  svg: "xml",
  swift: "swift",
  tf: "hcl",
  tfvars: "hcl",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

/**
 * Extensionless file names that are still recognisable code — a `Dockerfile`
 * or `Makefile` has no dot to key off, and rendering the most common ones as
 * plain text is a gap a user notices immediately. Matched case-insensitively
 * against the file name, after any directory prefix.
 */
const NAME_TO_LANG: Record<string, string> = {
  ".env": "bash",
  ".gitignore": "ini",
  ".zshrc": "bash",
  containerfile: "dockerfile",
  dockerfile: "dockerfile",
  gemfile: "ruby",
  makefile: "make",
  rakefile: "ruby",
};

/** Map a file path to a shiki language id, falling back to `"text"`. */
export function langForPath(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const byName = NAME_TO_LANG[name.toLowerCase()];
  if (byName) {
    return byName;
  }
  const dot = name.lastIndexOf(".");
  // `dot <= 0` covers both "no extension at all" and a leading-dot dotfile
  // (`.gitignore`), whose whole name is the identity — never an extension.
  if (dot <= 0 || dot === name.length - 1) {
    return "text";
  }
  const ext = name.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? "text";
}

function plainLines(code: string): HighlightedLine[] {
  return code.split("\n").map((text) => [{ text }]);
}

/** One shiki token → one rendered span. Optional keys are omitted rather than
 * set to `false`/`undefined` so the common (unstyled) span stays a single-key
 * object — these are allocated per token, per line, for every visible hunk. */
function toSpan(token: {
  color?: string;
  content: string;
  fontStyle?: number;
}): HighlightedLine[number] {
  const span: HighlightedLine[number] = { text: token.content };
  if (token.color) {
    span.color = token.color;
  }
  if (hasFontStyle(token.fontStyle, FONT_STYLE_ITALIC)) {
    span.italic = true;
  }
  if (hasFontStyle(token.fontStyle, FONT_STYLE_BOLD)) {
    span.bold = true;
  }
  return span;
}

/** Bounds the highlight result cache below so a long session's worth of
 * distinct hunks can't grow it without limit. FIFO eviction (oldest
 * inserted key first) — good enough here, not true LRU: `DiffFeed`'s
 * virtualization keeps scrolling within a bounded working set of nearby
 * hunks, so simple insertion-order eviction rarely evicts something about
 * to be reused. */
export const MAX_HIGHLIGHT_CACHE_ENTRIES = 300;

/** Above this many characters, a `highlightLines` call is assumed to be a
 * whole-file view (`FileViewer`, bounded by `read_file`'s 1 MB cap) rather
 * than a diff hunk (`DiffHunk`'s short, per-change snippets) — routed to
 * {@link largeHighlightCache} instead of {@link highlightCache}. Without this
 * split, a handful of large files browsed in one session could push the
 * count-capped hunk cache past its 300-entry limit and evict hunks the
 * diff feed still needs, flashing them back to plain text mid-scroll — a
 * whole-file entry is the same "one entry" as a two-line hunk to a
 * count-only cap, even though it can be orders of magnitude larger. */
const LARGE_CONTENT_CHAR_THRESHOLD = 4000;

/** Far smaller than {@link MAX_HIGHLIGHT_CACHE_ENTRIES}: each entry here can
 * be up to ~1 MB (a whole file), so this cache trades entry count for a
 * bounded worst-case footprint rather than trying to size itself by bytes. */
export const MAX_LARGE_HIGHLIGHT_CACHE_ENTRIES = 20;

/**
 * Tokenization results keyed on `lang + code`, so a `DiffHunk` that
 * remounts with the same content (virtualization unmounts/remounts cards
 * while scrolling — see `DiffFeed`) reuses its previous highlight instead of
 * re-tokenizing and flashing back to plain text. Stores the in-flight
 * `Promise`, not just its resolved value, so concurrent calls for the same
 * content share one tokenization — the same pattern `langLoads` below uses
 * for grammar loads. A call that degrades to `plainLines` via the catch in
 * {@link computeHighlight} deletes its own entry instead of caching the
 * degradation: a transient failure must still get a real retry on the next
 * identical call, the same "don't poison the cache" rule `getHighlighter`
 * follows for its own singleton.
 *
 * Holds diff-hunk-sized content only — see {@link LARGE_CONTENT_CHAR_THRESHOLD}
 * and {@link largeHighlightCache} for the whole-file counterpart that's kept
 * separate so the two can never evict each other.
 */
const highlightCache = new Map<string, Promise<HighlightedLine[]>>();

/** The whole-file counterpart to {@link highlightCache} — same shape, same
 * caching contract (in-flight promises, degradation never cached), just a
 * separate Map with its own, much smaller cap ({@link
 * MAX_LARGE_HIGHLIGHT_CACHE_ENTRIES}) so browsing large files in `FileViewer`
 * can't evict `DiffFeed`'s hunk highlights, or vice versa. */
const largeHighlightCache = new Map<string, Promise<HighlightedLine[]>>();

function highlightCacheKey(code: string, lang: string): string {
  return `${lang}:${code}`;
}

/**
 * Resolved tokenizations, mirroring whatever the two promise caches above hold
 * — the *synchronously* readable half.
 *
 * The promise caches already stop re-tokenization, but a `Promise` can only be
 * read a microtask later, and that was enough to be visible: `DiffFeed`
 * virtualizes, so scrolling unmounts and remounts hunk cards constantly, and
 * every remount rendered one plain-text frame before the already-known colours
 * came back. Content that has been tokenized once now renders coloured on its
 * first frame, for as long as its promise entry survives eviction.
 *
 * Kept as a separate map (rather than a resolved-value field on the promise
 * entries) so eviction stays exactly the two existing count caps: an entry
 * here is deleted precisely when the promise it mirrors is.
 */
const resolvedHighlights = new Map<string, HighlightedLine[]>();

/**
 * The tokenization for `code`/`lang` if it has already been computed and not
 * yet evicted, or `undefined` — never starts work. Callers use it to render
 * known content coloured immediately and fall back to {@link highlightLines}
 * otherwise; see {@link resolvedHighlights} for why this exists at all.
 */
export function peekHighlight(
  code: string,
  lang: string
): HighlightedLine[] | undefined {
  return resolvedHighlights.get(highlightCacheKey(code, lang));
}

/** Which of the two caches a given `code` belongs in — see
 * {@link LARGE_CONTENT_CHAR_THRESHOLD}. */
function cacheFor(code: string): Map<string, Promise<HighlightedLine[]>> {
  return code.length > LARGE_CONTENT_CHAR_THRESHOLD
    ? largeHighlightCache
    : highlightCache;
}

function capFor(cache: Map<string, Promise<HighlightedLine[]>>): number {
  return cache === largeHighlightCache
    ? MAX_LARGE_HIGHLIGHT_CACHE_ENTRIES
    : MAX_HIGHLIGHT_CACHE_ENTRIES;
}

function cacheHighlight(
  cache: Map<string, Promise<HighlightedLine[]>>,
  key: string,
  promise: Promise<HighlightedLine[]>
): void {
  cache.set(key, promise);
  const cap = capFor(cache);
  if (cache.size > cap) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
      resolvedHighlights.delete(oldestKey);
    }
  }
}

// Module-level singleton: the core highlighter is created at most once, no
// matter how many times `highlightLines` is called.
let highlighterPromise: Promise<HighlighterCore> | undefined;

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] =
        await Promise.all([
          import("@shikijs/core"),
          import("@shikijs/engine-javascript"),
        ]);
      return createHighlighterCore({
        engine: createJavaScriptRegexEngine(),
        langs: [],
        themes: [buildTheme()],
      });
    })().catch((error: unknown) => {
      // Don't poison the singleton with a failed init — let a later call
      // retry, same as the per-language grammar cache below.
      highlighterPromise = undefined;
      throw error;
    });
  }
  return highlighterPromise;
}

// Per-language grammar load, cached so concurrent/repeated calls for the same
// language reuse one in-flight (or settled) load instead of re-importing.
const langLoads = new Map<string, Promise<void>>();

async function ensureLanguage(
  highlighter: HighlighterCore,
  lang: string
): Promise<void> {
  if (highlighter.getLoadedLanguages().includes(lang)) {
    return;
  }
  let load = langLoads.get(lang);
  if (!load) {
    const loadGrammar = GRAMMAR_LOADERS[lang];
    load = highlighter.loadLanguage(loadGrammar()).catch((error: unknown) => {
      // Don't poison the cache with a failed load — let a later call retry.
      langLoads.delete(lang);
      throw error;
    });
    langLoads.set(lang, load);
  }
  await load;
}

/**
 * Tokenize `code` as `lang` into per-line colored spans. Never throws: an
 * unsupported language, a failed grammar import, or a highlighter init
 * failure all degrade to plain single-span lines. Cached by `lang + code`,
 * split across {@link highlightCache} (diff hunks) and
 * {@link largeHighlightCache} (whole files) by content size, so a repeated
 * call for content already tokenized returns instantly instead of redoing
 * the work, and the two working sets can't evict each other.
 */
export function highlightLines(
  code: string,
  lang: string
): Promise<HighlightedLine[]> {
  const key = highlightCacheKey(code, lang);
  const cache = cacheFor(code);
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const promise = computeHighlight(code, lang, key, cache);
  cacheHighlight(cache, key, promise);
  // Mirror the result into the synchronous cache once it lands — but only
  // while this exact promise is still the cached one, so a degraded result
  // that `computeHighlight` deliberately un-cached (see its catch) can't leave
  // plain lines behind for `peekHighlight` to serve forever.
  promise
    .then((lines) => {
      if (cache.get(key) === promise) {
        resolvedHighlights.set(key, lines);
      }
    })
    .catch(() => {
      // `computeHighlight` never rejects by contract; nothing to mirror.
    });
  return promise;
}

async function computeHighlight(
  code: string,
  lang: string,
  key: string,
  cache: Map<string, Promise<HighlightedLine[]>>
): Promise<HighlightedLine[]> {
  if (!GRAMMAR_LOADERS[lang]) {
    return plainLines(code);
  }
  try {
    const highlighter = await getHighlighter();
    await ensureLanguage(highlighter, lang);
    const tokenLines = highlighter.codeToTokensBase(code, {
      lang,
      theme: THEME_NAME,
    });
    return tokenLines.map((line) => line.map(toSpan));
  } catch {
    // Don't poison the cache with a degraded fallback — let a later call
    // retry for real (see the "retries the core highlighter..." test).
    cache.delete(key);
    return plainLines(code);
  }
}
