import type { CSSProperties, KeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { readClipboard } from "../ipc/bridge.ts";
import { useDrafts } from "../state/drafts.ts";
import { useLayout } from "../state/layout.ts";
import {
  EMPTY_LIBRARY_COPY,
  filterPrompts,
  orderPrompts,
  usePromptLibrary,
} from "../state/promptLibrary.ts";
import { useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import {
  inputBox,
  kbd,
  overlayEmpty,
  overlayPanel,
  resultLabel,
  resultList,
  resultRow,
  resultSub,
  searchInput,
  searchRow,
} from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import type { SavedPrompt } from "../types.ts";
import { Overlay } from "../ui/Overlay.tsx";
import { showToast } from "../ui/Toast.tsx";
import { PromptRowActions } from "./PromptRowActions.tsx";
import {
  CLIPBOARD_PLACEHOLDER,
  parsePlaceholders,
  resolvePlaceholders,
} from "./placeholders.ts";
import { usePromptRowActions } from "./usePromptRowActions.ts";

type Stage = "search" | "fill";

const SEARCH_PLACEHOLDER = "Search saved prompts…";

// A `{name}` span, kept in the split output so it can be re-wrapped in an
// accent-colored <span> for the preview pane.
const PLACEHOLDER_SPLIT_RE = /(\{[\w- ]+\})/g;
const PLACEHOLDER_MATCH_RE = /^\{[\w- ]+\}$/;

// The same overlay the command palette is: one panel, a 46px search row and a
// result list. What the picker adds is width and a second column (the preview
// pane) that the palette has no use for.
const panelStyle: CSSProperties = {
  ...overlayPanel(),
  maxHeight: "62vh",
  overflow: "hidden",
  width: "min(700px, 92vw)",
};

const bodyRowStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  minHeight: 0,
};

const listColumnStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  minWidth: 0,
};

const searchRowStyle: CSSProperties = searchRow();

const inputStyle: CSSProperties = searchInput();

const escStyle: CSSProperties = kbd();

const listStyle: CSSProperties = resultList();

const emptyStyle: CSSProperties = overlayEmpty();

const labelStyle: CSSProperties = resultLabel();

const subStyle: CSSProperties = resultSub();

const rowLabelStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  cursor: "pointer",
  flex: 1,
  minWidth: 0,
  padding: 0,
  textAlign: "left",
};

const legendStyle: CSSProperties = {
  borderTop: `1px solid ${tokens.color.line.soft}`,
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.mono,
  fontSize: "10.5px",
  padding: "8px 14px",
};

const previewStyle: CSSProperties = {
  borderLeft: `1px solid ${tokens.color.line.soft}`,
  flex: "none",
  overflowY: "auto",
  padding: tokens.space.md,
  width: "260px",
};

const previewTitleStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  fontSize: "12.5px",
  fontWeight: 500,
  marginBottom: tokens.space.xs,
};

const previewTagsStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "4px",
  marginBottom: tokens.space.sm,
};

const tagChipStyle: CSSProperties = {
  background: tokens.color.chip,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.pill,
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.mono,
  fontSize: "10.5px",
  padding: "2px 8px",
};

const previewBodyStyle: CSSProperties = {
  color: tokens.color.ink.secondary,
  fontFamily: tokens.font.mono,
  fontSize: "11.5px",
  lineHeight: 1.5,
  margin: 0,
  whiteSpace: "pre-wrap",
};

const fillColumnStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.sm,
  overflowY: "auto",
  padding: "15px 18px",
};

const fieldLabelStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  display: "flex",
  flexDirection: "column",
  fontSize: "10.5px",
  gap: "5px",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
};

// `textTransform: none` un-does the label's uppercase, which would otherwise
// inherit into the field and shout back whatever the user typed.
const fieldInputStyle: CSSProperties = {
  ...inputBox(),
  color: tokens.color.ink.bright,
  display: "block",
  fontFamily: tokens.font.sans,
  fontSize: "12.5px",
  outline: "none",
  textTransform: "none",
};

/** Body text with `{name}` spans wrapped in an accent-colored <span>. */
function renderHighlightedBody(body: string) {
  return body.split(PLACEHOLDER_SPLIT_RE).map((part, index) =>
    PLACEHOLDER_MATCH_RE.test(part) ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: static split of an immutable string
      <span key={index} style={{ color: tokens.color.accentBright }}>
        {part}
      </span>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: static split of an immutable string
      <span key={index}>{part}</span>
    )
  );
}

