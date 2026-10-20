import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import {
  companionStatus,
  DEFAULT_INTEGRATION_PREFS,
  noteTurnEnded,
  onCompanionChanged,
  openExternalUrl,
  openPath,
  revealPath,
  structuredPartial,
  structuredTurns,
  type WorkReport,
  writeStdin,
} from "../ipc/bridge.ts";
import { useIntegration } from "../state/integration.ts";
import { useLayout } from "../state/layout.ts";
import { useOutsideOpen } from "../state/outsideOpen.ts";
import { useSentPrompts } from "../state/sentPrompts.ts";
import { useSessions } from "../state/sessions.ts";
import { useUsageCards } from "../state/usageCards.ts";
import { registerScreenText } from "../terminal/screenText.ts";
import type { SessionStatus } from "../types.ts";
import { resetInterruptGate } from "./interrupt.ts";
import { StructuredView } from "./StructuredView.tsx";

const WHAT_CLAUDE_DID = /What Claude did/;
const IMAGE_ONE = /\[Image #1\]/;

/** The fields a turn has that most tests don't care about. */
const QUIET = {
  ended: false,
  endedMs: null,
  images: [] as string[],
  reports: [] as WorkReport[],
  interrupted: false,
  startedMs: null,
} as const;

const sentNow = (text: string) => ({
  at: Date.now(),
  attachments: [],
  draft: text,
  text,
});
const WORKING = /Claude is working/;
const NO_TURNS = /No turns yet/;
const TRUST_HINT = /trust this folder/;

function setStatus(status: SessionStatus) {
  useSessions.setState({
    sessions: {
      s1: {
        archivedAt: null,
        baselineOid: null,
        claudeSessionId: null,
        createdAt: 1,
        cwd: "/proj",
        id: "s1",
        projectId: "p1",
        status,
        summary: "",
        title: "s1",
        titleLocked: false,
        worktreePath: null,
      },
    },
  });
}

const on = () =>
  vi.mocked(companionStatus).mockResolvedValue({
    claudeVersion: "2.1.288",
    state: "on",
  });

vi.mock("../ipc/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/bridge.ts")>()),
  companionStatus: vi.fn(),
  onCompanionChanged: vi.fn(() => Promise.resolve(() => undefined)),
  openExternalUrl: vi.fn(() => Promise.resolve()),
  openPath: vi.fn(() => Promise.resolve()),
  revealPath: vi.fn(() => Promise.resolve()),
  attachmentPreview: vi.fn(() => Promise.resolve(new ArrayBuffer(1))),
  noteTurnEnded: vi.fn(() => Promise.resolve()),
  structuredPartial: vi.fn(() => Promise.resolve(null)),
  structuredTurns: vi.fn(),
  writeStdin: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  resetInterruptGate();
  vi.mocked(writeStdin).mockClear();
  useSentPrompts.setState({ sent: {} });
  useUsageCards.setState({ shown: {} });
  useSessions.setState({ activity: {} });
  setStatus("done");
  vi.mocked(structuredTurns).mockResolvedValue([
    {
      ...QUIET,
      did: [
        { durationMs: 12_000, kind: "thought" },
        {
          id: "t",
          input: "ls",
          isError: false,
          kind: "step",
          description: null,
          target: null,
          name: "Bash",
          result: "a",
          stepKind: "command",
        },
      ],
      prompt: "fix it",
      reply: "Fixed.",
      source: "transcript",
    },
  ]);
});

test("shows each turn as prompt, a folded summary and the reply", async () => {
  vi.mocked(companionStatus).mockResolvedValue({
    claudeVersion: "2.1.288",
    state: "on",
  });
  render(<StructuredView sessionId="s1" />);
  expect(await screen.findByText("fix it")).toBeInTheDocument();
  expect(screen.getByText("Fixed.")).toBeInTheDocument();
  expect(screen.getByText("From transcript")).toBeInTheDocument();
  expect(screen.queryByText("Thought for 12s")).toBeNull();
  expect(
    screen.getByRole("button", { name: WHAT_CLAUDE_DID })
  ).toHaveTextContent("What Claude did · ran 1 command");
  fireEvent.click(screen.getByRole("button", { name: WHAT_CLAUDE_DID }));
  expect(screen.getByText("Thought for 12s")).toBeInTheDocument();
});

