import {
  BookMarked,
  ChevronDown,
  ChevronUp,
  Paperclip,
  Square,
} from "lucide-react";
import type {
  ClipboardEvent,
  CSSProperties,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CompletionPopover } from "../completion/CompletionPopover.tsx";
import type { ChipKind } from "../completion/chipModel.ts";
import {
  buildFragment,
  caretOffsetInValue,
  locateRange,
  makeChip,
  serializeEditable,
} from "../completion/chipModel.ts";
import { useCompletion } from "../completion/useCompletion.ts";
import { type Attachment, promptHistory } from "../ipc/bridge.ts";
import { useAttachments } from "../state/attachments.ts";
import { useDrafts } from "../state/drafts.ts";
import { type TranscriptView, useLayout } from "../state/layout.ts";
import { useSentPrompts } from "../state/sentPrompts.ts";
import { sessionWorkingDir, useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import { sessionUsageView } from "../state/usage.ts";
import { useUsageCards } from "../state/usageCards.ts";
import { useActiveSession } from "../state/useActiveSession.ts";
import { useCliDialog } from "../structured/cliDialog.ts";
import { interruptSession } from "../structured/interrupt.ts";
import { sendPrompt } from "../structured/send.ts";
import { isUsageCommand } from "../structured/usageRules.ts";
import { button, card, chip } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { Kbd } from "../ui/Kbd.tsx";
import { showToast } from "../ui/Toast.tsx";
import { AttachmentTray } from "./AttachmentTray.tsx";
import { type FooterFit, FULL_FIT, footerFit } from "./composerFooterFit.ts";
import {
  type HistoryCursor,
  onFirstLine,
  onLastLine,
  START,
  stepHistory,
} from "./promptHistory.ts";
import { useAttachmentIntake } from "./useAttachmentIntake.ts";

const wrapStyle: CSSProperties = {
  flex: "0 0 auto",
  padding: "8px 24px 20px",
};

/**
 * The collapsible drawer around the composer. The 1fr→0fr grid row is the one
 * CSS way to animate shut a box of unknown height (the textarea autosizes);
 * `visibility` rides the same transition so the hidden composer leaves the
 * tab order without popping out mid-slide.
 */
function drawerStyle(hidden: boolean): CSSProperties {
  return {
    display: "grid",
    gridTemplateRows: hidden ? "0fr" : "1fr",
    transition: `grid-template-rows ${tokens.motion.panel}, visibility ${tokens.motion.panel}`,
    visibility: hidden ? "hidden" : "visible",
  };
}

const drawerInnerStyle: CSSProperties = {
  minHeight: 0,
  overflow: "hidden",
};

/** The slim strip left behind when the composer is hidden. */
const revealStripStyle: CSSProperties = {
  display: "flex",
  flex: "0 0 auto",
  justifyContent: "center",
  padding: "4px 0 9px",
};

const revealButtonStyle: CSSProperties = {
  ...button("secondary", "sm"),
  borderRadius: tokens.radius.pill,
  fontSize: "11px",
  height: "22px",
};

/**
 * The composer card. A card, not a popover: flat fill, hairline border, no
 * shadow. The focus ring is a border-colour step (`.kr-composer-box` in
 * `App.css`) rather than a glow — the canvas lifts the border to `#323b4e`
 * and leaves everything else alone.
 */
const boxStyle: CSSProperties = {
  ...card(),
  padding: "12px 14px 8px",
  position: "relative",
};

/** The chip editor itself: an uncontrolled contentEditable that autosizes
 * (contentEditable grows with its content, so no manual scrollHeight dance is
 * needed the way the old textarea required). */
const editableStyle: CSSProperties = {
  boxSizing: "border-box",
  color: tokens.color.ink.primary,
  fontFamily: tokens.font.sans,
  fontSize: "13px",
  letterSpacing: "normal",
  lineHeight: 1.5,
  maxHeight: "180px",
  minHeight: "24px",
  outline: "none",
  overflowWrap: "anywhere",
  overflowY: "auto",
  whiteSpace: "pre-wrap",
};

/** Positioned to overlap the editable's own text start; shown only while the
 * draft is empty (a plain React overlay, not global CSS `::before` — the
 * editable's content is managed imperutively so we can't rely on the DOM
 * having a stable empty state to hang a CSS placeholder off of). */
const placeholderStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  fontFamily: tokens.font.sans,
  fontSize: "13px",
  inset: 0,
  lineHeight: 1.5,
  pointerEvents: "none",
  position: "absolute",
};

/**
 * A chip's shape — roomy and gapped now that it's a real inline element the
 * caret flows around, not a zero-width tint under transparent text. Only
 * `background`/`color` vary per {@link ChipKind}.
 */
function chipStyle(kind: ChipKind): CSSProperties {
  const { bg, fg } = tokens.color.pill[kind];
  return {
    background: bg,
    borderRadius: tokens.radius.sm,
    color: fg,
    fontFamily: tokens.font.sans,
    margin: "0 2px",
    padding: "1px 7px",
    userSelect: "none",
    whiteSpace: "nowrap",
  };
}

