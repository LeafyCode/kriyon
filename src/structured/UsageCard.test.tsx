import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { submitPrompt } from "../ipc/bridge.ts";
import { usePlanLimits } from "../state/planLimits.ts";
import { useSentPrompts } from "../state/sentPrompts.ts";
import { useSessions } from "../state/sessions.ts";
import { useUsageCards } from "../state/usageCards.ts";
import { UsageCard } from "./UsageCard.tsx";

vi.mock("../ipc/bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/bridge.ts")>()),
  structuredTurns: vi.fn(() => Promise.resolve([])),
  submitPrompt: vi.fn(() => Promise.resolve()),
}));

const NO_LIMITS = /No plan limits reported yet/;

/** Monday 12 October 2026, 5:30 AM, local time. */
const MONDAY_530 = new Date(2026, 9, 12, 5, 30).getTime() / 1000;
const TODAY_240 = new Date(2026, 9, 11, 14, 40).getTime() / 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 11, 12, 42));
  useSessions.setState({
    usage: {
      s1: {
        contextWindowSize: 1_000_000,
        inputTokens: 60_800,
        model: "Opus 5.5",
        outputTokens: null,
        sessionId: null,
        usedPercentage: 6,
      },
    },
  });
  usePlanLimits.setState({
    limits: {
      fiveHour: { resetsAt: TODAY_240, usedPercentage: 9 },
      sevenDay: { resetsAt: MONDAY_530, usedPercentage: 36 },
    },
  });
  useUsageCards.setState({ shown: { s1: { at: 1, command: "/usage" } } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(submitPrompt).mockClear();
  useSentPrompts.setState({ sent: {} });
});

test("shows the session's context and the plan's limits, as Claude reported them", () => {
  render(<UsageCard sessionId="s1" />);
  const context = screen.getByTestId("usage-card-context");
  expect(context).toHaveTextContent("Context window");
  expect(context).toHaveTextContent("60.8k of 1M");
  expect(context).toHaveTextContent("6%");
  expect(context).toHaveTextContent("Opus 5.5");
  expect(screen.getByTestId("usage-card-five-hour")).toHaveTextContent(
    "5-hour limit9%Resets 2:40 PM"
  );
  expect(screen.getByTestId("usage-card-seven-day")).toHaveTextContent(
    "Weekly limit36%Resets Mon 5:30 AM"
  );
  expect(screen.queryByTestId("usage-card-alert")).toBeNull();
  expect(screen.getByRole("region", { name: "Usage" })).toBeInTheDocument();
});

test("a limit at 80% or more is called out", () => {
  usePlanLimits.setState({
    limits: {
      fiveHour: { resetsAt: TODAY_240, usedPercentage: 100 },
      sevenDay: { resetsAt: MONDAY_530, usedPercentage: 64 },
    },
  });
  render(<UsageCard sessionId="s1" />);
  expect(screen.getByTestId("usage-card-alert")).toHaveTextContent(
    "5-hour limit reached"
  );
});

test("figures Claude hasn't reported show as a dash, never a guess", () => {
  useSessions.setState({ usage: {} });
  usePlanLimits.setState({ limits: { fiveHour: null, sevenDay: null } });
  render(<UsageCard sessionId="s1" />);
  expect(screen.getByTestId("usage-card-context")).toHaveTextContent("—");
  expect(screen.queryByTestId("usage-card-five-hour")).toBeNull();
  expect(screen.getByText(NO_LIMITS)).toBeInTheDocument();
});

test("Close takes the card away", () => {
  render(<UsageCard sessionId="s1" />);
  fireEvent.click(screen.getByRole("button", { name: "Close usage" }));
  expect(useUsageCards.getState().shown.s1).toBeUndefined();
});

test("Claude's full panel waits while a dialog is open: its Enter would answer it", () => {
  useSessions.setState({
    activity: {
      s1: {
        main: { currentTool: null },
        pendingAsk: { askedAt: null, kind: "question", text: "Which db?" },
        shells: [],
        subagents: [],
        tasks: [],
      },
    },
  });
  render(<UsageCard sessionId="s1" />);
  expect(
    screen.getByRole("button", { name: "Claude's full panel" })
  ).toBeDisabled();
  useSessions.setState({ activity: {} });
});

test("Claude's full panel waits while a sent prompt is still pending", () => {
  useSentPrompts.getState().note("s1", {
    at: Date.now(),
    attachments: [],
    draft: "fix it",
    text: "fix it",
  });
  render(<UsageCard sessionId="s1" />);
  expect(
    screen.getByRole("button", { name: "Claude's full panel" })
  ).toBeDisabled();
  expect(useSentPrompts.getState().sent.s1?.text).toBe("fix it");
});

test("Claude's full panel sends /usage to the terminal", () => {
  render(<UsageCard sessionId="s1" />);
  fireEvent.click(screen.getByRole("button", { name: "Claude's full panel" }));
  expect(submitPrompt).toHaveBeenCalledWith("s1", "/usage", []);
});
