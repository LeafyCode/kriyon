/**
 * The window's **top band**: the 46px strip every column owns since ADR-0023
 * deleted the global title bar.
 *
 * The ADR states the invariant and its consequence in one breath — *a view
 * whose header forgets it is a view the user cannot drag the window from* —
 * and until this module there was nowhere for that rule to live. Six facts
 * were re-typed across five files: the height, the hairline, `flex: none`,
 * the drag region, the traffic-light clearance, and the way back to a
 * collapsed sidebar.
 *
 * This owns the *geometry* half of that. The behavioural half (which element
 * carries `data-tauri-drag-region`, and which header is currently the
 * window's top-left corner) stays in the headers themselves, because it is a
 * property of where a component sits in the tree, not of its style object —
 * and `layout/topBand.test.ts` is what holds the headers to it.
 *
 * A recipe module rather than a component, for ADR-0023's own reason: the
 * seam is a module-level style object referencing `var(--kr-*)`, so what is
 * worth sharing between five headers is the object, not a wrapper that would
 * force every call site to re-express its content as props.
 */

import type { CSSProperties } from "react";
import { tokens } from "../theme/tokens.ts";

/** The band's height. The 46 of ADR-0023's 30 / 32 / 46 row rhythm. */
export const TOP_BAND_HEIGHT = 46;

/**
 * The 96px the native traffic lights occupy in the top-left.
 * `titleBarStyle: "Overlay"` draws them over our content and
 * `env(titlebar-area-*)` is not wired for it on macOS, so this is a measured
 * constant rather than a query.
 *
 * It used to be the title bar's left padding; since ADR-0023 it belongs to
 * whatever is in the window's top-left corner — the sidebar's top strip, the
 * focus rail's spacer, or the main header when the sidebar is collapsed.
 *
 * It is a macOS fact, not a sidebar one — it lived in `sidebar/SidebarHeader`
 * only because that is where it was first typed, and `layout/` imported it
 * back out three times. It pairs with `trafficLightPosition` in
 * `src-tauri/tauri.conf.json`, which drops to `y: 23` to centre the lights in
 * a 46px strip.
 */
export const TRAFFIC_LIGHT_CLEARANCE = 96;

/**
 * One row of the top band.
 *
 * `hairline` is the only real variation among the five: the sidebar's top
 * strip draws none, because the search box below it already separates the
 * strip from the rail. Everything else differs by padding alone, which each
 * host passes.
 */
export function topBandRow(
  options: { hairline?: boolean; padding?: string } = {}
): CSSProperties {
  const { hairline = true, padding = "0 20px" } = options;
  return {
    alignItems: "center",
    ...(hairline
      ? { borderBottom: `1px solid ${tokens.color.line.base}` }
      : {}),
    display: "flex",
    flex: "none",
    gap: "10px",
    height: `${TOP_BAND_HEIGHT}px`,
    justifyContent: "space-between",
    padding,
  };
}

/**
 * The clearance a header owes when it is the one in the top-left corner.
 *
 * Spread it conditionally: a header is only in that corner while the sidebar
 * is collapsed (the sidebar's own strip is otherwise), and the Details rail
 * never is at all, being on the other side of the window.
 */
export function trafficLightInset(owed: boolean): CSSProperties {
  return owed ? { paddingLeft: `${TRAFFIC_LIGHT_CLEARANCE}px` } : {};
}
