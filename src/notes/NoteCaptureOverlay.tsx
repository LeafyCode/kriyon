import { type CSSProperties, useEffect, useState } from "react";
import {
  NOTE_TEXT_MAX,
  useNotesProjectId,
  useProjectNotes,
} from "../state/projectNotes.ts";
import { useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import {
  button,
  inputBox,
  overlayPanel,
  searchInput,
} from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import type { NoteKind, ProjectRow } from "../types.ts";
import { Kbd } from "../ui/Kbd.tsx";
import { Overlay } from "../ui/Overlay.tsx";
import { showToast } from "../ui/Toast.tsx";
import { KindPicker } from "./KindPicker.tsx";
import { NOTE_KIND_META } from "./noteKinds.ts";

const panelStyle: CSSProperties = {
  ...overlayPanel(),
  gap: "10px",
  maxWidth: "calc(100vw - 32px)",
  padding: "14px",
  width: "520px",
};

const rowStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: "8px",
};

const labelStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "11.5px",
};

const selectStyle: CSSProperties = {
  ...inputBox(),
  color: tokens.color.ink.primary,
  fontFamily: tokens.font.sans,
  fontSize: "12px",
  height: "26px",
  maxWidth: "60%",
  padding: "0 6px",
};

const inputStyle: CSSProperties = {
  ...searchInput(),
  fontSize: "15px",
  height: "30px",
};

const hintStyle: CSSProperties = {
  alignItems: "center",
  color: tokens.color.ink.muted,
  display: "flex",
  flex: 1,
  fontSize: "11px",
  gap: "4px",
};

const addStyle: CSSProperties = button("primary", "sm");

function isCaptureChord(event: KeyboardEvent): boolean {
  return (
    event.key.toLowerCase() === "n" &&
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    !event.altKey
  );
}

/**
 * The ⌘⇧N [Note capture]: write a thought down from anywhere in the app
 * without leaving what you're doing. It files under the project the Notes
 * tab would show (the active session's), and can be pointed at another.
 */
export function NoteCaptureOverlay() {
  const open = useUi((state) => state.noteCaptureOpen);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isCaptureChord(event)) {
        return;
      }
      event.preventDefault();
      if (useSessions.getState().projects.length === 0) {
        showToast("Add a project first — notes belong to a project", "error");
        return;
      }
      useUi.getState().openNoteCapture();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return open ? <CapturePanel /> : null;
}

/** Mounted only while open, so each opening starts fresh. */
function CapturePanel() {
  const projects = useSessions((state) => state.projects);
  const shownProjectId = useNotesProjectId();
  const add = useProjectNotes((state) => state.add);
  const close = useUi((state) => state.closeNoteCapture);
  const [projectId, setProjectId] = useState(
    () => shownProjectId ?? projects[0]?.id ?? ""
  );
  const [kind, setKind] = useState<NoteKind>("todo");
  const [text, setText] = useState("");

  const submit = () => {
    const project: ProjectRow | undefined = projects.find(
      (p) => p.id === projectId
    );
    if (!(project && add(project.id, kind, text, Date.now()))) {
      return;
    }
    close();
    showToast(`${NOTE_KIND_META[kind].label} added to ${project.name}`);
  };

  return (
    <Overlay label="Close note capture" onClose={close}>
      <div aria-label="Add a note" role="dialog" style={panelStyle}>
        {/* First, so the Overlay's focus lands in it: capture means typing. */}
        <input
          aria-label="Note"
          maxLength={NOTE_TEXT_MAX}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={NOTE_KIND_META[kind].placeholder}
          style={inputStyle}
          type="text"
          value={text}
        />
        <div style={rowStyle}>
          <KindPicker onChange={setKind} value={kind} />
          <span
            aria-hidden="true"
            style={{ ...labelStyle, marginLeft: "auto" }}
          >
            in
          </span>
          <select
            aria-label="Project"
            onChange={(event) => setProjectId(event.target.value)}
            style={selectStyle}
            value={projectId}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div style={rowStyle}>
          <span style={hintStyle}>
            <Kbd>↵</Kbd> add · <Kbd>esc</Kbd> close
          </span>
          <button
            className="kr-hover-accent"
            onClick={submit}
            style={addStyle}
            type="button"
          >
            Add
          </button>
        </div>
      </div>
    </Overlay>
  );
}
