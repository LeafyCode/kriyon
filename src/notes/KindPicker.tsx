import type { CSSProperties } from "react";
import { accentAlpha, tokens } from "../theme/tokens.ts";
import type { NoteKind } from "../types.ts";
import { NOTE_KIND_META, NOTE_KINDS } from "./noteKinds.ts";

const groupStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: "2px",
};

function kindStyle(picked: boolean): CSSProperties {
  return {
    alignItems: "center",
    background: picked ? accentAlpha(0.16) : "transparent",
    border: `1px solid ${picked ? accentAlpha(0.4) : "transparent"}`,
    borderRadius: tokens.radius.sm,
    color: picked ? tokens.color.accentInk : tokens.color.ink.muted,
    cursor: "pointer",
    display: "inline-flex",
    fontFamily: tokens.font.sans,
    fontSize: "11.5px",
    gap: "5px",
    height: "24px",
    padding: "0 8px",
  };
}

/** The Todo / Idea / Note toggle a new [Project note] is filed under. */
export function KindPicker({
  onChange,
  value,
}: {
  onChange: (kind: NoteKind) => void;
  value: NoteKind;
}) {
  return (
    <fieldset
      aria-label="Kind"
      style={{ ...groupStyle, border: 0, margin: 0, padding: 0 }}
    >
      {NOTE_KINDS.map((kind) => {
        const meta = NOTE_KIND_META[kind];
        const Icon = meta.icon;
        const picked = kind === value;
        return (
          <button
            aria-pressed={picked}
            className={picked ? undefined : "kr-hover-surface"}
            key={kind}
            onClick={() => onChange(kind)}
            style={kindStyle(picked)}
            type="button"
          >
            <Icon
              aria-hidden="true"
              color={meta.color}
              size={12}
              strokeWidth={2}
            />
            {meta.label}
          </button>
        );
      })}
    </fieldset>
  );
}
