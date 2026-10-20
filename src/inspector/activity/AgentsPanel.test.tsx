import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import type { Subagent } from "../../types.ts";
import { AgentsPanel } from "./AgentsPanel.tsx";

function subagent(overrides: Partial<Subagent>): Subagent {
  return {
    agentId: null,
    currentTool: null,
    description: null,
    durationMs: null,
    endedAt: null,
    kind: "general-purpose",
    result: null,
    startedAt: null,
    state: "done",
    toolUseId: "tu_1",
    ...overrides,
  };
}

test("renders running and done subagents with their kind text", () => {
  render(
    <AgentsPanel
      subagents={[
        subagent({ kind: "explorer", state: "running", toolUseId: "tu_1" }),
        subagent({ kind: "reviewer", state: "done", toolUseId: "tu_2" }),
      ]}
    />
  );

  expect(screen.getByText("explorer")).toBeInTheDocument();
  expect(screen.getByText("reviewer")).toBeInTheDocument();
});

test("meta shows the running and done counts", () => {
  render(
    <AgentsPanel
      subagents={[
        subagent({ state: "running", toolUseId: "tu_1" }),
        subagent({ state: "running", toolUseId: "tu_2" }),
        subagent({ state: "done", toolUseId: "tu_3" }),
      ]}
    />
  );

  expect(screen.getByText("2 running, 1 done")).toBeInTheDocument();
});

test("clicking a done subagent with a result reveals the result text", () => {
  render(
    <AgentsPanel
      subagents={[
        subagent({
          kind: "reviewer",
          result: "the answer is 42",
          state: "done",
          toolUseId: "tu_1",
        }),
      ]}
    />
  );

  expect(screen.queryByText("the answer is 42")).not.toBeInTheDocument();

  fireEvent.click(screen.getByText("reviewer"));

  expect(screen.getByText("the answer is 42")).toBeInTheDocument();
});

test("shows a running subagent's current tool line", () => {
  render(
    <AgentsPanel
      subagents={[
        subagent({
          currentTool: {
            startedAt: null,
            target: "src/foo.tsx",
            toolName: "Edit",
          },
          kind: "explorer",
          state: "running",
          toolUseId: "tu_1",
        }),
      ]}
    />
  );

  expect(screen.getByText("Editing foo.tsx")).toBeInTheDocument();
});

test("shows an exact duration for a done subagent", () => {
  render(
    <AgentsPanel
      subagents={[
        subagent({ durationMs: 1300, kind: "reviewer", state: "done" }),
      ]}
    />
  );

  expect(screen.getByText("done in 1.3s")).toBeInTheDocument();
});

test("renders an empty state when there are no subagents", () => {
  render(<AgentsPanel subagents={[]} />);

  expect(screen.getByText("No subagents")).toBeInTheDocument();
});
