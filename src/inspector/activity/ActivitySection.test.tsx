import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import type { SessionActivity } from "../../types.ts";
import { ActivitySection } from "./ActivitySection.tsx";

function activity(overrides: Partial<SessionActivity>): SessionActivity {
  return {
    main: { currentTool: null },
    pendingAsk: null,
    shells: [],
    subagents: [],
    tasks: [],
    ...overrides,
  };
}

test("shows Idle when nothing is active", () => {
  render(<ActivitySection activity={activity({})} />);
  expect(screen.getByText("Idle")).toBeInTheDocument();
});

test("shows the main agent's current tool", () => {
  render(
    <ActivitySection
      activity={activity({
        main: {
          currentTool: { startedAt: null, target: "a.ts", toolName: "Edit" },
        },
      })}
    />
  );
  expect(screen.getByText("Editing a.ts")).toBeInTheDocument();
  expect(screen.queryByText("Idle")).not.toBeInTheDocument();
});

test("a background shell alone never claims the session is working", () => {
  render(
    <ActivitySection
      activity={activity({
        shells: [
          {
            bashId: "bash_1",
            cmd: "pnpm dev",
            exit: null,
            lastPolledAt: "2026-09-19T12:00:00.000Z",
            status: "running",
          },
        ],
      })}
    />
  );
  // The shell is still listed — honestly, with its own staleness — but the
  // line above it says Idle, because ADR-0002 gives us no completion signal.
  expect(screen.getByText("pnpm dev")).toBeInTheDocument();
  expect(screen.getByText("Idle")).toBeInTheDocument();
  expect(screen.queryByText("Working…")).not.toBeInTheDocument();
});

test("a finished subagent is listed but does not read as Working", () => {
  render(
    <ActivitySection
      activity={activity({
        subagents: [
          {
            agentId: null,
            currentTool: null,
            description: null,
            durationMs: 1200,
            endedAt: "2026-09-19T12:00:00.000Z",
            kind: "explorer",
            result: null,
            startedAt: null,
            state: "done",
            toolUseId: "tu_1",
          },
        ],
      })}
    />
  );
  expect(screen.getByText("explorer")).toBeInTheDocument();
  expect(screen.getByText("Idle")).toBeInTheDocument();
});

test("a checklist with nothing in progress does not read as Working", () => {
  render(
    <ActivitySection
      activity={activity({
        tasks: [
          { activeForm: null, status: "completed", text: "Ship it" },
          { activeForm: null, status: "pending", text: "Write the ADR" },
        ],
      })}
    />
  );
  expect(screen.getByText("Idle")).toBeInTheDocument();
});

test("an in-progress task reads as Working", () => {
  render(
    <ActivitySection
      activity={activity({
        tasks: [
          { activeForm: "Writing", status: "in_progress", text: "Write it" },
        ],
      })}
    />
  );
  expect(screen.getByText("Working…")).toBeInTheDocument();
});

test("renders the agents panel and hides Idle when subagents exist", () => {
  render(
    <ActivitySection
      activity={activity({
        subagents: [
          {
            agentId: null,
            currentTool: null,
            description: null,
            durationMs: null,
            endedAt: null,
            kind: "explorer",
            result: null,
            startedAt: null,
            state: "running",
            toolUseId: "tu_1",
          },
        ],
      })}
    />
  );
  expect(screen.getByText("explorer")).toBeInTheDocument();
  expect(screen.queryByText("Idle")).not.toBeInTheDocument();
});
