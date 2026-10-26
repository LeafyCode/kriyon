import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../state/nestedSessions.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/nestedSessions.ts")>()),
  startNestedSession: vi.fn(() => Promise.resolve({ error: null, ok: true })),
}));
vi.mock("../ui/Toast.tsx", () => ({ showToast: vi.fn() }));

import {
  startNestedSession,
  useSessionProposals,
} from "../state/nestedSessions.ts";
import { useSessions } from "../state/sessions.ts";
import type { SessionRequest } from "../types.ts";
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
  vi.mocked(startNestedSession).mockClear();
  useSessions.setState({ activeSessionId: "lead" });
  useSessionProposals.setState({
    proposals: [{ leadSessionId: "lead", request: REQUEST }],
  });
});
afterEach(cleanup);

test("shows the active session's suggestions with the task, and starts one on request", async () => {
  render(<SessionProposals />);
  const card = screen.getByTestId("session-proposal-tu9");
  expect(card).toHaveTextContent("Claude suggests a session");
  expect(card).toHaveTextContent("Changelog");
  expect(card).toHaveTextContent("Update the changelog for the release");
  fireEvent.click(screen.getByLabelText("Own worktree"));
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  await vi.waitFor(() =>
    expect(useSessionProposals.getState().proposals).toEqual([])
  );
  expect(startNestedSession).toHaveBeenCalledWith(
    "lead",
    expect.objectContaining({ title: "Changelog", worktree: true }),
    { focus: false }
  );
});

test("not now drops the suggestion without starting anything", () => {
  render(<SessionProposals />);
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(useSessionProposals.getState().proposals).toEqual([]);
  expect(startNestedSession).not.toHaveBeenCalled();
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
    "You asked for this session · held back by your limit on busy sessions"
  );
  expect(card).not.toHaveTextContent("Claude suggests");
});
