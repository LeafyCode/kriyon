import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import {
  defaultBranch,
  diffWorktree,
  mergeWorktree,
  removeWorktree,
} from "../ipc/bridge.ts";
import { idleSession, useSessions } from "../state/sessions.ts";
import { ReviewPanel } from "./ReviewPanel.tsx";

vi.mock("../ipc/bridge", () => ({
  defaultBranch: vi.fn(),
  diffWorktree: vi.fn(),
  mergeWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));

// Archiving stops the session's processes; this panel is not the pty layer.
vi.mock("../terminal/sessionHost.ts", () => ({
  disposeSession: vi.fn(() => Promise.resolve()),
}));

const mockedDefaultBranch = vi.mocked(defaultBranch);
const mockedDiffWorktree = vi.mocked(diffWorktree);
const mockedMergeWorktree = vi.mocked(mergeWorktree);
const mockedRemoveWorktree = vi.mocked(removeWorktree);

beforeEach(() => {
  vi.clearAllMocks();
  mockedDefaultBranch.mockResolvedValue("main");
  mockedDiffWorktree.mockResolvedValue({
    base: "main",
    files: [
      {
        binary: false,
        hunks: [
          {
            header: "@@ -1 +1 @@",
            lines: [
              { kind: "removed", text: "old" },
              { kind: "added", text: "new" },
            ],
          },
        ],
        oldPath: null,
        path: "src/main.rs",
        status: "modified",
      },
    ],
  });
  mockedMergeWorktree.mockResolvedValue({ kind: "clean" });
  mockedRemoveWorktree.mockResolvedValue(undefined);
  useSessions.setState({ activeSessionId: null, projects: [], sessions: {} });
});

const props = {
  branch: "feature",
  repoRoot: "/repo",
  worktreePath: "/repo-wt",
};

const REVIEW_BUTTON = /review changes/i;
const MERGE_BUTTON = /^merge/i;
const MERGED_MSG = /merged into main/i;
const CONFLICT_HINT = /resolve in the terminal/i;

test("loads and renders the session diff on review", async () => {
  render(<ReviewPanel {...props} />);
  screen.getByRole("button", { name: REVIEW_BUTTON }).click();

  expect(await screen.findByText("src/main.rs")).toBeInTheDocument();
  expect(await screen.findByText("new")).toBeInTheDocument();
  expect(mockedDiffWorktree).toHaveBeenCalledWith("/repo-wt", "main");
});

test("merges and reports a clean outcome", async () => {
  render(<ReviewPanel {...props} />);
  screen.getByRole("button", { name: REVIEW_BUTTON }).click();
  const merge = await screen.findByRole("button", { name: MERGE_BUTTON });
  merge.click();

  expect(await screen.findByText(MERGED_MSG)).toBeInTheDocument();
  expect(mockedMergeWorktree).toHaveBeenCalledWith("/repo", "feature");
});

test("surfaces conflicted files read-only", async () => {
  mockedMergeWorktree.mockResolvedValue({
    files: ["src/main.rs"],
    kind: "conflicted",
  });
  render(<ReviewPanel {...props} />);
  screen.getByRole("button", { name: REVIEW_BUTTON }).click();
  (await screen.findByRole("button", { name: MERGE_BUTTON })).click();

  await waitFor(() => {
    expect(screen.getByText(CONFLICT_HINT)).toBeInTheDocument();
  });
});

function seedActiveSession(): void {
  useSessions.setState({
    activeSessionId: "s1",
    projects: [
      {
        color: null,
        id: "p1",
        name: "repo",
        path: "/repo",
        setupCommand: null,
      },
    ],
    sessions: {
      s1: idleSession({
        archivedAt: null,
        baselineOid: null,
        claudeSessionId: null,
        createdAt: Date.now(),
        cwd: "/repo-wt",
        id: "s1",
        projectId: "p1",
        title: "feature",
        titleLocked: false,
        worktreePath: "/repo-wt",
      }),
    },
  });
}

test("a clean merge offers to archive the session", async () => {
  seedActiveSession();

  render(<ReviewPanel {...props} />);
  screen.getByRole("button", { name: REVIEW_BUTTON }).click();
  const merge = await screen.findByRole("button", { name: MERGE_BUTTON });
  merge.click();

  const archive = await screen.findByTestId("merge-archive");
  archive.click();

  expect(useSessions.getState().sessions.s1?.archivedAt).toBeGreaterThan(0);
});

test("archive & remove worktree removes cleanly without a confirm step", async () => {
  seedActiveSession();

  render(<ReviewPanel {...props} />);
  screen.getByRole("button", { name: REVIEW_BUTTON }).click();
  const merge = await screen.findByRole("button", { name: MERGE_BUTTON });
  merge.click();

  const archiveRemove = await screen.findByTestId("merge-archive-remove");
  archiveRemove.click();

  await waitFor(() => {
    expect(mockedRemoveWorktree).toHaveBeenCalledWith("/repo", "/repo-wt");
  });
  expect(
    screen.queryByTestId("merge-archive-remove-confirm")
  ).not.toBeInTheDocument();
  expect(useSessions.getState().sessions.s1?.archivedAt).toBeGreaterThan(0);
});

test("a dirty worktree escalates to confirm instead of silently staying on disk", async () => {
  mockedRemoveWorktree.mockRejectedValueOnce(new Error("dirty"));
  seedActiveSession();

  render(<ReviewPanel {...props} />);
  screen.getByRole("button", { name: REVIEW_BUTTON }).click();
  const merge = await screen.findByRole("button", { name: MERGE_BUTTON });
  merge.click();

  const archiveRemove = await screen.findByTestId("merge-archive-remove");
  archiveRemove.click();

  const confirmGo = await screen.findByTestId(
    "merge-archive-remove-confirm-go"
  );
  // The old code archived the session immediately and swallowed a failed
  // removal, leaving a dirty worktree on disk with no sign anything went
  // wrong. It must escalate to the confirm step instead.
  expect(useSessions.getState().sessions.s1?.archivedAt).toBeNull();

  confirmGo.click();

  await waitFor(() => {
    expect(mockedRemoveWorktree).toHaveBeenLastCalledWith(
      "/repo",
      "/repo-wt",
      true
    );
  });
  expect(useSessions.getState().sessions.s1?.archivedAt).toBeGreaterThan(0);
});
