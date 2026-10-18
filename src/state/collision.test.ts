import { expect, test } from "vitest";
import { detectCollision } from "./collision.ts";
import { sessionWorkingDir, type UiSession } from "./sessions.ts";

function session(over: Partial<UiSession> & { id: string }): UiSession {
  const { id, ...rest } = over;
  return {
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "/repo",
    id,
    projectId: "p1",
    status: "running",
    summary: "",
    title: `T ${id}`,
    titleLocked: false,
    worktreePath: null,
    ...rest,
  };
}

test("working dir prefers the worktree over the cwd", () => {
  expect(
    sessionWorkingDir(session({ id: "s", cwd: "/repo", worktreePath: "/wt" }))
  ).toBe("/wt");
  expect(sessionWorkingDir(session({ id: "s", cwd: "/repo" }))).toBe("/repo");
});

test("a live session in the same dir collides", () => {
  const sessions = { a: session({ id: "a", cwd: "/repo" }) };
  expect(detectCollision("/repo", sessions)?.id).toBe("a");
});

test("a fresh worktree path never collides", () => {
  const sessions = { a: session({ id: "a", cwd: "/repo" }) };
  expect(detectCollision("/repo-worktrees/feat-x", sessions)).toBeNull();
});

test("archived sessions and the ignored session are skipped", () => {
  const sessions = {
    a: session({ archivedAt: 1, id: "a", cwd: "/repo" }),
    b: session({ id: "b", cwd: "/repo" }),
  };
  // Only 'b' would collide; ignoring it clears the collision.
  expect(detectCollision("/repo", sessions, "b")).toBeNull();
  // 'a' is archived, so with 'b' ignored nothing remains.
  expect(detectCollision("/repo", { a: sessions.a }, undefined)).toBeNull();
});