const editableContainerStyle: CSSProperties = {
  position: "relative",
};

const footerStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: "16px",
  justifyContent: "space-between",
  marginTop: "9px",
};

// Nothing in the footer wraps. The left group may shrink (and, past the last
// step `footerFit` takes, clip); the right one, with Stop and Send, never
// does, so they stay in the box at any width.
const footerLeftStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: "9px",
  minWidth: 0,
  overflow: "hidden",
  whiteSpace: "nowrap",
};

const footerRightStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flex: "none",
  gap: "7px",
  whiteSpace: "nowrap",
};

const modelChipStyle: CSSProperties = chip();

const modeChipStyle: CSSProperties = {
  ...chip(),
  fontSize: "11px",
  height: "20px",
  padding: "0 8px",
  pointerEvents: "none",
  position: "absolute",
  right: "8px",
  top: "8px",
};

const metaStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "11px",
};

const footerActionStyle: CSSProperties = {
  ...button("ghost", "sm"),
  flex: "none",
  padding: "0 7px",
};

const footerActionDisabledStyle: CSSProperties = {
  ...footerActionStyle,
  color: tokens.color.ink.faint,
  cursor: "default",
  opacity: 0.5,
};

const sendStyle: CSSProperties = button("primary");

const sendDisabledStyle: CSSProperties = {
  ...sendStyle,
  background: tokens.color.surface.s3,
  color: tokens.color.ink.faint,
  cursor: "default",
};

const NO_ATTACHMENTS: Attachment[] = [];

/** The footer's left side: attach, the Session chip, the usage readout,
 *  Save prompt and Prompts, each as much of it as `fit` has room for. */
function FooterTools({
  fit,
  onAttach,
  usageLabel,
  value,
}: {
  fit: FooterFit;
  onAttach: () => void;
  usageLabel: string | null;
  value: string;
}) {
  const empty = value.trim().length === 0;
  return (
    <span style={footerLeftStyle}>
      <button
        aria-label="Attach files"
        className="kr-hover-surface"
        onClick={onAttach}
        style={footerActionStyle}
        title="Attach files or images (or paste, or drop them here)"
        type="button"
      >
        <Paperclip size={13} />
      </button>
      {fit.session ? (
        <span style={modelChipStyle}>
          Session
          <ChevronDown size={10} style={{ color: tokens.color.ink.faint }} />
        </span>
      ) : null}
      {usageLabel && fit.usage ? (
        <span style={metaStyle}>{usageLabel}</span>
      ) : null}
      <button
        aria-label="Save as prompt"
        className="kr-hover-surface"
        disabled={empty}
        onClick={() =>
          useUi.getState().openPromptEditor({
            body: value,
            tags: [],
            title: value.split("\n")[0].slice(0, 60),
          })
        }
        style={empty ? footerActionDisabledStyle : footerActionStyle}
        title={
          empty
            ? "Type a message to save it as a prompt"
            : "Save this message as a prompt"
        }
        type="button"
      >
        {fit.saveLabel ? "✦ Save prompt" : "✦"}
      </button>
      <button
        aria-label="Open prompt library"
        className="kr-hover-surface"
        onClick={() => useUi.getState().openPromptPicker()}
        style={footerActionStyle}
        title="Open prompt library (⌘⇧P)"
        type="button"
      >
        {fit.promptsLabel ? "Prompts" : <BookMarked size={13} />}
        {fit.promptsKey ? <Kbd>⌘⇧P</Kbd> : null}
      </button>
    </span>
  );
}

/** The element's width as it resizes; `null` until it has been laid out. */
function useWidth(ref: { current: HTMLElement | null }): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      let next = 0;
      for (const entry of entries) {
        next = entry.contentRect.width;
      }
      // A box not laid out yet (or a test's DOM) measures 0: not a width.
      setWidth(next > 0 ? next : null);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** How long after a send the history is read again: the CLI records the
 *  prompt as it takes it. */
const HISTORY_REFRESH_MS = 1500;

/** The composer box while files are dragged over the window. */
const dropStyle: CSSProperties = {
  borderColor: tokens.color.accent,
  borderStyle: "dashed",
};

const dropLabelStyle: CSSProperties = {
  alignItems: "center",
  background: tokens.color.chrome.content,
  borderRadius: tokens.radius.lg,
  color: tokens.color.accentBright,
  display: "flex",
  fontSize: "13px",
  fontWeight: 600,
  inset: 0,
  justifyContent: "center",
  opacity: 0.94,
  pointerEvents: "none",
  position: "absolute",
  zIndex: 1,
};

/** Apply {@link chipStyle} to a chip built by `chipModel.ts`'s helpers (which
 * intentionally leave styling to the caller — they're pure DOM structure). */
function styleChip(chip: Element): void {
  const kind = chip.getAttribute("data-kind") as ChipKind | null;
  if (kind && chip instanceof HTMLElement) {
    Object.assign(chip.style, chipStyle(kind));
  }
}

