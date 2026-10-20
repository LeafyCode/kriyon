/**
 * One hover-revealed icon action in a project group's header — the seam the
 * sort / palette / new-worktree / new-session buttons share, so the reveal
 * policy and trigger aria live once instead of four inline copies.
 */
import type { CSSProperties, ReactNode } from "react";
import { iconButton } from "../theme/recipes.ts";
import type { AnchoredMenu } from "../ui/AnchoredMenu.tsx";

// The 26×26 icon button the rest of the app uses — the old 22px square was
// tuned for a denser header and is below the comfortable pointer target the
// canvas settles on.
const headerActionStyle: CSSProperties = {
  ...iconButton(),
  fontSize: "13px",
  lineHeight: 1,
};

interface HeaderActionProps {
  ariaLabel: string;
  children: ReactNode;
  onClick: () => void;
  /** Hover-revealed (the default). `false` keeps the icon always visible —
   *  used when the action carries state worth noticing (an active sort
   *  override) even while the header isn't hovered. */
  reveal?: boolean;
  title?: string;
  /** Spread from the {@link AnchoredMenu} this action triggers, if any. */
  triggerAria?: AnchoredMenu<HTMLDivElement>["triggerAria"];
}

export function HeaderAction({
  ariaLabel,
  children,
  onClick,
  reveal = true,
  title,
  triggerAria,
}: HeaderActionProps) {
  return (
    <button
      aria-label={ariaLabel}
      className={reveal ? "kr-reveal kr-hover-surface" : "kr-hover-surface"}
      onClick={onClick}
      style={headerActionStyle}
      title={title}
      type="button"
      {...triggerAria}
    >
      {children}
    </button>
  );
}