test("a prompt sent from Kriyon shows at once, with a working line", async () => {
  on();
  render(<StructuredView sessionId="s1" />);
  await screen.findByText("fix it");
  act(() => {
    useSentPrompts.getState().note("s1", sentNow("now add tests"));
  });
  expect(screen.getByText("now add tests")).toBeInTheDocument();
  expect(screen.getByText(WORKING)).toBeInTheDocument();
});

test("the usage card answers /usage where it was asked, between the turns", async () => {
  on();
  vi.mocked(structuredTurns).mockResolvedValue([
    {
      ...QUIET,
      did: [],
      prompt: "first",
      reply: "One.",
      source: "live",
      startedMs: 1000,
    },
    {
      ...QUIET,
      did: [],
      prompt: "second",
      reply: "Two.",
      source: "live",
      startedMs: 9000,
    },
  ]);
  useUsageCards.getState().show("s1", { at: 5000, command: "/cost" });
  render(<StructuredView sessionId="s1" />);
  await screen.findByText("Two.");
  const card = screen.getByRole("region", { name: "Usage" });
  const asked = screen.getByText("/cost");
  // Neither holds the other, so "following" is the whole answer.
  const follows = (a: Node, b: Node) =>
    a.compareDocumentPosition(b) === Node.DOCUMENT_POSITION_FOLLOWING;
  expect(follows(screen.getByText("One."), asked)).toBe(true);
  expect(follows(asked, card)).toBe(true);
  expect(follows(card, screen.getByText("second"))).toBe(true);
});

test("the sent prompt gives way to the real turn once it arrives", async () => {
  on();
  useSentPrompts.getState().note("s1", sentNow("fix it"));
  render(<StructuredView sessionId="s1" />);
  await screen.findByText("Fixed.");
  expect(screen.getAllByText("fix it")).toHaveLength(1);
});

test("a running turn says Claude is working until it ends", async () => {
  on();
  setStatus("running");
  render(<StructuredView sessionId="s1" />);
  expect(await screen.findByText(WORKING)).toBeInTheDocument();
  act(() => setStatus("done"));
  expect(screen.queryByText(WORKING)).toBeNull();
});

test("a companion post is read at once, not after a delay", async () => {
  on();
  let post: ((update: { sessionId: string }) => void) | undefined;
  vi.mocked(onCompanionChanged).mockImplementation((cb) => {
    post = cb;
    return Promise.resolve(() => undefined);
  });
  render(<StructuredView sessionId="s1" />);
  await screen.findByText("fix it");
  vi.mocked(structuredTurns).mockClear();
  act(() => post?.({ sessionId: "s1" }));
  expect(structuredTurns).toHaveBeenCalledTimes(1);
});

test("replies render their markdown: code blocks, inline code, bold", async () => {
  on();
  vi.mocked(structuredTurns).mockResolvedValue([
    {
      ...QUIET,
      did: [],
      prompt: "go",
      reply: "**Done.** Ran `ls`:\n\n```\ntotal 8\n```",
      source: "live",
    },
  ]);
  const { container } = render(<StructuredView sessionId="s1" />);
  expect((await screen.findByText("Done.")).tagName).toBe("STRONG");
  expect(screen.getByText("ls").tagName).toBe("CODE");
  expect(container.querySelector("pre")?.textContent).toBe("total 8");
  expect(container.textContent).not.toContain("`");
});

test("without the companion it says why instead of guessing", async () => {
  vi.mocked(companionStatus).mockResolvedValue({
    claudeVersion: null,
    state: "silent",
  });
  render(<StructuredView sessionId="s1" />);
  expect(
    await screen.findByText("The Structured view needs Kriyon Companion.")
  ).toBeInTheDocument();
  expect(screen.queryByText("fix it")).toBeNull();
});

