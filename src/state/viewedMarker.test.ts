import { expect, test } from "vitest";
import type { SessionActivity, TaskStatus } from "../types.ts";
import {
  completedTasks,
  stampViewed,
  unseenCount,
  type ViewedMarker,
} from "./viewedMarker.ts";

const marker = (appendSeq: number, ms = 0, tasksDone = 0): ViewedMarker => ({
  appendSeq,
  ms,
  tasksDone,
});

function activityWithTasks(statuses: TaskStatus[]): SessionActivity {
  return {
    main: { currentTool: null },
    pendingAsk: null,
    shells: [],
    subagents: [],
    tasks: statuses.map((status, i) => ({
      activeForm: null,
      status,
      text: `task ${i}`,
    })),
  };
}

test("stampViewed captures the append counter, time, and completed tasks", () => {
  expect(stampViewed({ appendSeq: 42, nowMs: 1000, tasksDone: 3 })).toEqual({
    appendSeq: 42,
    ms: 1000,
    tasksDone: 3,
  });
});

test("unseenCount is the append-seq delta, clamped at zero", () => {
  expect(unseenCount(marker(100), 150)).toBe(50);
  expect(unseenCount(marker(100), 100)).toBe(0);
  // A marker ahead of the live count (shouldn't happen) clamps to zero.
  expect(unseenCount(marker(100), 90)).toBe(0);
  // Never viewed → everything is unseen.
  expect(unseenCount(undefined, 7)).toBe(7);
});

test("completedTasks counts only the completed entries of the task list", () => {
  expect(
    completedTasks(
      activityWithTasks(["completed", "in_progress", "completed", "pending"])
    )
  ).toBe(2);
  expect(completedTasks(activityWithTasks(["in_progress"]))).toBe(0);
  expect(completedTasks(activityWithTasks([]))).toBe(0);
});

test("completedTasks is zero for a session with no activity snapshot yet", () => {
  expect(completedTasks(undefined)).toBe(0);
});
