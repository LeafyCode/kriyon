import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import type { Task } from "../../types.ts";
import { TasksPanel } from "./TasksPanel.tsx";

const TASKS: Task[] = [
  { activeForm: null, status: "pending", text: "Write the spec" },
  { activeForm: "Building the panel", status: "in_progress", text: "Build it" },
  { activeForm: null, status: "completed", text: "Read the conventions" },
];

test("renders pending, in_progress, and completed task text", () => {
  render(<TasksPanel tasks={TASKS} />);

  expect(screen.getByText("Write the spec")).toBeInTheDocument();
  expect(screen.getByText("Build it")).toBeInTheDocument();
  expect(screen.getByText("Read the conventions")).toBeInTheDocument();
});

test("meta shows completed over total", () => {
  render(<TasksPanel tasks={TASKS} />);

  expect(screen.getByText("1/3")).toBeInTheDocument();
});

test("an in_progress task with activeForm shows the activeForm sub-label", () => {
  render(<TasksPanel tasks={TASKS} />);

  expect(screen.getByText("Building the panel")).toBeInTheDocument();
});

test("renders an empty state when there are no tasks", () => {
  render(<TasksPanel tasks={[]} />);

  expect(screen.getByText("No tasks")).toBeInTheDocument();
});
