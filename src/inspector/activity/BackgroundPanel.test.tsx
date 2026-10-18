import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import type { BackgroundShell } from "../../types.ts";
import { BackgroundPanel } from "./BackgroundPanel.tsx";

const LAST_POLLED = /last polled/;
const NOT_YET_POLLED = /not yet polled/;
const EXITED_ZERO = /exited 0/;

function shell(overrides: Partial<BackgroundShell> = {}): BackgroundShell {
  return {
    bashId: "bash_1",
    cmd: "pnpm dev",
    exit: null,
    lastPolledAt: new Date().toISOString(),
    status: "running",
    ...overrides,
  };
}

test("a running shell shows its cmd and an honest last-polled label", () => {
  render(<BackgroundPanel shells={[shell({ cmd: "pnpm dev --watch" })]} />);

  expect(screen.getByText("pnpm dev --watch")).toBeInTheDocument();
  expect(screen.getByText(LAST_POLLED)).toBeInTheDocument();
});

test("a running shell that was never polled is honest about it", () => {
  render(<BackgroundPanel shells={[shell({ lastPolledAt: null })]} />);

  expect(screen.getByText(NOT_YET_POLLED)).toBeInTheDocument();
});

test("an exited shell shows its exit code", () => {
  render(<BackgroundPanel shells={[shell({ exit: 0, status: "exited" })]} />);

  expect(screen.getByText(EXITED_ZERO)).toBeInTheDocument();
});

test("clicking a row reveals its bashId", () => {
  render(<BackgroundPanel shells={[shell({ bashId: "bash_abc123" })]} />);

  expect(screen.queryByText("bash_abc123")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByText("bash_abc123")).toBeInTheDocument();
});

test("empty state renders 'No background shells'", () => {
  render(<BackgroundPanel shells={[]} />);

  expect(screen.getByText("No background shells")).toBeInTheDocument();
});
