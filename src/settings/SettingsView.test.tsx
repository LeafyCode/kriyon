import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { activityDeleteAll, previewNotifySound } from "../ipc/bridge.ts";
import { useIntegration } from "../state/integration.ts";
import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { useUpdates } from "../state/updates.ts";
import { THEMES } from "../theme/themes/index.ts";
import { SettingsView } from "./SettingsView.tsx";
import { matchingSections, SETTINGS_SECTIONS } from "./settingsSections.ts";

const NOW_THREE = /Now 3 sessions, 2\.0 MB/;
const KEPT_14 = /^Kept 14 days and up to 500\.0 MB, only on this Mac\./;
const RE_0 = /only in Kriyon's sessions/;
const RE_1 = /my-bar/;
const CALM = /^Calm/;
const TRIAGE = /^Triage/;

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

/** Settings shows one section at a time; open one from the side menu. */
function openSection(name: string) {
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "Settings sections" })
    ).getByRole("button", { name })
  );
}

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
  openSection("Integration");
  const group = screen.getByRole("region", {
    name: "What Kriyon adds to Claude Code",
  });
  expect(within(group).getByText(RE_0)).toBeInTheDocument();
  expect(within(group).getByText(RE_1)).toBeInTheDocument();

  const liveUsage = within(group).getByRole("switch", { name: "Live usage" });
  expect(liveUsage).toHaveAttribute("aria-checked", "true");
  fireEvent.click(liveUsage);
  expect(integrationUpdate).toHaveBeenCalledWith({
    ...PREFS,
    liveUsage: false,
  });
});

test("remove everything asks first, listing what goes", () => {
  render(<SettingsView />);
  openSection("Integration");
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
  openSection("Integration");
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
  const picker = screen.getByRole("group", { name: "Theme" });
  fireEvent.click(within(picker).getByRole("button", { name: "Nord" }));
  expect(useLayout.getState().layout.themeId).toBe("nord");
});

