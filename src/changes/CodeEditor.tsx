/**
 * Lazy CodeMirror 6 editor for the "All files" tab's text-file view (Task 17
 * wires this into `FileViewer`'s save/dirty/conflict flow).
 *
 * Everything from `@codemirror/*` (and `@lezer/highlight`, needed for the
 * syntax-highlighting tag palette) is reached only through dynamic
 * `import()`, and only from inside this component's effects — never a
 * top-level static import. That keeps CodeMirror out of the app's entry
 * chunk, the same discipline `highlighter.ts` already holds shiki to:
 * importing this module's exports costs nothing until a `CodeEditor` is
 * actually mounted. See ADR for why CodeMirror 6 (not Monaco, not a
 * shiki/CodeMirror bridge) and why this file, not `highlighter.ts`, is the
 * one CodeMirror-aware module.
 *
 * A missing or failed per-language grammar must never break the editor: it
 * degrades to a plain, ungrammared CodeMirror instance (still fully
 * editable), mirroring `highlightLines`' "never throws" contract.
 */

// Type-only imports are erased at compile time — they cost nothing in the
// bundle and exist purely so `viewRef`/`readOnlyCompartmentRef` below can be
// typed without a runtime import of CodeMirror.
import type { Compartment, Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useLayout } from "../state/layout.ts";
import { themeById } from "../theme/themes/index.ts";
import { accentAlpha, tokens } from "../theme/tokens.ts";
import type { FileBlame } from "../types.ts";

export interface CodeEditorProps {
  /** The HEAD version of the file, for the git-gutter's added/modified/
   * deleted line markers. `undefined` mounts no gutter at all (no repo, an
   * untracked file, or a HEAD blob that couldn't be shown) — see
   * `readBaseline`/`useFileEditorSession`'s `baselineText` for how a caller
   * derives this. */
  baseline?: string;
  /** Who last touched each line, for the cursor-line blame note. Pass it
   * only while the buffer matches the file on disk: once the draft moves,
   * line numbers no longer line up with git's. */
  blame?: FileBlame;
  /** A language id in the same vocabulary `langForPath` (`highlighter.ts`)
   * produces. Anything without an entry in {@link LANGUAGE_LOADERS} mounts as
   * a plain, ungrammared but still fully editable editor. */
  language: string;
  onChange: (value: string) => void;
  /** Invoked when the user presses the platform save chord (⌘S / Ctrl+S)
   * inside the editor. The keystroke is always swallowed (the browser's own
   * "save page" dialog never appears); when omitted the chord is simply a
   * no-op. `FileViewer` passes its `Save` action here so the button and the
   * keyboard shortcut share one code path. */
  onSave?: () => void;
  readOnly?: boolean;
  /** The file's text when the session started, for the session-change
   * tint; `""` for a file the session created. `undefined` mounts none. */
  sessionStart?: string;
  value: string;
}

// Every module CodeMirror needs, loaded together once and cached at module
// scope so a second (or later) `CodeEditor` mount reuses the same import —
// same "singleton, never poisoned by a failed load" shape as
// `highlighter.ts`'s `getHighlighter`.
interface CoreModules {
  autocomplete: typeof import("@codemirror/autocomplete");
  commands: typeof import("@codemirror/commands");
  editorGit: typeof import("./editorGit.ts");
  gitGutter: typeof import("./gitGutter.ts");
  highlight: typeof import("@lezer/highlight");
  indentMarkers: typeof import("@replit/codemirror-indentation-markers");
  language: typeof import("@codemirror/language");
  search: typeof import("@codemirror/search");
  state: typeof import("@codemirror/state");
  view: typeof import("@codemirror/view");
}

let corePromise: Promise<CoreModules> | undefined;

/** The HEAD gutter, with its click-to-peek (and revert) on each marker. */
function gutterExtension(
  core: CoreModules,
  baseline: string | undefined
): Extension {
  if (baseline === undefined) {
    return [];
  }
  return core.gitGutter.gitGutter(baseline, core.editorGit.onMarkerClick);
}

/** The session tint and the cursor-line blame note, each when it has data,
 * plus the gutter's change peek — inert without a gutter to click. */
function annotationExtension(
  core: CoreModules,
  { blame, sessionStart }: { blame?: FileBlame; sessionStart?: string }
): Extension {
  return [
    core.editorGit.changePeek,
    sessionStart === undefined
      ? []
      : core.editorGit.sessionHighlight(sessionStart),
    blame === undefined ? [] : core.editorGit.blameAnnotation(blame),
  ];
}

