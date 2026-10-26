import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { useSessions } from "../state/sessions.ts";
import type { TaskStatus } from "../types.ts";
import { TaskStrip } from "./TaskStrip.tsx";

function seedTasks(statuses: TaskStatus[]): void {
  useSessions.setState({
    activeSessionId: "s1",
    activity: {
      s1: {
        main: { currentTool: null },
        pendingAsk: null,
        shells: [],
        subagents: [],
        tasks: statuses.map((status, i) => ({
          activeForm: status === "in_progress" ? `Doing task ${i}` : null,
          status,
          text: `Task ${i}`,
        })),
      },
    },
  });
}

beforeEach(() => {
  useSessions.setState({ activeSessionId: null, activity: {} });
});
afterEach(cleanup);

test("pins the open task list above the terminal: count, bar and current item", () => {
  seedTasks(["completed", "in_progress", "pending", "pending"]);
  render(<TaskStrip />);
  const strip = screen.getByTestId("task-strip");
  expect(strip).toHaveTextContent("1/4");
  expect(strip).toHaveTextContent("Doing task 1");
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
});

test("expands to the whole list and folds back", () => {
  seedTasks(["completed", "in_progress", "pending"]);
  render(<TaskStrip />);
  expect(screen.queryByText("Task 2")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show all 3 tasks" }));
  expect(screen.getByText("Task 2")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Hide tasks" }));
  expect(screen.queryByText("Task 2")).not.toBeInTheDocument();
});

test("shows nothing without a task list, or once every task is done", () => {
  render(<TaskStrip />);
  expect(screen.queryByTestId("task-strip")).not.toBeInTheDocument();
  act(() => seedTasks(["completed", "completed"]));
  expect(screen.queryByTestId("task-strip")).not.toBeInTheDocument();
});
