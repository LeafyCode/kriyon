import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import type { FileBlame } from "../types.ts";
import {
  blameAnnotation,
  blameText,
  changeAtLine,
  revertChangeAt,
  sessionHighlight,
  sessionLines,
} from "./editorGit.ts";

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
