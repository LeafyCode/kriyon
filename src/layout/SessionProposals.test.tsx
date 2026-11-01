import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../state/nestedSessions.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/nestedSessions.ts")>()),
  startProposal: vi.fn(() =>
    Promise.resolve({ bootstrap: null, error: null, ok: true })
  ),
}));
vi.mock("../ui/Toast.tsx", () => ({ showToast: vi.fn() }));

import { startProposal, useSessionProposals } from "../state/nestedSessions.ts";
import { useSessions } from "../state/sessions.ts";
import type { SessionRequest } from "../types.ts";
import { showToast } from "../ui/Toast.tsx";
import { SessionProposals } from "./SessionProposals.tsx";

const REQUEST: SessionRequest = {
  branch: null,
  initiation: "own_initiative",
  prompt: "Update the changelog for the release",
  requestId: "tu9",
  title: "Changelog",
  worktree: false,
};

beforeEach(() => {
  vi.mocked(startProposal).mockClear();
  vi.mocked(showToast).mockClear();
  useSessions.setState({ activeSessionId: "lead" });
  useSessionProposals.setState({
    proposals: [{ leadSessionId: "lead", request: REQUEST }],
    starting: [],
  });
});
afterEach(cleanup);

test("shows the active session's suggestions with the task, and starts one on request", async () => {
  render(<SessionProposals />);
  const card = screen.getByTestId("session-proposal-tu9");
  expect(card).toHaveTextContent("Suggested by Claude");
  expect(card).toHaveTextContent("Changelog");
  expect(card).toHaveTextContent("Update the changelog for the release");
  fireEvent.click(screen.getByLabelText("Own worktree"));
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  await vi.waitFor(() =>
    expect(showToast).toHaveBeenCalledWith("Started “Changelog”", "success")
  );
  expect(startProposal).toHaveBeenCalledWith(
    { leadSessionId: "lead", request: REQUEST },
    true
  );
});

test("a card whose request a freed slot is already starting says nothing", async () => {
  vi.mocked(startProposal).mockResolvedValueOnce(null);
  render(<SessionProposals />);
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  await vi.waitFor(() => expect(startProposal).toHaveBeenCalled());
  await Promise.resolve();
  expect(showToast).not.toHaveBeenCalled();
});

test("a card whose request a freed slot is starting can't be started or put off", () => {
  useSessionProposals.setState({ starting: ["tu9"] });
  render(<SessionProposals />);
  expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Not now" })).toBeDisabled();
});

test("not now drops the suggestion without starting anything", () => {
  render(<SessionProposals />);
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(useSessionProposals.getState().proposals).toEqual([]);
  expect(startProposal).not.toHaveBeenCalled();
});

test("another session's suggestions stay off this one", () => {
  useSessions.setState({ activeSessionId: "other" });
  render(<SessionProposals />);
  expect(screen.queryByTestId("session-proposals")).not.toBeInTheDocument();
});

test("a session you asked for that hit your limit says so, not that Claude suggested it", () => {
  useSessionProposals.setState({
    proposals: [
      {
        leadSessionId: "lead",
        request: { ...REQUEST, initiation: "user_asked" },
      },
    ],
  });
  useSessions.setState({ activeSessionId: "lead" });
  render(<SessionProposals />);
  const card = screen.getByTestId("session-proposal-tu9");
  expect(card).toHaveTextContent(
    "You asked · starts when a busy session finishes"
  );
  expect(card).not.toHaveTextContent("Suggested by Claude");
});

test("a suggestion that starts but whose worktree setup fails says so", async () => {
  vi.mocked(startProposal).mockResolvedValueOnce({
    bootstrap: { ok: false, output: "boom", steps: [] },
    error: null,
    ok: false,
  });
  render(<SessionProposals />);
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  await vi.waitFor(() =>
    expect(showToast).toHaveBeenCalledWith(
      "“Changelog”: it started, but the worktree's setup step failed",
      "error"
    )
  );
});

test("a suggestion whose worktree install fails names the install, not the setup", async () => {
  vi.mocked(startProposal).mockResolvedValueOnce({
    bootstrap: {
      ok: false,
      output: "pnpm was not found",
      steps: [{ label: "install (pnpm install)", ok: false }],
    },
    error: null,
    ok: false,
  });
  render(<SessionProposals />);
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  await vi.waitFor(() =>
    expect(showToast).toHaveBeenCalledWith(
      "“Changelog”: it started, but the worktree's install (pnpm install) failed",
      "error"
    )
  );
});

test("a long task stays folded to one line until opened, then scrolls in a capped box", () => {
  render(<SessionProposals />);
  expect(screen.queryByTestId("proposal-task-tu9")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show task" }));
  const task = screen.getByTestId("proposal-task-tu9");
  expect(task).toHaveTextContent("Update the changelog for the release");
  expect(task).toHaveStyle({ overflowY: "auto" });
  fireEvent.click(screen.getByRole("button", { name: "Hide task" }));
  expect(screen.queryByTestId("proposal-task-tu9")).not.toBeInTheDocument();
});
