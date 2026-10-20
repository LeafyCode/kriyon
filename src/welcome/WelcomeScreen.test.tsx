import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import {
  activityStats,
  DEFAULT_INTEGRATION_PREFS,
  type IntegrationStatus,
  quitApp,
} from "../ipc/bridge.ts";
import { useIntegration } from "../state/integration.ts";
import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { WelcomeScreen } from "./WelcomeScreen.tsx";

const RE_0 = /Status hooks/;
const RE_1 = /Live usage and plan limits/;
const RE_2 = /Activity log/;
const RE_3 = /not affiliated with Anthropic/;
const RE_4 = /only in Kriyon's sessions/;
const RE_5 = /Live usage/;
const RE_6 = /Cancel and quit/;
const RE_7 = /organization blocks per-session plugins/;
const COMES_WITH_HOOKS = /Comes with status hooks/;
const LOG_EMPTY = /stays empty while status hooks are off/;
const COMPANION_UNAVAILABLE = /which your setup doesn't allow/;
const KEPT_14 = /Kept 14 days, only on this Mac\./;
const KEPT_30 = /Kept 30 days, only on this Mac\./;

vi.mock("../ipc/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/bridge.ts")>()),
  activityStats: vi.fn(),
  quitApp: vi.fn(() => Promise.resolve()),
}));

const status: IntegrationStatus = {
  companionDir: null,
  originalStatusLine: null,
  prefs: DEFAULT_INTEGRATION_PREFS,
  companionAvailable: true,
  plannedReason: "plugin",
  plannedRoute: "plugin",
  route: "off",
  routeReason: "off",
  sideload: "allowed",
};

const update = vi.fn(() => Promise.resolve());

beforeEach(() => {
  update.mockClear();
  vi.mocked(activityStats).mockResolvedValue({
    retentionDays: 14,
    sessions: 0,
    sizeBytes: 0,
    sizeCapBytes: 0,
  });
  useIntegration.setState({ error: null, status, update });
});

test("explains each thing Kriyon adds before anything is written", () => {
  render(<WelcomeScreen />);
  expect(screen.getByText(RE_0)).toBeInTheDocument();
  expect(screen.getByText(RE_1)).toBeInTheDocument();
  expect(screen.getByText(RE_2)).toBeInTheDocument();
  expect(screen.getByText(RE_3)).toBeInTheDocument();
  expect(screen.getByText(RE_4)).toBeInTheDocument();
});

function choose(name: string | RegExp, option: "On" | "Off") {
  fireEvent.click(
    within(screen.getByRole("tablist", { name })).getByRole("tab", {
      name: option,
    })
  );
}

test("continue gives consent with the choices made", () => {
  render(<WelcomeScreen />);
  choose(RE_5, "Off");
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(update).toHaveBeenCalledWith({
    ...DEFAULT_INTEGRATION_PREFS,
    consented: true,
    liveUsage: false,
  });
});

test("every choice is a switch, so it's clear what can be turned off", () => {
  render(<WelcomeScreen />);
  for (const name of ["Status hooks", "Live usage", "Kriyon Companion"]) {
    expect(screen.getByRole("tablist", { name })).toBeInTheDocument();
  }
  expect(screen.getByText(COMES_WITH_HOOKS)).toBeInTheDocument();
});

test("the companion is offered on, and can be turned off here", () => {
  render(<WelcomeScreen />);
  const companion = screen.getByRole("tablist", { name: "Kriyon Companion" });
  expect(within(companion).getByRole("tab", { name: "On" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  choose("Kriyon Companion", "Off");
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(update).toHaveBeenCalledWith({
    ...DEFAULT_INTEGRATION_PREFS,
    companion: false,
    consented: true,
  });
});

test("with status hooks off, the companion can't be on and the log stays empty", () => {
  render(<WelcomeScreen />);
  choose("Kriyon Companion", "On");
  choose("Status hooks", "Off");
  expect(
    within(screen.getByRole("tablist", { name: "Kriyon Companion" })).getByRole(
      "tab",
      { name: "On" }
    )
  ).toBeDisabled();
  expect(screen.getByText(LOG_EMPTY)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(update).toHaveBeenCalledWith({
    ...DEFAULT_INTEGRATION_PREFS,
    companion: false,
    consented: true,
    statusHooks: false,
  });
});

test("a setup that can't run the companion says why, with no switch", () => {
  useIntegration.setState({
    status: { ...status, companionAvailable: false },
  });
  render(<WelcomeScreen />);
  expect(
    screen.queryByRole("tablist", { name: "Kriyon Companion" })
  ).not.toBeInTheDocument();
  expect(screen.getByText(COMPANION_UNAVAILABLE)).toBeInTheDocument();
});

test("cancel quits the app", () => {
  render(<WelcomeScreen />);
  fireEvent.click(screen.getByRole("button", { name: RE_6 }));
  expect(quitApp).toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

test("an org that blocks plugins is told where the hooks go instead", () => {
  useIntegration.setState({
    status: {
      ...status,
      plannedReason: "orgBlocks",
      plannedRoute: "settings",
      sideload: "blocked",
    },
  });
  render(<WelcomeScreen />);
  expect(screen.getByText(RE_7)).toBeInTheDocument();
});

test("a failed integration read offers retry and quit, not a dead end", () => {
  const load = vi.fn(() => Promise.resolve());
  useIntegration.setState({
    error: "settings.json is not valid JSON",
    load,
    status: null,
  });
  render(<WelcomeScreen />);
  expect(
    screen.getByText("settings.json is not valid JSON")
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(load).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: RE_6 }));
  expect(quitApp).toHaveBeenCalledWith("stopAll");
});

test("the activity log's retention comes from the backend", async () => {
  render(<WelcomeScreen />);
  expect(await screen.findByText(KEPT_14)).toBeInTheDocument();
});

test("the retention falls back to 30 days when the backend can't say", async () => {
  vi.mocked(activityStats).mockRejectedValue(new Error("store locked"));
  render(<WelcomeScreen />);
  expect(await screen.findByText(KEPT_30)).toBeInTheDocument();
});

test("sessions can open in the Structured view once the companion is on", () => {
  useLayout.setState({ layout: DEFAULT_LAYOUT });
  render(<WelcomeScreen />);
  const opensIn = screen.getByRole("tablist", { name: "Open sessions in" });
  choose("Kriyon Companion", "Off");
  expect(
    within(opensIn).getByRole("tab", { name: "Structured" })
  ).toBeDisabled();
  choose("Kriyon Companion", "On");
  fireEvent.click(within(opensIn).getByRole("tab", { name: "Structured" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(useLayout.getState().layout.preferredSessionView).toBe("structured");
});