/** The mode-chip kind a leading character puts the composer into, or `null`
 * for anything else — mirrors {@link import("../completion/detect.ts").detectTrigger}'s
 * `startsWith("!")`/`startsWith("#")` checks. */
function leadingModeKind(char: string | undefined): ChipKind | null {
  if (char === "!") {
    return "bash";
  }
  if (char === "#") {
    return "memory";
  }
  return null;
}

/** True when `el`'s first child is already the atomic mode chip for `kind` —
 * the signal that this leading `!`/`#` was already converted, so live
 * conversion should no-op instead of re-splitting an already-atomic chip. */
function hasLeadingModeChip(el: HTMLDivElement, kind: ChipKind): boolean {
  const first = el.firstChild;
  return (
    first instanceof Element &&
    first.hasAttribute("data-chip") &&
    first.getAttribute("data-kind") === kind
  );
}

/**
 * Convert a freshly-typed leading `!`/`#` into an atomic mode chip in place,
 * the instant it becomes the first character (Claude parity). Surgical: only
 * the leading character moves from a text node into a chip — every other
 * node in the editable is untouched, so the caret stays stable except for the
 * one case where it sat right after the converted character (restored to sit
 * right after the new chip instead). No-ops once the chip already exists, so
 * this only ever fires once per leading `!`/`#`.
 */
function convertLeadingModeChar(el: HTMLDivElement, value: string): void {
  const kind = leadingModeKind(value[0]);
  const first = el.firstChild;
  if (!kind || hasLeadingModeChip(el, kind) || !first) {
    return;
  }
  if (first.nodeType !== Node.TEXT_NODE) {
    return;
  }
  const sel = window.getSelection();
  const caretRightAfterChar =
    !!sel?.isCollapsed && sel.focusNode === first && sel.focusOffset === 1;

  const leadingText = first as Text;
  leadingText.splitText(1); // leadingText now holds just the `!`/`#`; the rest is its new next sibling
  const chip = makeChip(el.ownerDocument, kind, leadingText.data);
  styleChip(chip);
  leadingText.replaceWith(chip);

  if (caretRightAfterChar) {
    placeCaretAtOffset(el, value, 1);
  }
}

/** {@link buildFragment}, with every chip it produced given its visual style. */
function styledFragment(doc: Document, value: string): DocumentFragment {
  const fragment = buildFragment(doc, value);
  for (const chip of Array.from(fragment.querySelectorAll("[data-chip]"))) {
    styleChip(chip);
  }
  return fragment;
}

/** Slash-triggered completions are always commands; mention-triggered ones
 * are either an `@agent-x` agent mention or a plain file mention. */
function chipKindFor(
  triggerKind: "slash" | "mention" | null,
  token: string
): ChipKind {
  if (triggerKind === "slash") {
    return "command";
  }
  return token.startsWith("@agent-") ? "agent" : "mention";
}

/** Move the DOM selection to the linear offset `pos` within `value`. Falls
 * back to the end (or start, for an empty value) of the editable when `pos`
 * doesn't land inside a single text node — e.g. a draft that's nothing but a
 * chip with no trailing text. */
