import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * Real CodeMirror 6 needs browser APIs jsdom doesn't fully provide
 * (MutationObserver-driven layout, requestAnimationFrame-timed measurement)
 * and is documented upstream as fiddly to drive in jsdom — so every
 * `@codemirror/*`/`@lezer/highlight` module `CodeEditor.tsx` reaches via
 * dynamic `import()` is mocked here with a small fake that mirrors just
 * enough of the real shape (extensions are inert marker objects; a
 * `Compartment` really does carry its current value; `EditorView` really
 * does render `doc` into a DOM node and really does call back into whatever
 * `updateListener` extension it was constructed with) to exercise
 * `CodeEditor.tsx`'s OWN wiring for real — not just print a canned result.
 * Every mocked factory always resolves (never a `new Promise(() =>
 * undefined)` stand-in) so a broken implementation can't hide behind an
 * import that never settles.
 */

type Extension =
  | Extension[]
  | { kind: string; value?: unknown }
  | null
  | undefined;

/** Walks nested extension arrays/compartments into one flat list of marker
 * objects — mirrors how real CodeMirror flattens `Extension` trees. */
function flattenExtensions(
  ext: Extension,
  into: { kind: string; value?: unknown }[] = []
): { kind: string; value?: unknown }[] {
  if (Array.isArray(ext)) {
    for (const item of ext) {
      flattenExtensions(item, into);
    }
    return into;
  }
  if (ext && typeof ext === "object") {
    into.push(ext);
    if (ext.kind === "compartment") {
      flattenExtensions(ext.value as Extension, into);
    }
  }
  return into;
}

class FakeCompartment {
  current: Extension;
  of(ext: Extension) {
    this.current = ext;
    return { compartment: this, kind: "compartment", value: ext };
  }
  reconfigure(ext: Extension) {
    this.current = ext;
    return { compartment: this, kind: "reconfigure", value: ext };
  }
}

const fakeEditorState = {
  allowMultipleSelections: {
    of: (value: boolean) => ({ kind: "allowMultipleSelections", value }),
  },
  create: ({ doc, extensions }: { doc: string; extensions: Extension }) => ({
    doc: { toString: () => doc },
    extensions,
    selection: { main: { anchor: 0, head: 0 } },
  }),
  readOnly: { of: (value: boolean) => ({ kind: "readOnly", value }) },
};

/** Hoisted per Biome's `useTopLevelRegex`. */
const CRLF_RE = /\r\n/g;

/** What `EditorState.changes()` hands back, modelled down to the one property
 * that matters here: `newLength`, the length of the document the change
 * produces. Real CodeMirror splits inserted text on `/\r\n?|\n/` and joins the
 * lines with `\n`, so a CRLF file's document is strictly SHORTER than the
 * string it came from — which is exactly what a caret clamped against the raw
 * string length overshoots. */
interface FakeChangeSet {
  insert: string;
  newLength: number;
}

interface FakeState {
  changes?: (spec: {
    from: number;
    insert: string;
    to: number;
  }) => FakeChangeSet;
  doc: { toString: () => string };
  extensions?: Extension;
  selection?: { main: { anchor: number; head: number } };
}

/** The most recently constructed `EditorView`, so a test can assert on
 * teardown (`destroy`) or `dispatch` without threading a spy through the
 * mock factory. A plain "last one wins" ref rather than array + last-index
 * access — this repo's `tsc` `lib` predates `Array.prototype.at()`, and
 * Biome's `useAtIndex` rejects `arr[arr.length - 1]` as the alternative. */
let lastConstructedView: FakeEditorView | undefined;

class FakeEditorView {
  contentDOM: HTMLDivElement;
  dom: HTMLDivElement;
  destroyed = false;
  dispatch = vi.fn(
    (tr: { changes?: { insert: string }; effects?: unknown }) => {
      // Real CodeMirror throws here; a destroyed view has no state to update.
      if (this.destroyed) {
        throw new Error("dispatch on a destroyed EditorView");
      }
      if (tr.changes) {
        this.contentDOM.textContent = tr.changes.insert;
      }
      if (tr.effects) {
        const effects = Array.isArray(tr.effects) ? tr.effects : [tr.effects];
        for (const effect of effects) {
          this.applyReconfigure(effect as { kind: string; value?: unknown });
        }
      }
    }
  );
  requestMeasure = vi.fn();
  private editable = true;
  private readonly updateListener?: (update: {
    docChanged: boolean;
    state: { doc: { toString: () => string } };
  }) => void;