function PreviewPane({ prompt }: { prompt: SavedPrompt | null }) {
  if (!prompt) {
    return <div style={previewStyle} />;
  }
  return (
    <div style={previewStyle}>
      <div style={previewTitleStyle}>{prompt.title}</div>
      {prompt.tags.length > 0 ? (
        <div style={previewTagsStyle}>
          {prompt.tags.map((tag) => (
            <span key={tag} style={tagChipStyle}>
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      <pre style={previewBodyStyle}>{renderHighlightedBody(prompt.body)}</pre>
    </div>
  );
}

/**
 * The [Prompt picker] overlay: ⌘⇧P → search a [Saved prompt] → (optionally)
 * fill its `{placeholder}` slots → insert the resolved text into the active
 * session's [Composer draft]. Two stages, one component (search/fill; YAGNI —
 * one caller). Clipboard reads go through the Rust core via
 * `bridge.readClipboard` (`navigator.clipboard` rejects in the packaged
 * webview); insertion still goes only through `useDrafts.requestInsert`, and
 * this component never sends anything itself.
 */
export function PromptPicker() {
  const open = useUi((s) => s.promptPickerOpen);
  const openPromptPicker = useUi((s) => s.openPromptPicker);
  const closePromptPicker = useUi((s) => s.closePromptPicker);
  const prompts = usePromptLibrary((s) => s.prompts);

  const [stage, setStage] = useState<Stage>("search");
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [activePrompt, setActivePrompt] = useState<SavedPrompt | null>(null);
  const [fillValues, setFillValues] = useState<Record<string, string>>({});
  const {
    deleteArmedId,
    disarmDelete,
    deleteRow,
    favouriteRow,
    editRow,
    markUsed,
  } = usePromptRowActions();

  const inputRef = useRef<HTMLInputElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  // Re-entrancy guard: the clipboard read can take human time (permission
  // dialog); a second Enter/click meanwhile must not race a second
  // requestInsert into the one-shot mailbox or double-count markUsed.
  const insertingRef = useRef(false);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        event.key.toLowerCase() === "p" &&
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey
      ) {
        event.preventDefault();
        openPromptPicker();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openPromptPicker]);

  useEffect(() => {
    if (open) {
      setStage("search");
      setQuery("");
      setHighlight(0);
      setActivePrompt(null);
      setFillValues({});
      disarmDelete();
      insertingRef.current = false;
      inputRef.current?.focus();
    }
  }, [open, disarmDelete]);

  useEffect(() => {
    if (stage === "fill") {
      firstFieldRef.current?.focus();
    }
  }, [stage]);

  // Escape steps back from the fill stage to search, and closes from search.
  const onEscape = useCallback(() => {
    if (stage === "fill") {
      setStage("search");
    } else {
      closePromptPicker();
    }
  }, [stage, closePromptPicker]);

  if (!open) {
    return null;
  }

  const filtered = filterPrompts(orderPrompts(prompts), query);
  const safeHighlight = Math.min(highlight, Math.max(filtered.length - 1, 0));
  const highlighted = filtered[safeHighlight] ?? null;
  const placeholders = activePrompt ? parsePlaceholders(activePrompt.body) : [];

  function insertPrompt(
    prompt: SavedPrompt,
    values: Record<string, string>
  ): void {
    if (insertingRef.current) {
      return;
    }
    const sessionId = useSessions.getState().activeSessionId;
    if (!sessionId) {
      closePromptPicker();
      return;
    }
    insertingRef.current = true;
    const needsClipboard = prompt.body.includes(`{${CLIPBOARD_PLACEHOLDER}}`);
    const clipboardText = needsClipboard
      ? readClipboard().catch(() => {
          showToast("Could not read the clipboard", "error");
          return "";
        })
      : Promise.resolve("");
    clipboardText.then((clip) => {
      // The (permission-gated) clipboard read can take human time; if the
      // active session changed while it was pending, the captured
      // `sessionId` no longer points at anything the user is looking at —
      // skip delivering it rather than silently insert into a session
      // nobody's on.
      if (useSessions.getState().activeSessionId === sessionId) {
        const resolved = resolvePlaceholders(prompt.body, values, clip);
        useDrafts.getState().requestInsert(sessionId, resolved);
        markUsed(prompt);
        if (useLayout.getState().layout.view === "command") {
          showToast("Inserted into the session draft");
        }
      }
      closePromptPicker();
      insertingRef.current = false;
    });
  }

  function pickPrompt(prompt: SavedPrompt): void {
    const names = parsePlaceholders(prompt.body);
    if (names.length === 0) {
      insertPrompt(prompt, {});
      return;
    }
    setActivePrompt(prompt);
    setFillValues({});
    setStage("fill");
  }

  // The visible PromptRowActions target a specific row; the ⌘F/⌘E/⌘⌫ shortcuts
  // act on the highlighted row. Both funnel through the shared row-action hook
  // (favouriteRow / editRow / deleteRow) so the two surfaces stay in lockstep.
  function toggleHighlightedFavourite(): void {
    if (highlighted) {
      favouriteRow(highlighted);
    }
  }

  function editHighlighted(): void {
    if (highlighted) {
      editRow(highlighted);
    }
  }

  // An armed ⌘⌫ confirms one specific row; moving the highlight (keys or
  // hover) changes what the next press would delete, so it must disarm —
  // same disarm-on-target-change convention as the PromptEditor's overwrite.
  function moveHighlight(update: (index: number) => number): void {
    setHighlight(update);
    disarmDelete();
  }

  function deleteHighlighted(): void {
    if (highlighted) {
      deleteRow(highlighted);
    }
  }

  // Returns true when it handled the event, so onSearchKeyDown can bail early.
  function onSearchMetaKeyDown(
    event: KeyboardEvent<HTMLInputElement>
  ): boolean {
    const key = event.key.toLowerCase();
    if (key === "f") {
      event.preventDefault();
      toggleHighlightedFavourite();
      return true;
    }
    if (key === "e") {
      event.preventDefault();
      editHighlighted();
      return true;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      deleteHighlighted();
      return true;
    }
    return false;
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    const meta = event.metaKey || event.ctrlKey;
    if (meta && onSearchMetaKeyDown(event)) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight((index) => Math.min(index + 1, filtered.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (highlighted) {
        pickPrompt(highlighted);
      }
    }
  }

  function renderPromptRows() {
    if (prompts.length === 0) {
      return <div style={emptyStyle}>{EMPTY_LIBRARY_COPY}</div>;
    }
    if (filtered.length === 0) {
      return <div style={emptyStyle}>No matches</div>;
    }
    return filtered.map((prompt, index) => (
      <div
        data-active={index === safeHighlight ? "true" : "false"}
        key={prompt.id}
        style={resultRow(index === safeHighlight)}
      >
        <button
          onClick={() => pickPrompt(prompt)}
          onMouseEnter={() => moveHighlight(() => index)}
          style={rowLabelStyle}
          type="button"
        >
          <span style={{ ...labelStyle, display: "block" }}>
            {prompt.favourite ? (
              <span style={{ color: tokens.color.accentBright }}>★ </span>
            ) : null}
            {prompt.title}
          </span>
          {prompt.tags.length > 0 ? (
            <span style={{ ...subStyle, display: "block" }}>
              {prompt.tags.join(", ")}
            </span>
          ) : null}
        </button>
        <PromptRowActions
          deleteArmed={deleteArmedId === prompt.id}
          favourite={prompt.favourite}
          insertDisabled={false}
          onDelete={() => deleteRow(prompt)}
          onEdit={() => editRow(prompt)}
          onInsert={() => pickPrompt(prompt)}
          onToggleFavourite={() => favouriteRow(prompt)}
        />
      </div>
    ));
  }

  function onFieldKeyDown(
    event: KeyboardEvent<HTMLInputElement>,
    index: number
  ): void {
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey || index === placeholders.length - 1)
    ) {
      event.preventDefault();
      if (activePrompt) {
        insertPrompt(activePrompt, fillValues);
      }
    }
  }

  return (
    <Overlay
      backdropTestId="prompt-picker-backdrop"
      label="Close prompt picker"
      onClose={closePromptPicker}
      onEscape={onEscape}
    >
      <div data-testid="prompt-picker" style={panelStyle}>
        <div style={bodyRowStyle}>
          <div style={listColumnStyle}>
            {stage === "search" ? (
              <>
                <div style={searchRowStyle}>
                  <span
                    style={{ color: tokens.color.ink.faint, fontSize: "14px" }}
                  >
                    ⌕
                  </span>
                  <input
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setHighlight(0);
                      disarmDelete();
                    }}
                    onKeyDown={onSearchKeyDown}
                    placeholder={SEARCH_PLACEHOLDER}
                    ref={inputRef}
                    style={inputStyle}
                    type="text"
                    value={query}
                  />
                  <span style={escStyle}>esc</span>
                </div>
                <div data-testid="prompt-picker-list" style={listStyle}>
                  {renderPromptRows()}
                </div>
                <div style={legendStyle}>
                  Enter insert · ⌘F favourite · ⌘E edit · ⌘⌫ delete
                </div>
              </>
            ) : (
              <div style={fillColumnStyle}>
                {placeholders.map((name, index) => (
                  <label key={name} style={fieldLabelStyle}>
                    {name}
                    <input
                      onChange={(event) =>
                        setFillValues((values) => ({
                          ...values,
                          [name]: event.target.value,
                        }))
                      }
                      onKeyDown={(event) => onFieldKeyDown(event, index)}
                      ref={index === 0 ? firstFieldRef : undefined}
                      style={fieldInputStyle}
                      type="text"
                      value={fillValues[name] ?? ""}
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
          <PreviewPane prompt={stage === "fill" ? activePrompt : highlighted} />
        </div>
      </div>
    </Overlay>
  );
}
