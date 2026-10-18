import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { UpdateSnapshot } from "../ipc/bridge.ts";
import { useUpdates } from "../state/updates.ts";
import { UpdatePill } from "./UpdatePill.tsx";

const snapshot: UpdateSnapshot = {
  available: {
    installable: true,
    notes: null,
    offer: "upgrade",
    version: "0.13.0",
  },
  checking: false,
  error: null,
  lastCheckedMs: 1,
  prefs: { autoCheck: true, channel: "stable", skipped: null },
  running: "0.12.0",
  supported: true,
};

beforeEach(() => {
  useUpdates.setState({ dialogOpen: false, snapshot: null });
});

describe("UpdatePill", () => {
  it("shows an icon and names the version it offers", () => {
    useUpdates.setState({ snapshot });
    render(<UpdatePill />);
    const pill = screen.getByTestId("update-pill");
    expect(pill.textContent).toBe("Update available");
    expect(pill.querySelector("svg")).not.toBeNull();
    expect(pill.title).toBe("Kriyon 0.13.0 is ready to install");
    // Painted through --kr-fill, so the hover class can still light it.
    expect(pill.style.background).toBe("");
  });

  it("opens the update dialog", () => {
    useUpdates.setState({ snapshot });
    render(<UpdatePill />);
    fireEvent.click(screen.getByTestId("update-pill"));
    expect(useUpdates.getState().dialogOpen).toBe(true);
  });

  it("is hidden when nothing can be installed", () => {
    useUpdates.setState({
      snapshot: { ...snapshot, available: null },
    });
    render(<UpdatePill />);
    expect(screen.queryByTestId("update-pill")).toBeNull();
  });
});
