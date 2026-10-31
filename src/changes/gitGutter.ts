import { presentableDiff } from "@codemirror/merge";
import {
  type Extension,
  Facet,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Text,
  type Transaction,
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

/**
 * Everything that follows one baseline text as the document changes: the
 * baseline facet, a field holding what was built from the diff, and the
 * plugin that rebuilds it. Shared by the HEAD gutter here and the editor's
 * session highlight (`editorGit.ts`), so the debounce and the
 * baseline-moved rules below are written once.
 *
 * The baseline is a facet rather than a closure variable so the field can be
 * one module-level `StateField` per tracker instead of a fresh field per
 * call — which is what lets a headless `EditorState` read the value back
 * (`state.field(...)`) and makes it testable without an `EditorView`. `null`
 * (no tracker extension mounted) means there is no baseline and the field
 * stays empty.
 *
 * The field has two update paths, and the distinction is the whole point of
 * the debounce: a `set` effect installs a freshly built value, while a plain
 * document change only **remaps** the existing one (`map`), so it keeps
 * pointing at the right lines during the 200 ms before the next rebuild lands.
 *
 * The plugin rebuilds `GIT_GUTTER_DEBOUNCE_MS` after the last document change
 * (VSCode's dirty-diff cadence) — never per keystroke, since
 * `presentableDiff` walks the whole file — and immediately when the baseline
 * itself moves. The baseline case is the correctness half: CodeMirror keeps
 * a field's value across a compartment reconfiguration, so a swapped-in
 * baseline (a commit moved HEAD) would otherwise leave the old diff painted
 * until the user typed. Both go through a timer because a `ViewPlugin` must
 * not dispatch from inside `update` — at 0 ms for a baseline change, so it
 * lands on the very next task.
 */
export function createDiffTracker<T>(options: {
  build: (doc: Text, changes: LineChanges) => T;
  empty: T;
  map: (value: T, tr: Transaction) => T;
}) {
  const baselineFacet = Facet.define<string, string | null>({
    combine: (values) => (values.length > 0 ? values[0] : null),
  });
  const set = StateEffect.define<T>();
  const field = StateField.define<T>({
    create(state) {
      const baseline = state.facet(baselineFacet);
      if (baseline === null) {
        return options.empty;
      }
      return options.build(
        state.doc,
        computeLineChanges(baseline, state.doc.toString(), state.doc)
      );
    },
    update(value, tr) {
      for (const effect of tr.effects) {
        if (effect.is(set)) {
          return effect.value;
        }
      }
      return tr.docChanged ? options.map(value, tr) : value;
    },
  });
  const plugin = ViewPlugin.fromClass(
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
            view.dispatch({ effects: set.of(options.build(doc, changes)) });
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
  return {
    baselineFacet,
    extension: (baseline: string): Extension => [
      baselineFacet.of(baseline),
      field,
      plugin,
    ],
    field,
  };
}

const headTracker = createDiffTracker<RangeSet<GutterMarker>>({
  build: buildMarks,
  empty: RangeSet.empty,
  map: (marks, tr) => marks.map(tr.changes),
});

/** The current git-gutter markers for a state, keyed by document position. */
export const gitGutterMarks = headTracker.field;

/** The HEAD text the gutter diffs against, or `null` with no gutter mounted —
 * what a click on a marker reverts to (see `editorGit.ts`). */
export const headBaseline = headTracker.baselineFacet;

/**
 * Builds the full git-gutter extension for the given HEAD-baseline text: the
 * tracker holding the current line markers, and the gutter that renders
 * them. `onMarkerClick` (the editor's "show this change" peek) is handed the
 * clicked line's start position.
 */
export function gitGutter(
  baseline: string,
  onMarkerClick?: (view: EditorView, pos: number) => boolean
): Extension {
  return [
    headTracker.extension(baseline),
    gutter({
      class: "cm-gitGutter",
      domEventHandlers: onMarkerClick
        ? { mousedown: (view, line) => onMarkerClick(view, line.from) }
        : {},
      markers: (view: EditorView) => view.state.field(gitGutterMarks),
    }),
  ];
}
