/**
 * The code editor's git features beyond the gutter: undoing one change from
 * the gutter, tinting what changed during the session, and blaming the
 * cursor's line.
 *
 * Reached only through `CodeEditor`'s lazy `loadCore`, like `gitGutter.ts`,
 * so none of CodeMirror lands in the entry chunk.
 */
import { presentableDiff } from "@codemirror/merge";
import {
  type EditorState,
  type Extension,
  Facet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  showTooltip,
  type Tooltip,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { relativeTime } from "../sidebar/pastSessionTime.ts";
import type { FileBlame } from "../types.ts";
import {
  createDiffTracker,
  headBaseline,
  type LineChanges,
  MAX_GUTTER_CHANGED_LINES,
} from "./gitGutter.ts";

/** One change between a baseline and the document, located both ways. */
export interface LineChange {
  /** The baseline's range (`fromA`–`toA`) and the document's (`fromB`–`toB`). */
  fromA: number;
  fromB: number;
  kind: "added" | "deleted" | "modified";
  /** What the baseline had there — what a revert puts back. */
  oldText: string;
  toA: number;
  toB: number;
}

/**
 * The change covering `line` (1-based) of `current`, measured against
 * `baseline` — the same diff, and the same line attribution, the gutter
 * draws from (`computeLineChanges`), so the marker clicked and the change
 * found are always the same one.
 */
export function changeAtLine(
  baseline: string,
  current: string,
  line: number,
  doc: Text = Text.of(current.split("\n"))
): LineChange | undefined {
  const end = doc.length;
  const lineAt = (pos: number) =>
    doc.lineAt(Math.min(Math.max(pos, 0), end)).number;
  for (const c of presentableDiff(baseline, current)) {
    const located = {
      fromA: c.fromA,
      fromB: c.fromB,
      oldText: baseline.slice(c.fromA, c.toA),
      toA: c.toA,
      toB: c.toB,
    };
    if (c.fromB === c.toB) {
      if (lineAt(c.fromB) === line) {
        return { ...located, kind: "deleted" };
      }
      continue;
    }
    const first = lineAt(c.fromB);
    const last = lineAt(Math.max(c.toB - 1, c.fromB));
    if (line >= first && line <= last) {
      return { ...located, kind: c.fromA === c.toA ? "added" : "modified" };
    }
  }
}

/**
 * Put `line`'s change back to what `baseline` had, leaving every other edit
 * in the document alone. An ordinary editor transaction: the buffer turns
 * dirty, Save writes it, and ⌘Z brings the change back. Returns whether
 * there was a change to revert.
 */
export function revertChangeAt(
  view: EditorView,
  baseline: string,
  line: number
): boolean {
  const { doc } = view.state;
  const change = changeAtLine(baseline, doc.toString(), line, doc);
  if (!change) {
    return false;
  }
  view.dispatch({
    changes: { from: change.fromB, insert: change.oldText, to: change.toB },
    userEvent: "input.revert",
  });
  return true;
}

// --- the change peek: a gutter click shows the change and offers to revert --

/** Where a peek is open: the line, and that line's start offset (where the
 * tooltip anchors). */
interface Peek {
  line: number;
  pos: number;
}

const openPeek = StateEffect.define<Peek>();
const closePeek = StateEffect.define<null>();

/** The open peek, or `null`. Any edit closes it: the change it described may
 * no longer be the one under that line. */
const peekField = StateField.define<Peek | null>({
  create: () => null,
  provide: (field) =>
    showTooltip.from(field, (peek): Tooltip | null =>
      peek === null
        ? null
        : {
            above: false,
            create: (view) => ({ dom: peekDom(view, peek.line) }),
            pos: peek.pos,
          }
    ),
  update(peek, tr) {
    for (const effect of tr.effects) {
      if (effect.is(openPeek)) {
        return effect.value;
      }
      if (effect.is(closePeek)) {
        return null;
      }
    }
    return tr.docChanged ? null : peek;
  },
});

const TRAILING_NEWLINE = /\n$/;

function peekDom(view: EditorView, line: number): HTMLElement {
  const baseline = view.state.facet(headBaseline);
  const dom = document.createElement("div");
  dom.className = "cm-changePeek";
  const change =
    baseline === null
      ? undefined
      : changeAtLine(baseline, view.state.doc.toString(), line, view.state.doc);

  const head = document.createElement("div");
  head.className = "cm-changePeek-head";
  const title = document.createElement("span");
  title.textContent =
    change?.kind === "added"
      ? "Added since the last commit"
      : "Before (last commit)";
  head.append(title);

  const revert = document.createElement("button");
  revert.type = "button";
  revert.className = "cm-changePeek-revert";
  revert.textContent = "Revert change";
  revert.disabled = change === undefined;
  revert.addEventListener("mousedown", (event) => {
    event.preventDefault();
    if (baseline !== null) {
      revertChangeAt(view, baseline, line);
    }
    view.dispatch({ effects: closePeek.of(null) });
    view.focus();
  });
  const close = document.createElement("button");
  close.type = "button";
  close.className = "cm-changePeek-close";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  close.addEventListener("mousedown", (event) => {
    event.preventDefault();
    view.dispatch({ effects: closePeek.of(null) });
  });
  head.append(revert, close);
  dom.append(head);

  const body = document.createElement("pre");
  body.className = "cm-changePeek-old";
  const old = change?.oldText.replace(TRAILING_NEWLINE, "") ?? "";
  body.textContent =
    change?.kind === "added" || old === ""
      ? "Nothing here before — reverting removes these lines."
      : old;
  dom.append(body);
  return dom;
}

/**
 * The gutter's click handler and the peek it opens. Pass `onMarkerClick` to
 * `gitGutter`; mount `changePeek` beside it.
 */
export function onMarkerClick(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos).number;
  const baseline = view.state.facet(headBaseline);
  if (baseline === null) {
    return false;
  }
  const found = changeAtLine(
    baseline,
    view.state.doc.toString(),
    line,
    view.state.doc
  );
  if (!found) {
    return false;
  }
  const current = view.state.field(peekField, false);
  view.dispatch({
    effects:
      current?.line === line
        ? closePeek.of(null)
        : openPeek.of({ line, pos: view.state.doc.line(line).from }),
  });
  return true;
}

