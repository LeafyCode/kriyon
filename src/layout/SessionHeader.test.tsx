import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { useChanges } from "../state/changes.ts";
import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { idleSession, useSessions } from "../state/sessions.ts";
import { SessionHeader } from "./SessionHeader.tsx";

const CHANGES_TAB = /Changes/;
const CHANGES_WITH_NO_COUNT = /^Changes$/;
const STRUCTURED_OFF_TITLE = /Kriyon Companion is off/;

vi.mock("../ipc/bridge.ts", () => ({
  companionStatus: vi.fn().mockResolvedValue({
    claudeVersion: null,
    state: "off",
  }),
  onCompanionChanged: vi.fn(() => Promise.resolve(() => undefined)),
  repoStatus: vi.fn().mockResolvedValue({
    ahead: 0,
    behind: 0,
    branch: "feat/v3",
    // A working tree that was already dirty before this session started —
    // the case that made the tab lie.
    dirtyCount: 1,
  }),
}));

beforeEach(() => {
  useLayout.setState({ layout: DEFAULT_LAYOUT });
  useSessions.setState({
    activeSessionId: "s1",
    projects: [
      {
        color: null,
        id: "p1",
        name: "acme-web",
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
        cwd: "/repo",
        id: "s1",
        projectId: "p1",
        title: "hi",
        titleLocked: false,
        worktreePath: null,
      }),
    },
  });
  useChanges.setState({ bySession: {} });
});

/**
 * The tab's count has to be the number of files the tab *opens on*. Sourcing
 * it from `repoStatus.dirtyCount` — the raw working-tree count — produced a
 * "Changes 1" badge over a Changes view showing nothing, because the one
 * dirty file predated the session and so isn't in its baseline diff.
 */
test("the Changes tab counts this session's changed files, not the dirty working tree", () => {
  useChanges.setState({
    bySession: {
      s1: {
        baselineLabel: "HEAD",
        collapsed: {},
        diff: { base: "HEAD", files: [] },
        fetchedAt: Date.now(),
        hunkHashes: {},
        status: "ready",
        totals: { additions: 0, deletions: 0, files: 0 },
        viewed: {},
      },
    },
  });

  render(<SessionHeader />);

  // The dirty working tree says 1; this session changed nothing, so the tab
  // shows no count at all rather than a number it cannot open on.
  const tab = screen.getByRole("tab", { name: CHANGES_TAB });
  expect(tab).toHaveTextContent(CHANGES_WITH_NO_COUNT);
});

test("the Changes tab shows the session's own file count when it has one", () => {
  useChanges.setState({
    bySession: {
      s1: {
        baselineLabel: "HEAD",
        collapsed: {},
        diff: { base: "HEAD", files: [] },
        fetchedAt: Date.now(),
        hunkHashes: {},
        status: "ready",
        totals: { additions: 9, deletions: 2, files: 3 },
        viewed: {},
      },
    },
  });

  render(<SessionHeader />);

  expect(screen.getByRole("tab", { name: CHANGES_TAB })).toHaveTextContent(
    "Changes3"
  );
});

test("the Structured tab opens even with the companion off, where the view offers to turn it on", async () => {
  render(<SessionHeader />);
  const tab = screen.getByRole("tab", { name: "Structured" });
  // The status loads after the first render; it must not disable the tab.
  await screen.findByTitle(STRUCTURED_OFF_TITLE);
  expect(tab).toBeEnabled();
});
