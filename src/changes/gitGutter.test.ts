import { Compartment, EditorState, type RangeSet } from "@codemirror/state";
import { EditorView, type GutterMarker } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeLineChanges,
  GIT_GUTTER_DEBOUNCE_MS,
  gitGutter,
  gitGutterMarks,
  MAX_GUTTER_CHANGED_LINES,
} from "./gitGutter.ts";

describe("computeLineChanges", () => {
  it("returns nothing for identical docs", () => {
    const r = computeLineChanges("a\nb\n", "a\nb\n");
    expect(r.added.size + r.modified.size + r.deleted.size).toBe(0);
  });

  it("marks a changed line as modified", () => {
    const r = computeLineChanges("a\nb\nc", "a\nX\nc");
    expect([...r.modified]).toEqual([2]);
    expect(r.added.size).toBe(0);
  });

  it("marks inserted lines as added", () => {
    const r = computeLineChanges("a\nc", "a\nb\nc");
    expect(r.added.has(2)).toBe(true);
  });

  it("marks a removal on the line it collapsed onto", () => {
    const r = computeLineChanges("a\nb\nc", "a\nc");
    expect(r.deleted.size).toBe(1);
  });

  it("treats an empty baseline as all-added (untracked file)", () => {
    const r = computeLineChanges("", "a\nb");
    expect(r.added.has(1)).toBe(true);
    expect(r.added.has(2)).toBe(true);
  });
});

/** Every marked position in a marker set, in document order — the shape the
 * gutter actually renders from, flattened so a test can assert on it. */
function markedPositions(marks: RangeSet<GutterMarker>): number[] {
  const positions: number[] = [];
  const cursor = marks.iter();
  while (cursor.value !== null) {
    positions.push(cursor.from);
    cursor.next();
  }
  return positions;
}

/** The marked positions of a state, as `(line, class)` pairs — positions
 * alone can't tell "remapped correctly" from "happens to still be a number". */
function markedLines(state: EditorState): { kind: string; line: number }[] {
  const marks = state.field(gitGutterMarks);
  const out: { kind: string; line: number }[] = [];
  const cursor = marks.iter();
  while (cursor.value !== null) {
    out.push({
      kind: cursor.value.elementClass,
      line: state.doc.lineAt(cursor.from).number,
    });
    cursor.next();
  }
  return out;
}

describe("the gitGutter state field", () => {
  it("seeds markers from the baseline when the state is created", () => {
    const state = EditorState.create({
      doc: "a\nX\nc",
      extensions: gitGutter("a\nb\nc"),
    });

    expect(markedLines(state)).toEqual([
      { kind: "cm-gitMarker cm-gitModified", line: 2 },
    ]);
  });

  it("seeds an added and a deleted marker on the lines they belong to", () => {
    // The two buckets the field path never asserted end to end: every other
    // test here only ever produced `cm-gitModified`, so an added/deleted
    // marker could have been built with the wrong class — or at the wrong
    // line — without a single test noticing.
    const state = EditorState.create({
      doc: "alpha\nINSERTED\nbeta\ngamma\nepsilon\nzeta",
      extensions: gitGutter("alpha\nbeta\ngamma\ndelta\nepsilon\nzeta"),
    });

    expect(markedLines(state)).toEqual([
      { kind: "cm-gitMarker cm-gitAdded", line: 2 },
      // `delta` is gone; its marker sits on the line it collapsed onto.
      { kind: "cm-gitMarker cm-gitDeleted", line: 4 },
    ]);
  });

  it("holds no markers for a doc identical to its baseline", () => {
    const state = EditorState.create({
      doc: "a\nb\nc",
      extensions: gitGutter("a\nb\nc"),
    });

    expect(markedPositions(state.field(gitGutterMarks))).toEqual([]);
  });

  it("remaps marker positions through tr.changes when text is inserted above them", () => {
    // The 200 ms before the next recompute lands: the markers must follow
    // their lines rather than sitting at the offsets they were computed at.
    // Line 2 is modified vs the baseline; inserting a whole new line 1 above
    // it must carry that marker down to line 3, not leave it on line 2.
    const state = EditorState.create({
      doc: "a\nX\nc",
      extensions: gitGutter("a\nb\nc"),
    });
    expect(markedLines(state)).toEqual([
      { kind: "cm-gitMarker cm-gitModified", line: 2 },
    ]);

    const after = state.update({ changes: { from: 0, insert: "new\n" } }).state;

    expect(markedLines(after)).toEqual([
      { kind: "cm-gitMarker cm-gitModified", line: 3 },
    ]);
  });

  it("keeps marker positions unchanged for a transaction that doesn't touch the doc", () => {
    const state = EditorState.create({
      doc: "a\nX\nc",
      extensions: gitGutter("a\nb\nc"),
    });
    const before = markedPositions(state.field(gitGutterMarks));

    const after = state.update({ selection: { anchor: 0 } }).state;

    expect(markedPositions(after.field(gitGutterMarks))).toEqual(before);
  });
});

