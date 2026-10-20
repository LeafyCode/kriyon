import { type CSSProperties, useEffect, useRef } from "react";
import { tokens } from "../theme/tokens.ts";

/**
 * The shared inline text editor behind both the project-header and
 * session-row renames. An uncontrolled input, seeded with the current name
 * and selected on focus: Enter (or clicking away) commits the trimmed text,
 * Escape reverts. `data-no-dnd` and the pointer-event guards keep a press
 * inside the field from starting a row/project drag or selecting the row
 * beneath it.
 */
export interface InlineRenameProps {
  ariaLabel: string;
  onCancel: () => void;
  /** Called with the raw field text on commit; the caller trims/validates. */
  onCommit: (next: string) => void;
  /** Merged over the default box style so each caller can match its context. */
  style?: CSSProperties;
  testId?: string;
  value: string;
}

const inputStyle: CSSProperties = {
  background: tokens.color.surface.hover,
  border: `1px solid ${tokens.color.line.strong}`,
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.bright,
  fontFamily: tokens.font.sans,
  fontSize: "12.5px",
  minWidth: 0,
  outline: "none",
  padding: "3px 6px",
  // The editor sits inside the row's click-through content, so it must opt
  // pointer input back in to be typed into or clicked.
  pointerEvents: "auto",
  width: "100%",
};

export function InlineRename({
  ariaLabel,
  onCancel,
  onCommit,
  style,
  testId,
  value,
}: InlineRenameProps) {
  // Escape reverts by blurring after arming this flag, so the blur handler
  // knows not to also commit — otherwise a cancel would save the field's text.
  const cancelledRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus and select ONCE, on mount. An inline `ref={node => node.select()}`
  // would re-run on every re-render — and these editors live inside SessionRow,
  // which re-renders on a live session's status/activity ticks — re-selecting
  // the field mid-edit so the next keystroke wipes the user's in-progress name.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <input
      aria-label={ariaLabel}
      className="kr-inline-rename"
      data-no-dnd="true"
      data-testid={testId}
      defaultValue={value}
      onBlur={(event) => {
        if (cancelledRef.current) {
          cancelledRef.current = false;
          return;
        }
        onCommit(event.target.value);
      }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          cancelledRef.current = true;
          onCancel();
          event.currentTarget.blur();
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
      ref={inputRef}
      spellCheck={false}
      style={{ ...inputStyle, ...style }}
      type="text"
    />
  );
}
