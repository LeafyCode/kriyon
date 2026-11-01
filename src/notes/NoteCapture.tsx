import { type CSSProperties, type KeyboardEvent, useState } from "react";
import { NOTE_TEXT_MAX, useProjectNotes } from "../state/projectNotes.ts";
import { card, searchInput } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import type { NoteKind } from "../types.ts";
import { Kbd } from "../ui/Kbd.tsx";
import { KindPicker } from "./KindPicker.tsx";
import { NOTE_KIND_META } from "./noteKinds.ts";

const frameStyle: CSSProperties = {
  ...card(),
  display: "flex",
  flexDirection: "column",
  gap: "6px",
  padding: "8px 8px 6px 10px",
};

const inputStyle: CSSProperties = {
  ...searchInput(),
  height: "22px",
  padding: 0,
};

const footStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: "6px",
  justifyContent: "space-between",
};

const hintStyle: CSSProperties = {
  alignItems: "center",
  color: tokens.color.ink.muted,
  display: "flex",
  fontSize: "11px",
  gap: "4px",
};

/**
 * The Notes tab's capture box: type, pick a kind, press Enter. The kind
 * stays picked after an add, because thoughts tend to come in runs of one
 * kind.
 */
export function NoteCapture({ projectId }: { projectId: string }) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<NoteKind>("todo");
  const add = useProjectNotes((state) => state.add);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (add(projectId, kind, text, Date.now())) {
        setText("");
      }
    } else if (event.key === "Escape" && text) {
      event.preventDefault();
      setText("");
    }
  };

  return (
    <div style={frameStyle}>
      <input
        aria-label="New note"
        maxLength={NOTE_TEXT_MAX}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={NOTE_KIND_META[kind].placeholder}
        style={inputStyle}
        type="text"
        value={text}
      />
      <div style={footStyle}>
        <KindPicker onChange={setKind} value={kind} />
        <span style={hintStyle}>
          <Kbd>↵</Kbd> add
        </span>
      </div>
    </div>
  );
}