function loadCore(): Promise<CoreModules> {
  if (!corePromise) {
    corePromise = Promise.all([
      import("@codemirror/autocomplete"),
      import("@codemirror/commands"),
      import("./editorGit.ts"),
      import("./gitGutter.ts"),
      import("@lezer/highlight"),
      import("@replit/codemirror-indentation-markers"),
      import("@codemirror/language"),
      import("@codemirror/search"),
      import("@codemirror/state"),
      import("@codemirror/view"),
    ])
      .then(
        ([
          autocomplete,
          commands,
          editorGit,
          gitGutter,
          highlight,
          indentMarkers,
          language,
          search,
          state,
          view,
        ]) => ({
          autocomplete,
          commands,
          editorGit,
          gitGutter,
          highlight,
          indentMarkers,
          language,
          search,
          state,
          view,
        })
      )
      .catch((error: unknown) => {
        // Don't poison the singleton with a failed init — let a later mount
        // retry, same as highlighter.ts's getHighlighter.
        corePromise = undefined;
        throw error;
      });
  }
  return corePromise;
}

/**
 * Wrap a CodeMirror 5-era `StreamParser` as a CM6 `Language`.
 *
 * Used for every language with no first-party `@codemirror/lang-*` package.
 * Stream modes are coarser than Lezer's incremental parsers — regex/state
 * machine rather than a real parse tree, so no grammar-driven bracket
 * matching or folding — but they are what `@codemirror/legacy-modes` (already
 * a dependency, for TOML) ships, and they are the difference between a `.yaml`
 * or `.go` file having colour and having none. Adding eight more `lang-*`
 * packages to close the same gap would be a worse trade for this app's bundle.
 * See ADR 0016, which took this trade-off for TOML first.
 */
async function streamLang(
  load: () => Promise<{ [key: string]: unknown }>,
  key: string
): Promise<Extension> {
  const [{ StreamLanguage }, mode] = await Promise.all([
    import("@codemirror/language"),
    load(),
  ]);
  // The cast is the seam's one unavoidable `any`-shaped step: the legacy-mode
  // packages export their parsers under per-language names with no shared
  // type, and `StreamLanguage.define` is what validates the shape at runtime.
  return StreamLanguage.define(
    mode[key] as Parameters<typeof StreamLanguage.define>[0]
  );
}

/**
 * Per-language grammar loaders, dynamic-imported on first use of that
 * language, keyed by the same language ids `langForPath` (`highlighter.ts`)
 * produces so the editor colours whatever the read-only view colours.
 *
 * `javascript()`'s `jsx`/`typescript` options cover js/jsx/ts/tsx from one
 * package; everything past the seven first-party grammars comes through
 * {@link streamLang}.
 */
