import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { TOP_BAND_HEIGHT, topBandRow, trafficLightInset } from "./topBand.ts";
import { ViewHeader } from "./ViewHeader.tsx";

vi.mock("../ipc/bridge.ts", () => ({
  repoStatus: vi.fn(() => Promise.resolve(null)),
}));

/**
 * ADR-0023 deleted the global title bar and made "every column owns its 46px
 * header" a structural invariant, stating the consequence itself: *a view
 * whose header forgets it is a view the user cannot drag the window from*.
 *
 * Nothing held that rule. These tests do — for the geometry through the
 * recipe, and for the two behaviours a header can silently forget: being a
 * drag region at all, and offering the way back to a collapsed sidebar when
 * it is the one sitting in the window's top-left corner.
 */

beforeEach(() => {
  useLayout.setState({ layout: { ...DEFAULT_LAYOUT } });
});

describe("the top band's geometry", () => {
  it("is 46px, on the ADR-0023 rhythm", () => {
    expect(TOP_BAND_HEIGHT).toBe(46);
    expect(topBandRow().height).toBe("46px");
  });

  it("never shrinks — the band is chrome, not content", () => {
    expect(topBandRow().flex).toBe("none");
  });

  it("draws a hairline unless its host says otherwise", () => {
    expect(topBandRow().borderBottom).toBeDefined();
    // The sidebar's strip is the one that draws none: the search box below
    // it already separates the strip from the rail.
    expect(topBandRow({ hairline: false })).not.toHaveProperty("borderBottom");
  });

  it("owes the traffic-light inset only when it is in that corner", () => {
    expect(trafficLightInset(true).paddingLeft).toBe("96px");
    expect(trafficLightInset(false)).not.toHaveProperty("paddingLeft");
  });
});

describe("a full view's header", () => {
  it("is a drag region — the window has no other handle here", () => {
    render(<ViewHeader testId="settings-header" title="Settings" />);
    expect(screen.getByTestId("settings-header")).toHaveAttribute(
      "data-tauri-drag-region"
    );
  });

  it("offers the way back when the sidebar is collapsed", () => {
    // With the sidebar collapsed this header IS the top-left corner, so it
    // carries both the clearance and the only control that brings the
    // sidebar back. Forgetting the second one strands the user.
    useLayout.setState((state) => ({
      layout: { ...state.layout, sidebarCollapsed: true },
    }));
    render(<ViewHeader testId="settings-header" title="Settings" />);

    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
    expect(screen.getByTestId("settings-header")).toHaveStyle({
      paddingLeft: "96px",
    });
  });

  it("carries neither while the sidebar is showing", () => {
    render(<ViewHeader testId="settings-header" title="Settings" />);
    expect(screen.queryByRole("button", { name: "Expand sidebar" })).toBeNull();
    expect(screen.getByTestId("settings-header")).toHaveStyle({
      paddingLeft: "20px",
    });
  });
});
