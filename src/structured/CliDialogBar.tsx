import { ArrowLeft, MessageCircleQuestion } from "lucide-react";
import type { CSSProperties } from "react";
import { button } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";

/**
 * The controls of a [CLI dialog] shown over the [Structured view]: put it
 * aside, or bring it back. Putting it aside leaves the dialog open in the
 * terminal — only the CLI's own keys close it.
 */

const pillStyle: CSSProperties = {
  alignItems: "center",
  background: tokens.color.surface.s3,
  border: `1px solid ${tokens.color.line.soft}`,
  borderRadius: tokens.radius.pill,
  boxShadow: tokens.shadow.pop,
  color: tokens.color.ink.secondary,
  display: "flex",
  fontFamily: tokens.font.sans,
  fontSize: "12px",
  gap: tokens.space.sm,
  padding: `${tokens.space.xs} ${tokens.space.xs} ${tokens.space.xs} ${tokens.space.md}`,
  position: "absolute",
  zIndex: 2,
};

const pillButtonStyle: CSSProperties = {
  ...button("secondary", "sm"),
  borderRadius: tokens.radius.pill,
};

/** Over the terminal while it answers a dialog for the Structured view. */
export function CliDialogBar({ onBack }: { onBack: () => void }) {
  return (
    <div style={{ ...pillStyle, right: tokens.space.xl, top: tokens.space.sm }}>
      <span>Claude Code needs an answer here</span>
      <button
        className="kr-focusable kr-hover-surface"
        onClick={onBack}
        style={pillButtonStyle}
        title="The dialog stays open in the terminal"
        type="button"
      >
        <ArrowLeft size={12} />
        Back to Structured
      </button>
    </div>
  );
}

/** Over the Structured view while a dialog put aside is still open. */
export function CliDialogWaiting({ onAnswer }: { onAnswer: () => void }) {
  return (
    <div
      role="status"
      style={{
        ...pillStyle,
        bottom: tokens.space.md,
        left: "50%",
        transform: "translateX(-50%)",
      }}
    >
      <MessageCircleQuestion
        aria-hidden
        size={13}
        style={{ color: tokens.color.status.waiting }}
      />
      <span>Claude Code is waiting on a dialog</span>
      <button
        className="kr-focusable kr-hover-accent"
        onClick={onAnswer}
        style={{ ...button("primary", "sm"), borderRadius: tokens.radius.pill }}
        type="button"
      >
        Answer
      </button>
    </div>
  );
}
