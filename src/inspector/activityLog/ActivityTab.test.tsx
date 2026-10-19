import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import {
  type ActivityStep,
  type ActivityTurn,
  activityStats,
  activityStep,
  activityTurns,
  onActivityChanged,
} from "../../ipc/bridge.ts";
import { useSessions } from "../../state/sessions.ts";
import { ActivityTab } from "./ActivityTab.tsx";
import { STEP_FLAGS } from "./activityLog.ts";

vi.mock("../../ipc/bridge.ts", () => ({
  activityStats: vi.fn(),
  activityStep: vi.fn(),
  activityTurns: vi.fn(),
  onActivityChanged: vi.fn(),
}));

const EDIT: ActivityStep = {
  agentType: null,
  durationMs: 40,
  flags: 0,
  id: 1,
  kind: "edit",
  startedMs: 0,
  status: "ok",
  summary: null,
  target: "/w/src/a.ts",
  toolName: "Edit",
};

const INSTALL: ActivityStep = {
  ...EDIT,
  flags: STEP_FLAGS.installed,
  id: 2,
  kind: "command",
  target: "pnpm add zod",
  toolName: "Bash",
};

const TURN: ActivityTurn = {
  endedMs: 5000,
  endReason: null,
  id: 1,
  prompt: "add validation",
  report: null,
  source: "user",
  startedMs: 0,
  steps: [EDIT, INSTALL],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(onActivityChanged).mockResolvedValue(() => undefined);
  vi.mocked(activityStats).mockResolvedValue({
    retentionDays: 30,
    sessions: 1,
    sizeBytes: 0,
    sizeCapBytes: 0,
  });
  useSessions.setState({ repoToplevel: { s1: "/w" } });
});

test("an empty log says steps will appear", async () => {
  vi.mocked(activityTurns).mockResolvedValue([]);
  render(<ActivityTab onOpenInChanges={vi.fn()} sessionId="s1" />);
  expect(
    await screen.findByText(
      "No activity yet. Steps appear here as Claude works."
    )
  ).toBeTruthy();
  expect(
    await screen.findByText("Kept 30 days · only on this Mac")
  ).toBeTruthy();
});

test("shows each turn's prompt and its steps, and the chips filter them", async () => {
  vi.mocked(activityTurns).mockResolvedValue([TURN]);
  render(<ActivityTab onOpenInChanges={vi.fn()} sessionId="s1" />);
  expect(await screen.findByText("“add validation”")).toBeTruthy();
  expect(screen.getByText("Changed a.ts")).toBeTruthy();
  expect(screen.getByText("Installed a package")).toBeTruthy();
  expect(screen.getByText("installed")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Commands 1" }));
  expect(screen.queryByText("Changed a.ts")).toBeNull();
  expect(screen.getByText("Installed a package")).toBeTruthy();
});

test("a chained command shows each command on its own line", async () => {
  vi.mocked(activityTurns).mockResolvedValue([
    {
      ...TURN,
      steps: [
        {
          ...INSTALL,
          flags: STEP_FLAGS.network,
          target: 'echo "hi" > hello.txt && curl -sI https://example.com',
        },
      ],
    },
  ]);
  render(<ActivityTab onOpenInChanges={vi.fn()} sessionId="s1" />);
  expect(await screen.findByText("Ran 2 commands")).toBeTruthy();
  expect(screen.getByText('echo "hi" > hello.txt')).toBeTruthy();
  expect(screen.getByText("curl -sI https://example.com")).toBeTruthy();
  expect(screen.getByText("internet")).toBeTruthy();
});

test("a step opens its detail, and an edit opens in the Changes view", async () => {
  vi.mocked(activityTurns).mockResolvedValue([TURN]);
  vi.mocked(activityStep).mockResolvedValue({
    ...EDIT,
    agentId: null,
    allowedBy: "auto-accept edits",
    endedMs: 40,
    input: '{"file_path":"/w/src/a.ts"}',
    result: "ok",
  });
  const onOpen = vi.fn();
  render(<ActivityTab onOpenInChanges={onOpen} sessionId="s1" />);
  fireEvent.click(await screen.findByText("Changed a.ts"));

  expect(await screen.findByText("auto-accept edits")).toBeTruthy();
  expect(activityStep).toHaveBeenCalledWith("s1", 1);
  expect(screen.getByText("Main agent")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open in Changes" }));
  expect(onOpen).toHaveBeenCalledWith("src/a.ts");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("an edit in a folder without git says why it can't open in Changes", async () => {
  useSessions.setState({ repoToplevel: {} });
  vi.mocked(activityTurns).mockResolvedValue([TURN]);
  vi.mocked(activityStep).mockResolvedValue({
    ...EDIT,
    agentId: null,
    allowedBy: "auto mode",
    endedMs: 40,
    input: null,
    result: null,
  });
  render(<ActivityTab onOpenInChanges={vi.fn()} sessionId="s1" />);
  fireEvent.click(await screen.findByText("Changed a.ts"));
  expect(
    await screen.findByText(
      "This folder isn't a git repository, so the Changes view can't show this file."
    )
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open in Changes" })).toBeNull();
});

test("the timeline scrolls on its own, under fixed chips", async () => {
  vi.mocked(activityTurns).mockResolvedValue([TURN]);
  render(<ActivityTab onOpenInChanges={vi.fn()} sessionId="s1" />);
  await screen.findByText("“add validation”");
  expect(screen.getByTestId("activity-timeline").style.overflowY).toBe("auto");
});
