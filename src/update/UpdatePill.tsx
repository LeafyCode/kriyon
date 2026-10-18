import type { CSSProperties } from "react";
import { showsPill, useUpdates } from "../state/updates.ts";
import { chip } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";

const pillStyle: CSSProperties = {
  ...chip(),
  color: tokens.color.accentBright,
  cursor: "pointer",
  fontSize: "11.5px",
  marginRight: "auto",
};

/** The sidebar footer's "Update available" pill; opens the update dialog. */
export function UpdatePill() {
  const visible = useUpdates((state) => showsPill(state.snapshot));
  const openDialog = useUpdates((state) => state.openDialog);
  if (!visible) {
    return null;
  }
  return (
    <button
      className="kr-focusable kr-hover-surface"
      data-testid="update-pill"
      onClick={openDialog}
      style={pillStyle}
      type="button"
    >
      Update available
    </button>
  );
}
