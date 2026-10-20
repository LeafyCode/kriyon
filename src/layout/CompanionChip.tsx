import type { CSSProperties } from "react";
import type { CompanionStatus } from "../ipc/bridge.ts";
import { useLayout } from "../state/layout.ts";
import { chip } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { companionChip } from "./companionChip.ts";

const chipStyle: CSSProperties = {
  ...chip({}),
  cursor: "pointer",
  fontSize: "11.5px",
};

/**
 * The session header's companion chip: hidden when the companion is off. The
 * header owns the status (it gates a tab on it too), so it is passed in rather
 * than fetched and polled a second time here.
 */
export function CompanionChip({ status }: { status: CompanionStatus | null }) {
  const view = status ? companionChip(status) : null;
  if (!view) {
    return null;
  }
  const style: CSSProperties = {
    ...chipStyle,
    color: view.on ? tokens.color.status.running : tokens.color.ink.muted,
  };
  return (
    <button
      className="kr-focusable kr-hover-surface"
      data-testid="companion-chip"
      onClick={() => useLayout.getState().setView("settings")}
      style={style}
      title={view.title}
      type="button"
    >
      {view.on ? "◆" : "◇"} {view.label}
    </button>
  );
}