  constructor(config: { parent?: HTMLElement; state: FakeState }) {
    const flat = flattenExtensions(config.state.extensions);
    const contentAttrs = flat.find((e) => e.kind === "contentAttributes")
      ?.value as Record<string, string> | undefined;
    const editableMarker = flat.find((e) => e.kind === "editable");
    if (editableMarker) {
      this.editable = Boolean(editableMarker.value);
    }
    this.updateListener = flat.find((e) => e.kind === "updateListener")
      ?.value as typeof this.updateListener;

    this.contentDOM = document.createElement("div");
    this.contentDOM.textContent = config.state.doc.toString();
    this.contentDOM.contentEditable = this.editable ? "true" : "false";
    for (const [key, value] of Object.entries(contentAttrs ?? {})) {
      this.contentDOM.setAttribute(key, value);
    }
    this.contentDOM.addEventListener("input", () => {
      if (!this.editable) {
        return;
      }
      const text = this.contentDOM.textContent ?? "";
      // Spread rather than replace: `selection` and `changes` are part of a
      // real state and the code under test reads both.
      this.state = { ...this.state, doc: { toString: () => text } };
      this.updateListener?.({ docChanged: true, state: this.state });
    });

    this.dom = document.createElement("div");
    this.dom.appendChild(this.contentDOM);
    config.parent?.appendChild(this.dom);

    this.state = {
      ...config.state,
      changes: (spec) => this.makeChanges(spec),
    };
    lastConstructedView = this;
  }

  state: FakeState;

  /** `EditorState.changes()` — the real one reports the length of the
   * document the change produces, after CodeMirror has split the inserted
   * text into lines (`\r\n` → `\n`). */
  private makeChanges({
    from,
    insert,
    to,
  }: {
    from: number;
    insert: string;
    to: number;
  }): FakeChangeSet {
    const kept = this.state.doc.toString().length - (to - from);
    return { insert, newLength: kept + insert.replace(CRLF_RE, "\n").length };
  }

  private applyReconfigure(effect: { kind: string; value?: unknown }) {
    if (effect.kind !== "reconfigure") {
      return;
    }
    const flat = flattenExtensions(effect.value as Extension);
    const editableMarker = flat.find((e) => e.kind === "editable");
    if (editableMarker) {
      this.editable = Boolean(editableMarker.value);
      this.contentDOM.contentEditable = this.editable ? "true" : "false";
    }
  }

  destroy() {
    this.destroyed = true;
    this.dom.remove();
  }
}

const fakeEditorViewStatics = {
  contentAttributes: {
    of: (value: Record<string, string>) => ({
      kind: "contentAttributes",
      value,
    }),
  },
  editable: { of: (value: boolean) => ({ kind: "editable", value }) },
  lineWrapping: { kind: "lineWrapping" },
  theme: (spec: unknown, options?: { dark?: boolean }) => ({
    dark: options?.dark ?? false,
    kind: "theme",
    value: spec,
  }),
  updateListener: {
    of: (fn: unknown) => ({ kind: "updateListener", value: fn }),
  },
};

vi.mock("@codemirror/state", () => ({
  Compartment: FakeCompartment,
  EditorState: fakeEditorState,
  Transaction: {
    addToHistory: { of: (value: boolean) => ({ kind: "addToHistory", value }) },
  },
}));

vi.mock("@codemirror/view", () => ({
  drawSelection: () => ({ kind: "drawSelection" }),
  dropCursor: () => ({ kind: "dropCursor" }),
  EditorView: Object.assign(FakeEditorView, fakeEditorViewStatics),
  highlightActiveLine: () => ({ kind: "highlightActiveLine" }),
  highlightActiveLineGutter: () => ({ kind: "highlightActiveLineGutter" }),
  keymap: { of: (value: unknown) => ({ kind: "keymap", value }) },
  lineNumbers: () => ({ kind: "lineNumbers" }),
  rectangularSelection: () => ({ kind: "rectangularSelection" }),
}));

