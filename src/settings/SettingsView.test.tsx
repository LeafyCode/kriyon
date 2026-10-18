import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { activityDeleteAll, previewNotifySound } from "../ipc/bridge.ts";
import { useIntegration } from "../state/integration.ts";
import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { THEMES } from "../theme/themes/index.ts";
import { SettingsView } from "./SettingsView.tsx";

const NOW_THREE = /Now 3 sessions, 2\.0 MB/;
const KEPT_14 = /^Kept 14 days and up to 500\.0 MB, only on this Mac\./;
const RE_0 = /only in Kriyon's sessions/;
const RE_1 = /my-bar/;

vi.mock("../ipc/bridge.ts", () => ({
  activityDeleteAll: vi.fn(() => Promise.resolve()),
  activityStats: vi.fn(() =>
    Promise.resolve({
      retentionDays: 14,
      sessions: 3,
      sizeBytes: 2 * 1024 * 1024,
      sizeCapBytes: 500 * 1024 * 1024,
    })
  ),
  previewNotifySound: vi.fn(() => Promise.resolve()),
}));

const integrationUpdate = vi.fn(() => Promise.resolve());
const PREFS = {
  companion: false,
  consented: true,
  liveUsage: true,
  sideloadRefused: false,
  statusHooks: true,
};

beforeEach(() => {
  useLayout.setState({ layout: { ...DEFAULT_LAYOUT } });
  integrationUpdate.mockClear();
  useIntegration.setState({
    error: null,
    status: {
      companionDir: "/h/.claude/kriyon/companion/1",
      originalStatusLine: "my-bar",
      prefs: PREFS,
      companionAvailable: true,
      plannedReason: "plugin",
      plannedRoute: "plugin",
      route: "plugin",
      routeReason: "plugin",
      sideload: "allowed",
    },
    update: integrationUpdate,
  });
});

test("lists what Kriyon adds to Claude Code, with switches", () => {
  render(<SettingsView />);
  const group = screen.getByRole("region", {
    name: "What Kriyon adds to Claude Code",
  });
  expect(within(group).getByText(RE_0)).toBeInTheDocument();
  expect(within(group).getByText(RE_1)).toBeInTheDocument();

  fireEvent.click(
    within(
      within(group).getByRole("tablist", { name: "Live usage" })
    ).getByRole("tab", { name: "Off" })
  );
  expect(integrationUpdate).toHaveBeenCalledWith({
    ...PREFS,
    liveUsage: false,
  });
});