test("links in a reply open: URLs in the browser, files in their app", async () => {
  on();
  vi.mocked(structuredTurns).mockResolvedValue([
    {
      ...QUIET,
      did: [],
      prompt: "go",
      reply: "See https://x.dev and `src/a.ts:4`.",
      source: "live",
    },
  ]);
  render(<StructuredView sessionId="s1" />);
  fireEvent.click(await screen.findByRole("link", { name: "https://x.dev" }));
  expect(openExternalUrl).toHaveBeenCalledWith("https://x.dev");
  const file = screen.getByRole("link", { name: "src/a.ts:4" });
  fireEvent.click(file);
  expect(openPath).toHaveBeenCalledWith("/proj", "src/a.ts:4");
  fireEvent.click(file, { metaKey: true });
  expect(revealPath).toHaveBeenCalledWith("/proj", "src/a.ts:4");
});

test("a file link resolves against the session's worktree", async () => {
  on();
  setStatus("done");
  useSessions.setState((state) => ({
    sessions: {
      s1: { ...state.sessions.s1, worktreePath: "/proj/.wt/b" },
    },
  }));
  vi.mocked(structuredTurns).mockResolvedValue([
    {
      ...QUIET,
      did: [],
      prompt: "go",
      reply: "Wrote src/a.ts.",
      source: "live",
    },
  ]);
  render(<StructuredView sessionId="s1" />);
  fireEvent.click(await screen.findByRole("link", { name: "src/a.ts" }));
  expect(openPath).toHaveBeenCalledWith("/proj/.wt/b", "src/a.ts");
});

test("a step's file path in What Claude did opens too", async () => {
  on();
  vi.mocked(structuredTurns).mockResolvedValue([
    {
      ...QUIET,
      did: [
        {
          id: "t",
          input: "/proj/src/a.ts",
          isError: false,
          kind: "step",
          description: null,
          target: null,
          name: "Read",
          result: null,
          stepKind: "read",
        },
      ],
      prompt: "go",
      reply: null,
      source: "live",
    },
  ]);
  render(<StructuredView sessionId="s1" />);
  fireEvent.click(await screen.findByRole("button", { name: WHAT_CLAUDE_DID }));
  fireEvent.click(screen.getByRole("link", { name: "/proj/src/a.ts" }));
  expect(openPath).toHaveBeenCalledWith("/proj", "/proj/src/a.ts");
});

test("an interrupted turn says so, and a turn shows when it was sent", async () => {
  on();
  vi.mocked(structuredTurns).mockResolvedValue([
    {
      ...QUIET,
      did: [],
      endedMs: 13_000,
      interrupted: true,
      prompt: "write a story",
      reply: "Once upon",
      source: "live",
      startedMs: 1000,
    },
  ]);
  render(<StructuredView sessionId="s1" />);
  expect(await screen.findByText("Interrupted")).toBeInTheDocument();
  expect(screen.getByText("took 12s")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Copy reply" })
  ).toBeInTheDocument();
});

test("a prompt's images replace its placeholders, and its links open", async () => {
  on();
  vi.mocked(structuredTurns).mockResolvedValue([
    {
      ...QUIET,
      did: [],
      images: ["/shots/a.png"],
      prompt: "what is in src/a.ts? [Image #1]",
      reply: null,
      source: "live",
    },
  ]);
  render(<StructuredView sessionId="s1" />);
  expect(
    await screen.findByRole("button", { name: "View a.png" })
  ).toBeInTheDocument();
  expect(screen.queryByText(IMAGE_ONE)).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "src/a.ts" }));
  expect(openPath).toHaveBeenCalledWith("/proj", "src/a.ts");
});