function placeCaretAtOffset(
  el: HTMLDivElement,
  value: string,
  pos: number
): void {
  const sel = window.getSelection();
  if (!sel) {
    return;
  }
  const range = el.ownerDocument.createRange();
  const loc = locateRange(el, value, pos, pos);
  if (loc) {
    range.setStart(loc.startNode, loc.startOffset);
    range.setEnd(loc.startNode, loc.startOffset);
  } else {
    range.selectNodeContents(el);
    range.collapse(pos <= 0);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Whether the composer currently holds the document's selection — it has
 * focus, or the caret/range is anchored somewhere inside it. Clearing the
 * editable destroys whatever node the caret sat on, so this decides whether
 * putting a caret back is restoring the user's own (yes) or seizing a
 * selection they made somewhere else, like a diff line (no). */
function ownsSelection(el: HTMLElement): boolean {
  if (el.ownerDocument.activeElement === el) {
    return true;
  }
  const anchor = el.ownerDocument.getSelection()?.anchorNode ?? null;
  return anchor !== null && el.contains(anchor);
}

/** Rebuild the editable's content from a plain draft string and restore the
 * caret. This is the only DOM-rebuilding path — every other keystroke is
 * handled imperatively in place so React never fights the caret. Called on
 * mount, on an active-session change, and after an external draft splice
 * (prompt-picker insert). */
function renderFromValue(
  el: HTMLDivElement,
  text: string,
  caretPos: number,
  placeCaret = true
): void {
  el.replaceChildren(styledFragment(el.ownerDocument, text));
  if (placeCaret) {
    placeCaretAtOffset(el, text, caretPos);
  }
}

/**
 * The composer. Kriyon hosts the real `claude` CLI in the session's pty, so
 * sending writes the text to that session's stdin — the same as typing it into
 * the terminal — then submits with a separate Enter (`structured/send.ts`,
 * `kriyon_core::attachment::keystrokes`).
 */
export interface PromptBarProps {
  /**
   * Render nothing on screen while staying mounted. The Changes tab and a
   * maximized terminal dock both want the composer gone; neither may UNMOUNT
   * it. The Prompt-picker mailbox in `useDrafts` is a one-shot slot that only a
   * mounted PromptBar drains, so an unmounted composer turns an accepted prompt
   * into a request that waits, then splices itself into the draft on some
   * later, unrelated visit — while the picker has already toasted "Inserted".
   * Staying mounted makes that impossible by construction, instead of asking
   * every caller that hides the composer to remember to undo itself.
   */
  suppressed?: boolean;
}

/** Whether Kriyon answers this message itself: `/usage` (or `/cost`) on its
 *  own in the Structured view, as a [Usage card] instead of Claude's pane over
 *  it (ADR-0041). The Raw view keeps the CLI's. */
function answeredHere(
  view: TranscriptView,
  text: string,
  attachments: number
): boolean {
  return view === "structured" && attachments === 0 && isUsageCommand(text);
}

/** The slash menu's tag for a command Kriyon answers itself. Module-level,
 *  so its identity is stable across renders. */
function usageTag(command: string): string | undefined {
  return isUsageCommand(command) ? "Opens here" : undefined;
}

/** The slash menu's tags in `view`: only the Structured view answers any. */
function slashTags(
  view: TranscriptView
): ((command: string) => string | undefined) | undefined {
  return view === "structured" ? usageTag : undefined;
}

export function PromptBar({ suppressed = false }: PromptBarProps) {
  const hidden = useLayout((state) => state.layout.composerCollapsed);
  const toggleHidden = useLayout((state) => state.toggleComposerCollapsed);
  const activeSessionId = useSessions((state) => state.activeSessionId);
  const live = useSessions((state) =>
    activeSessionId ? state.usage[activeSessionId] : undefined
  );
  const value = useDrafts((state) =>
    activeSessionId ? (state.drafts[activeSessionId] ?? "") : ""
  );
  const setDraft = useDrafts((state) => state.setDraft);
  const insertRequest = useDrafts((state) => state.insertRequest);
  const editableRef = useRef<HTMLDivElement>(null);
  const editableBoxRef = useRef<HTMLDivElement>(null);
  const revealRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  // True while an IME composition is in flight. Guards two things: onKeyDown
  // must not treat the composition-confirming Enter as send/accept, and
  // onInput must not mutate the DOM (convertLeadingModeChar) out from under the
  // IME. Reset on compositionend, where we then run the deferred sync.
  const composingRef = useRef(false);
  const prevHidden = useRef(hidden);

  const attachments = useAttachments((state) =>
    activeSessionId
      ? (state.bySession[activeSessionId] ?? NO_ATTACHMENTS)
      : NO_ATTACHMENTS
  );
  const running = useSessions((state) =>
    activeSessionId
      ? state.sessions[activeSessionId]?.status === "running"
      : false
  );
  const pendingSent = useSentPrompts((state) =>
    activeSessionId ? state.sent[activeSessionId] !== undefined : false
  );
  // A message typed into Claude Code's open dialog would land as its keys.
  const inDialog = useCliDialog(activeSessionId);
  const transcriptView = useLayout((state) => state.layout.transcriptView);
  const intake = useAttachmentIntake(activeSessionId, !(suppressed || hidden));

  const { session } = useActiveSession();
  const cwd = session ? sessionWorkingDir(session) : null;
  // The [Prompt history] Up/Down walks, read when the session (or a send)
  // changes it, so a key press never waits on the backend.
  const historyRef = useRef<string[]>([]);
  const historyCursorRef = useRef<HistoryCursor>(START);
  const [historyStamp, setHistoryStamp] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `historyStamp` is the signal that a send added to the history.
  useEffect(() => {
    historyCursorRef.current = START;
    if (!cwd) {
      historyRef.current = [];
      return;
    }
    let alive = true;
    promptHistory(cwd)
      .then((entries) => {
        if (alive) {
          historyRef.current = entries;
        }
      })
      .catch(() => {
        // No history is an empty walk, never a broken composer.
      });
    return () => {
      alive = false;
    };
  }, [cwd, historyStamp]);
  const [caret, setCaret] = useState(0);
  const { view, move, reset, itemAt } = useCompletion({
    caret,
    cwd,
    tagFor: slashTags(transcriptView),
    value,
  });

  // The editable is uncontrolled, so the live DOM selection — not a React
  // value prop — is the only source of truth for where the caret sits. Mirror
  // it into `caret` state, the signal `useCompletion` reparses on every
  // keystroke/click.
  function syncFromDom(): void {
    const el = editableRef.current;
    const sel = window.getSelection();
    if (
      !(el && sel?.isCollapsed && sel.focusNode && el.contains(sel.focusNode))
    ) {
      return;
    }
    setCaret(caretOffsetInValue(el, sel.focusNode, sel.focusOffset));
  }

  // A fresh session's draft has its own text; render it into the (uncontrolled)
  // editable and reset the caret to its end. A stale caret left over from the
  // previous session could otherwise get re-parsed as a completion trigger
  // against the new draft for one interaction.
  //
  // Placing that caret is gated on `ownsSelection` for the same reason `send`
  // is: this runs on every mount, and since the Changes view stopped rendering
  // a composer, "every mount" includes every trip back from it. Ungated, it
  // reaches out and takes whatever selection the user had — a diff line, or the
  // terminal's own caret, which in WebKit is destroyed by the taking. The
  // `caret` state still resets either way; that is what the stale-trigger case
  // above actually needs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value is read only to seed this render, not to re-run on every draft edit
  useEffect(() => {
    const el = editableRef.current;
    if (el) {
      renderFromValue(el, value, value.length, ownsSelection(el));
    }
    setCaret(value.length);
  }, [activeSessionId]);

  // Unmounting destroys the node the caret sits on. WebKit re-anchors that
  // caret onto an ancestor rather than dropping it, and a caret out in ordinary
  // content costs a whole-document word scan every frame (see ui/strayCaret.ts)
  // — so hand it back rather than leaving one behind on the way out.
  // A layout effect, not a passive one: its cleanup has to run while the editor
  // is still mounted and its ref still set, so `ownsSelection` can tell whether
  // the caret is ours to clear. Passive cleanup runs after React has detached
  // both, by which point the answer is unknowable.
  useLayoutEffect(
    () => () => {
      const el = editableRef.current;
      if (el && ownsSelection(el)) {
        el.ownerDocument.getSelection()?.removeAllRanges();
      }
    },
    []
  );

  // Hiding puts keyboard focus inside an aria-hidden subtree and showing
  // unmounts the reveal strip under the focused button — hand focus to the
  // surviving control on each toggle instead of dropping it to <body>.
  useEffect(() => {
    if (prevHidden.current === hidden) {
      return;
    }
    prevHidden.current = hidden;
    if (hidden) {
      revealRef.current?.focus();
    } else {
      editableRef.current?.focus();
    }
  }, [hidden]);

  const trimmed = value.trim();
  const canSend =
    (trimmed.length > 0 || attachments.length > 0) && activeSessionId !== null;
  // Claude is on a turn (or about to be): Esc and Stop interrupt it.
  const canStop = running || pendingSent;

  // Same [Session usage view] the inspector reads, so the composer's ctx% can
  // never diverge from the inspector's for one session.
  const usageLabel = sessionUsageView(live).label;
  const footerWidth = useWidth(footerRef);
  const fit =
    footerWidth === null
      ? FULL_FIT
      : footerFit(footerWidth, { stop: canStop, usage: usageLabel });

  // Re-serialize the (uncontrolled) editable into the draft on every
  // keystroke, then resync the completion popover's caret from the fresh DOM
  // selection.
  function handleInput(): void {
    const el = editableRef.current;
    if (!(el && activeSessionId)) {
      return;
    }
    const value = serializeEditable(el);
    // Never split/replace the live text node while the IME is mid-composition —
    // that aborts or garbles the composition. Defer the conversion to
    // compositionend (which calls handleInput again with composing cleared).
    if (!composingRef.current) {
      convertLeadingModeChar(el, value);
    }
    setDraft(activeSessionId, value);
    // Typing makes the shown text the user's own: a walk starts over from it.
    historyCursorRef.current = START;
    syncFromDom();
  }

  // Up on the first line and Down on the last walk the [Prompt history], the
  // CLI's way. Returns whether it took the key.
  function walkHistory(event: KeyboardEvent<HTMLDivElement>): boolean {
    const el = editableRef.current;
    const dir = event.key === "ArrowUp" ? 1 : -1;
    const sel = window.getSelection();
    if (
      !(el && activeSessionId && sel?.isCollapsed && sel.focusNode) ||
      event.shiftKey ||
      event.altKey ||
      event.metaKey
    ) {
      return false;
    }
    const text = serializeEditable(el);
    const at = caretOffsetInValue(el, sel.focusNode, sel.focusOffset);
    if (dir === 1 ? !onFirstLine(text, at) : !onLastLine(text, at)) {
      return false;
    }
    const next = stepHistory(
      historyCursorRef.current,
      historyRef.current,
      dir,
      text
    );
    if (next === null) {
      return false;
    }
    event.preventDefault();
    historyCursorRef.current = next.cursor;
    renderFromValue(el, next.text, next.text.length);
    setDraft(activeSessionId, next.text);
    setCaret(next.text.length);
    return true;
  }

  // IME composition brackets: suppress key/DOM handling in between, then run the
  // deferred sync once the composed text has settled.
  function onCompositionStart(): void {
    composingRef.current = true;
  }
  function onCompositionEnd(): void {
    composingRef.current = false;
    handleInput();
  }

  function send(): void {
    if (!(canSend && activeSessionId)) {
      return;
    }
    if (answeredHere(transcriptView, trimmed, attachments.length)) {
      useUsageCards
        .getState()
        .show(activeSessionId, { at: Date.now(), command: trimmed });
      clearComposer(activeSessionId);
      return;
    }
    if (inDialog) {
      showToast(
        "Claude Code is showing a dialog. Answer it in the terminal first, or press Esc there to close it.",
        "error"
      );
      return;
    }
    const id = activeSessionId;
    sendPrompt(id, {
      at: Date.now(),
      attachments,
      draft: value,
      text: trimmed,
    });
    window.setTimeout(() => setHistoryStamp((n) => n + 1), HISTORY_REFRESH_MS);
    useAttachments.getState().clear(id);
    clearComposer(id);
  }

  /** Empty the composer once its message has gone. */
  function clearComposer(id: string): void {
    setDraft(id, "");
    const el = editableRef.current;
    if (el) {
      // Put the caret back, the way every other rebuild of this editable does
      // (see `renderFromValue`). Emptying it destroys the node the caret was
      // anchored to, and a caret WebKit re-anchors outside an editable costs a
      // whole-document word scan on every rendering update — see
      // `ui/strayCaret.ts`. The guard there would clear it, but only after the
      // first scan has already been paid.
      const owned = ownsSelection(el);
      el.replaceChildren();
      if (owned) {
        placeCaretAtOffset(el, "", 0);
      }
    }
    setCaret(0);
  }

  // A paste: files and images become attachments; text goes in as one plain
  // text node, newlines and all. Left to the browser, rich text from a web
  // page lands as elements, and a pasted newline can become a <div> the draft
  // serializer would read as nothing.
  function onPaste(event: ClipboardEvent<HTMLDivElement>): void {
    if (intake.onPaste(event)) {
      return;
    }
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    const sel = window.getSelection();
    const el = editableRef.current;
    if (!(text && el && sel && sel.rangeCount > 0)) {
      return;
    }
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) {
      return;
    }
    range.deleteContents();
    const node = el.ownerDocument.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    el.normalize();
    handleInput();
  }

  // Accept a completion row: replace the in-progress token text [start, end)
  // with a real chip plus a trailing space, then place the caret after it.
  function accept(index: number): void {
    const item = itemAt(index);
    const el = editableRef.current;
    if (!(item && activeSessionId && el)) {
      return;
    }
    const currentValue = serializeEditable(el);
    const token = item.insert.trimEnd();
    const kind: ChipKind = chipKindFor(view.kind, token);
    const doc = el.ownerDocument;
    const chip = makeChip(doc, kind, token);
    styleChip(chip);
    const space = doc.createTextNode(" ");
    // WebKit routinely splits a typed run into adjacent text nodes, which would
    // leave `locateRange` unable to find one node spanning [start,end) and drop
    // the chip at the wrong place. Merge adjacent text nodes first so the
    // in-progress trigger is a single node; content (and thus offsets) is
    // unchanged, so `currentValue` stays valid.
    el.normalize();
    const loc = locateRange(el, currentValue, item.start, item.end);
    if (
      loc &&
      loc.startNode === loc.endNode &&
      loc.startNode.nodeType === Node.TEXT_NODE
    ) {
      const textNode = loc.startNode as Text;
      // Split off the tail past the token, then the token itself — leaving
      // [before][token][after] as siblings — and swap the token span for the
      // chip + trailing space.
      textNode.splitText(loc.endOffset);
      const mid = textNode.splitText(loc.startOffset);
      mid.replaceWith(chip, space);
    } else {
      el.appendChild(chip);
      el.appendChild(space);
    }
    reset();
    el.focus();
    placeCaretAtOffset(
      el,
      serializeEditable(el),
      item.start + token.length + 1
    );
    handleInput();
  }

  // If the caret sits right after an atomic chip, delete the whole chip in
  // one Backspace — the browser's own contenteditable=false handling of this
  // is inconsistent enough across WebKit builds to not be relied on alone.
  function chipBeforeCaret(el: HTMLDivElement): Element | null {
    const sel = window.getSelection();
    if (!(sel?.isCollapsed && sel.rangeCount > 0)) {
      return null;
    }
    const { startContainer, startOffset } = sel.getRangeAt(0);
    let prev: Node | null = null;
    if (startContainer === el) {
      prev = el.childNodes[startOffset - 1] ?? null;
    } else if (
      startContainer.nodeType === Node.TEXT_NODE &&
      startOffset === 0
    ) {
      prev = startContainer.previousSibling;
    }
    return prev instanceof Element && prev.hasAttribute("data-chip")
      ? prev
      : null;
  }

  // The popover's own key handling, factored out of onKeyDown to keep it
  // under the complexity limit. Returns whether it consumed the key.
  function handlePopoverKeyDown(event: KeyboardEvent<HTMLDivElement>): boolean {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      accept(view.activeIndex);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      reset();
      return true;
    }
    return false;
  }

  // The keys that act as they do in the CLI's own input: Up/Down walk the
  // [Prompt history], Esc stops the turn (and takes back a prompt Claude
  // never started on). Returns whether it took the key.
  function handleCliKeys(event: KeyboardEvent<HTMLDivElement>): boolean {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      return walkHistory(event);
    }
    if (event.key === "Escape" && canStop && activeSessionId) {
      event.preventDefault();
      interruptSession(activeSessionId).catch(() => undefined);
      return true;
    }
    return false;
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // While an IME composition is active the Enter (or Space) that CONFIRMS a
    // candidate is still reported as key "Enter" in WebKit. Hand it to the
    // browser so it commits the composition — never accept a completion or
    // send() a half-composed message.
    if (event.nativeEvent.isComposing) {
      return;
    }
    const el = editableRef.current;
    if (event.key === "Backspace" && el) {
      const chip = chipBeforeCaret(el);
      if (chip) {
        event.preventDefault();
        chip.remove();
        handleInput();
        return;
      }
    }
    if (view.open && handlePopoverKeyDown(event)) {
      return;
    }
    if (handleCliKeys(event)) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  // Consume a Prompt-picker insert: splice at the (live) caret, rebuild the
  // editable from the result, refocus.
  useEffect(() => {
    const request = insertRequest;
    // Read the mailbox, not the closure. Since `requestInsert` leaves the
    // Changes view in the same batch that posts, this effect can now fire as a
    // MOUNT effect with a request already pending — and StrictMode double-
    // invokes mount effects in dev, which would splice the same prompt twice.
    // The store is cleared below, so the second pass sees nothing to do.
    if (!request || useDrafts.getState().insertRequest?.seq !== request.seq) {
      return;
    }
    const currentSessionId = useSessions.getState().activeSessionId;
    if (request.sessionId !== currentSessionId) {
      // The picker only ever targets the then-active session, so a mismatch
      // means the request went stale (e.g. the active session changed while
      // PromptBar was unmounted across a studio<->focus view switch). Drop it
      // rather than let it survive to splice into an unrelated draft later.
      useDrafts.getState().clearInsertRequest();
      return;
    }
    // The ⌘⇧P picker works from anywhere: inserting into a composer the user
    // cannot see would mutate the draft invisibly and focus an unfocusable
    // editable, so bring it back first. Both ways it can be out of sight are
    // handled here, in the consumer — the producer posts and nothing else, so a
    // future third way to hide the composer costs a stranded request at worst,
    // never a lost one.
    if (useLayout.getState().layout.composerCollapsed) {
      useLayout.getState().toggleComposerCollapsed();
    }
    useLayout.getState().leaveChangesView();
    const store = useDrafts.getState();
    const currentValue = store.drafts[currentSessionId] ?? "";
    const el = editableRef.current;
    const sel = window.getSelection();
    const liveCaret =
      el && sel?.isCollapsed && sel.focusNode && el.contains(sel.focusNode)
        ? caretOffsetInValue(el, sel.focusNode, sel.focusOffset)
        : currentValue.length;
    const start = Math.min(liveCaret, currentValue.length);
    const next =
      currentValue.slice(0, start) + request.text + currentValue.slice(start);
    store.setDraft(currentSessionId, next);
    store.clearInsertRequest();
    const pos = start + request.text.length;
    // `el.isConnected` rather than a cleanup that cancels the frame: this effect
    // clears the mailbox itself, which re-runs it, so a cancelling cleanup would
    // abort its own pending rebuild. The hazard is only ever the composer having
    // unmounted (a transcript-tab switch) before the frame lands.
    requestAnimationFrame(() => {
      if (el?.isConnected) {
        renderFromValue(el, next, pos);
        el.focus();
      }
      setCaret(pos);
    });
  }, [insertRequest]);

  /**
   * The rounded box is what reads as "the input", but only the editable inside
   * it takes focus — a 24px line sitting in 14px of padding, above a footer
   * row. A press on that padding used to land on a plain `<div>`, so the first
   * click on the composer often focused nothing and showed no caret. Forward
   * it: anything that isn't a control (or the editable itself, which the
   * browser already handles) puts the caret at the end of the draft.
   *
   * Matching the two padding wrappers by identity, rather than excluding a list
   * of controls, is deliberate. An exclusion list has to be right about every
   * descendant, and it was not: it swallowed presses on the ctx% readout and
   * the model chip, so neither could be drag-selected. It also caught the
   * completion popover, which portals into `document.body` but stays a React
   * child of the box — React bubbles its row clicks here even though the DOM
   * says they happened elsewhere, so a row press ran this too, after the row
   * had already spliced its chip in, dragging the caret back to the pre-accept
   * offset. Only the wrappers themselves are padding; everything else in the
   * box is content that owns its own press.
   */
  function onBoxMouseDown(event: ReactMouseEvent<HTMLDivElement>): void {
    const el = editableRef.current;
    const { target } = event;
    const isPadding =
      target === boxRef.current || target === editableBoxRef.current;
    if (event.button !== 0 || !el || !isPadding || composingRef.current) {
      return;
    }
    // Without this the press also collapses the selection onto the box itself,
    // undoing the caret we are about to place.
    event.preventDefault();
    el.focus();
    // Read the text from the DOM, not from React state: the editable is
    // uncontrolled and runs ahead of `value` during a chip conversion.
    const text = serializeEditable(el);
    placeCaretAtOffset(el, text, text.length);
    setCaret(text.length);
  }

  const composer = (
    <>
      <div
        aria-hidden={hidden}
        data-testid="composer-drawer"
        style={drawerStyle(hidden)}
      >
        <div style={drawerInnerStyle}>
          <div style={wrapStyle}>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: the box is chrome, not a control — it only forwards a stray press into the editable it wraps */}
            {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: the editable keeps the role, the tab stop and every keyboard handler, so nothing here is reachable by mouse alone */}
            <div
              className="kr-composer-box"
              onMouseDown={onBoxMouseDown}
              ref={boxRef}
              style={intake.dragging ? { ...boxStyle, ...dropStyle } : boxStyle}
            >
              {intake.dragging ? (
                <div style={dropLabelStyle}>Drop to attach</div>
              ) : null}
              <AttachmentTray
                attachments={attachments}
                onRemove={(path) =>
                  activeSessionId &&
                  useAttachments.getState().remove(activeSessionId, path)
                }
              />
              {view.open ? (
                <CompletionPopover
                  activeIndex={view.activeIndex}
                  anchorRef={boxRef}
                  degraded={view.degraded}
                  header={view.header}
                  onPick={accept}
                  rows={view.rows}
                />
              ) : null}
              <div ref={editableBoxRef} style={editableContainerStyle}>
                {value.length === 0 ? (
                  <span aria-hidden="true" style={placeholderStyle}>
                    Ask Claude, or type / for slash commands…
                  </span>
                ) : null}
                {/* biome-ignore lint/a11y/useSemanticElements: a native <textarea> can't host the inline chip elements this editor renders */}
                <div
                  aria-label="Message the session"
                  aria-multiline="true"
                  contentEditable
                  data-placeholder="Ask Claude, or type / for slash commands…"
                  onClick={syncFromDom}
                  onCompositionEnd={onCompositionEnd}
                  onCompositionStart={onCompositionStart}
                  onInput={handleInput}
                  onKeyDown={onKeyDown}
                  onKeyUp={syncFromDom}
                  onPaste={onPaste}
                  ref={editableRef}
                  role="textbox"
                  style={editableStyle}
                  suppressContentEditableWarning
                  tabIndex={0}
                />
              </div>
              {view.mode ? (
                <span style={modeChipStyle}>
                  {view.mode === "bash" ? "! bash command" : "# add to memory"}
                </span>
              ) : null}
              <div ref={footerRef} style={footerStyle}>
                <FooterTools
                  fit={fit}
                  onAttach={intake.pick}
                  usageLabel={usageLabel}
                  value={value}
                />
                <span style={footerRightStyle}>
                  <button
                    aria-label="Hide composer"
                    className="kr-hover-surface"
                    onClick={toggleHidden}
                    style={footerActionStyle}
                    title="Hide the composer"
                    type="button"
                  >
                    <ChevronDown size={13} />
                  </button>
                  {canStop ? (
                    <button
                      aria-label="Stop Claude"
                      className="kr-hover-surface"
                      onClick={() =>
                        activeSessionId &&
                        interruptSession(activeSessionId).catch(() => undefined)
                      }
                      style={button("secondary")}
                      title="Stop Claude (Esc)"
                      type="button"
                    >
                      <Square fill="currentColor" size={10} />
                      Stop
                    </button>
                  ) : null}
                  <button
                    className={canSend ? "kr-hover-accent" : undefined}
                    disabled={!canSend}
                    onClick={send}
                    style={canSend ? sendStyle : sendDisabledStyle}
                    type="button"
                  >
                    Send ↵
                  </button>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
      {hidden ? (
        <div style={revealStripStyle}>
          <button
            aria-label="Show composer"
            className="kr-hover-surface"
            onClick={toggleHidden}
            ref={revealRef}
            style={revealButtonStyle}
            type="button"
          >
            <ChevronUp size={12} />
            Composer
          </button>
        </div>
      ) : null}
    </>
  );

  // One wrapper, always present, only its `display` changes. Returning a
  // different shape when suppressed (a bare fragment vs a wrapped one) would
  // make React unmount and rebuild the whole composer on every trip to the
  // Changes tab, which is the remount this prop exists to avoid. `contents`
  // keeps the wrapper out of the flex column entirely, so the drawer and the
  // reveal strip stay siblings of the terminal dock the way they were.
  return (
    <div
      data-testid="composer-shell"
      style={{ display: suppressed ? "none" : "contents" }}
    >
      {composer}
    </div>
  );
}
