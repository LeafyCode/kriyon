import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({
  // Mirrors the Rust sibling-path convention: slashes and other non-word
  // characters collapse to "-" in the directory segment.
  worktreePathFor: vi.fn((_r: string, b: string) =>
    Promise.resolve(
      `/repo-worktrees/${b.replace(/[^A-Za-z0-9_.]+/g, "-").replace(/^-|-$/g, "")}`
    )
  ),
  captureBaseline: vi.fn(() => Promise.resolve("test-baseline-oid")),
  createWorktree: vi.fn(() => Promise.resolve()),
  bootstrapWorktree: vi.fn(() =>
    Promise.resolve({ ok: true, output: "", steps: [] })
  ),
  isTauriRuntime: () => true,
  pickDirectory: vi.fn(),
  upsertProject: vi.fn(() => Promise.resolve()),
  upsertSession: vi.fn(() => Promise.resolve()),
}));

import {
  bootstrapWorktree,
  createWorktree,
  pickDirectory,
} from "../ipc/bridge.ts";
import { type UiSession, useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import type { ProjectRow } from "../types.ts";
import { nestedTitle, SpawnDialog } from "./SpawnDialog.tsx";

const project: ProjectRow = {
  color: null,
  id: "p1",
  name: "Repo",
  path: "/repo",
  setupCommand: null,
};
function session(over: Partial<UiSession> & { id: string }): UiSession {
  return {
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "/repo",
    projectId: "p1",
    status: "done",
    summary: "",
    title: `T ${over.id}`,
    titleLocked: false,
    worktreePath: null,
    ...over,
  };
}

beforeEach(() => {
  // Clear call history between tests (implementations from the mock factory
  // survive) so per-test assertions like `not.toHaveBeenCalled` are honest.
  vi.clearAllMocks();
  useSessions.setState({
    activeSessionId: "pre",
    events: {},
    activity: {},
    projects: [project],
    sessions: { pre: session({ id: "pre" }) },
    pendingSeedPrompt: {},
  });
  useUi.setState({
    spawnOpen: true,
    spawnPredecessorId: "pre",
    spawnProjectId: null,
    spawnNest: false,
    spawnSeed: null,
    spawnWorktreeDefault: false,
  });
});

test("opens with a pre-filled, editable prompt", () => {
  render(<SpawnDialog />);
  const box = screen.getByTestId("spawn-prompt") as HTMLTextAreaElement;
  expect(box.value).toContain("Continuing from a previous session");
});

test("a handoff open seeds the given prompt and the follow-up keeps it", async () => {
  useUi.setState({ spawnSeed: "Read /tmp/handoff.md and continue." });
  render(<SpawnDialog />);
  const box = screen.getByTestId("spawn-prompt") as HTMLTextAreaElement;
  expect(box.value).toBe("Read /tmp/handoff.md and continue.");
  fireEvent.click(screen.getByTestId("spawn-confirm"));
  await waitFor(() => expect(useUi.getState().spawnOpen).toBe(false));
  const state = useSessions.getState();
  const created = Object.values(state.sessions).find((s) => s.id !== "pre");
  expect(created?.parentSessionId).toBe("pre");
  expect(state.pendingSeedPrompt[created?.id ?? ""]).toBe(
    "Read /tmp/handoff.md and continue."
  );
});

test("picking the worktree option reveals the branch field, with no collision note", () => {
  render(<SpawnDialog />);
  fireEvent.click(screen.getByTestId("spawn-mode-worktree"));
  expect(screen.getByTestId("spawn-branch")).toBeTruthy();
  // The branch field is visibly marked required.
  expect(screen.getByTestId("spawn-branch-required")).toHaveTextContent("*");
  // A fresh worktree never collides.
  expect(screen.queryByTestId("spawn-collision")).toBeNull();
});

test("both run modes explain themselves in plain language", () => {
  render(<SpawnDialog />);
  const dialog = screen.getByTestId("spawn-dialog");
  // The folder option says what "same place" means…
  expect(dialog.textContent).toContain("current branch");
  // …and the worktree option says what isolation you get.
  expect(dialog.textContent).toContain("separate copy");
});

test("a same-folder spawn explains the clash risk in plain language", () => {
  useSessions.setState((s) => ({
    sessions: { ...s.sessions, other: session({ id: "other", cwd: "/repo" }) },
  }));
  render(<SpawnDialog />);
  // Folder mode is the default → runs in /repo, where 'other' is live.
  const note = screen.getByTestId("spawn-collision").textContent ?? "";
  expect(note).toContain("T other");
  expect(note).toContain("already working in this folder");
  expect(note).toContain("worktree");
});

test("escape closes the dialog", () => {
  render(<SpawnDialog />);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(useUi.getState().spawnOpen).toBe(false);
});

test("a project-anchored open (no predecessor) spawns a worktree session", async () => {
  useUi.setState({
    spawnOpen: true,
    spawnPredecessorId: null,
    spawnProjectId: "p1",
    spawnWorktreeDefault: true,
  });
  render(<SpawnDialog />);
  // No predecessor → nothing to hand off; the prompt starts empty.
  const box = screen.getByTestId("spawn-prompt") as HTMLTextAreaElement;
  expect(box.value).toBe("");
  // The worktree toggle honors the default and the branch starts blank.
  const branch = screen.getByTestId("spawn-branch") as HTMLInputElement;
  expect(branch.value).toBe("");
  // A blank branch must not spawn — it explains what is missing instead.
  fireEvent.click(screen.getByTestId("spawn-confirm"));
  expect(Object.keys(useSessions.getState().sessions)).toHaveLength(1);
  expect(screen.getByTestId("spawn-branch-error").textContent).toContain(
    "branch"
  );

  // Typing clears the message; a named branch spawns.
  fireEvent.change(branch, { target: { value: "feat/fresh" } });
  expect(screen.queryByTestId("spawn-branch-error")).toBeNull();
  fireEvent.click(screen.getByTestId("spawn-confirm"));
  await waitFor(() => {
    expect(useUi.getState().spawnOpen).toBe(false);
  });
  const created = Object.values(useSessions.getState().sessions).find(
    (s) => s.id !== "pre"
  );
  expect(created?.worktreePath).toBe("/repo-worktrees/feat-fresh");
  expect(created?.projectId).toBe("p1");
});

test("an invalid branch name is rejected with a specific message", async () => {
  render(<SpawnDialog />);
  fireEvent.click(screen.getByTestId("spawn-mode-worktree"));
  fireEvent.change(screen.getByTestId("spawn-branch"), {
    target: { value: "has space" },
  });
  // Live validation names the problem…
  expect(screen.getByTestId("spawn-branch-error").textContent).toContain(
    "spaces"
  );
  // …and Start does not create anything.
  fireEvent.click(screen.getByTestId("spawn-confirm"));
  await Promise.resolve();
  expect(createWorktree).not.toHaveBeenCalled();
  expect(useUi.getState().spawnOpen).toBe(true);
});

test("choosing a location places the worktree under the picked folder", async () => {
  vi.mocked(pickDirectory).mockResolvedValueOnce("/tmp/wt-parent");
  render(<SpawnDialog />);
  fireEvent.click(screen.getByTestId("spawn-mode-worktree"));
  fireEvent.change(screen.getByTestId("spawn-branch"), {
    target: { value: "feat/x" },
  });
  // Default location resolves from the Rust core (mock → /repo-worktrees/feat-x).
  await waitFor(() => {
    expect(screen.getByTestId("spawn-worktree-location").textContent).toContain(
      "/repo-worktrees/feat-x"
    );
  });

  fireEvent.click(screen.getByTestId("spawn-choose-location"));
  await waitFor(() => {
    expect(screen.getByTestId("spawn-worktree-location").textContent).toBe(
      "/tmp/wt-parent/feat-x"
    );
  });

  fireEvent.click(screen.getByTestId("spawn-confirm"));
  await waitFor(() => {
    expect(createWorktree).toHaveBeenCalledWith(
      "/repo",
      "feat/x",
      "/tmp/wt-parent/feat-x"
    );
  });
});

test("a failed worktree bootstrap keeps the dialog open and shows the failure", async () => {
  vi.mocked(bootstrapWorktree).mockResolvedValueOnce({
    ok: false,
    output: "install failed: boom",
    steps: [{ label: "install (pnpm install)", ok: false }],
  });
  render(<SpawnDialog />);
  fireEvent.click(screen.getByTestId("spawn-mode-worktree"));
  fireEvent.change(screen.getByTestId("spawn-branch"), {
    target: { value: "wt/test-branch" },
  });
  fireEvent.click(screen.getByTestId("spawn-confirm"));

  await waitFor(() => {
    expect(useUi.getState().spawnOpen).toBe(true);
  });
  const dialog = await screen.findByTestId("spawn-dialog");
  expect(dialog.textContent).toContain("install failed");
});

test("a failed worktree bootstrap locks the dialog against re-spawn; primary button closes it", async () => {
  vi.mocked(bootstrapWorktree).mockResolvedValueOnce({
    ok: false,
    output: "install failed: boom",
    steps: [{ label: "install (pnpm install)", ok: false }],
  });
  render(<SpawnDialog />);
  fireEvent.click(screen.getByTestId("spawn-mode-worktree"));
  fireEvent.change(screen.getByTestId("spawn-branch"), {
    target: { value: "wt/test-branch" },
  });
  fireEvent.click(screen.getByTestId("spawn-confirm"));

  await waitFor(() => {
    expect(screen.getByTestId("spawn-confirm").textContent).toBe("Close");
  });
  // The session already exists — the dialog must still be open, showing the
  // failure, with no way to re-trigger a spawn.
  expect(useUi.getState().spawnOpen).toBe(true);
  const dialog = await screen.findByTestId("spawn-dialog");
  expect(dialog.textContent).toContain("install failed");

  fireEvent.click(screen.getByTestId("spawn-confirm"));
  expect(useUi.getState().spawnOpen).toBe(false);
});

test("split off titles a nested session from its task's first words", () => {
  expect(nestedTitle("Fix the flaky login test on CI please now", "P")).toBe(
    "Fix the flaky login test on"
  );
  expect(nestedTitle("   ", "Parent")).toBe("Parent (split)");
});

test("split off starts an empty task and nests the new session under this one", async () => {
  useUi.getState().openSpawn({ predecessorId: "pre" }, { nest: true });
  render(<SpawnDialog />);
  expect(screen.getByTestId("spawn-dialog")).toHaveTextContent(
    "Split off from “T pre”"
  );
  const box = screen.getByTestId("spawn-prompt") as HTMLTextAreaElement;
  expect(box.value).toBe("");
  fireEvent.change(box, { target: { value: "Write the release notes" } });
  fireEvent.click(screen.getByTestId("spawn-confirm"));
  await waitFor(() => expect(useUi.getState().spawnOpen).toBe(false));
  const created = Object.values(useSessions.getState().sessions).find(
    (s) => s.id !== "pre"
  );
  expect(created?.nestedUnder).toBe("pre");
  expect(created?.parentSessionId ?? null).toBeNull();
  expect(created?.title).toBe("Write the release notes");
});

test("a split off whose worktree setup fails shows the failure instead of closing", async () => {
  vi.mocked(bootstrapWorktree).mockResolvedValueOnce({
    ok: false,
    output: "install failed: boom",
    steps: [{ label: "install (pnpm install)", ok: false }],
  });
  useUi.getState().openSpawn({ predecessorId: "pre" }, { nest: true });
  render(<SpawnDialog />);
  fireEvent.change(screen.getByTestId("spawn-prompt"), {
    target: { value: "Write the docs" },
  });
  fireEvent.click(screen.getByTestId("spawn-mode-worktree"));
  fireEvent.change(screen.getByTestId("spawn-branch"), {
    target: { value: "wt/docs" },
  });
  fireEvent.click(screen.getByTestId("spawn-confirm"));
  await waitFor(() => {
    expect(screen.getByTestId("spawn-confirm").textContent).toBe("Close");
  });
  expect(useUi.getState().spawnOpen).toBe(true);
  expect(screen.getByTestId("spawn-dialog").textContent).toContain(
    "install failed"
  );
});