test("a picture outside the project opens in Preview once the user agrees", async () => {
  on();
  vi.mocked(structuredTurns).mockResolvedValue([
    {
      ...QUIET,
      did: [],
      images: ["/tmp/shot.png"],
      prompt: "[Image #1]",
      reply: null,
      source: "live",
    },
  ]);
  vi.mocked(openPath).mockRejectedValueOnce(
    "kind:outside-roots: /tmp/shot.png"
  );
  render(<StructuredView sessionId="s1" />);
  fireEvent.click(await screen.findByRole("button", { name: "View shot.png" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Open in Preview" })
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(useOutsideOpen.getState().request?.path).toBe("/tmp/shot.png");
});

test("a slow read never replaces a newer one", async () => {
  on();
  const turnSaying = (reply: string) => [
    { ...QUIET, did: [], prompt: "go", reply, source: "live" as const },
  ];
  let slow: (value: ReturnType<typeof turnSaying>) => void = () => undefined;
  vi.mocked(structuredTurns)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          slow = resolve;
        })
    )
    .mockImplementationOnce(() => Promise.resolve(turnSaying("Newer")));
  render(<StructuredView sessionId="s1" />);
  expect(await screen.findByText("Newer")).toBeInTheDocument();
  await act(async () => {
    slow(turnSaying("Older"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.queryByText("Older")).toBeNull();
  expect(screen.getByText("Newer")).toBeInTheDocument();
});

test("Esc in the view stops Claude while it works", async () => {
  on();
  setStatus("running");
  render(<StructuredView sessionId="s1" />);
  await screen.findByText(WORKING);
  const field = document.createElement("input");
  document.body.append(field);
  fireEvent.keyDown(field, { key: "Escape" });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(writeStdin).not.toHaveBeenCalled();
  field.remove();
  fireEvent.keyDown(document.body, { key: "Escape" });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(writeStdin).toHaveBeenCalledWith(
    "s1",
    new TextEncoder().encode("\u001b")
  );
});

test("Esc in the view leaves an open dialog alone, even one put aside", async () => {
  on();
  setStatus("running");
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
  render(<StructuredView sessionId="s1" />);
  await screen.findByText(WORKING);
  fireEvent.keyDown(document.body, { key: "Escape" });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // It would reach the dialog and cancel it.
  expect(writeStdin).not.toHaveBeenCalled();
});

test("Esc that an overlay takes doesn't also stop Claude", async () => {
  on();
  setStatus("running");
  render(<StructuredView sessionId="s1" />);
  await screen.findByText(WORKING);
  // Like the image viewer: it listens on window too, registered later.
  const overlay = (event: KeyboardEvent) => event.preventDefault();
  window.addEventListener("keydown", overlay);
  fireEvent.keyDown(document.body, { key: "Escape" });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  window.removeEventListener("keydown", overlay);
  expect(writeStdin).not.toHaveBeenCalled();
});

test("Claude's reply streams in while it works", async () => {
  on();
  setStatus("running");
  vi.mocked(structuredPartial).mockResolvedValue({
    block: 0,
    done: false,
    receivedMs: Date.now(),
    step: 0,
    text: "Once upon a",
    turnId: "t",
  });
  render(<StructuredView sessionId="s1" />);
  expect(await screen.findByTestId("live-reply")).toHaveTextContent(
    "Once upon a"
  );
});

test("a turn the transcript records as ended is reported, for the backend to settle", async () => {
  on();
  setStatus("running");
  vi.mocked(structuredTurns).mockResolvedValue([
    {
      ...QUIET,
      did: [],
      ended: true,
      endedMs: Date.now() - 60_000,
      prompt: "go",
      reply: "Done.",
      source: "live",
    },
  ]);
  render(<StructuredView sessionId="s1" />);
  await screen.findByText("Done.");
  await vi.waitFor(() =>
    expect(noteTurnEnded).toHaveBeenCalledWith("s1", expect.any(Number), false)
  );
  // The view never decides on its own that Claude stopped: the turn read may
  // be the one before a prompt just sent.
  expect(screen.getByText(WORKING)).toBeInTheDocument();
});

test("the tip the CLI shows under its spinner shows under the working line", async () => {
  on();
  setStatus("running");
  const stop = registerScreenText("s1", () => [
    "✳ Deliberating… (4s · esc to interrupt)",
    "  ⎿ \u00a0Tip: Use /memory to view and manage Claude memory",
  ]);
  render(<StructuredView sessionId="s1" />);
  expect(
    await screen.findByText("Use /memory to view and manage Claude memory", {
      exact: false,
    })
  ).toBeInTheDocument();
  stop();
});

test("Claude's messages in the middle of a turn show, not just the last", async () => {
  on();
  vi.mocked(structuredTurns).mockResolvedValue([
    {
      ...QUIET,
      did: [
        { kind: "text", text: "Let me look at the config first." },
        {
          id: "t",
          input: "{}",
          isError: false,
          kind: "step",
          description: null,
          target: null,
          name: "Read",
          result: "x",
          stepKind: "read",
        },
        { kind: "text", text: "The port is wrong; fixing it." },
      ],
      prompt: "fix it",
      reply: "Fixed.",
      source: "live",
    },
  ]);
  render(<StructuredView sessionId="s1" />);
  expect(
    await screen.findByText("Let me look at the config first.")
  ).toBeInTheDocument();
  expect(screen.getByText("The port is wrong; fixing it.")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: WHAT_CLAUDE_DID })
  ).toHaveTextContent("read 1 file");
});

test("a thought between Claude's messages shows as is, not as a fold of nothing", async () => {
  on();
  vi.mocked(structuredTurns).mockResolvedValue([
    {
      ...QUIET,
      did: [
        { durationMs: 3000, kind: "thought" },
        { kind: "text", text: "Let me look at the config first." },
        { durationMs: 5000, kind: "thought" },
        { kind: "text", text: "The port is wrong; fixing it." },
      ],
      prompt: "fix it",
      reply: "Fixed.",
      source: "live",
    },
  ]);
  render(<StructuredView sessionId="s1" />);
  expect(await screen.findByText("Thought for 5s")).toBeInTheDocument();
  expect(screen.getByText("Thought for 3s")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: WHAT_CLAUDE_DID })).toBeNull();
  expect(
    screen.queryByText("nothing but the reply", { exact: false })
  ).toBeNull();
});

