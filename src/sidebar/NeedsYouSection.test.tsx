import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { type UiSession, useSessions } from "../state/sessions.ts";
import type { SessionActivity } from "../types.ts";
import { NeedsYouSection } from "./NeedsYouSection.tsx";

function session(id: string): UiSession {
  return {
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "/x",
    id,
    projectId: "p1",
    status: "waiting",
    summary: "",
    title: id,
    titleLocked: false,
    worktreePath: null,
  };
}

function asking(text: string): SessionActivity {
  return {
    main: { currentTool: null },
    pendingAsk: { askedAt: null, kind: "question", text },
    shells: [],
    subagents: [],
    tasks: [],
  };
}

beforeEach(() => {
  useSessions.setState({
    activeSessionId: "s2",
    activity: { s1: asking("Merge or rebase?") },
    appendSeq: {},
    projects: [
      { color: null, id: "p1", name: "P1", path: "/x", setupCommand: null },
    ],
    sessions: { s1: session("s1"), s2: session("s2") },
    statusOrigin: {},
    viewed: {},
  });
  useLayout.setState({ layout: DEFAULT_LAYOUT });
});

test("clicking a needs-you row selects that session", () => {
  const spy = vi.spyOn(useSessions.getState(), "setActiveSession");
  render(<NeedsYouSection />);

  fireEvent.click(screen.getByTestId("needs-you-s1"));

  expect(spy).toHaveBeenCalledWith("s1");
});

test("selecting from needs-you returns to the terminal, like the project tree does", () => {
  // The Needs-you list is the more urgent selection route of the two in this
  // sidebar; landing on the *new* session's Changes tab is exactly as wrong
  // there as it was from a project row.
  useLayout.getState().setTranscriptView("changes");
  render(<NeedsYouSection />);

  fireEvent.click(screen.getByTestId("needs-you-s1"));

  expect(useLayout.getState().layout.transcriptView).toBe("raw");
});