vi.mock("@codemirror/language", () => ({
  bracketMatching: () => ({ kind: "bracketMatching" }),
  HighlightStyle: {
    define: (specs: unknown) => ({ kind: "highlightStyle", value: specs }),
  },
  indentOnInput: () => ({ kind: "indentOnInput" }),
  StreamLanguage: {
    define: (spec: unknown) => ({ kind: "streamLanguage", value: spec }),
  },
  syntaxHighlighting: (style: unknown) => ({
    kind: "syntaxHighlighting",
    value: style,
  }),
}));

vi.mock("@codemirror/commands", () => ({
  defaultKeymap: [{ key: "ArrowDown", kind: "defaultKeymapBinding" }],
  history: () => ({ kind: "history" }),
  historyKeymap: [{ key: "Mod-z", kind: "historyKeymapBinding" }],
  indentWithTab: { kind: "indentWithTab" },
}));

vi.mock("@codemirror/search", () => ({
  highlightSelectionMatches: () => ({ kind: "highlightSelectionMatches" }),
  search: (config?: unknown) => ({ kind: "search", value: config }),
  searchKeymap: [{ key: "Mod-f", kind: "searchKeymapBinding" }],
}));

vi.mock("@codemirror/autocomplete", () => ({
  closeBrackets: () => ({ kind: "closeBrackets" }),
  closeBracketsKeymap: [{ key: "Backspace", kind: "closeBracketsBinding" }],
}));

/** `@lezer/highlight`'s tag modifiers — the names that are functions taking a
 * tag and returning a derived one (`tags.function(tags.variableName)`).
 * Everything else on `tags` is a plain tag object. */
const TAG_MODIFIERS = new Set([
  "constant",
  "definition",
  "function",
  "local",
  "special",
  "standard",
]);

/**
 * Stands in for the real `tags` export without enumerating it.
 *
 * A hand-written list of tags was the previous shape, and it made this mock a
 * silent tripwire: adding a tag to `buildHighlightStyle` returned `undefined`
 * here, `HighlightStyle.define` threw, `CodeEditor` caught it and fell back to
 * the textarea — so *every* test failed with "expected a view to have
 * mounted", pointing nowhere near the actual cause. Answering for any name
 * keeps this mock about what it's testing (that a style is built and passed to
 * `syntaxHighlighting`) rather than about which tags happen to be in use.
 */
const fakeTags = new Proxy({} as Record<string, unknown>, {
  get(cache, name: string) {
    if (TAG_MODIFIERS.has(name)) {
      return (t: unknown) => ({ of: t, tag: name });
    }
    // Memoized so tag identity is stable across reads, like the real module's.
    if (!(name in cache)) {
      cache[name] = { tag: name };
    }
    return cache[name];
  },
});
vi.mock("@lezer/highlight", () => ({ tags: fakeTags }));

vi.mock("@codemirror/lang-javascript", () => ({
  javascript: (opts: unknown) => ({
    kind: "langExtension",
    lang: "javascript",
    opts,
  }),
}));

vi.mock("@codemirror/legacy-modes/mode/toml", () => ({
  toml: { name: "toml" },
}));

vi.mock("./gitGutter.ts", () => ({
  gitGutter: (b: string) => ({ kind: "gitGutter", value: b }),
}));

import { useLayout } from "../state/layout.ts";
import { tokens } from "../theme/tokens.ts";
import { CodeEditor } from "./CodeEditor.tsx";

// Hoisted per Biome's `useTopLevelRegex`.
const CONST_X_1_RE = /const x = 1/;

/** One `HighlightStyle.define` rule as the mocked `@codemirror/language`
 * records it — the colour and the (mocked) lezer tags it applies to. */
interface HighlightRule {
  color?: string;
  tag: unknown;
}

/** Every rule `buildHighlightStyle` passed to `HighlightStyle.define`.
 * `buildHighlightStyle` is module-private, so the mounted editor's
 * `syntaxHighlighting(...)` extension is the only honest way to read what it
 * actually produced. */
function highlightRules(view: FakeEditorView): HighlightRule[] {
  const styled = flattenExtensions(view.state.extensions).find(
    (e) => e.kind === "syntaxHighlighting"
  );
  const style = styled?.value as { value: HighlightRule[] } | undefined;
  if (!style) {
    throw new Error("expected a syntaxHighlighting extension");
  }
  return style.value;
}

/** The names of the mocked lezer tags a rule applies to — `fakeTags` returns
 * `{ tag: "<name>" }` for a plain tag and `{ of, tag: "<modifier>" }` for a
 * derived one, so a plain tag's own name is what identifies it here. */