test("while Claude works, the line says what it is doing", async () => {
  on();
  setStatus("running");
  vi.mocked(structuredTurns).mockResolvedValue([
    {
      ...QUIET,
      did: [
        {
          id: "t",
          input: '{"command":"pnpm test","description":"Run the test suite"}',
          isError: false,
          kind: "step",
          description: "Run the test suite",
          target: null,
          name: "Bash",
          result: null,
          stepKind: "command",
        },
      ],
      prompt: "fix it",
      reply: null,
      source: "live",
    },
  ]);
  const stop = registerScreenText("s1", () => [
    "✻ Fixing the login bug… (40s · esc to interrupt)",
  ]);
  render(<StructuredView sessionId="s1" />);
  expect(await screen.findByText("Fixing the login bug…")).toBeInTheDocument();
  expect(screen.getByText("Run the test suite")).toBeInTheDocument();
  stop();
});

test("with the companion off, the view offers to turn it on", async () => {
  vi.mocked(companionStatus).mockResolvedValue({
    claudeVersion: null,
    state: "off",
  });
  const update = vi.fn(() => Promise.resolve());
  useIntegration.setState({
    status: {
      companionAvailable: true,
      companionDir: null,
      originalStatusLine: null,
      plannedReason: "plugin",
      plannedRoute: "plugin",
      prefs: {
        ...DEFAULT_INTEGRATION_PREFS,
        companion: false,
        consented: true,
      },
      route: "plugin",
      routeReason: "plugin",
      sideload: "allowed",
    },
    update,
  });
  render(<StructuredView sessionId="s1" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Turn on Kriyon Companion" })
  );
  expect(update).toHaveBeenCalledWith({
    ...DEFAULT_INTEGRATION_PREFS,
    companion: true,
    consented: true,
    statusHooks: true,
  });
});

test("/usage still answers with the companion off: the card needs no turns", async () => {
  vi.mocked(companionStatus).mockResolvedValue({
    claudeVersion: null,
    state: "off",
  });
  useIntegration.setState({ status: null });
  useUsageCards.getState().show("s1", { at: 1, command: "/usage" });
  render(<StructuredView sessionId="s1" />);
  await screen.findByText("The Structured view needs Kriyon Companion.");
  expect(screen.getByRole("region", { name: "Usage" })).toBeInTheDocument();
});

