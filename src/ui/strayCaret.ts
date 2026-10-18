/**
 * Drops the [Stray caret] — a collapsed selection sitting in non-editable page
 * content — because on macOS WebKit it costs a full-document scan on every
 * rendering update.
 *
 * Measured on the real app (macOS 26, WebKit 21624): the webview's main thread
 * spent 8621 of 8621 samples, ten captures running, in
 *
 *   RemoteLayerTreeDrawingArea::updateRendering
 *     WebPage::willCommitMainFrameData
 *       WebPage::editorState
 *         Editor::stringForCandidateRequest      <- macOS autocorrect candidates
 *           wordRangeFromPosition -> previousBoundary
 *             backwardSearchForBoundaryWithTextIterator
 *               findNextWordFromIndex -> -[NSAttributedString initWithString:]
 *
 * Three facts make that pathological here, all confirmed against WebKit source:
 *
 * 1. `getPlatformEditorState` calls `stringForCandidateRequest()` for ANY
 *    non-null selection. It is NOT gated on the selection being editable —
 *    `isContentEditable` only gates `canEnableAutomaticSpellingCorrection`.
 * 2. `previousBoundary` starts its backward word search at
 *    `Position::parentEditingBoundary()`, which for a non-editable anchor walks
 *    all the way up to `<html>`. The search therefore spans the whole document.
 * 3. `findNextWordFromIndex` wraps the accumulated buffer in a fresh
 *    `NSAttributedString` each time the search extends, making it quadratic in
 *    the text behind the caret.
 *
 * Kriyon is one document holding the terminal, the transcript and the diff
 * feed, so a caret left in that content froze the UI for as long as anything
 * kept repainting. Clicking into the composer ended it instantly — moving the
 * caret into a small editable bounds the search — which is the intervention
 * that confirmed this diagnosis.
 *
 * A collapsed caret outside an editable has no user value: you cannot type
 * there. Range selections are what copying needs, and they are always kept.
 */

/** The parts of a `Selection` this guard reasons about. */
export interface CaretProbe {
  anchorNode: Node | null;
  isCollapsed: boolean;
  rangeCount: number;
}

/**
 * True when `node` sits inside something the user can type into, so its caret
 * is real and bounded. Walks ancestors rather than checking `node` alone: the
 * composer's atomic chips are `contenteditable="false"` islands whose caret
 * still belongs to the editable composer around them.
 */
function isInsideEditable(node: Node | null): boolean {
  let element: Element | null =
    node instanceof Element ? node : (node?.parentElement ?? null);
  while (element) {
    // `isContentEditable` is an HTMLElement property; SVG and other non-HTML
    // elements are never editable hosts, so they fall through to the tag check.
    if (element instanceof HTMLElement && element.isContentEditable) {
      return true;
    }
    const tag = element.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      return true;
    }
    element = element.parentElement;
  }
  return false;
}

/**
 * True when a selection is a caret the user cannot use but WebKit will pay a
 * whole-document word search for on every frame. Kept deliberately narrow: no
 * selection at all is already free, and a range selection is the user copying.
 *
 * `focused` is the element that currently has focus, and it is not redundant
 * with the anchor. WebKit reports a text control's caret against the control's
 * PARENT rather than anything inside it: `DOMSelection::shadowAdjustedNode`
 * leaves the shadow inner editor and returns `host->parentNodeGuaranteedHostFree()`.
 * Measured in Safari 26 on `<div id="wrap"><input></div>` with the caret at
 * offset 2 of the field, `anchorNode` is `DIV#wrap`. So the anchor alone calls
 * a live typing caret stray, and clearing it destroys the field's insertion
 * point (`selectionStart` collapses to 0 while the field keeps focus) — the
 * caret vanishes and the next keystroke lands nowhere. A `contenteditable`
 * anchors inside itself and never hit this, which is why the composer typed
 * fine while every plain `<input>` in the app did not.
 *
 * Deferring to the focused element costs nothing the guard exists to save: a
 * caret inside a focused field is bounded by that field's inner editor, which
 * is the cheap case the original fix was steering toward.
 *
 * That deference is exactly as wide as the measurement and no wider: the anchor
 * must be the focused control's own parent. Anything looser lets the worst
 * caret in the app through. WebKit re-anchors a caret to an ancestor when the
 * node holding it is destroyed, and the terminal's helper textarea holds focus
 * while that happens — so "an ancestor of something editable" would keep a
 * caret sitting at the document root, scanning the whole tree every frame,
 * which is the precise failure this module exists to kill.
 *
 * Only text controls need this branch. A `contenteditable` anchors inside
 * itself, so `isInsideEditable(anchorNode)` below already spares it.
 */
