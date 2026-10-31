import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import type { FileBlame } from "../types.ts";
import {
  blameAnnotation,
  blameText,
  changeAtLine,
  changePeek,
  onMarkerClick,
  revertChangeAt,
  sessionHighlight,
  sessionLines,
} from "./editorGit.ts";
import { gitGutter } from "./gitGutter.ts";

describe("changeAtLine", () => {
  it("finds the change a modified line belongs to, with the old text", () => {
    const change = changeAtLine("a\nb\nc\n", "a\nB\nc\n", 2);
    expect(change?.oldText).toBe("b");
    expect(change?.kind).toBe("modified");
  });

  it("finds a deletion on the line it collapsed onto", () => {
    const change = changeAtLine("a\nb\nc\n", "a\nc\n", 2);
    expect(change?.kind).toBe("deleted");
    expect(change?.oldText).toBe("b\n");
  });

  it("returns nothing for an unchanged line", () => {
    expect(changeAtLine("a\nb\n", "a\nB\n", 1)).toBeUndefined();
  });
});

describe("revertChangeAt", () => {
  const views: EditorView[] = [];
  afterEach(() => {
    for (const v of views.splice(0)) {
      v.destroy();
    }
  });
  function view(doc: string): EditorView {
    const v = new EditorView({ state: EditorState.create({ doc }) });
    views.push(v);
    return v;
  }

  it("puts back just that change and leaves the rest of the edits alone", () => {
    const v = view("a\nB\nc\nD\n");
    expect(revertChangeAt(v, "a\nb\nc\nd\n", 2)).toBe(true);
    expect(v.state.doc.toString()).toBe("a\nb\nc\nD\n");
  });

  it("restores deleted lines", () => {
    const v = view("a\nc\n");
    revertChangeAt(v, "a\nb\nc\n", 2);
    expect(v.state.doc.toString()).toBe("a\nb\nc\n");
  });

  it("removes added lines", () => {
    const v = view("a\nnew\nb\n");
    revertChangeAt(v, "a\nb\n", 2);
    expect(v.state.doc.toString()).toBe("a\nb\n");
  });

  it("does nothing on an unchanged line", () => {
    const v = view("a\nb\n");
    expect(revertChangeAt(v, "a\nb\n", 1)).toBe(false);
  });
});

describe("the session highlight", () => {
  it("marks the lines that differ from the session's start", () => {
    const state = EditorState.create({
      doc: "alpha\ninserted by claude\nbeta\nreplaced entirely\n",
      extensions: sessionHighlight("alpha\nbeta\ngamma\n"),
    });
    expect([...sessionLines(state)].sort()).toEqual([2, 4]);
  });

  it("marks nothing without a session start to compare against", () => {
    const state = EditorState.create({ doc: "a\n" });
    expect(sessionLines(state).size).toBe(0);
  });
});

describe("blameText", () => {
  const blame: FileBlame = {
    commits: [
      {
        author: "Ada",
        authorTime: 1_700_000_000,
        sha: "1".repeat(40),
        summary: "Fix the thing",
        uncommitted: false,
      },
      {
        author: "Not Committed Yet",
        authorTime: 0,
        sha: "0".repeat(40),
        summary: "",
        uncommitted: true,
      },
    ],
    lines: [0, 1],
  };
  const now = (1_700_000_000 + 3 * 86_400) * 1000;

  it("names the author, how long ago, and the commit", () => {
    expect(blameText(blame, 1, false, now)).toBe(
      "Ada, 3 days ago · Fix the thing"
    );
  });

  it("says when a line is not committed yet", () => {
    expect(blameText(blame, 2, false, now)).toBe("Not committed yet");
  });

  it("says when a line changed in this session, ahead of git's answer", () => {
    expect(blameText(blame, 1, true, now)).toBe("Changed in this session");
  });

  it("says nothing past the end of the blame", () => {
    expect(blameText(blame, 9, false, now)).toBeUndefined();
  });
});

