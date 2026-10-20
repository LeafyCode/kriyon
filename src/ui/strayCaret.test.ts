import { afterEach, describe, expect, it, vi } from "vitest";
import { installStrayCaretGuard, isStrayCaret } from "./strayCaret.ts";

function build(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("isStrayCaret", () => {
  it("is false with no selection at all — nothing to clear", () => {
    expect(isStrayCaret(null, null)).toBe(false);
    expect(
      isStrayCaret({ anchorNode: null, isCollapsed: true, rangeCount: 0 }, null)
    ).toBe(false);
  });

  it("is false for a real range selection — the user is selecting text to copy", () => {
    const host = build("<p>hello world</p>");
    expect(
      isStrayCaret(
        {
          anchorNode: host.firstChild?.firstChild ?? null,
          isCollapsed: false,
          rangeCount: 1,
        },
        null
      )
    ).toBe(false);
  });

  it("is false for a caret inside a contenteditable — that caret is what the user types with", () => {
    const host = build('<div contenteditable="true">draft</div>');
    const editable = host.firstElementChild as HTMLElement;
    // jsdom does not derive isContentEditable from the attribute.
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(
      isStrayCaret(
        {
          anchorNode: editable.firstChild,
          isCollapsed: true,
          rangeCount: 1,
        },
        editable
      )
    ).toBe(false);
  });

  it("is false inside an atomic chip nested in the composer — the editable ancestor still owns the caret", () => {
    const host = build(
      '<div contenteditable="true">a<span contenteditable="false">/cmd</span></div>'
    );
    const editable = host.firstElementChild as HTMLElement;
    const chip = editable.querySelector("span") as HTMLElement;
    Object.defineProperty(editable, "isContentEditable", { value: true });
    Object.defineProperty(chip, "isContentEditable", { value: false });
    expect(
      isStrayCaret(
        {
          anchorNode: chip.firstChild,
          isCollapsed: true,
          rangeCount: 1,
        },
        editable
      )
    ).toBe(false);
  });

  it("is true for a collapsed caret in ordinary non-editable content", () => {
    const host = build("<p>a diff line</p>");
    expect(
      isStrayCaret(
        {
          anchorNode: host.firstChild?.firstChild ?? null,
          isCollapsed: true,
          rangeCount: 1,
        },
        null
      )
    ).toBe(true);
  });

  it("is false for the caret of a focused text field, which WebKit anchors OUTSIDE the field", () => {
    // Measured in Safari 26 on `<div id="wrap"><input></div>` with the caret at
    // offset 2 of the field: `anchorNode` is `DIV#wrap`, the field's parent.
    // Judging that anchor alone calls a live typing caret stray.
    const host = build(
      '<div id="wrap"><input type="text" value="hello"></div>'
    );
    const wrap = host.firstElementChild as HTMLElement;
    const field = wrap.querySelector("input") as HTMLInputElement;
    expect(
      isStrayCaret(
        { anchorNode: wrap, isCollapsed: true, rangeCount: 1 },
        field
      )
    ).toBe(false);
  });

  it("is false for the caret of a focused textarea, anchored outside it the same way", () => {
    const host = build('<div id="wrap"><textarea>draft</textarea></div>');
    const wrap = host.firstElementChild as HTMLElement;
    const field = wrap.querySelector("textarea") as HTMLTextAreaElement;
    expect(
      isStrayCaret(
        { anchorNode: wrap, isCollapsed: true, rangeCount: 1 },
        field
      )
    ).toBe(false);
  });

  it("is still true when the focused editable is nowhere near the caret", () => {
    // The terminal's helper textarea holds focus almost all the time. A caret
    // stranded out in the transcript while it does is exactly the whole-document
    // scan this guard exists to kill, so "something editable has focus" is not
    // on its own a reason to keep the caret.
    const host = build(
      '<div id="term"><textarea></textarea></div><p id="feed">a diff line</p>'
    );
    const field = host.querySelector("textarea") as HTMLTextAreaElement;
    const feed = host.querySelector("#feed") as HTMLElement;
    expect(
      isStrayCaret(
        { anchorNode: feed.firstChild, isCollapsed: true, rangeCount: 1 },
        field
      )
    ).toBe(true);
  });

  it("is still true when the caret re-anchors ABOVE the focused field", () => {
    // The case that matters most: WebKit re-anchors a caret to an ancestor when
    // the node holding it is destroyed, and the terminal's textarea holds focus
    // while that happens. An ancestor of the focused field is NOT the parent
    // WebKit uses for a live field caret, so it must stay stray — otherwise the
    // worst caret in the app (anchored at the root, scanning everything) is the
    // one the guard lets through.
    const host = build('<div id="pane"><textarea></textarea></div>');
    const pane = host.firstElementChild as HTMLElement;
    const field = pane.querySelector("textarea") as HTMLTextAreaElement;
    expect(
      isStrayCaret(
        { anchorNode: host, isCollapsed: true, rangeCount: 1 },
        field
      )
    ).toBe(true);
    expect(
      isStrayCaret(
        { anchorNode: document.body, isCollapsed: true, rangeCount: 1 },
        field
      )
    ).toBe(true);
  });

  it("is false for an empty focused contenteditable, whose caret anchors on itself", () => {
    const host = build('<div contenteditable="true"></div>');
    const editable = host.firstElementChild as HTMLElement;
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(
      isStrayCaret(
        { anchorNode: editable, isCollapsed: true, rangeCount: 1 },
        editable
      )
    ).toBe(false);
  });

  it("is still true when the same anchor has nothing editable focused", () => {
    const host = build(
      '<div id="wrap"><input type="text" value="hello"></div>'
    );
    const wrap = host.firstElementChild as HTMLElement;
    expect(
      isStrayCaret({ anchorNode: wrap, isCollapsed: true, rangeCount: 1 }, null)
    ).toBe(true);
  });
});

describe("installStrayCaretGuard", () => {
  function fakeSelection(overrides: Partial<Selection> = {}) {
    return {
      anchorNode: document.body.firstChild,
      isCollapsed: true,
      rangeCount: 1,
      removeAllRanges: vi.fn(),
      ...overrides,
    } as unknown as Selection & { removeAllRanges: ReturnType<typeof vi.fn> };
  }

  it("clears a stray caret once the pointer is released", () => {
    build("<p>plain text</p>");
    const selection = fakeSelection();
    const stop = installStrayCaretGuard(document, () => selection);

    document.dispatchEvent(new Event("pointerdown"));
    document.dispatchEvent(new Event("pointerup"));

    expect(selection.removeAllRanges).toHaveBeenCalledTimes(1);
    stop();
  });

  it("leaves the selection alone while the pointer is still down — a drag-select passes through collapsed states", () => {
    build("<p>plain text</p>");
    const selection = fakeSelection();
    const stop = installStrayCaretGuard(document, () => selection);

    document.dispatchEvent(new Event("pointerdown"));
    document.dispatchEvent(new Event("selectionchange"));

    expect(selection.removeAllRanges).not.toHaveBeenCalled();
    stop();
  });

  it("keeps a range selection made by dragging", () => {
    build("<p>plain text</p>");
    const selection = fakeSelection({ isCollapsed: false });
    const stop = installStrayCaretGuard(document, () => selection);

    document.dispatchEvent(new Event("pointerdown"));
    document.dispatchEvent(new Event("pointerup"));

    expect(selection.removeAllRanges).not.toHaveBeenCalled();
    stop();
  });

  it("re-arms after a cancelled pointer sequence", () => {
    build("<p>plain text</p>");
    const selection = fakeSelection();
    const stop = installStrayCaretGuard(document, () => selection);

    document.dispatchEvent(new Event("pointerdown"));
    document.dispatchEvent(new Event("pointercancel"));
    document.dispatchEvent(new Event("selectionchange"));

    expect(selection.removeAllRanges).toHaveBeenCalled();
    stop();
  });

  it("re-arms when the pointer is released outside the window", () => {
    build("<p>plain text</p>");
    const selection = fakeSelection();
    const stop = installStrayCaretGuard(document, () => selection);

    // No `pointerup` ever reaches the document: the drag ended off-window.
    document.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("blur"));
    document.dispatchEvent(new Event("selectionchange"));

    expect(selection.removeAllRanges).toHaveBeenCalled();
    stop();
  });

  it("clears a stray caret placed without any pointer at all", () => {
    build("<p>plain text</p>");
    const selection = fakeSelection();
    const stop = installStrayCaretGuard(document, () => selection);

    document.dispatchEvent(new Event("selectionchange"));

    expect(selection.removeAllRanges).toHaveBeenCalledTimes(1);
    stop();
  });

  it("never clears while a text field has focus — that caret is the one being typed with", () => {
    const host = build(
      '<div id="wrap"><input type="text" value="hello"></div>'
    );
    const wrap = host.firstElementChild as HTMLElement;
    const field = wrap.querySelector("input") as HTMLInputElement;
    field.focus();
    // WebKit anchors the field's caret at the field's parent, not inside it.
    const selection = fakeSelection({ anchorNode: wrap });
    const stop = installStrayCaretGuard(document, () => selection);

    // Every keystroke and caret move in a field fires `selectionchange`.
    document.dispatchEvent(new Event("selectionchange"));
    document.dispatchEvent(new Event("pointerdown"));
    document.dispatchEvent(new Event("pointerup"));

    expect(selection.removeAllRanges).not.toHaveBeenCalled();
    stop();
  });

  it("reads focus live, not once at install time", () => {
    const host = build(
      '<div id="wrap"><input type="text" value="hello"></div>'
    );
    const wrap = host.firstElementChild as HTMLElement;
    const field = wrap.querySelector("input") as HTMLInputElement;
    const selection = fakeSelection({ anchorNode: wrap });
    // Installed while nothing is focused; the field takes focus afterwards.
    const stop = installStrayCaretGuard(document, () => selection);
    field.focus();

    document.dispatchEvent(new Event("selectionchange"));

    expect(selection.removeAllRanges).not.toHaveBeenCalled();
    stop();
  });

  it("resumes clearing once the field gives up focus", () => {
    const host = build(
      '<div id="wrap"><input type="text" value="hello"></div>'
    );
    const wrap = host.firstElementChild as HTMLElement;
    const field = wrap.querySelector("input") as HTMLInputElement;
    field.focus();
    const selection = fakeSelection({ anchorNode: wrap });
    const stop = installStrayCaretGuard(document, () => selection);

    field.blur();
    document.dispatchEvent(new Event("selectionchange"));

    expect(selection.removeAllRanges).toHaveBeenCalled();
    stop();
  });

  it("stops acting once uninstalled", () => {
    build("<p>plain text</p>");
    const selection = fakeSelection();
    const stop = installStrayCaretGuard(document, () => selection);
    stop();

    document.dispatchEvent(new Event("pointerup"));

    expect(selection.removeAllRanges).not.toHaveBeenCalled();
  });
});