const LANGUAGE_LOADERS: Record<string, () => Promise<Extension>> = {
  bash: () =>
    streamLang(() => import("@codemirror/legacy-modes/mode/shell"), "shell"),
  c: () => streamLang(() => import("@codemirror/legacy-modes/mode/clike"), "c"),
  cpp: () =>
    streamLang(() => import("@codemirror/legacy-modes/mode/clike"), "cpp"),
  csharp: () =>
    streamLang(() => import("@codemirror/legacy-modes/mode/clike"), "csharp"),
  css: async () => (await import("@codemirror/lang-css")).css(),
  dockerfile: () =>
    streamLang(
      () => import("@codemirror/legacy-modes/mode/dockerfile"),
      "dockerFile"
    ),
  go: () => streamLang(() => import("@codemirror/legacy-modes/mode/go"), "go"),
  html: async () => (await import("@codemirror/lang-html")).html(),
  ini: () =>
    streamLang(
      () => import("@codemirror/legacy-modes/mode/properties"),
      "properties"
    ),
  java: () =>
    streamLang(() => import("@codemirror/legacy-modes/mode/clike"), "java"),
  javascript: async () =>
    (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
  // JSON with comments: the JSON grammar rejects them, so the closest honest
  // fit is the JS grammar, which accepts both.
  jsonc: async () => (await import("@codemirror/lang-javascript")).javascript(),
  json: async () => (await import("@codemirror/lang-json")).json(),
  jsx: async () =>
    (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
  kotlin: () =>
    streamLang(() => import("@codemirror/legacy-modes/mode/clike"), "kotlin"),
  lua: () =>
    streamLang(() => import("@codemirror/legacy-modes/mode/lua"), "lua"),
  markdown: async () => (await import("@codemirror/lang-markdown")).markdown(),
  proto: () =>
    streamLang(
      () => import("@codemirror/legacy-modes/mode/protobuf"),
      "protobuf"
    ),
  python: async () => (await import("@codemirror/lang-python")).python(),
  ruby: () =>
    streamLang(() => import("@codemirror/legacy-modes/mode/ruby"), "ruby"),
  rust: async () => (await import("@codemirror/lang-rust")).rust(),
  scss: () =>
    streamLang(() => import("@codemirror/legacy-modes/mode/sass"), "sass"),
  sql: () =>
    streamLang(
      () => import("@codemirror/legacy-modes/mode/sql"),
      "standardSQL"
    ),
  swift: () =>
    streamLang(() => import("@codemirror/legacy-modes/mode/swift"), "swift"),
  toml: () =>
    streamLang(() => import("@codemirror/legacy-modes/mode/toml"), "toml"),
  tsx: async () =>
    (await import("@codemirror/lang-javascript")).javascript({
      jsx: true,
      typescript: true,
    }),
  typescript: async () =>
    (await import("@codemirror/lang-javascript")).javascript({
      typescript: true,
    }),
  xml: () =>
    streamLang(() => import("@codemirror/legacy-modes/mode/xml"), "xml"),
  yaml: () =>
    streamLang(() => import("@codemirror/legacy-modes/mode/yaml"), "yaml"),
};

/** Per-language grammar loads, cached so opening a second file of the same
 * language reuses one in-flight (or settled) load — the same shape
 * `highlighter.ts`'s `langLoads` uses for shiki grammars. `FileViewer` mounts a
 * fresh `CodeEditor` per file (undo history must not carry between files), so
 * without this every open re-ran the loader and put another await between the
 * content landing and the editor appearing. */
const languageExtensions = new Map<string, Promise<Extension | undefined>>();

/** Resolves `language` to a grammar extension, or `undefined` for an
 * unrecognised language (plain text) or a grammar whose dynamic import
 * failed — either way the editor still mounts, just ungrammared. */
function loadLanguageExtension(
  language: string
): Promise<Extension | undefined> {
  const loader = LANGUAGE_LOADERS[language];
  if (!loader) {
    return Promise.resolve(undefined);
  }
  const cached = languageExtensions.get(language);
  if (cached) {
    return cached;
  }
  // The catch's return type is annotated rather than returning an explicit
  // `undefined`: this repo's lint config rejects a literal `undefined` return
  // (`noUselessUndefined`) and rewrites it to a bare `return`, which without
  // this annotation infers `void` and stops matching `Promise<Extension |
  // undefined>`.
  const load = loader().catch((): Extension | undefined => {
    // Don't poison the cache with a failed load — let a later mount retry,
    // same as `loadCore` and `highlighter.ts`'s grammar cache.
    languageExtensions.delete(language);
    return undefined;
  });
  languageExtensions.set(language, load);
  return load;
}

/** The editor's type scale. One place, because the gutter and the content
 * must share a line height exactly — a mismatch of even a fraction of a pixel
 * makes line numbers drift out of alignment with their lines further down a
 * long file, which is the kind of thing that reads as "sloppy" without being
 * consciously noticed. */
const EDITOR_FONT_SIZE = "12.5px";
const EDITOR_LINE_HEIGHT = "1.55";

/**
 * Editor chrome (background, gutters, cursor, selection) bound to the live
 * `--kr-*` custom properties so a theme switch restyles the editor with no
 * remount — the same seam every other surface in the app uses.
 *
 * Tuned against a real editor side by side. What was actually wrong before:
 * the gutter used the content's own 12px at the default line height, so line
 * numbers sat as large and nearly as bright as the code itself and competed
 * with it; the active line was a full-width `surface.s1` band bright enough to
 * read as a selection; and there was no separation between gutter and content,
 * so the numbers ran straight into the first character.
 *
 * Line numbers are a step down in size and several steps down in brightness —
 * present when looked for, silent otherwise — with the active one lifted back
 * to normal ink. The caret's row itself carries a solid fill one step up
 * from the well.
 */
function buildEditorTheme(
  EditorView_: typeof import("@codemirror/view").EditorView,
  dark: boolean
) {
  const { color, font } = tokens;
  return EditorView_.theme(
    {
      "&": {
        backgroundColor: color.codeWell,
        // The editor's own ink, matching the base shiki falls back to
        // in `highlighter.ts` — so unclaimed text is the same ink whether the
        // file is being read or edited.
        color: color.editorInk,
        height: "100%",
      },
      "&.cm-focused": { outline: "none" },
      "&.cm-focused .cm-cursor": {
        borderLeftColor: color.accent,
        borderLeftWidth: "2px",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: color.editorSelection,
      },
      // A solid fill one step up from the well, so the caret's row reads as
      // located rather than tinted.
      ".cm-activeLine": { backgroundColor: color.editorActiveLine },
      ".cm-content": {
        caretColor: color.accent,
        fontFamily: font.mono,
        fontSize: EDITOR_FONT_SIZE,
        lineHeight: EDITOR_LINE_HEIGHT,
        // Room to breathe at the top, and enough at the bottom that the last
        // line can still be scrolled clear of the window edge.
        padding: "8px 0 40vh 0",
      },
      ".cm-line": { padding: "0 16px 0 8px" },
      ".cm-gutters": {
        backgroundColor: color.codeWell,
        border: "none",
        color: color.editorGutterInk,
        fontFamily: font.mono,
        fontSize: "11.5px",
        lineHeight: EDITOR_LINE_HEIGHT,
        // The one piece of structure the gutter needs: a quiet edge that
        // separates numbers from code without drawing a visible rule.
        paddingRight: "4px",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        minWidth: "34px",
        padding: "0 6px 0 12px",
      },
      // The current line's number reads brighter; every other stays quiet.
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
        color: color.editorGutterActiveInk,
      },
      // The git-gutter's own strip, one per changed line: a thin coloured bar
      // (VSCode's convention) rather than a symbol, so it reads at a glance
      // without competing with the line-number gutter beside it. Structure
      // only — see Task 13's polish pass for the final tuned look.
      ".cm-gitGutter": { width: "3px" },
      ".cm-gitMarker": { cursor: "pointer", height: "100%" },
      // Lines changed since the session started: a faint accent wash, so
      // what this session did reads at a glance without hiding the syntax.
      ".cm-sessionLine": {
        backgroundColor: accentAlpha(dark ? 0.07 : 0.06),
        boxShadow: `inset 2px 0 0 ${accentAlpha(0.55)}`,
      },
      // The cursor line's blame: quiet, and set off from the code.
      ".cm-blameNote": {
        color: color.ink.faint,
        fontFamily: font.sans,
        fontSize: "11.5px",
        fontStyle: "italic",
        marginLeft: "28px",
        whiteSpace: "pre",
      },
      // The gutter's change peek: what the lines were, and a revert.
      ".cm-tooltip.cm-changePeek": {
        backgroundColor: color.raised,
        border: `1px solid ${color.line.base}`,
        borderRadius: tokens.radius.md,
        fontFamily: font.sans,
        fontSize: "12px",
        maxWidth: "560px",
        minWidth: "280px",
      },
      ".cm-changePeek-head": {
        alignItems: "center",
        borderBottom: `1px solid ${color.line.soft}`,
        color: color.ink.muted,
        display: "flex",
        gap: "8px",
        padding: "6px 6px 6px 10px",
      },
      ".cm-changePeek-head > span": { flex: 1 },
      ".cm-changePeek-revert": {
        background: color.surface.s2,
        border: `1px solid ${color.line.base}`,
        borderRadius: tokens.radius.sm,
        color: color.ink.primary,
        cursor: "pointer",
        fontFamily: font.sans,
        fontSize: "11.5px",
        padding: "2px 8px",
      },
      ".cm-changePeek-close": {
        background: "transparent",
        border: "none",
        color: color.ink.muted,
        cursor: "pointer",
        fontSize: "14px",
        padding: "0 4px",
      },
      ".cm-changePeek-old": {
        background: color.delSoft,
        color: color.diffDelInk,
        fontFamily: font.mono,
        fontSize: "12px",
        margin: 0,
        maxHeight: "240px",
        overflow: "auto",
        padding: "6px 10px",
        whiteSpace: "pre",
      },
      ".cm-gitAdded": { background: color.add },
      ".cm-gitModified": { background: color.mod },
      ".cm-gitDeleted": {
        background: color.del,
        height: "2px",
        marginTop: "auto",
      },
      ".cm-scroller": {
        fontFamily: font.mono,
        lineHeight: EDITOR_LINE_HEIGHT,
        // Long lines scroll rather than wrap (see the mount effect): give the
        // horizontal scrollbar the same quiet treatment as the rest.
        overflow: "auto",
      },
      ".cm-foldPlaceholder": {
        backgroundColor: color.surface.s2,
        border: "none",
        color: color.ink.muted,
      },
      ".cm-panels": {
        backgroundColor: color.surface.s1,
        border: "none",
        color: color.text,
        fontFamily: font.sans,
      },
      ".cm-panels.cm-panels-top": {
        borderBottom: `1px solid ${color.line.soft}`,
      },
      ".cm-panel.cm-search": { fontSize: "11.5px", padding: "6px 8px" },
      ".cm-panel.cm-search input": {
        background: color.codeWell,
        border: `1px solid ${color.line.base}`,
        borderRadius: tokens.radius.sm,
        color: color.text,
        // The browser's own focus ring is removed, so the border has to carry
        // the indicator: without a replacement there was no way to tell which
        // of the search panel's two fields the caret was in.
        "&:focus": { borderColor: color.accent },
        outline: "none",
      },
      ".cm-panel.cm-search button": {
        background: color.surface.s1,
        border: `1px solid ${color.line.base}`,
        borderRadius: tokens.radius.sm,
        color: color.ink.secondary,
        cursor: "pointer",
      },
      ".cm-panel.cm-search label": { color: color.ink.secondary },
      ".cm-searchMatch": { backgroundColor: color.surface.s2 },
      ".cm-searchMatch-selected": { backgroundColor: color.surface.s3 },
      ".cm-selectionMatch": { backgroundColor: color.surface.s2 },
    },
    // CodeMirror's own base styles pick a light or dark set from this, and
    // some of them outrank the rules above (a focused selection is `#233` in
    // dark mode) — so it has to follow the theme, not stay dark.
    { dark }
  );
}

/**
 * Syntax colors, mapped from Lezer highlighting tags onto
 * `tokens.color.syntax` — the *same* palette `highlighter.ts`'s shiki theme
 * reads. One palette, two consumers: shiki tokenizes the read-only diff and
 * file views, CodeMirror tokenizes the same file once it's open for editing.
 *
 * They never highlight the same view at once, which is exactly why this used
 * to drift: each side carried its own hand-written colour map, so a file
 * changed colour depending on whether you happened to be editing it. Sharing
 * the palette fixes the *values*; keeping the maps in step is what stops a
 * token landing on a different slot in each engine, and is what the golden
 * tests on both sides exist to hold. The tag list below is deliberately a
 * tag-for-scope mirror of that theme's scope list — a comment is the comment
 * colour and
 * italic in both, control flow is distinct from declaration in both, and so on.
 */
function buildHighlightStyle(
  HighlightStyle: typeof import("@codemirror/language").HighlightStyle,
  tags: typeof import("@lezer/highlight").tags
) {
  const { syntax } = tokens.color;
  return HighlightStyle.define([
    {
      color: syntax.comment,
      fontStyle: "italic",
      tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    },

    // Control flow reads differently from declaration, mirroring the shiki
    // theme's keyword.control / storage split.
    {
      color: syntax.keywordFlow,
      tag: [tags.controlKeyword, tags.moduleKeyword],
    },
    {
      color: syntax.keyword,
      tag: [
        tags.keyword,
        tags.definitionKeyword,
        tags.modifier,
        tags.operatorKeyword,
        tags.self,
        tags.atom,
      ],
    },

    {
      color: syntax.string,
      tag: [tags.string, tags.special(tags.string), tags.docString],
    },
    { color: syntax.regexp, tag: tags.regexp },
    { color: syntax.stringEscape, tag: [tags.escape, tags.character] },

    {
      color: syntax.number,
      tag: [tags.number, tags.integer, tags.float, tags.unit],
    },
    {
      color: syntax.constant,
      tag: [
        tags.bool,
        tags.null,
        tags.constant(tags.variableName),
        tags.standard(tags.name),
      ],
    },

    {
      color: syntax.function,
      tag: [
        tags.function(tags.variableName),
        tags.function(tags.propertyName),
        tags.function(tags.definition(tags.variableName)),
        tags.macroName,
      ],
    },

    {
      color: syntax.type,
      tag: [
        tags.typeName,
        tags.className,
        tags.namespace,
        tags.definition(tags.typeName),
      ],
    },

    {
      color: syntax.variable,
      tag: [
        tags.variableName,
        tags.definition(tags.variableName),
        tags.local(tags.variableName),
        tags.special(tags.variableName),
        tags.labelName,
      ],
    },
    // The one split inside the variable family — see the
    // matching shiki rule in `highlighter.ts`. lezer *does* separate the two
    // cases (`PropertyName` for an accessed property, `PropertyDefinition` for
    // an object-literal key), so both sides can agree here: violet for the
    // access, the variable ink for the key, exactly as shiki resolves
    // `variable.other.property` and `meta.object-literal.key`.
    { color: syntax.property, tag: [tags.propertyName] },
    { color: syntax.variable, tag: [tags.definition(tags.propertyName)] },

    // Ordinary operators stay near-neutral. CodeMirror has
    // no equivalent of TextMate prefix-matching, so without this rule they
    // fell through to the base ink instead — a different wrong answer from
    // shiki's (which sent them to the teal keyword). Both are fixed to the
    // same value; the word-shaped operators (`typeof`, `new`, `delete`) are
    // separate lezer tags and stay on the keyword rule above.
    {
      color: syntax.punctuation,
      tag: [
        tags.operator,
        tags.arithmeticOperator,
        tags.logicOperator,
        tags.compareOperator,
        tags.definitionOperator,
        tags.updateOperator,
        tags.bitwiseOperator,
        tags.derefOperator,
      ],
    },

    {
      color: syntax.punctuation,
      tag: [tags.punctuation, tags.separator, tags.bracket],
    },

    { color: syntax.tag, tag: tags.tagName },
    { color: syntax.attribute, tag: tags.attributeName },
    { color: syntax.string, tag: tags.attributeValue },

    // Markdown, where font style carries as much meaning as colour.
    { color: syntax.keyword, fontWeight: "bold", tag: tags.heading },
    { fontWeight: "bold", tag: tags.strong },
    { fontStyle: "italic", tag: tags.emphasis },
    { color: syntax.string, tag: tags.monospace },
    { color: syntax.constant, tag: tags.link, textDecoration: "underline" },
    { color: tokens.color.add, tag: tags.inserted },
    { color: tokens.color.del, tag: tags.deleted },
  ]);
}

const rootStyle: CSSProperties = {
  height: "100%",
  minHeight: 0,
  overflow: "auto",
};

/** The plain-`<textarea>` fallback shown only if the CodeMirror core chunk
 * itself fails to load (an unrecognised/failed grammar already degrades to a
 * plain CodeMirror instance in-place). Editing and Save still work — it's
 * wired to the same `value`/`onChange`/`readOnly` — so a chunk-load failure
 * degrades the experience, never blocks it, the same "never break the view"
 * contract `highlighter.ts` and the grammar loader already hold. */
const fallbackStyle: CSSProperties = {
  background: tokens.color.codeWell,
  border: "none",
  // The editor's ink, not the app's: this shows code on the code well.
  color: tokens.color.editorInk,
  fontFamily: tokens.font.mono,
  fontSize: "12px",
  height: "100%",
  minHeight: 0,
  outline: "none",
  padding: tokens.space.sm,
  resize: "none",
  width: "100%",
};

/**
 * A raw CodeMirror 6 `EditorView` mounted into a plain ref'd `div` — not the
 * `@uiw/react-codemirror` wrapper, to avoid its `@babel/runtime` peer and
 * keep this the thinnest possible React↔CodeMirror seam.
 *
 * Recreates the whole `EditorView` when `language` changes (a different
 * grammar is effectively a new editor session — `FileViewer` mounts one
 * `CodeEditor` per open file rather than swapping language on a live one).
 * `value` and `readOnly` are synced into the already-live view instead, so
 * neither clobbers the user's cursor/undo history: an external `value`
 * change (e.g. a post-save reload) is only pushed in when it actually
 * differs from the view's current document — the common case, where a
 * parent's `value` prop merely echoes back what `onChange` just emitted,
 * is a no-op.
 */
export function CodeEditor({
  value,
  baseline,
  blame,
  language,
  onChange,
  onSave,
  readOnly = false,
  sessionStart,
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The whole set of lazy-loaded CodeMirror modules, stashed so effects other
  // than the mount effect (the `[value]` sync effect below; a later
  // compartment-reconfiguration task) can reach `state.Transaction` etc.
  // without awaiting `loadCore()` again — it's already resolved by the time
  // any other effect can run.
  const coreRef = useRef<CoreModules | null>(null);
  const readOnlyCompartmentRef = useRef<Compartment | null>(null);
  const gutterCompartmentRef = useRef<Compartment | null>(null);
  // The session tint and the blame note — one compartment, since both are
  // reconfigured from the same fetch (`useGitAnnotations`).
  const annotationCompartmentRef = useRef<Compartment | null>(null);
  const annotationsRef = useRef({ blame, sessionStart });
  annotationsRef.current = { blame, sessionStart };
  const themeCompartmentRef = useRef<Compartment | null>(null);
  const themeId = useLayout((state) => state.layout.themeId);
  const dark = themeById(themeId).appearance === "dark";
  // Read at editor-creation time, like `valueRef`: the mount effect awaits
  // two imports, and a theme switch in that window must still seed the view.
  const darkRef = useRef(dark);
  darkRef.current = dark;
  // Read at editor-creation time instead of closing over the mount-render's
  // `baseline`, mirroring `valueRef` below — the mount effect awaits two
  // dynamic imports before constructing the `EditorState`, so a `baseline`
  // change landing during that async window must still seed the compartment
  // it built with, not a stale closed-over value.
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;
  // True only if the CodeMirror *core* chunk fails to import — then this
  // renders a plain editable `<textarea>` instead of a blank box.
  const [loadFailed, setLoadFailed] = useState(false);

  // Always call the latest `onChange`/`onSave` without re-running the mount
  // effect (which would tear down and recreate the editor) whenever the caller
  // passes a new closure. The save keymap reads `onSaveRef.current` at
  // keystroke time, so a parent re-render that hands down a fresh `onSave`
  // takes effect immediately without a remount.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  // Read at editor-creation time instead of closing over the mount-render's
  // `value`: the mount effect awaits two dynamic imports before constructing
  // the `EditorState`, and the `[value]` sync effect below early-returns
  // while `viewRef.current` is still null, so a `value` change that lands
  // during that async window would otherwise be silently lost.
  const valueRef = useRef(value);
  valueRef.current = value;

  // The last document text this editor itself emitted through `onChange`.
  //
  // Exists to keep typing O(1) in re-renders rather than O(document). Every
  // keystroke round-trips: the update listener serializes the doc to emit it,
  // the parent stores it, and it comes straight back as `value`. The sync
  // effect below then had to serialize the *whole document again* just to
  // discover the two were equal — a second full flatten of the rope, per
  // keypress, growing with file size. Comparing against what we emitted
  // answers the same question by identity.
  const lastEmittedRef = useRef<string | null>(null);

  // `value`/`readOnly` are read here only to seed the initial editor
  // state — intentionally not deps, so changing them doesn't tear down and
  // recreate the whole `EditorView` (losing cursor/undo history). They're
  // synced into the already-live view by the two effects below instead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value/readOnly seed the initial state only; see comment above and the sync effects below.
  useEffect(() => {
    let cancelled = false;
    let resizeObserver: ResizeObserver | undefined;

    loadCore()
      .then(async (core) => {
        const langExtension = await loadLanguageExtension(language);
        if (cancelled || !containerRef.current) {
          return;
        }
        // Captured once the null check has passed so later use (the
        // `EditorView` constructor and the `ResizeObserver` below) keeps
        // TypeScript's non-null narrowing across the intervening calls,
        // which a re-read of `containerRef.current` would lose.
        const container = containerRef.current;
        coreRef.current = core;
        const {
          autocomplete,
          commands,
          highlight,
          indentMarkers,
          language: lang,
          search,
          state,
          view,
        } = core;
        const readOnlyCompartment = new state.Compartment();
        readOnlyCompartmentRef.current = readOnlyCompartment;
        const gutterCompartment = new state.Compartment();
        gutterCompartmentRef.current = gutterCompartment;
        const annotationCompartment = new state.Compartment();
        annotationCompartmentRef.current = annotationCompartment;
        const themeCompartment = new state.Compartment();
        themeCompartmentRef.current = themeCompartment;

        const extensions: Extension[] = [
          // Placed first so it wins precedence over the default keymap, and
          // `preventDefault` stops the browser's own "save page" dialog from
          // ever surfacing over the webview. Returning `true` marks the chord
          // handled even when no `onSave` is wired, so the browser dialog is
          // suppressed either way.
          view.keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current?.();
                return true;
              },
            },
          ]),
          // One merged keymap (not several `keymap.of` calls) so precedence
          // is a single, explicit list rather than an accident of extension
          // order: close-brackets' Backspace-pairing wins over the default
          // keymap's own Backspace, then the default keymap, then search
          // (Mod-f/Mod-g/Alt-Mod-f/Mod-d-select-next-occurrence), then
          // history (undo/redo), then Tab indentation last.
          view.keymap.of([
            ...autocomplete.closeBracketsKeymap,
            ...commands.defaultKeymap,
            ...search.searchKeymap,
            ...commands.historyKeymap,
            commands.indentWithTab,
          ]),
          commands.history(),
          view.lineNumbers(),
          view.highlightActiveLine(),
          view.highlightActiveLineGutter(),
          view.drawSelection(),
          view.dropCursor(),
          lang.indentOnInput(),
          lang.bracketMatching(),
          autocomplete.closeBrackets(),
          search.search({ top: true }),
          search.highlightSelectionMatches(),
          state.EditorState.allowMultipleSelections.of(true),
          view.rectangularSelection(),
          // Vertical rules down each indent level. Structure that a reader
          // otherwise has to reconstruct from leading whitespace, and the one
          // piece of the reference look that CodeMirror ships nothing for.
          indentMarkers.indentationMarkers({
            // Faint enough to be structure rather than content — a guide the
            // eye follows only when it is looking for one. `colors` is handed
            // straight to `EditorView.baseTheme` as plain CSS custom-property
            // values (verified against the package's source: it's a
            // style-mod stylesheet, not a canvas/computed pipeline), so a
            // `var(--kr-…)` reference works exactly like a literal here.
            colors: {
              activeDark: tokens.color.editorIndentGuideActive,
              activeLight: tokens.color.editorIndentGuideActive,
              dark: tokens.color.editorIndentGuide,
              light: tokens.color.editorIndentGuide,
            },
            hideFirstIndent: true,
            highlightActiveBlock: true,
            thickness: 1,
          }),
          // Deliberately NOT `EditorView.lineWrapping`. Wrapping was on, and
          // it is the single thing that made this view read as unfinished: a
          // long line broke to a second visual row whose continuation started
          // at the left margin with no indent, while its line number floated
          // vertically centred across both rows — so the gutter stopped
          // lining up with the code beside it. Every real code editor scrolls
          // long lines horizontally instead, which keeps one line on one row
          // and the gutter honest.
          view.EditorView.contentAttributes.of({
            "aria-label": "Code editor",
            "aria-multiline": "true",
            role: "textbox",
          }),
          readOnlyCompartment.of([
            state.EditorState.readOnly.of(readOnly),
            view.EditorView.editable.of(!readOnly),
          ]),
          gutterCompartment.of(gutterExtension(core, baselineRef.current)),
          annotationCompartment.of(
            annotationExtension(core, annotationsRef.current)
          ),
          themeCompartment.of(
            buildEditorTheme(view.EditorView, darkRef.current)
          ),
          lang.syntaxHighlighting(
            buildHighlightStyle(lang.HighlightStyle, highlight.tags)
          ),
          view.EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const text = update.state.doc.toString();
              lastEmittedRef.current = text;
              onChangeRef.current(text);
            }
          }),
          ...(langExtension ? [langExtension] : []),
        ];

        const editorState = state.EditorState.create({
          doc: valueRef.current,
          extensions,
        });
        viewRef.current = new view.EditorView({
          parent: container,
          state: editorState,
        });

        // The pane can be display:none when this mounts (ChangesView keeps
        // the viewer alive across tab flips). A view created at zero size
        // renders blank until CodeMirror happens to re-measure; nudge it
        // explicitly whenever the container's size changes (including
        // 0 → visible).
        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(() => {
            viewRef.current?.requestMeasure();
          });
          resizeObserver.observe(container);
        }
      })
      .catch(() => {
        // The core chunk failed to import (loadCore already de-poisons its
        // singleton so a later mount can retry). Fall back to a plain editable
        // textarea rather than leaving a blank box with an unhandled rejection.
        if (!cancelled) {
          setLoadFailed(true);
        }
      });

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      viewRef.current?.destroy();
      viewRef.current = null;
      readOnlyCompartmentRef.current = null;
      gutterCompartmentRef.current = null;
      themeCompartmentRef.current = null;
      coreRef.current = null;
    };
  }, [language]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    // The overwhelmingly common case: `value` is the parent echoing back what
    // this editor just emitted. Answering that by string identity keeps a
    // keystroke from re-serializing the entire document (see
    // `lastEmittedRef`); only a genuinely external change falls through to the
    // comparison below.
    if (value === lastEmittedRef.current) {
      return;
    }
    const current = view.state.doc.toString();
    if (current === value) {
      return;
    }
    // A plain `{changes}` dispatch here would land in the undo history (⌘Z
    // after an external reload would resurrect the pre-reload content and
    // mark the buffer dirty again) and reset the selection to the document
    // start. `addToHistory.of(false)` keeps the reload out of undo, and
    // re-asserting the clamped-to-bounds caret position keeps the user's
    // cursor from jumping to 0 when the new document is shorter.
    //
    // The change set is built first, and the caret is clamped to ITS
    // `newLength` rather than to `value.length`. Those two are not the same
    // number: CodeMirror splits a document on `/\r\n?|\n/` and joins the lines
    // with `\n`, so a CRLF file's document is strictly shorter than the string
    // it came from. Clamping against the string put the caret past the end of
    // the new document, and CodeMirror threw `RangeError: Selection points
    // outside of document` out of this effect — an uncaught error that killed
    // the whole pane on any external reload of a CRLF file.
    const core = coreRef.current;
    const changes = view.state.changes({
      from: 0,
      insert: value,
      to: current.length,
    });
    const head = Math.min(view.state.selection.main.head, changes.newLength);
    view.dispatch({
      changes,
      ...(core
        ? {
            annotations: core.state.Transaction.addToHistory.of(false),
            selection: { anchor: head },
          }
        : {}),
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    const compartment = readOnlyCompartmentRef.current;
    if (!(view && compartment)) {
      return;
    }
    loadCore()
      .then((core) => {
        // An unmount racing the resolved import would otherwise dispatch into
        // a destroyed `EditorView`, which CodeMirror throws on.
        if (viewRef.current !== view) {
          return;
        }
        view.dispatch({
          effects: compartment.reconfigure([
            core.state.EditorState.readOnly.of(readOnly),
            core.view.EditorView.editable.of(!readOnly),
          ]),
        });
      })
      .catch(() => {
        // Core already loaded once to build this view; a reject here is
        // near-impossible, but never leave an unhandled rejection.
      });
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    const compartment = themeCompartmentRef.current;
    if (!(view && compartment)) {
      return;
    }
    loadCore()
      .then((core) => {
        // See the `[readOnly]` effect: a destroyed view must never be
        // dispatched into.
        if (viewRef.current !== view) {
          return;
        }
        view.dispatch({
          effects: compartment.reconfigure(
            buildEditorTheme(core.view.EditorView, dark)
          ),
        });
      })
      .catch(() => {
        // Core already loaded once to build this view; see `[readOnly]`.
      });
  }, [dark]);

  useEffect(() => {
    const view = viewRef.current;
    const compartment = gutterCompartmentRef.current;
    if (!(view && compartment)) {
      return;
    }
    loadCore()
      .then((core) => {
        // See the `[readOnly]` effect: a destroyed view must never be
        // dispatched into.
        if (viewRef.current !== view) {
          return;
        }
        view.dispatch({
          effects: compartment.reconfigure(gutterExtension(core, baseline)),
        });
      })
      .catch(() => {
        // Core already loaded once to build this view; a reject here is
        // near-impossible, but never leave an unhandled rejection.
      });
  }, [baseline]);

  useEffect(() => {
    const view = viewRef.current;
    const compartment = annotationCompartmentRef.current;
    if (!(view && compartment)) {
      return;
    }
    loadCore()
      .then((core) => {
        // See the `[readOnly]` effect: a destroyed view must never be
        // dispatched into.
        if (viewRef.current !== view) {
          return;
        }
        view.dispatch({
          effects: compartment.reconfigure(
            annotationExtension(core, { blame, sessionStart })
          ),
        });
      })
      .catch(() => {
        // Core already loaded once to build this view.
      });
  }, [blame, sessionStart]);

  if (loadFailed) {
    return (
      <textarea
        aria-label="Code editor"
        data-testid="code-editor-fallback"
        onChange={(event) => onChangeRef.current(event.target.value)}
        readOnly={readOnly}
        style={fallbackStyle}
        value={value}
      />
    );
  }
  return <div data-testid="code-editor" ref={containerRef} style={rootStyle} />;
}