describe("the blame annotation", () => {
  it("shows on the cursor's line only", () => {
    const blame: FileBlame = {
      commits: [
        {
          author: "Ada",
          authorTime: 1_700_000_000,
          sha: "1".repeat(40),
          summary: "First",
          uncommitted: false,
        },
      ],
      lines: [0, 0],
    };
    const v = new EditorView({
      state: EditorState.create({
        doc: "one\ntwo",
        extensions: blameAnnotation(blame),
        selection: { anchor: 5 },
      }),
    });
    const notes = v.dom.querySelectorAll(".cm-blameNote");
    expect(notes).toHaveLength(1);
    expect(notes[0].closest(".cm-line")?.textContent).toContain("two");
    v.destroy();
  });
});

describe("the change peek", () => {
  const views: EditorView[] = [];
  afterEach(() => {
    for (const v of views.splice(0)) {
      v.destroy();
    }
  });

  function editor(doc: string, baseline: string) {
    const gutterSlot = new Compartment();
    const v = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc,
        extensions: [
          gutterSlot.of(gitGutter(baseline, onMarkerClick)),
          changePeek,
        ],
      }),
    });
    views.push(v);
    return { gutterSlot, v };
  }

  const peek = (v: EditorView) => v.dom.querySelector(".cm-changePeek");

  it("opens on a changed line, shows the old text, and a second click closes it", () => {
    const { v } = editor("a\nB\nc\n", "a\nb\nc\n");
    expect(onMarkerClick(v, v.state.doc.line(2).from)).toBe(true);
    expect(peek(v)?.textContent).toContain("b");
    onMarkerClick(v, v.state.doc.line(2).from);
    expect(peek(v)).toBeNull();
  });

  it("does nothing on an unchanged line", () => {
    const { v } = editor("a\nB\nc\n", "a\nb\nc\n");
    expect(onMarkerClick(v, v.state.doc.line(1).from)).toBe(false);
    expect(peek(v)).toBeNull();
  });

  it("Revert change puts the line back and closes the peek", () => {
    const { v } = editor("a\nB\nc\n", "a\nb\nc\n");
    onMarkerClick(v, v.state.doc.line(2).from);
    const revert = v.dom.querySelector<HTMLButtonElement>(
      ".cm-changePeek-revert"
    );
    revert?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(v.state.doc.toString()).toBe("a\nb\nc\n");
    expect(peek(v)).toBeNull();
  });

  it("Escape closes it", () => {
    const { v } = editor("a\nB\nc\n", "a\nb\nc\n");
    onMarkerClick(v, v.state.doc.line(2).from);
    v.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
    );
    expect(peek(v)).toBeNull();
  });

  it("closes when the last commit moves under it", () => {
    const { gutterSlot, v } = editor("a\nB\nc\n", "a\nb\nc\n");
    onMarkerClick(v, v.state.doc.line(2).from);
    v.dispatch({
      effects: gutterSlot.reconfigure(gitGutter("a\nB\nc\n", onMarkerClick)),
    });
    expect(peek(v)).toBeNull();
  });

  it("says a blank line was there when the change removed one", () => {
    const { v } = editor("a\nb\n", "a\n\nb\n");
    onMarkerClick(v, v.state.doc.line(2).from);
    expect(peek(v)?.textContent).toContain("A blank line was here.");
  });
});

describe("blame and the session highlight arriving apart", () => {
  it("the note switches to the session's answer when the highlight lands after blame", () => {
    const blame: FileBlame = {
      commits: [
        {
          author: "Ada",
          authorTime: 1_700_000_000,
          sha: "1".repeat(40),
          summary: "First",
          uncommitted: false,
        },
      ],
      lines: [0, 0],
    };
    const slot = new Compartment();
    const v = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "one\nchanged by claude",
        extensions: [slot.of(blameAnnotation(blame))],
        selection: { anchor: 6 },
      }),
    });
    expect(v.dom.querySelector(".cm-blameNote")?.textContent).toContain("Ada");

    v.dispatch({
      effects: slot.reconfigure([
        sessionHighlight("one\ntwo"),
        blameAnnotation(blame),
      ]),
    });

    expect(v.dom.querySelector(".cm-blameNote")?.textContent).toBe(
      "Changed in this session"
    );
    v.destroy();
  });
});
