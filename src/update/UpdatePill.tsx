import { Sparkles } from "lucide-react";
import type { CSSProperties } from "react";
import { showsPill, useUpdates } from "../state/updates.ts";
import { chip } from "../theme/recipes.ts";
import { accentAlpha, tokens } from "../theme/tokens.ts";

const pillStyle: CSSProperties = {
  ...chip({ fill: accentAlpha(0.12), hover: accentAlpha(0.22) }),
  animation: "kr-pop-in 0.3s ease-out",
  border: `1px solid ${accentAlpha(0.35)}`,
  borderRadius: tokens.radius.pill,
  color: tokens.color.accentBright,
  cursor: "pointer",
  fontSize: "11.5px",
  fontWeight: 500,
  marginRight: "auto",
};

/** A slow glow, so a waiting update is noticed without nagging. Reduced
 *  motion stills it (App.css). */
const iconStyle: CSSProperties = {
  animation: "kr-pulse 2.4s ease-in-out infinite",
  flex: "none",
};

/** The sidebar footer's "Update available" pill; opens the update dialog. */
export function UpdatePill() {
  const version = useUpdates((state) =>
    showsPill(state.snapshot)
      ? (state.snapshot?.available?.version ?? null)
      : null
  );
  const openDialog = useUpdates((state) => state.openDialog);
  if (version === null) {
    return null;
  }
  return (
    <button
      className="kr-focusable kr-hover-surface"
      data-testid="update-pill"
      onClick={openDialog}
      style={pillStyle}
      title={`Kriyon ${version} is ready to install`}
      type="button"
    >
      <Sparkles aria-hidden size={12} style={iconStyle} />
      Update available
    </button>
  );
}
