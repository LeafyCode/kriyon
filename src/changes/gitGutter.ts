import { presentableDiff } from "@codemirror/merge";
import {
  type Extension,
  Facet,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Text,
} from "@codemirror/state";
import {
  type EditorView,
  GutterMarker,
  gutter,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

/** Per-line git status for the current doc, keyed by 1-based line number. */
export interface LineChanges {
  added: Set<number>;
  /** Line numbers a deletion sits at (marker rendered on that line). */
  deleted: Set<number>;
  modified: Set<number>;
}

export const GIT_GUTTER_DEBOUNCE_MS = 200;

/**
 * The most changed lines the gutter will draw before it gives up and draws
 * nothing.
 *
 * One changed line is one marker, and one marker is a DOM element the gutter
 * lays out — built synchronously, on the main thread, in one pass. A file that
 * is entirely new to git (or entirely rewritten) has every line changed, so a
 * 1 MiB file of one-byte lines is ~500k markers and a frozen window. Past this
 * ceiling the gutter goes silently off: a decoration must never be the reason
 * the editor stops responding. Well above any file a person is editing by
 * hand, so a real session never reaches it.
 */
export const MAX_GUTTER_CHANGED_LINES = 20_000;

/**
 * Maps a HEAD-baseline string vs. the current doc into per-line
 * added/modified/deleted sets, using `@codemirror/merge`'s presentable diff.
 *
 * `doc` lets a caller that already holds the current document's rope hand it
 * over instead of paying for `Text.of(current.split("\n"))` again — both real
 * call sites do; the fallback keeps this callable with two plain strings.
 */
export function computeLineChanges(
  baseline: string,
  current: string,
  doc: Text = Text.of(current.split("\n"))
): LineChanges {
  const added = new Set<number>();
  const modified = new Set<number>();
  const deleted = new Set<number>();
  const docEnd = doc.length;

  const lineAt = (pos: number) =>
    doc.lineAt(Math.min(Math.max(pos, 0), docEnd)).number;

  for (const change of presentableDiff(baseline, current)) {
    const isDeletion = change.fromB === change.toB;
    if (isDeletion) {
      deleted.add(lineAt(change.fromB));
      continue;
    }
    const isInsertion = change.fromA === change.toA;
    const bucket = isInsertion ? added : modified;
    const from = lineAt(change.fromB);
    const to = lineAt(Math.max(change.toB - 1, change.fromB));
    for (let line = from; line <= to; line += 1) {
      bucket.add(line);
    }
  }

  return { added, modified, deleted };
}

class GitMarker extends GutterMarker {
  override elementClass: string;

  constructor(kind: "added" | "modified" | "deleted") {
    super();
    this.elementClass = `cm-gitMarker cm-git${kind[0].toUpperCase()}${kind.slice(1)}`;
  }

  override eq(other: GutterMarker): boolean {
    return (
      other instanceof GitMarker && other.elementClass === this.elementClass
    );
  }
}

const addedMarker = new GitMarker("added");
const modifiedMarker = new GitMarker("modified");
const deletedMarker = new GitMarker("deleted");

function buildMarks(doc: Text, changes: LineChanges): RangeSet<GutterMarker> {
  const changedLines =
    changes.added.size + changes.modified.size + changes.deleted.size;
  if (changedLines > MAX_GUTTER_CHANGED_LINES) {
    return RangeSet.empty;
  }
  const marks: { pos: number; marker: GitMarker }[] = [];
  for (const line of changes.added) {
    marks.push({ pos: doc.line(line).from, marker: addedMarker });
  }
  for (const line of changes.modified) {
    marks.push({ pos: doc.line(line).from, marker: modifiedMarker });
  }
  for (const line of changes.deleted) {
    marks.push({ pos: doc.line(line).from, marker: deletedMarker });
  }
  marks.sort((a, b) => a.pos - b.pos);

  const builder = new RangeSetBuilder<GutterMarker>();
  for (const { pos, marker } of marks) {
    builder.add(pos, pos, marker);
  }
  return builder.finish();
}

const setMarks = StateEffect.define<RangeSet<GutterMarker>>();

/**
 * The HEAD-baseline text every other part of this module diffs against.
 *
 * A facet rather than a closure variable so {@link gitGutterMarks} can be one
 * module-level `StateField` instead of a fresh field per {@link gitGutter}
 * call — which is what lets a headless `EditorState` read the markers back
 * (`state.field(gitGutterMarks)`) and makes the field genuinely testable
 * without an `EditorView`. `null` (no `gitGutter` extension mounted) means
 * there is no baseline and the field stays empty.
 */
const baselineFacet = Facet.define<string, string | null>({
  combine: (values) => (values.length > 0 ? values[0] : null),
});

/**
 * The current git-gutter markers for a state, as a `RangeSet` keyed by
 * document position.
 *
 * Two update paths, and the distinction is the whole point of the debounce:
 * a `setMarks` effect installs freshly computed markers, while a plain
 * document change only **remaps** the existing ones through `tr.changes`, so
 * markers keep pointing at the right lines during the 200 ms before the next
 * recompute lands (rather than sitting at stale offsets or vanishing).
 */
export const gitGutterMarks = StateField.define<RangeSet<GutterMarker>>({
  create(state) {
    const baseline = state.facet(baselineFacet);
    if (baseline === null) {
      return RangeSet.empty;
    }
    return buildMarks(
      state.doc,
      computeLineChanges(baseline, state.doc.toString(), state.doc)
    );
  },
  update(marks, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setMarks)) {
        return effect.value;
      }
    }
    return tr.docChanged ? marks.map(tr.changes) : marks;
  },
});