export function isStrayCaret(
  probe: CaretProbe | null,
  focused: Element | null
): boolean {
  if (!probe || probe.rangeCount === 0 || !probe.isCollapsed) {
    return false;
  }
  if (isFieldCaret(focused, probe.anchorNode)) {
    return false;
  }
  return !isInsideEditable(probe.anchorNode);
}

/**
 * Whether `anchor` is where WebKit puts the caret of the focused text control:
 * the control's immediate parent, per `DOMSelection::shadowAdjustedNode`
 * returning `host->parentNodeGuaranteedHostFree()`.
 */
function isFieldCaret(focused: Element | null, anchor: Node | null): boolean {
  if (!(focused && anchor)) {
    return false;
  }
  const tag = focused.tagName;
  if (tag !== "INPUT" && tag !== "TEXTAREA") {
    return false;
  }
  return anchor === focused.parentNode;
}

/**
 * Clear stray carets for the lifetime of the app. Returns an uninstall function
 * (the `install*` idiom the other app-level listeners use).
 *
 * Clearing is deferred until the pointer is released. A drag-select starts as a
 * collapsed caret and only becomes a range as the pointer moves, so acting on
 * `selectionchange` mid-drag would cancel the user's selection as they made it.
 *
 * That deferral is the guard's only "off" state, so every way a drag can end
 * has to turn it back on. `pointerup` is the ordinary one; `pointercancel` (the
 * system took the gesture) and the window losing focus (released outside the
 * webview, so no `pointerup` ever reaches this document) are the two that
 * otherwise leave the guard disabled indefinitely — re-opening the freeze this
 * module exists to close.
 *
 * `read` is injected so the guard is testable without depending on jsdom's
 * partial Selection implementation.
 */
export function installStrayCaretGuard(
  doc: Document = document,
  read: () => Selection | null = () => doc.getSelection()
): () => void {
  let pointerDown = false;

  function clearIfStray(): void {
    const selection = read();
    if (selection && isStrayCaret(selection, doc.activeElement)) {
      // Re-entrancy is safe: this fires `selectionchange` again, and the next
      // pass sees rangeCount 0 and does nothing.
      selection.removeAllRanges();
    }
  }

  function onPointerDown(): void {
    pointerDown = true;
  }
  function onPointerUp(): void {
    pointerDown = false;
    clearIfStray();
  }
  // The window losing focus only re-arms the guard; it deliberately does not
  // clear. The user may be switching apps mid-drag, and dropping their
  // selection out from under them on the way out would be its own bug — the
  // next `selectionchange` or `pointerup` clears it if it really is stray.
  function onWindowBlur(): void {
    pointerDown = false;
  }
  function onSelectionChange(): void {
    if (!pointerDown) {
      clearIfStray();
    }
  }

  const view = doc.defaultView;
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("pointerup", onPointerUp, true);
  doc.addEventListener("pointercancel", onPointerUp, true);
  doc.addEventListener("selectionchange", onSelectionChange);
  view?.addEventListener("blur", onWindowBlur);

  return () => {
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("pointerup", onPointerUp, true);
    doc.removeEventListener("pointercancel", onPointerUp, true);
    doc.removeEventListener("selectionchange", onSelectionChange);
    view?.removeEventListener("blur", onWindowBlur);
  };
}