function plainTagNames(rule: HighlightRule): string[] {
  const tags = Array.isArray(rule.tag) ? rule.tag : [rule.tag];
  return tags
    .filter(
      (t): t is { tag: string } =>
        typeof t === "object" && t !== null && !("of" in t)
    )
    .map((t) => t.tag);
}

/** Simulates a real keystroke into CodeMirror's contenteditable content DOM:
 * jsdom doesn't drive contentEditable input itself, so this appends text
 * directly and fires the same `input` event a keystroke would — mirrors
 * `PromptBar.test.tsx`'s `typeInto`. */
function typeInto(el: HTMLElement, text: string): void {
  el.textContent = `${el.textContent ?? ""}${text}`;
  fireEvent.input(el);
}

interface KeyBinding {
  key?: string;
  preventDefault?: boolean;
  run?: () => boolean;
}

/** Finds the first keymap binding for `key` across every `keymap.of(...)`
 * extension the editor mounted with — the real CodeMirror dispatches keys
 * through these same binding objects, so invoking one's `run` exercises the
 * exact handler a keystroke would. */
function findKeyBinding(
  view: FakeEditorView,
  key: string
): KeyBinding | undefined {
  for (const ext of flattenExtensions(view.state.extensions)) {
    if (ext.kind === "keymap" && Array.isArray(ext.value)) {
      const binding = (ext.value as KeyBinding[]).find((b) => b.key === key);
      if (binding) {
        return binding;
      }
    }
  }
}

function mountedView(): FakeEditorView {
  if (!lastConstructedView) {
    throw new Error("expected a CodeEditor view to have mounted");
  }
  return lastConstructedView;
}

