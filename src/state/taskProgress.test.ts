import { expect, test } from "vitest";
import type { Task } from "../types.ts";
import { taskProgress } from "./taskProgress.ts";

function task(
  text: string,
  status: Task["status"],
  activeForm: string | null = null
): Task {
  return { activeForm, status, text };
}

test("no task list reads as nothing to show", () => {
  expect(taskProgress(undefined)).toBeNull();
  expect(taskProgress([])).toBeNull();
});

test("counts done tasks and names the one in progress by its active form", () => {
  const view = taskProgress([
    task("Read the spec", "completed"),
    task("Write the test", "in_progress", "Writing the test"),
    task("Make it pass", "pending"),
  ]);
  expect(view).toEqual({
    current: "Writing the test",
    done: 1,
    finished: false,
    label: "1/3",
    total: 3,
  });
});

test("falls back to the task's own text when it has no active form", () => {
  expect(taskProgress([task("Ship it", "in_progress")])?.current).toBe(
    "Ship it"
  );
});

test("with nothing in progress, the next pending task is what's current", () => {
  expect(
    taskProgress([task("A", "completed"), task("B", "pending")])?.current
  ).toBe("B");
});

test("a list with every task done is finished and has no current item", () => {
  const view = taskProgress([task("A", "completed"), task("B", "completed")]);
  expect(view?.finished).toBe(true);
  expect(view?.current).toBeNull();
  expect(view?.label).toBe("2/2");
});