test("a usage card in a session with no turns yet replaces the empty note", async () => {
  on();
  vi.mocked(structuredTurns).mockResolvedValue([]);
  useUsageCards.getState().show("s1", { at: 1, command: "/usage" });
  render(<StructuredView sessionId="s1" />);
  await screen.findByRole("region", { name: "Usage" });
  expect(screen.queryByText(NO_TURNS)).toBeNull();
});

test("before the setup is known, the notice doesn't say it forbids the companion", async () => {
  vi.mocked(companionStatus).mockResolvedValue({
    claudeVersion: null,
    state: "off",
  });
  useIntegration.setState({ status: null });
  render(<StructuredView sessionId="s1" />);
  await screen.findByText("The Structured view needs Kriyon Companion.");
  expect(screen.queryByText("doesn't allow", { exact: false })).toBeNull();
});

test("a work report opens its turn as a status line, not a prompt", async () => {
  on();
  vi.mocked(structuredTurns).mockResolvedValue([
    {
      ...QUIET,
      did: [],
      prompt: null,
      reports: [
        {
          event: null,
          outcome: "completed",
          summary:
            'Background command "Watch the nightly run" completed (exit code 0)',
        },
        {
          event: "- Installing CocoaPods...",
          outcome: "event",
          summary: 'Monitor event: "iPhone build"',
        },
        { event: null, outcome: "failed", summary: 'Agent "A" failed' },
        { event: null, outcome: "stopped", summary: "Shell stopped" },
        { event: null, outcome: "update", summary: "Artifact auto-replies on" },
      ],
      reply: "It passed.",
      source: "live",
    },
  ]);
  render(<StructuredView sessionId="s1" />);
  expect(await screen.findByText("Watch the nightly run")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Completed" })).toBeInTheDocument();
  expect(
    screen.getByRole("img", { name: "Monitor event" })
  ).toBeInTheDocument();
  for (const name of ["Failed", "Stopped", "Update"]) {
    expect(screen.getByRole("img", { name })).toBeInTheDocument();
  }
  expect(screen.getByText("- Installing CocoaPods...")).toBeInTheDocument();
  expect(screen.getByText("It passed.")).toBeInTheDocument();
});

test("tells the user's prompt apart from Claude's side of the turn", async () => {
  on();
  render(<StructuredView sessionId="s1" />);
  const prompt = await screen.findByRole("region", { name: "Your prompt" });
  expect(prompt).toHaveTextContent("fix it");
  // The corner nearest the user's edge stays tucked in, like a bubble's tail.
  const card = screen.getByText("fix it").closest("p");
  expect(card?.style.borderRadius).toBe("12px 12px 4px 12px");
  const claude = screen.getByRole("region", { name: "Claude" });
  expect(claude).toHaveTextContent("Fixed.");
  expect(claude).not.toHaveTextContent("fix it");
});

test("a prompt sent from Kriyon shows as the user's before its turn arrives", async () => {
  on();
  vi.mocked(structuredTurns).mockResolvedValue([]);
  useSentPrompts.setState({ sent: { s1: sentNow("hello") } });
  render(<StructuredView sessionId="s1" />);
  const prompt = await screen.findByRole("region", { name: "Your prompt" });
  expect(prompt).toHaveTextContent("hello");
});

test("while the companion starts, it shows it connecting, not that it's missing", async () => {
  vi.mocked(companionStatus).mockResolvedValue({
    claudeVersion: null,
    state: "starting",
  });
  useLayout.getState().setTranscriptView("structured", false);
  render(<StructuredView sessionId="s1" />);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Starting Kriyon Companion…"
  );
  expect(screen.getByText(TRUST_HINT)).toBeInTheDocument();
  expect(
    screen.queryByText("The Structured view needs Kriyon Companion.")
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Turn on Kriyon Companion" })
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open the terminal" }));
  expect(useLayout.getState().layout.transcriptView).toBe("raw");
});
