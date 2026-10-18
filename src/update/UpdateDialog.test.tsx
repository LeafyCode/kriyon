import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { UpdateSnapshot } from "../ipc/bridge.ts";
import { useUpdates } from "../state/updates.ts";
import { UpdateDialog } from "./UpdateDialog.tsx";

const snapshot: UpdateSnapshot = {
  available: {
    installable: true,
    notes: "### Features\n- Auto-update",
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

function show(next: UpdateSnapshot, extra = {}) {
  useUpdates.setState({ dialogOpen: true, snapshot: next, ...extra });
  render(<UpdateDialog />);
}

beforeEach(() => {
  useUpdates.setState({
    dialogOpen: false,
    error: null,
    installing: false,
    progress: null,
    snapshot: null,
  });
});

describe("UpdateDialog", () => {
  it("shows the notes, skip and install for an upgrade", () => {
    show(snapshot);
    expect(screen.getByTestId("update-notes").textContent).toContain(
      "Auto-update"
    );
    expect(screen.getByText("Skip this version")).toBeTruthy();
    expect(screen.getByTestId("update-install").textContent).toBe(
      "Install & restart"
    );
  });

  it("draws the notes' Markdown instead of showing its marks", () => {
    show({
      ...snapshot,
      available: {
        ...snapshot.available,
        notes:
          "### Fixed\n\n- Keep **every** turn (#8)\n- Show `stapler` output",
      },
    } as UpdateSnapshot);
    const notes = screen.getByTestId("update-notes");
    expect(notes.textContent).not.toContain("###");
    expect(notes.textContent).not.toContain("**");
    expect(notes.querySelectorAll("li")).toHaveLength(2);
    expect(notes.querySelector("strong")?.textContent).toBe("every");
    expect(notes.querySelector("code")?.textContent).toBe("stapler");
  });

  it("offers no install when the step-down has to wait", () => {
    show({
      ...snapshot,
      available: {
        installable: false,
        notes: null,
        offer: "waitForChannel",
        version: "0.12.4",
      },
      running: "0.14.0-beta.1",
    });
    expect(screen.queryByTestId("update-install")).toBeNull();
    expect(screen.getByText("Wait for the next stable release")).toBeTruthy();
  });

  it("shows download progress while installing", () => {
    show(snapshot, { installing: true, progress: { downloaded: 1, total: 4 } });
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByTestId("update-install").textContent).toBe(
      "Installing…"
    );
  });

  it("renders nothing while closed", () => {
    useUpdates.setState({ dialogOpen: false, snapshot });
    render(<UpdateDialog />);
    expect(screen.queryByTestId("update-dialog")).toBeNull();
  });
});
