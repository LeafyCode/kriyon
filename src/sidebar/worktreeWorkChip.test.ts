import { expect, test } from "vitest";
import { worktreeWorkChip } from "./worktreeWorkChip.ts";

test("a worktree's work that isn't in the base branch yet is flagged until it is", () => {
  expect(worktreeWorkChip(true, 0)?.label).toBe("Not committed");
  // Uncommitted work is the first thing to deal with, merged or not.
  expect(worktreeWorkChip(true, 3)?.label).toBe("Not committed");
  expect(worktreeWorkChip(false, 1)).toEqual({
    label: "Not merged",
    title: "1 commit on this branch isn't in the main branch yet",
  });
  expect(worktreeWorkChip(false, 2)?.title).toBe(
    "2 commits on this branch aren't in the main branch yet"
  );
  expect(worktreeWorkChip(false, 0)).toBeNull();
});
