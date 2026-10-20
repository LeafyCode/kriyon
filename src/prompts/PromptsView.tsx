import type { CSSProperties } from "react";
import { useState } from "react";
import { ViewHeader } from "../layout/ViewHeader.tsx";
import { useDrafts } from "../state/drafts.ts";
import {
  EMPTY_LIBRARY_COPY,
  filterPrompts,
  importPromptsFromCommands,
  orderPrompts,
  usePromptLibrary,
} from "../state/promptLibrary.ts";
import { useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import { button, inputBox } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import type { SavedPrompt } from "../types.ts";
import { showToast } from "../ui/Toast.tsx";
import { PromptRowActions } from "./PromptRowActions.tsx";
import { usePromptRowActions } from "./usePromptRowActions.ts";

const viewStyle: CSSProperties = {
  color: tokens.color.text,
  display: "flex",
  flex: 1,
  flexDirection: "column",
  fontFamily: tokens.font.sans,
  minHeight: 0,
};

/** The view's own body, below the shared 46px `ViewHeader`. */
const bodyStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  minHeight: 0,
  padding: "20px 24px",
};

const buttonStyle: CSSProperties = button("secondary", "sm");

const searchStyle: CSSProperties = {
  ...inputBox(),
  color: tokens.color.ink.bright,
  display: "block",
  fontFamily: tokens.font.sans,
  fontSize: "12.5px",
  marginBottom: tokens.space.md,
  outline: "none",
};

const listStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  overflowY: "auto",
};

/** A 46px library row; the hairline separates, so it sits under every row. */
const rowStyle: CSSProperties = {
  alignItems: "center",
  borderBottom: `1px solid ${tokens.color.line.soft}`,
  display: "flex",
  flex: "none",
  gap: tokens.space.sm,
  height: "46px",
};

const rowLabelStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  flex: 1,
  fontSize: "12.5px",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const tagStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.mono,
  fontSize: "10.5px",
};

const emptyStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "12.5px",
  padding: "40px",
  textAlign: "center",
};

/**
 * [Prompt library view]: the persistent "Prompts" tab — browse, search, and
 * manage every [Saved prompt] with the shared [Prompt row actions]. Insert
 * targets the active [Session]'s [Composer draft] (never sends); with no active
 * session the insert control is disabled. Reuses the [Prompt editor] dialog for
 * New/Edit and the existing import command. Distinct from the transient
 * [Prompt picker] overlay (which owns the guided `{placeholder}` fill flow —
 * this tab inserts the raw body for the user to edit in the composer).
 */
export function PromptsView() {
  const prompts = usePromptLibrary((s) => s.prompts);
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const [query, setQuery] = useState("");
  const {
    deleteArmedId,
    disarmDelete,
    deleteRow,
    favouriteRow,
    editRow,
    markUsed,
  } = usePromptRowActions();

  const rows = filterPrompts(orderPrompts(prompts), query);

  function insertRow(p: SavedPrompt): void {
    if (!activeSessionId) {
      return;
    }
    useDrafts.getState().requestInsert(activeSessionId, p.body);
    markUsed(p);
    showToast("Inserted into the session draft");
  }

  return (
    <div data-testid="prompts-view" style={viewStyle}>
      <ViewHeader
        actions={
          <>
            <button
              aria-label="New prompt"
              className="kr-hover-surface"
              onClick={() =>
                useUi
                  .getState()
                  .openPromptEditor({ body: "", tags: [], title: "" })
              }
              style={buttonStyle}
              type="button"
            >
              + New
            </button>
            <button
              aria-label="Import from /commands"
              className="kr-hover-surface"
              onClick={() => {
                importPromptsFromCommands();
              }}
              style={buttonStyle}
              type="button"
            >
              Import from /commands
            </button>
          </>
        }
        testId="prompts-header"
        title="Prompts"
      />
      <div style={bodyStyle}>
        <input
          onChange={(event) => {
            setQuery(event.target.value);
            disarmDelete();
          }}
          placeholder="Search prompts…"
          style={searchStyle}
          type="text"
          value={query}
        />
        {prompts.length === 0 ? (
          <div style={emptyStyle}>{EMPTY_LIBRARY_COPY}</div>
        ) : (
          <div style={listStyle}>
            {rows.map((p) => (
              <div key={p.id} style={rowStyle}>
                <span data-testid="prompts-row-title" style={rowLabelStyle}>
                  {p.favourite ? (
                    <span style={{ color: tokens.color.accentBright }}>★ </span>
                  ) : null}
                  {p.title}
                  {p.tags.length > 0 ? (
                    <span style={tagStyle}> · {p.tags.join(", ")}</span>
                  ) : null}
                </span>
                <PromptRowActions
                  deleteArmed={deleteArmedId === p.id}
                  favourite={p.favourite}
                  insertDisabled={!activeSessionId}
                  onDelete={() => deleteRow(p)}
                  onEdit={() => editRow(p)}
                  onInsert={() => insertRow(p)}
                  onToggleFavourite={() => favouriteRow(p)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