/** The peek's field, its tooltip and Escape to close it. */
export const changePeek: Extension = [
  peekField,
  keymap.of([
    {
      key: "Escape",
      run: (view) => {
        if (!view.state.field(peekField, false)) {
          return false;
        }
        view.dispatch({ effects: closePeek.of(null) });
        return true;
      },
    },
  ]),
];

// --- the session highlight: lines changed since the session started --------

interface SessionMarks {
  decorations: DecorationSet;
  lines: ReadonlySet<number>;
}

const sessionLineDeco = Decoration.line({ class: "cm-sessionLine" });
const NO_SESSION_MARKS: SessionMarks = {
  decorations: Decoration.none,
  lines: new Set(),
};

function buildSessionMarks(doc: Text, changes: LineChanges): SessionMarks {
  const lines = new Set([...changes.added, ...changes.modified]);
  // The same ceiling the gutter keeps, for the same reason: one decoration
  // per line, built on the main thread.
  if (lines.size > MAX_GUTTER_CHANGED_LINES) {
    return NO_SESSION_MARKS;
  }
  const builder = new RangeSetBuilder<Decoration>();
  for (const line of [...lines].sort((a, b) => a - b)) {
    const { from } = doc.line(line);
    builder.add(from, from, sessionLineDeco);
  }
  return { decorations: builder.finish(), lines };
}

const sessionTracker = createDiffTracker<SessionMarks>({
  build: buildSessionMarks,
  empty: NO_SESSION_MARKS,
  map: (marks, tr) => ({
    decorations: marks.decorations.map(tr.changes),
    lines: marks.lines,
  }),
});

/**
 * Tints the lines that differ from the file as it was when the session
 * started — what changed during this session, by Claude or anyone, at line
 * precision. `sessionStart` is that version's text (`""` for a file the
 * session created, which tints every line).
 */
export function sessionHighlight(sessionStart: string): Extension {
  return [
    sessionTracker.extension(sessionStart),
    EditorView.decorations.compute(
      [sessionTracker.field],
      (state) => state.field(sessionTracker.field).decorations
    ),
  ];
}

/** The line numbers the session highlight currently marks. */
export function sessionLines(state: EditorState): ReadonlySet<number> {
  return (
    state.field(sessionTracker.field, false)?.lines ?? NO_SESSION_MARKS.lines
  );
}

// --- blame: who last touched the cursor's line ------------------------------

/**
 * The annotation for `line` (1-based): the session's own changes first —
 * that is the question a reviewer is asking — then git's answer. `undefined`
 * past the end of the blame (lines typed since it was fetched).
 */
export function blameText(
  blame: FileBlame,
  line: number,
  changedInSession: boolean,
  now: number
): string | undefined {
  const index = blame.lines[line - 1];
  const commit = index === undefined ? undefined : blame.commits[index];
  if (!commit) {
    return;
  }
  if (changedInSession) {
    return "Changed in this session";
  }
  if (commit.uncommitted) {
    return "Not committed yet";
  }
  const when = relativeTime(commit.authorTime * 1000, now);
  return `${commit.author}, ${when} · ${commit.summary}`;
}

class BlameNote extends WidgetType {
  readonly text: string;
  readonly title: string;

  constructor(text: string, title: string) {
    super();
    this.text = text;
    this.title = title;
  }

  override eq(other: BlameNote): boolean {
    return other.text === this.text && other.title === this.title;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-blameNote";
    span.textContent = this.text;
    span.title = this.title;
    return span;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

const blameFacet = Facet.define<FileBlame, FileBlame | null>({
  combine: (values) => (values.length > 0 ? values[0] : null),
});

function blameDecorations(state: EditorState): DecorationSet {
  const blame = state.facet(blameFacet);
  if (!blame) {
    return Decoration.none;
  }
  const line = state.doc.lineAt(state.selection.main.head);
  const text = blameText(
    blame,
    line.number,
    sessionLines(state).has(line.number),
    Date.now()
  );
  if (text === undefined) {
    return Decoration.none;
  }
  const index = blame.lines[line.number - 1];
  const commit = blame.commits[index];
  const title = commit.uncommitted
    ? "This line differs from what is committed."
    : `${commit.sha.slice(0, 8)} · ${commit.author} · ${new Date(commit.authorTime * 1000).toLocaleString()}\n${commit.summary}`;
  return Decoration.set([
    Decoration.widget({ side: 1, widget: new BlameNote(text, title) }).range(
      line.to
    ),
  ]);
}

const blamePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = blameDecorations(view.state);
    }

    update(update: ViewUpdate) {
      if (
        update.selectionSet ||
        update.docChanged ||
        update.startState.facet(blameFacet) !== update.state.facet(blameFacet)
      ) {
        this.decorations = blameDecorations(update.state);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

/**
 * A quiet note at the end of the cursor's line saying who last changed it,
 * when, and in which commit — the full id and date on hover. The caller
 * mounts it only while the buffer matches what was blamed: once the draft
 * moves, line numbers no longer line up with git's.
 */
export function blameAnnotation(blame: FileBlame): Extension {
  return [blameFacet.of(blame), blamePlugin];
}
