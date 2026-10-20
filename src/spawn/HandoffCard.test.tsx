import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { useHandoffs } from "../state/handoffs.ts";
import { type UiSession, useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import { HandoffCards } from "./HandoffCard.tsx";

const PATH = "/tmp/handoff-1.md";

function session(id: string, title: string): UiSession {
  return {
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "/repo",
    id,
    projectId: "p1",
    status: "done",
    summary: "",
    title,
    titleLocked: false,
    worktreePath: null,
  };
}

beforeEach(() => {
  useSessions.setState({ sessions: { s1: session("s1", "Big refactor") } });
  useHandoffs.setState({ ready: {} });
  useUi.setState({ spawnOpen: false, spawnSeed: null });
});

test("nothing shows until a handoff is ready", () => {
  render(<HandoffCards />);
  expect(screen.queryByTestId("handoff-card-s1")).toBeNull();
});

test("a ready handoff asks to open it in a new session", () => {
  useHandoffs.getState().show("s1", PATH);
  render(<HandoffCards />);
  const card = screen.getByTestId("handoff-card-s1");
  expect(card).toHaveTextContent("Handoff ready");
  expect(card).toHaveTextContent("Big refactor");
  expect(card).toHaveTextContent("Open in a new session?");
});

test("Open opens the spawn dialog seeded with the file, and clears the card", () => {
  useHandoffs.getState().show("s1", PATH);
  render(<HandoffCards />);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  const ui = useUi.getState();
  expect(ui.spawnOpen).toBe(true);
  expect(ui.spawnPredecessorId).toBe("s1");
  expect(ui.spawnSeed).toBe(`Read ${PATH} and continue.`);
  expect(screen.queryByTestId("handoff-card-s1")).toBeNull();
});

test("Open seeds the handoff's own prompt when the backend sent one", () => {
  useHandoffs
    .getState()
    .show("s1", PATH, "Fix the chip.\n\n(Handoff: /tmp/handoff-1.md)");
  render(<HandoffCards />);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(useUi.getState().spawnSeed).toBe(
    "Fix the chip.\n\n(Handoff: /tmp/handoff-1.md)"
  );
});

test("Copy path copies the file path", () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.assign(navigator, { clipboard: { writeText } });
  useHandoffs.getState().show("s1", PATH);
  render(<HandoffCards />);
  fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
  expect(writeText).toHaveBeenCalledWith(PATH);
});

test("Dismiss clears the card without opening anything", () => {
  useHandoffs.getState().show("s1", PATH);
  render(<HandoffCards />);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByTestId("handoff-card-s1")).toBeNull();
  expect(useUi.getState().spawnOpen).toBe(false);
});

test("a handoff for a closed session shows nothing", () => {
  useHandoffs.getState().show("gone", PATH);
  render(<HandoffCards />);
  expect(screen.queryByTestId("handoff-card-gone")).toBeNull();
});
