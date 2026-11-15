import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { atBottom, RemoteReadable } from "./RemoteReadable.tsx";
import type { ReadableSummary } from "./readableSummary.ts";

const LOADING = /Loading/;

const summary: ReadableSummary = {
  entries: [
    { kind: "you", seq: 1, text: "Fix the login" },
    {
      kind: "step",
      name: "Bash",
      seq: 2,
      state: "failed",
      target: "cargo test",
    },
    { done: false, kind: "claude", seq: 3, text: "Looking into it" },
    {
      header: "Database",
      kind: "asking",
      options: ["Postgres", "SQLite"],
      question: "Which db?",
      seq: 4,
    },
    { kind: "note", seq: 5, text: "Context compacted" },
  ],
  unavailable: null,
};

test("shows each entry, in order", () => {
  render(<RemoteReadable onTerminal={vi.fn()} summary={summary} />);
  expect(screen.getByText("Fix the login")).toBeInTheDocument();
  expect(screen.getByText("cargo test")).toBeInTheDocument();
  expect(screen.getByText("Failed")).toBeInTheDocument();
  expect(screen.getByText("Looking into it")).toBeInTheDocument();
  expect(screen.getByText("Which db?")).toBeInTheDocument();
  expect(screen.getByText("Postgres")).toBeInTheDocument();
  expect(screen.getByText("Context compacted")).toBeInTheDocument();
});

test("a question is answered only in the terminal", () => {
  const onTerminal = vi.fn();
  render(<RemoteReadable onTerminal={onTerminal} summary={summary} />);
  expect(screen.queryByRole("button", { name: "Postgres" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Answer in the terminal" })
  );
  expect(onTerminal).toHaveBeenCalled();
});

test("says so while nothing has come yet", () => {
  render(<RemoteReadable onTerminal={vi.fn()} summary={undefined} />);
  expect(screen.getByText(LOADING)).toBeInTheDocument();
});

test("it follows the newest entry only while the view is at the bottom", () => {
  expect(
    atBottom({ clientHeight: 100, scrollHeight: 500, scrollTop: 400 })
  ).toBe(true);
  expect(
    atBottom({ clientHeight: 100, scrollHeight: 500, scrollTop: 396 })
  ).toBe(true);
  expect(
    atBottom({ clientHeight: 100, scrollHeight: 500, scrollTop: 200 })
  ).toBe(false);
});