/**
 * Recomputes the markers `GIT_GUTTER_DEBOUNCE_MS` after the last document
 * change (VSCode's dirty-diff cadence) — never per keystroke, since
 * `presentableDiff` walks the whole file — and immediately when the baseline
 * itself moves.
 *
 * The baseline case is not an optimization, it's the correctness half.
 * {@link gitGutterMarks} is one module-level `StateField`, and CodeMirror
 * preserves a field's value across a compartment reconfiguration — so when
 * `CodeEditor` swaps in a new baseline (a commit or checkout moved HEAD), the
 * field keeps the markers computed against the OLD one and the gutter paints a
 * stale diff until the user happens to type. Rescheduling on a baseline change
 * is what closes that.
 *
 * Both paths go through the same timer rather than dispatching inline: a
 * `ViewPlugin` must not dispatch from inside `update` (CodeMirror forbids
 * re-entrant updates), so the recompute is always scheduled — at 0 ms for a
 * baseline change, which puts it on the very next task rather than a fifth of
 * a second later.
 */
const recomputePlugin = ViewPlugin.fromClass(
  class implements PluginValue {
    private timer: ReturnType<typeof setTimeout> | undefined;

    update(update: ViewUpdate) {
      const baselineChanged =
        update.startState.facet(baselineFacet) !==
        update.state.facet(baselineFacet);
      if (!(update.docChanged || baselineChanged)) {
        return;
      }
      if (this.timer !== undefined) {
        clearTimeout(this.timer);
      }
      const { view } = update;
      this.timer = setTimeout(
        () => {
          this.timer = undefined;
          const baseline = view.state.facet(baselineFacet);
          if (baseline === null) {
            return;
          }
          const { doc } = view.state;
          const changes = computeLineChanges(baseline, doc.toString(), doc);
          view.dispatch({ effects: setMarks.of(buildMarks(doc, changes)) });
        },
        baselineChanged ? 0 : GIT_GUTTER_DEBOUNCE_MS
      );
    }

    destroy() {
      if (this.timer !== undefined) {
        clearTimeout(this.timer);
      }
    }
  }
);

/**
 * Builds the full git-gutter extension for the given HEAD-baseline text: the
 * baseline itself, the {@link gitGutterMarks} field holding the current line
 * markers, a ViewPlugin that recomputes them (debounced) as the doc changes,
 * and the gutter that renders them.
 */
export function gitGutter(baseline: string): Extension {
  return [
    baselineFacet.of(baseline),
    gitGutterMarks,
    recomputePlugin,
    gutter({
      class: "cm-gitGutter",
      markers: (view: EditorView) => view.state.field(gitGutterMarks),
    }),
  ];
}