test("remove everything asks first, listing what goes", () => {
  render(<SettingsView />);
  fireEvent.click(
    screen.getByRole("button", { name: "Remove from Claude Code" })
  );
  expect(integrationUpdate).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog");
  expect(
    within(dialog).getByText("Remove Kriyon from Claude Code?")
  ).toBeInTheDocument();
  const lines = within(dialog)
    .getAllByRole("listitem")
    .map((item) => item.textContent);
  expect(lines).toEqual([
    "•Status hooks: session status and the activity log stop",
    "•Live usage: your status line goes back to “my-bar”",
  ]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(integrationUpdate).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("remove everything, once confirmed, turns every addition off", () => {
  render(<SettingsView />);
  fireEvent.click(
    screen.getByRole("button", { name: "Remove from Claude Code" })
  );
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" })
  );
  expect(integrationUpdate).toHaveBeenCalledWith({
    ...PREFS,
    companion: false,
    liveUsage: false,
    statusHooks: false,
  });
});

test("renders the settings page", () => {
  render(<SettingsView />);
  expect(screen.getByTestId("settings-view")).toBeInTheDocument();
});

test("fills the shell's main area rather than shrinking to its content", () => {
  // Since ADR-0023 the shell is a ROW, and this view is one of its flex
  // children. `height: 100%` was the main axis under the old column shell and
  // is the cross axis now, so without an explicit grow this view — and its
  // 46px header and bottom hairline — would stop at the reading column's
  // width and leave the rest of the window bare. jsdom does no layout, so
  // only the declaration itself can be pinned here.
  render(<SettingsView />);
  expect(screen.getByTestId("settings-view")).toHaveStyle({
    flex: "1",
    minWidth: "0px",
  });
});

test("the theme control reflects and updates the store", () => {
  render(<SettingsView />);
  fireEvent.click(screen.getByRole("tab", { name: "Teal" }));
  expect(useLayout.getState().layout.themeId).toBe("teal");
});

test("the theme picker lists every shipped theme, Steel selected by default", () => {
  render(<SettingsView />);
  const picker = screen.getByRole("tablist", { name: "Theme" });
  expect(
    within(picker)
      .getAllByRole("tab")
      .map((tab) => tab.textContent)
  ).toEqual(THEMES.map((theme) => theme.label));
  expect(within(picker).getByRole("tab", { name: "Steel" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
});

test("the sidebar-mode control reflects and updates the store", () => {
  render(<SettingsView />);
  fireEvent.click(screen.getByRole("tab", { name: "Triage" }));
  expect(useLayout.getState().layout.sidebarMode).toBe("triage");
});

test("the notifications control reflects and updates the store", () => {
  render(<SettingsView />);
  const notifications = screen.getByRole("tablist", { name: "Notifications" });
  fireEvent.click(within(notifications).getByRole("tab", { name: "Off" }));
  expect(useLayout.getState().layout.notifyPreference).toBe("none");
});

test("the memory warnings control reflects and updates the store", () => {
  render(<SettingsView />);
  const warnings = screen.getByRole("tablist", { name: "Memory warnings" });
  fireEvent.click(within(warnings).getByRole("tab", { name: "Off" }));
  expect(useLayout.getState().layout.memoryWarnEnabled).toBe(false);
});

test("the memory budget control reflects and updates the store", () => {
  render(<SettingsView />);
  fireEvent.click(screen.getByRole("tab", { name: "8 GB" }));
  expect(useLayout.getState().layout.memoryBudgetMb).toBe(8192);
});

test("the menu-bar control reflects and updates the store", () => {
  render(<SettingsView />);
  fireEvent.click(screen.getByRole("tab", { name: "Compact" }));
  expect(useLayout.getState().layout.menuBarMode).toBe("compact");
});

test("the sound control reflects and updates the store", () => {
  render(<SettingsView />);
  fireEvent.change(screen.getByLabelText("Notification sound"), {
    target: { value: "marimba" },
  });
  expect(useLayout.getState().layout.notifySound).toBe("marimba");
});

test("the preview button plays the selected sound", () => {
  useLayout.setState({
    layout: { ...DEFAULT_LAYOUT, notifySound: "bell" },
  });
  render(<SettingsView />);
  fireEvent.click(
    screen.getByRole("button", { name: "Preview notification sound" })
  );
  expect(previewNotifySound).toHaveBeenCalledWith("bell");
});

test("the preview button is disabled for Silent", () => {
  useLayout.setState({
    layout: { ...DEFAULT_LAYOUT, notifySound: "silent" },
  });
  render(<SettingsView />);
  expect(
    screen.getByRole("button", { name: "Preview notification sound" })
  ).toBeDisabled();
});

test("the companion switch turns the opt-in mod on", () => {
  render(<SettingsView />);
  fireEvent.click(
    within(screen.getByRole("tablist", { name: "Kriyon Companion" })).getByRole(
      "tab",
      { name: "On" }
    )
  );
  expect(integrationUpdate).toHaveBeenCalledWith({ ...PREFS, companion: true });
});

test("the activity log shows its retention and deletes all after a confirm", async () => {
  render(<SettingsView />);
  expect(await screen.findByText(NOW_THREE)).toBeInTheDocument();
  expect(screen.getByText(KEPT_14)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Delete all…" }));
  expect(activityDeleteAll).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete all activity" }));
  expect(activityDeleteAll).toHaveBeenCalled();
});

test("a refused plugin can be tried again", () => {
  const { status } = useIntegration.getState();
  if (!status) {
    throw new Error("status set in beforeEach");
  }
  useIntegration.setState({
    status: { ...status, prefs: { ...PREFS, sideloadRefused: true } },
  });
  render(<SettingsView />);
  fireEvent.click(screen.getByRole("button", { name: "Try the plugin again" }));
  expect(integrationUpdate).toHaveBeenCalledWith({
    ...PREFS,
    sideloadRefused: false,
  });
});
