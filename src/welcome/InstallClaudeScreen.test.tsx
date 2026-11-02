import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { findClaudeCli } from "../ipc/bridge.ts";
import { useClaudeCli } from "../state/claudeCli.ts";
import { pretendPlatform } from "../test/platform.ts";
import { InstallClaudeScreen } from "./InstallClaudeScreen.tsx";

vi.mock("../ipc/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/bridge.ts")>()),
  findClaudeCli: vi.fn(),
}));

const PS_INSTALL = /install\.ps1/;
const SH_INSTALL = /install\.sh/;
const OPEN_TERMINAL = /Open Terminal/;
const OPEN_POWERSHELL = /Open PowerShell/;

let restorePlatform: () => void = () => undefined;
afterEach(() => restorePlatform());
beforeEach(() => {
  useClaudeCli.setState({
    checking: false,
    result: { state: "missing" },
    skipped: false,
  });
});

test("on a Mac it gives the official Terminal install command", () => {
  restorePlatform = pretendPlatform("mac");
  render(<InstallClaudeScreen />);
  expect(
    screen.getByText("curl -fsSL https://claude.ai/install.sh | bash")
  ).toBeInTheDocument();
  expect(screen.queryByText(PS_INSTALL)).not.toBeInTheDocument();
  expect(screen.getByText(OPEN_TERMINAL)).toBeInTheDocument();
});

test("on Windows it gives the official PowerShell install command", () => {
  restorePlatform = pretendPlatform("windows");
  render(<InstallClaudeScreen />);
  expect(
    screen.getByText("irm https://claude.ai/install.ps1 | iex")
  ).toBeInTheDocument();
  expect(screen.queryByText(SH_INSTALL)).not.toBeInTheDocument();
  expect(screen.getByText(OPEN_POWERSHELL)).toBeInTheDocument();
});

test("check again runs the check, and continue anyway skips it", () => {
  restorePlatform = pretendPlatform("mac");
  vi.mocked(findClaudeCli).mockResolvedValue({ state: "missing" });
  render(<InstallClaudeScreen />);
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(findClaudeCli).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Continue anyway" }));
  expect(useClaudeCli.getState().skipped).toBe(true);
});