/** A doc of `lines` one-word lines — the shape a whole-file rewrite (or an
 * untracked file diffed against an empty baseline) produces one marker per. */
function docOfLines(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n");
}

describe("the gitGutter changed-line ceiling", () => {
  it("still marks every changed line at the ceiling", () => {
    const state = EditorState.create({
      doc: docOfLines(MAX_GUTTER_CHANGED_LINES),
      extensions: gitGutter(""),
    });

    expect(markedPositions(state.field(gitGutterMarks))).toHaveLength(
      MAX_GUTTER_CHANGED_LINES
    );
  });

  it("builds no markers at all once the changed-line count passes the ceiling", () => {
    // One marker per changed line is a DOM element per changed line: a 1 MiB
    // file of one-byte lines is ~500k of them, built synchronously on the main
    // thread. Past the ceiling the gutter goes silently off rather than
    // freezing the window over a decoration.
    const state = EditorState.create({
      doc: docOfLines(MAX_GUTTER_CHANGED_LINES + 1),
      extensions: gitGutter(""),
    });

    expect(markedPositions(state.field(gitGutterMarks))).toEqual([]);
  });
});

describe("the gitGutter baseline reconfigure", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("recomputes markers when the baseline changes, with no document change", () => {
    // `gitGutterMarks` is one module-level `StateField`, and CodeMirror
    // preserves a field's value across a compartment reconfiguration — so a
    // commit/checkout moving HEAD (which is what changes the baseline) left
    // the OLD diff painted until the user happened to type.
    vi.useFakeTimers();
    const compartment = new Compartment();
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "a\nb\nc",
        extensions: compartment.of(gitGutter("a\nb\nc")),
      }),
    });
    expect(markedPositions(view.state.field(gitGutterMarks))).toEqual([]);

    view.dispatch({ effects: compartment.reconfigure(gitGutter("a\nX\nc")) });

    // Immediately — the debounce exists to keep `presentableDiff` off the
    // keystroke path, and a baseline change is not a keystroke.
    vi.advanceTimersByTime(0);
    expect(markedLines(view.state)).toEqual([
      { kind: "cm-gitMarker cm-gitModified", line: 2 },
    ]);
    view.destroy();
  });
});

describe("the gitGutter recompute debounce", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A real (if headless) `EditorView`: the debounce lives in a `ViewPlugin`,
   * so nothing short of an actual view exercises it. jsdom gives CodeMirror
   * no layout, which is fine — this asserts on state, never on geometry. */
  function mountView(baseline: string, doc: string): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    return new EditorView({
      parent,
      state: EditorState.create({ doc, extensions: gitGutter(baseline) }),
    });
  }

  it("recomputes markers only after the debounce window elapses", () => {
    vi.useFakeTimers();
    const view = mountView("a\nb\nc", "a\nb\nc");
    expect(markedPositions(view.state.field(gitGutterMarks))).toEqual([]);

    // Type over line 2: "b" → "X".
    view.dispatch({ changes: { from: 2, to: 3, insert: "X" } });

    // Still nothing — a keystroke must not run `presentableDiff`.
    expect(markedPositions(view.state.field(gitGutterMarks))).toEqual([]);
    vi.advanceTimersByTime(GIT_GUTTER_DEBOUNCE_MS - 1);
    expect(markedPositions(view.state.field(gitGutterMarks))).toEqual([]);

    vi.advanceTimersByTime(1);

    expect(markedLines(view.state)).toEqual([
      { kind: "cm-gitMarker cm-gitModified", line: 2 },
    ]);
    view.destroy();
  });

  it("coalesces a burst of edits into a single recompute after the last one", () => {
    vi.useFakeTimers();
    const view = mountView("a\nb\nc", "a\nb\nc");

    view.dispatch({ changes: { from: 2, to: 3, insert: "X" } });
    vi.advanceTimersByTime(GIT_GUTTER_DEBOUNCE_MS - 1);
    // A second keystroke inside the window restarts the clock.
    view.dispatch({ changes: { from: 3, to: 3, insert: "Y" } });
    vi.advanceTimersByTime(GIT_GUTTER_DEBOUNCE_MS - 1);
    expect(markedPositions(view.state.field(gitGutterMarks))).toEqual([]);

    vi.advanceTimersByTime(1);

    expect(markedLines(view.state)).toEqual([
      { kind: "cm-gitMarker cm-gitModified", line: 2 },
    ]);
    view.destroy();
  });

  it("cancels a pending recompute when the view is destroyed", () => {
    vi.useFakeTimers();
    const view = mountView("a\nb\nc", "a\nb\nc");
    view.dispatch({ changes: { from: 2, to: 3, insert: "X" } });

    view.destroy();

    // A timer firing into a destroyed view would throw out of the timer
    // queue; nothing should be pending at all.
    expect(vi.getTimerCount()).toBe(0);
  });
});
