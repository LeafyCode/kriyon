import { ChevronLeft, Pin, Trash2 } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { relativeTime } from "../sidebar/pastSessionTime.ts";
import {
  NOTE_BODY_MAX,
  NOTE_TEXT_MAX,
  useProjectNotes,
} from "../state/projectNotes.ts";
import { button, iconButton, inputBox } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import type { ProjectNote } from "../types.ts";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { KindPicker } from "./KindPicker.tsx";

const rootStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  gap: "12px",
  minHeight: 0,
  padding: "4px 14px 16px",
};

const barStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: "4px",
};

const titleStyle: CSSProperties = {
  ...inputBox(),
  color: tokens.color.ink.bright,
  fontFamily: tokens.font.sans,
  fontSize: "14px",
  fontWeight: 500,
  height: "34px",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const bodyStyle: CSSProperties = {
  ...inputBox(),
  color: tokens.color.ink.primary,
  flex: 1,
  fontFamily: tokens.font.sans,
  fontSize: "12.5px",
  height: "auto",
  lineHeight: 1.6,
  minHeight: "160px",
  outline: "none",
  padding: "10px",
  resize: "none",
  width: "100%",
  boxSizing: "border-box",
};

const metaStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "11px",
};

const doneButtonStyle: CSSProperties = button("secondary", "sm");

/**
 * One [Project note] opened in the Notes tab: its text, a longer body, its
 * kind, pin and delete. Edits are saved when a field loses focus, on Enter in
 * the text, and when the view closes — so leaving never loses a typed edit.
 */
export function NoteDetail({
  note,
  onBack,
}: {
  note: ProjectNote;
  onBack: () => void;
}) {
  const update = useProjectNotes((state) => state.update);
  const remove = useProjectNotes((state) => state.remove);
  const toggleDone = useProjectNotes((state) => state.toggleDone);
  const [text, setText] = useState(note.text);
  const [body, setBody] = useState(note.body);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // The latest draft and the stored copy, for the save on close below — the
  // effect's cleanup would otherwise see the values from its first render.
  const draft = useRef({ body, note, text });
  draft.current = { body, note, text };

  const commit = () => {
    const { body: nextBody, note: stored, text: typed } = draft.current;
    // A note always has text: a cleared title snaps back to the stored one,
    // and whatever else was edited still saves.
    const nextText = typed.trim() || stored.text;
    if (nextText !== typed) {
      setText(nextText);
    }
    if (nextText !== stored.text || nextBody !== stored.body) {
      update(stored.id, { body: nextBody, text: nextText }, Date.now());
    }
  };

  // Save on close: switching sessions or tabs unmounts this without a blur.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once; reads refs.
  useEffect(() => commit, []);

  const deleteNote = () => {
    setConfirmingDelete(false);
    remove(note.id);
    onBack();
  };

  return (
    <div data-testid="note-detail" style={rootStyle}>
      <div style={barStyle}>
        <button
          aria-label="Back to notes"
          className="kr-hover-surface"
          onClick={() => {
            commit();
            onBack();
          }}
          style={iconButton()}
          type="button"
        >
          <ChevronLeft size={14} />
        </button>
        <span style={{ flex: 1 }} />
        <button
          aria-label={note.pinned ? "Unpin" : "Pin to top"}
          aria-pressed={note.pinned}
          className="kr-hover-surface"
          onClick={() => update(note.id, { pinned: !note.pinned }, Date.now())}
          style={{
            ...iconButton(),
            color: note.pinned
              ? tokens.color.accentBright
              : tokens.color.ink.muted,
          }}
          title={note.pinned ? "Unpin" : "Pin to top"}
          type="button"
        >
          <Pin fill={note.pinned ? "currentColor" : "none"} size={13} />
        </button>
        <button
          aria-label="Delete note"
          className="kr-hover-surface"
          onClick={() => setConfirmingDelete(true)}
          style={iconButton()}
          title="Delete"
          type="button"
        >
          <Trash2 size={13} />
        </button>
      </div>

      <input
        aria-label="Note text"
        maxLength={NOTE_TEXT_MAX}
        onBlur={commit}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            commit();
          }
        }}
        style={titleStyle}
        type="text"
        value={text}
      />

      <div style={barStyle}>
        <KindPicker
          onChange={(kind) => update(note.id, { kind }, Date.now())}
          value={note.kind}
        />
        <span style={{ flex: 1 }} />
        {note.kind === "todo" ? (
          <button
            className="kr-hover-surface"
            onClick={() => toggleDone(note.id, Date.now())}
            style={doneButtonStyle}
            type="button"
          >
            {note.doneAt === null ? "Mark done" : "Mark not done"}
          </button>
        ) : null}
      </div>

      <textarea
        aria-label="More detail"
        maxLength={NOTE_BODY_MAX}
        onBlur={commit}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Add more detail…"
        style={bodyStyle}
        value={body}
      />

      <span style={metaStyle}>
        Added {relativeTime(note.createdMs, Date.now())}
        {note.updatedMs > note.createdMs
          ? ` · edited ${relativeTime(note.updatedMs, Date.now())}`
          : ""}
      </span>

      {confirmingDelete ? (
        <ConfirmDialog
          body="This can't be undone."
          confirmLabel="Delete"
          label="Keep this note"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={deleteNote}
          title={`Delete "${note.text}"?`}
        />
      ) : null}
    </div>
  );
}