test("the theme picker lists every shipped theme, Steel selected by default", () => {
  render(<SettingsView />);
  const picker = screen.getByRole("group", { name: "Theme" });
  expect(
    within(picker)
      .getAllByRole("button")
      .map((option) => option.getAttribute("aria-label"))
  ).toEqual(THEMES.map((theme) => theme.label));
  expect(within(picker).getByRole("button", { name: "Steel" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
});

test("the sidebar-mode control reflects and updates the store", () => {
  render(<SettingsView />);
  openSection("Layout");
  const picker = screen.getByRole("group", { name: "Sidebar" });
  expect(within(picker).getByRole("button", { name: CALM })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  fireEvent.click(within(picker).getByRole("button", { name: TRIAGE }));
  expect(useLayout.getState().layout.sidebarMode).toBe("triage");
});

test("the notifications control reflects and updates the store", () => {
  render(<SettingsView />);
  openSection("Notifications");
  const notifications = screen.getByRole("tablist", { name: "Notifications" });
  fireEvent.click(within(notifications).getByRole("tab", { name: "Off" }));
  expect(useLayout.getState().layout.notifyPreference).toBe("none");
});

test("the memory warnings control reflects and updates the store", () => {
  render(<SettingsView />);
  openSection("Sessions");
  fireEvent.click(screen.getByRole("switch", { name: "Memory warnings" }));
  expect(useLayout.getState().layout.memoryWarnEnabled).toBe(false);
});

test("the memory budget control reflects and updates the store", () => {
  render(<SettingsView />);
  openSection("Sessions");
  fireEvent.click(screen.getByRole("tab", { name: "8 GB" }));
  expect(useLayout.getState().layout.memoryBudgetMb).toBe(8192);
});

test("the menu-bar control reflects and updates the store", () => {
  render(<SettingsView />);
  openSection("Layout");
  fireEvent.click(screen.getByRole("tab", { name: "Compact" }));
  expect(useLayout.getState().layout.menuBarMode).toBe("compact");
});

test("the sound control reflects and updates the store", () => {
  render(<SettingsView />);
  openSection("Notifications");
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
  openSection("Notifications");
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
  openSection("Notifications");
  expect(
    screen.getByRole("button", { name: "Preview notification sound" })
  ).toBeDisabled();
});

test("the companion switch turns the opt-in mod on", () => {
  render(<SettingsView />);
  openSection("Integration");
  fireEvent.click(screen.getByRole("switch", { name: "Kriyon Companion" }));
  expect(integrationUpdate).toHaveBeenCalledWith({ ...PREFS, companion: true });
});

test("the activity log shows its retention and deletes all after a confirm", async () => {
  render(<SettingsView />);
  openSection("Activity log");
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
  openSection("Integration");
  fireEvent.click(screen.getByRole("button", { name: "Try the plugin again" }));
  expect(integrationUpdate).toHaveBeenCalledWith({
    ...PREFS,
    sideloadRefused: false,
  });
});

test("the busy limit takes a typed number, or no limit", () => {
  render(<SettingsView />);
  openSection("Sessions");
  const field = screen.getByRole("spinbutton", { name: "Most busy at once" });
  fireEvent.change(field, { target: { value: "3" } });
  fireEvent.blur(field);
  expect(useLayout.getState().layout.nestedSessionCap).toBe(3);

  // A number out of range is put back, not saved.
  fireEvent.change(field, { target: { value: "40" } });
  fireEvent.blur(field);
  expect(useLayout.getState().layout.nestedSessionCap).toBe(3);
  expect(field).toHaveValue(3);

  const none = screen.getByRole("checkbox", { name: "No limit" });
  fireEvent.click(none);
  expect(useLayout.getState().layout.nestedSessionCap).toBeNull();
  expect(field).toBeDisabled();
  // Turning the limit back on brings back the number they had.
  fireEvent.click(none);
  expect(useLayout.getState().layout.nestedSessionCap).toBe(3);
});

test("the busy limit steps up and down within its range", () => {
  useLayout.setState({ layout: { ...DEFAULT_LAYOUT, nestedSessionCap: 15 } });
  render(<SettingsView />);
  openSection("Sessions");
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  expect(useLayout.getState().layout.nestedSessionCap).toBe(16);
  expect(screen.getByRole("button", { name: "More" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Fewer" }));
  expect(useLayout.getState().layout.nestedSessionCap).toBe(15);
});

test("shows one section at a time, Appearance first", () => {
  render(<SettingsView />);
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  expect(
    within(nav).getByRole("button", { name: "Appearance" })
  ).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("group", { name: "Theme" })).toBeInTheDocument();
  expect(screen.queryByRole("tablist", { name: "Memory budget" })).toBeNull();

  openSection("Sessions");
  expect(
    screen.getByRole("tablist", { name: "Memory budget" })
  ).toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Theme" })).toBeNull();
});

test("search narrows the side menu and opens the first match", () => {
  render(<SettingsView />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), {
    target: { value: "budget" },
  });
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  expect(
    within(nav)
      .getAllByRole("button")
      .map((item) => item.textContent)
  ).toEqual(["Sessions"]);
  expect(
    screen.getByRole("tablist", { name: "Memory budget" })
  ).toBeInTheDocument();
});

test("a search that matches nothing says so", () => {
  render(<SettingsView />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), {
    target: { value: "zzzz" },
  });
  expect(screen.getByText("No settings match “zzzz”.")).toBeInTheDocument();
});

test("the theme filter shows only light or dark themes", () => {
  render(<SettingsView />);
  fireEvent.click(
    within(screen.getByRole("tablist", { name: "Show themes" })).getByRole(
      "tab",
      {
        name: "Light",
      }
    )
  );
  const picker = screen.getByRole("group", { name: "Theme" });
  expect(
    within(picker)
      .getAllByRole("button")
      .map((option) => option.getAttribute("aria-label"))
  ).toEqual(
    THEMES.filter((theme) => theme.appearance === "light").map(
      (theme) => theme.label
    )
  );
});

test("every setting a section shows can be found by searching its name", () => {
  // Show the rows that only appear in some states, so they are checked too.
  useUpdates.setState({
    snapshot: {
      available: null,
      checking: false,
      error: null,
      lastCheckedMs: null,
      prefs: { autoCheck: true, channel: "stable", skipped: null },
      running: "1.0.0",
      supported: true,
    },
  });
  const { status } = useIntegration.getState();
  if (!status) {
    throw new Error("status set in beforeEach");
  }
  useIntegration.setState({
    status: { ...status, prefs: { ...PREFS, sideloadRefused: true } },
  });
  const missed: string[] = [];
  for (const section of SETTINGS_SECTIONS) {
    const { container, unmount } = render(<SettingsView />);
    openSection(section.label);
    // Every name the page shows for a setting or one of its choices: row
    // labels, segment tabs, picker cards and swatches, dropdown options. The
    // theme filter's tabs pick what the picker shows, not a setting.
    const filter = container.querySelector('[aria-label="Show themes"]');
    const choices = Array.from(
      container.querySelectorAll('[role="tab"], [aria-pressed], option')
    ).filter((choice) => !filter?.contains(choice));
    const names = [
      ...Array.from(container.querySelectorAll("[data-setting-label]")).map(
        (label) => label.textContent ?? ""
      ),
      ...choices.map(
        (choice) =>
          choice.getAttribute("aria-label") ?? choice.textContent ?? ""
      ),
    ].filter((name) => name.trim() !== "");
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      if (!matchingSections(name).includes(section.id)) {
        missed.push(`${section.label}: ${name}`);
      }
    }
    unmount();
  }
  expect(missed).toEqual([]);
});

test("each section's page is titled the same as its side-menu entry", () => {
  render(<SettingsView />);
  for (const section of SETTINGS_SECTIONS) {
    openSection(section.label);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      section.label
    );
  }
});