describe("CodeEditor", () => {
  it("renders initial content and emits changes on edit", async () => {
    const onChange = vi.fn();
    render(
      <CodeEditor
        language="typescript"
        onChange={onChange}
        value={"const x = 1\n"}
      />
    );

    await screen.findByText(CONST_X_1_RE);
    typeInto(screen.getByRole("textbox"), "\nconst y = 2");

    expect(onChange).toHaveBeenCalledWith("const x = 1\n\nconst y = 2");
  });

  it("falls back to the legacy-modes StreamLanguage grammar for toml without throwing", async () => {
    render(<CodeEditor language="toml" onChange={vi.fn()} value={"key = 1"} />);

    expect(await screen.findByRole("textbox")).toBeInTheDocument();
    expect(screen.getByRole("textbox").textContent).toBe("key = 1");
  });

  it("mounts without a grammar for a genuinely unrecognised language", async () => {
    // No entry in CodeEditor's language-loader table at all — unlike toml,
    // this never even attempts a dynamic import. Still must mount cleanly.
    render(
      <CodeEditor language="cobol" onChange={vi.fn()} value={"MOVE 1 TO X"} />
    );

    expect(await screen.findByRole("textbox")).toBeInTheDocument();
  });

  it("does not fire onChange or accept edits when readOnly is set", async () => {
    const onChange = vi.fn();
    render(
      <CodeEditor
        language="typescript"
        onChange={onChange}
        readOnly
        value="const x = 1"
      />
    );

    const textbox = await screen.findByRole("textbox");
    expect(textbox.contentEditable).toBe("false");

    typeInto(textbox, "more text");

    expect(onChange).not.toHaveBeenCalled();
  });

  it("replaces the document when the value prop changes externally", async () => {
    const { rerender } = render(
      <CodeEditor
        language="typescript"
        onChange={vi.fn()}
        value="const x = 1"
      />
    );
    await screen.findByRole("textbox");

    rerender(
      <CodeEditor
        language="typescript"
        onChange={vi.fn()}
        value="const x = 2"
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("textbox").textContent).toBe("const x = 2");
    });
  });

  it("applies external value changes outside the undo history, preserving the selection", async () => {
    const { rerender } = render(
      <CodeEditor language="plain" onChange={vi.fn()} value="abc" />
    );
    await screen.findByRole("textbox");
    const view = mountedView();

    rerender(<CodeEditor language="plain" onChange={vi.fn()} value="xyz" />);

    await waitFor(() => expect(view.dispatch).toHaveBeenCalled());
    const spec = view.dispatch.mock.calls[0][0] as {
      annotations?: { kind: string; value: boolean };
      selection?: { anchor: number };
    };
    expect(spec.annotations).toEqual({ kind: "addToHistory", value: false });
    expect(spec.selection?.anchor).toBeLessThanOrEqual(3);
  });

  it("clamps the preserved caret to the reloaded document's length, not the raw string's", async () => {
    const { rerender } = render(
      <CodeEditor
        language="plain"
        onChange={vi.fn()}
        value="0123456789012345678"
      />
    );
    await screen.findByRole("textbox");
    const view = mountedView();
    // Caret parked at the very end of the 19-character document.
    if (view.state.selection) {
      view.state.selection.main = { anchor: 19, head: 19 };
    }
    view.dispatch.mockClear();

    // An external reload of a CRLF file: 21 string characters, but CodeMirror
    // splits the document on /\r\n?|\n/ and joins with \n, so the DOCUMENT is
    // 18 long. Clamping the caret to `value.length` left it at 19 — one past
    // the end — and CodeMirror threw `RangeError: Selection points outside of
    // document` out of an effect, killing the pane.
    rerender(
      <CodeEditor
        language="plain"
        onChange={vi.fn()}
        value={"line1\r\nline2\r\nline3\r\n"}
      />
    );

    await waitFor(() => expect(view.dispatch).toHaveBeenCalled());
    const spec = view.dispatch.mock.calls[0][0] as {
      selection?: { anchor: number };
    };
    expect(spec.selection?.anchor).toBe(18);
  });

  it("seeds the editor with the latest value, not the mount-time one", async () => {
    // The fakes' import promises resolve asynchronously, so this `rerender`
    // (issued synchronously, before `render` even settles) lands while the
    // core "chunk" is still loading — exactly the race where a `value`
    // change during the async mount window must not be lost.
    const { rerender } = render(
      <CodeEditor language="plain" onChange={vi.fn()} value="stale" />
    );
    rerender(<CodeEditor language="plain" onChange={vi.fn()} value="fresh" />);

    await waitFor(() => expect(lastConstructedView).not.toBeUndefined());

    expect(lastConstructedView?.state.doc.toString()).toBe("fresh");
  });

  it("does not dispatch a replace when the incoming value already matches the live document", async () => {
    const onChange = vi.fn((next: string) => {
      // Mirrors how a real caller (Task 17's FileViewer) would echo the
      // reported value straight back in as the next `value` prop.
      rerender(
        <CodeEditor language="typescript" onChange={onChange} value={next} />
      );
    });
    const { rerender } = render(
      <CodeEditor
        language="typescript"
        onChange={onChange}
        value="const x = 1"
      />
    );
    await screen.findByRole("textbox");
    const view = lastConstructedView;
    if (!view) {
      throw new Error("expected a CodeEditor view to have mounted");
    }

    typeInto(screen.getByRole("textbox"), "!");

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    // The user keystroke dispatched through the fake's own input handler,
    // not through `view.dispatch` (that's reserved for programmatic
    // replaces) — so the echoed-back value prop finding the document
    // already matching must skip calling `dispatch` a second time.
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("binds the platform save chord to onSave and swallows it", async () => {
    const onSave = vi.fn();
    render(
      <CodeEditor
        language="typescript"
        onChange={vi.fn()}
        onSave={onSave}
        value="const x = 1"
      />
    );
    await screen.findByRole("textbox");

    const binding = findKeyBinding(mountedView(), "Mod-s");
    expect(binding).toBeDefined();
    // preventDefault stops the browser's own "save page" dialog; returning
    // true marks the chord handled so it never falls through to any default.
    expect(binding?.preventDefault).toBe(true);
    expect(binding?.run?.()).toBe(true);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("still swallows the save chord when no onSave is wired", async () => {
    render(
      <CodeEditor
        language="typescript"
        onChange={vi.fn()}
        value="const x = 1"
      />
    );
    await screen.findByRole("textbox");

    const binding = findKeyBinding(mountedView(), "Mod-s");
    // No handler, but the chord must still be reported handled (true) so the
    // browser's save dialog can never appear over the editor.
    expect(binding?.run?.()).toBe(true);
  });

  it("follows the theme's light or dark appearance", async () => {
    // CodeMirror's own `&dark` base styles outrank ours in places (a focused
    // selection is #233), so a light theme in dark mode left selected code
    // unreadable.
    useLayout.getState().setThemeId("steel");
    render(
      <CodeEditor
        language="typescript"
        onChange={vi.fn()}
        value="const x = 1"
      />
    );
    await screen.findByRole("textbox");
    const view = mountedView();
    const editorTheme = () =>
      flattenExtensions(view.state.extensions).find(
        (e) => e.kind === "theme"
      ) as { dark: boolean } | undefined;
    expect(editorTheme()?.dark).toBe(true);
    view.dispatch.mockClear();

    act(() => useLayout.getState().setThemeId("steel-light"));

    await waitFor(() => expect(view.dispatch).toHaveBeenCalled());
    const reconfigure = view.dispatch.mock.calls
      .map(
        (call) =>
          (call[0] as { effects?: { kind?: string; value?: unknown } }).effects
      )
      .find((effects) => effects?.kind === "reconfigure");
    expect(reconfigure?.value).toMatchObject({ dark: false, kind: "theme" });
    act(() => useLayout.getState().setThemeId("steel"));
  });

  it("mounts with a line-number gutter and active-line highlighting", async () => {
    render(
      <CodeEditor
        language="typescript"
        onChange={vi.fn()}
        value="const x = 1"
      />
    );
    await screen.findByRole("textbox");

    const kinds = flattenExtensions(mountedView().state.extensions).map(
      (e) => e.kind
    );
    expect(kinds).toContain("lineNumbers");
    expect(kinds).toContain("highlightActiveLine");
    expect(kinds).toContain("drawSelection");
  });

  it("colours property names with the property slot, not the variable one", async () => {
    // `{ a: 1 }`'s `a` is violet, while
    // a plain identifier stays near-neutral. Both used to share
    // `syntax.variable`, so a JSON or config file rendered as one flat colour.
    render(
      <CodeEditor
        language="typescript"
        onChange={vi.fn()}
        value="const x = 1"
      />
    );
    await screen.findByRole("textbox");

    const rules = highlightRules(mountedView());
    const property = rules.find(
      (r) => r.color === tokens.color.syntax.property
    );
    expect(property).toBeDefined();
    expect(plainTagNames(property as HighlightRule)).toContain("propertyName");

    const variable = rules.find(
      (r) => r.color === tokens.color.syntax.variable
    );
    expect(variable).toBeDefined();
    expect(plainTagNames(variable as HighlightRule)).not.toContain(
      "propertyName"
    );
  });

  it("mounts search, close-brackets, selection-match and multi-cursor support", async () => {
    render(<CodeEditor language="plain" onChange={vi.fn()} value="x" />);
    await waitFor(() => expect(lastConstructedView).not.toBeUndefined());

    const kinds = flattenExtensions(mountedView().state.extensions).map(
      (e) => e.kind
    );
    for (const kind of [
      "search",
      "highlightSelectionMatches",
      "closeBrackets",
      "allowMultipleSelections",
      "rectangularSelection",
    ]) {
      expect(kinds).toContain(kind);
    }
  });

  it("merges close-brackets, default, search and history keymaps in precedence order", async () => {
    render(<CodeEditor language="plain" onChange={vi.fn()} value="x" />);
    await waitFor(() => expect(lastConstructedView).not.toBeUndefined());

    const mergedKeymap = flattenExtensions(mountedView().state.extensions).find(
      (ext) =>
        ext.kind === "keymap" &&
        Array.isArray(ext.value) &&
        (ext.value as { kind?: string }[]).some(
          (binding) => binding.kind === "closeBracketsBinding"
        )
    )?.value as { kind?: string }[] | undefined;

    expect(mergedKeymap).toBeDefined();
    expect(mergedKeymap?.map((binding) => binding.kind)).toEqual([
      "closeBracketsBinding",
      "defaultKeymapBinding",
      "searchKeymapBinding",
      "historyKeymapBinding",
      "indentWithTab",
    ]);
  });

  it("scrolls long lines instead of wrapping them", async () => {
    // Wrapping was on, and it was the single thing that made this view read
    // as unfinished: a long line broke to a second visual row starting at the
    // left margin with no indent, while its line number floated vertically
    // centred across both rows — so the gutter stopped lining up with the
    // code beside it. Every real code editor scrolls instead.
    render(
      <CodeEditor
        language="typescript"
        onChange={vi.fn()}
        value={`const x = "${"y".repeat(400)}"`}
      />
    );
    await screen.findByRole("textbox");

    const kinds = flattenExtensions(mountedView().state.extensions).map(
      (e) => e.kind
    );
    expect(kinds).not.toContain("lineWrapping");
  });

  it("destroys the CodeMirror view on unmount", async () => {
    const { unmount } = render(
      <CodeEditor
        language="typescript"
        onChange={vi.fn()}
        value="const x = 1"
      />
    );
    await screen.findByRole("textbox");
    const view = lastConstructedView;
    if (!view) {
      throw new Error("expected a CodeEditor view to have mounted");
    }

    unmount();

    expect(view.destroyed).toBe(true);
  });

  it("requests a measure when the container is resized or becomes visible", async () => {
    const observed: Element[] = [];
    let recordedCallback: ResizeObserverCallback | undefined;
    class RecordingRO {
      cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
        recordedCallback = cb;
      }
      observe(el: Element) {
        observed.push(el);
      }
      disconnect() {
        // recorded via spy below if needed
      }
      unobserve() {
        // no-op
      }
    }
    vi.stubGlobal("ResizeObserver", RecordingRO);

    render(<CodeEditor language="plain" onChange={vi.fn()} value="x" />);
    await waitFor(() => expect(lastConstructedView).not.toBeUndefined());
    const view = mountedView();

    expect(observed).toContain(screen.getByTestId("code-editor"));

    // Fire the recorded callback the same way a real ResizeObserver would
    // when the container is resized or flips from `display:none` to
    // visible, and confirm it nudges CodeMirror to re-measure.
    recordedCallback?.([], {} as ResizeObserver);
    expect(view.requestMeasure).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("falls back to a plain editable textarea if the core chunk fails to load", async () => {
    // Force the CodeMirror core import to reject, in a fresh isolated module
    // graph (vi.resetModules) so it never poisons the other tests' cached
    // modules. This is the one path with no CodeMirror view to assert on — the
    // point is that a chunk-load failure degrades to an editable textarea, not
    // a blank box.
    vi.resetModules();
    vi.doMock("@codemirror/state", () => {
      throw new Error("simulated core chunk load failure");
    });
    const { CodeEditor: FreshCodeEditor } = await import("./CodeEditor.tsx");
    const onChange = vi.fn();

    render(
      <FreshCodeEditor
        language="typescript"
        onChange={onChange}
        value="hello"
      />
    );

    const fallback = await screen.findByTestId("code-editor-fallback");
    expect(fallback).toHaveValue("hello");
    // Still editable — the Save button in FileViewer keeps working.
    fireEvent.change(fallback, { target: { value: "edited" } });
    expect(onChange).toHaveBeenCalledWith("edited");

    vi.doUnmock("@codemirror/state");
    vi.resetModules();
  });

  describe("git gutter", () => {
    it("mounts the git-gutter extension when a baseline is given", async () => {
      render(
        <CodeEditor
          baseline="was"
          language="typescript"
          onChange={vi.fn()}
          value="const x = 1"
        />
      );
      await screen.findByRole("textbox");

      const kinds = flattenExtensions(mountedView().state.extensions);
      expect(kinds).toContainEqual({ kind: "gitGutter", value: "was" });
    });

    it("mounts no git-gutter extension when baseline is undefined", async () => {
      render(
        <CodeEditor
          language="typescript"
          onChange={vi.fn()}
          value="const x = 1"
        />
      );
      await screen.findByRole("textbox");

      const kinds = flattenExtensions(mountedView().state.extensions);
      expect(kinds.some((e) => e.kind === "gitGutter")).toBe(false);
    });

    it("reconfigures the gutter compartment when the baseline prop changes", async () => {
      const { rerender } = render(
        <CodeEditor
          baseline="was"
          language="typescript"
          onChange={vi.fn()}
          value="const x = 1"
        />
      );
      await screen.findByRole("textbox");
      const view = mountedView();
      view.dispatch.mockClear();

      rerender(
        <CodeEditor
          baseline="now"
          language="typescript"
          onChange={vi.fn()}
          value="const x = 1"
        />
      );

      await waitFor(() => expect(view.dispatch).toHaveBeenCalled());
      const reconfigureCall = view.dispatch.mock.calls.find((call) => {
        const spec = call[0] as { effects?: { kind?: string } };
        return spec.effects?.kind === "reconfigure";
      });
      expect(reconfigureCall).toBeDefined();
      const spec = reconfigureCall?.[0] as {
        effects: { kind: string; value: unknown };
      };
      expect(spec.effects.value).toEqual({ kind: "gitGutter", value: "now" });
    });

    it("reconfigures the gutter compartment when a baseline arrives after an undefined mount", async () => {
      // The common real-world path: `readBaseline`'s git round-trip usually
      // resolves after CodeMirror has already mounted, so the editor mounts
      // with no baseline and picks one up later purely through the
      // compartment reconfigure — never through a fresh mount.
      const { rerender } = render(
        <CodeEditor
          language="typescript"
          onChange={vi.fn()}
          value="const x = 1"
        />
      );
      await screen.findByRole("textbox");
      const view = mountedView();
      view.dispatch.mockClear();

      rerender(
        <CodeEditor
          baseline="was"
          language="typescript"
          onChange={vi.fn()}
          value="const x = 1"
        />
      );

      await waitFor(() => expect(view.dispatch).toHaveBeenCalled());
      const reconfigureCall = view.dispatch.mock.calls.find((call) => {
        const spec = call[0] as { effects?: { kind?: string } };
        return spec.effects?.kind === "reconfigure";
      });
      expect(reconfigureCall).toBeDefined();
      const spec = reconfigureCall?.[0] as {
        effects: { kind: string; value: unknown };
      };
      expect(spec.effects.value).toEqual({ kind: "gitGutter", value: "was" });
    });

    it("seeds the gutter with the latest baseline, not the mount-time one", async () => {
      // Same race the `value` seeding test covers: the mount effect awaits two
      // dynamic imports before it builds the `EditorState`, so a `baseline`
      // that lands inside that window must still be the one the compartment is
      // seeded with — the `[baseline]` effect can't rescue it, since it
      // early-returns while `viewRef.current` is still null.
      const { rerender } = render(
        <CodeEditor
          baseline="stale"
          language="plain"
          onChange={vi.fn()}
          value="x"
        />
      );
      rerender(
        <CodeEditor
          baseline="fresh"
          language="plain"
          onChange={vi.fn()}
          value="x"
        />
      );

      await waitFor(() => expect(lastConstructedView).not.toBeUndefined());

      expect(flattenExtensions(mountedView().state.extensions)).toContainEqual({
        kind: "gitGutter",
        value: "fresh",
      });
    });

    it("does not dispatch into a destroyed view when a baseline change races unmount", async () => {
      // The `[baseline]` effect dispatches from inside `loadCore().then(...)`,
      // on a `view` captured before the await. An unmount landing in that
      // window used to dispatch into a destroyed `EditorView`, which throws.
      const { rerender, unmount } = render(
        <CodeEditor
          baseline="was"
          language="plain"
          onChange={vi.fn()}
          value="x"
        />
      );
      await screen.findByRole("textbox");
      const view = mountedView();
      view.dispatch.mockClear();

      rerender(
        <CodeEditor
          baseline="now"
          language="plain"
          onChange={vi.fn()}
          value="x"
        />
      );
      unmount();
      await Promise.resolve();
      await Promise.resolve();

      expect(view.destroyed).toBe(true);
      expect(view.dispatch).not.toHaveBeenCalled();
    });

    it("reconfigures the gutter compartment to empty when the baseline prop is cleared", async () => {
      const { rerender } = render(
        <CodeEditor
          baseline="was"
          language="typescript"
          onChange={vi.fn()}
          value="const x = 1"
        />
      );
      await screen.findByRole("textbox");
      const view = mountedView();
      view.dispatch.mockClear();

      rerender(
        <CodeEditor
          language="typescript"
          onChange={vi.fn()}
          value="const x = 1"
        />
      );

      await waitFor(() => expect(view.dispatch).toHaveBeenCalled());
      const reconfigureCall = view.dispatch.mock.calls.find((call) => {
        const spec = call[0] as { effects?: { kind?: string } };
        return spec.effects?.kind === "reconfigure";
      });
      expect(reconfigureCall).toBeDefined();
      const spec = reconfigureCall?.[0] as {
        effects: { kind: string; value: unknown };
      };
      expect(spec.effects.value).toEqual([]);
    });
  });
});
