import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { useRemoteHosts } from "../state/remoteHosts.ts";
import type { HostSummary, SessionSummary } from "./hostSummary.ts";
import { RemoteView } from "./RemoteView.tsx";

vi.mock("./RemoteTerminal.tsx", () => ({
  RemoteTerminal: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="remote-terminal">{sessionId}</div>
  ),
}));

const PAIR_HINT = /Settings, Remote access/;
const FIX_LOGIN = /Fix login/;
const DOCS = /Docs/;
const HOST = "ab".repeat(32);

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    dialogOpen: false,
    id: "s1",
    lastChangeMs: 0,
    mayType: false,
    needsYou: true,
    projectId: "/work/app",
    standing: "awaiting_input",
    status: "waiting",
    title: "Fix login",
    typing: null,
    ...over,
  };
}

/** A summary as Rust would send it; cases set mayStart as Rust would. */
function link(over: Partial<HostSummary> = {}): HostSummary {
  return {
    hostId: HOST,
    hostName: "Studio",
    link: "connected",
    mayStart: true,
    refused: null,
    role: "controller",
    projects: [{ id: "/work/app", name: "app", parked: false }],
    sessions: [
      session(),
      session({
        id: "s2",
        needsYou: false,
        standing: "running",
        status: "running",
        title: "Docs",
      }),
    ],
    ...over,
  };
}

beforeEach(() => {
  useRemoteHosts.setState(useRemoteHosts.getInitialState());
});

test("with no paired computer it says how to pair one", () => {
  render(<RemoteView />);
  expect(screen.getByText(PAIR_HINT)).toBeTruthy();
});

test("each paired computer lists its sessions with standing and needs-you", () => {
  useRemoteHosts.setState({
    hosts: [{ hostId: HOST, name: "Studio", pairedAt: 0 }],
    links: { [HOST]: link() },
  });
  render(<RemoteView />);
  expect(screen.getByText("Studio")).toBeTruthy();
  expect(screen.getByText("Connected")).toBeTruthy();
  expect(screen.getByRole("button", { name: FIX_LOGIN }).textContent).toContain(
    "Needs you"
  );
  expect(screen.getByRole("button", { name: DOCS }).textContent).toContain(
    "Running"
  );
  expect(screen.getByRole("button", { name: DOCS }).textContent).not.toContain(
    "Needs you"
  );
});

test("a paired computer not heard from yet says it is connecting", () => {
  useRemoteHosts.setState({
    hosts: [{ hostId: HOST, name: "Studio", pairedAt: 0 }],
  });
  render(<RemoteView />);
  expect(screen.getByText("Connecting…")).toBeTruthy();
});

test("a lost link says typing is off", () => {
  useRemoteHosts.setState({
    hosts: [{ hostId: HOST, name: "Studio", pairedAt: 0 }],
    links: { [HOST]: link({ link: "lost", mayStart: false }) },
  });
  render(<RemoteView />);
  expect(
    screen.getByText("Disconnected, reconnecting. Typing is off.")
  ).toBeTruthy();
});

test("choosing a session shows its screen", () => {
  useRemoteHosts.setState({
    hosts: [{ hostId: HOST, name: "Studio", pairedAt: 0 }],
    links: { [HOST]: link() },
  });
  render(<RemoteView />);
  expect(screen.queryByTestId("remote-terminal")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: DOCS }));
  expect(screen.getByTestId("remote-terminal").textContent).toBe("s2");
});

test("a session can be read as entries, and goes back to its terminal", () => {
  const readEntries = vi.fn(() => Promise.resolve());
  const stopEntries = vi.fn(() => Promise.resolve());
  useRemoteHosts.setState({
    hosts: [{ hostId: HOST, name: "Studio", pairedAt: 0 }],
    links: { [HOST]: link() },
    readEntries,
    stopEntries,
  });
  render(<RemoteView />);
  fireEvent.click(screen.getByRole("button", { name: DOCS }));
  fireEvent.click(screen.getByRole("tab", { name: "Readable" }));
  expect(readEntries).toHaveBeenCalledWith(HOST, "s2");
  act(() =>
    useRemoteHosts.setState({
      readable: {
        [`${HOST}:s2`]: {
          entries: [{ kind: "note", seq: 1, text: "Context compacted" }],
          unavailable: null,
        },
      },
    })
  );
  expect(screen.getByText("Context compacted")).toBeInTheDocument();
  expect(screen.getByTestId("remote-terminal")).not.toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
  expect(stopEntries).toHaveBeenCalledWith(HOST, "s2");
  expect(screen.getByTestId("remote-terminal")).toBeVisible();
});

test("with no entries to read there, the terminal shows with why", () => {
  useRemoteHosts.setState({
    hosts: [{ hostId: HOST, name: "Studio", pairedAt: 0 }],
    links: { [HOST]: link() },
    readEntries: vi.fn(() => Promise.resolve()),
    stopEntries: vi.fn(() => Promise.resolve()),
  });
  render(<RemoteView />);
  fireEvent.click(screen.getByRole("button", { name: DOCS }));
  fireEvent.click(screen.getByRole("tab", { name: "Readable" }));
  act(() =>
    useRemoteHosts.setState({
      readable: {
        [`${HOST}:s2`]: { entries: [], unavailable: "The Companion is off." },
      },
    })
  );
  expect(screen.getByText("The Companion is off.")).toBeInTheDocument();
  expect(screen.getByTestId("remote-terminal")).toBeVisible();
});

test("a session that ended there stops showing here", () => {
  useRemoteHosts.setState({
    hosts: [{ hostId: HOST, name: "Studio", pairedAt: 0 }],
    links: { [HOST]: link() },
  });
  render(<RemoteView />);
  fireEvent.click(screen.getByRole("button", { name: DOCS }));
  act(() =>
    useRemoteHosts.getState().linkChanged(link({ sessions: [session()] }))
  );
  expect(screen.queryByTestId("remote-terminal")).toBeNull();
});

test("a Controller starts a session in a project there, and it opens", async () => {
  const startSession = vi.fn(() => {
    useRemoteHosts.setState({
      started: { hostId: HOST, sessionId: "new-one" },
    });
    return Promise.resolve("new-one");
  });
  useRemoteHosts.setState({
    hosts: [{ hostId: HOST, name: "Studio", pairedAt: 0 }],
    links: {
      [HOST]: link({
        projects: [
          { id: "/work/app", name: "app", parked: false },
          { id: "/work/old", name: "old", parked: true },
        ],
      }),
    },
    startSession,
  });
  render(<RemoteView />);
  fireEvent.click(screen.getByRole("button", { name: "New session" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Project" }), {
    target: { value: "/work/old" },
  });
  expect(screen.getByRole("option", { name: "old (parked)" })).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Fix login" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await act(() => Promise.resolve());
  expect(startSession).toHaveBeenCalledWith(HOST, "/work/old", "Fix login");
  // It opens once that computer lists it.
  act(() =>
    useRemoteHosts.getState().linkChanged(
      link({
        sessions: [
          session({ id: "new-one", needsYou: false, title: "Fix login" }),
        ],
      })
    )
  );
  expect(screen.getByTestId("remote-terminal").textContent).toBe("new-one");
});

test("a start under way stays shown through a lost link, and can't be cancelled", () => {
  useRemoteHosts.setState({
    hosts: [{ hostId: HOST, name: "Studio", pairedAt: 0 }],
    links: { [HOST]: link() },
    startSession: vi.fn(() => new Promise<string | null>(() => undefined)),
  });
  render(<RemoteView />);
  fireEvent.click(screen.getByRole("button", { name: "New session" }));
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  act(() =>
    useRemoteHosts.setState({
      links: { [HOST]: link({ link: "lost", mayStart: false }) },
      starting: { [HOST]: true },
    })
  );
  expect(screen.getByRole("button", { name: "Starting…" })).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
      .disabled
  ).toBe(true);
});

test("a project gone from the list is not the one sent", async () => {
  const startSession = vi.fn(() => Promise.resolve(null));
  useRemoteHosts.setState({
    hosts: [{ hostId: HOST, name: "Studio", pairedAt: 0 }],
    links: {
      [HOST]: link({
        projects: [
          { id: "/work/app", name: "app", parked: false },
          { id: "/work/old", name: "old", parked: false },
        ],
      }),
    },
    startSession,
  });
  render(<RemoteView />);
  fireEvent.click(screen.getByRole("button", { name: "New session" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Project" }), {
    target: { value: "/work/old" },
  });
  act(() => useRemoteHosts.getState().linkChanged(link()));
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await act(() => Promise.resolve());
  expect(startSession).toHaveBeenCalledWith(HOST, "/work/app", "");
});

test("a refused start says why", async () => {
  useRemoteHosts.setState({
    hosts: [{ hostId: HOST, name: "Studio", pairedAt: 0 }],
    links: { [HOST]: link() },
    startSession: vi.fn(() => {
      useRemoteHosts.setState({
        startErrors: { [HOST]: "No, and here is why." },
      });
      return Promise.resolve(null);
    }),
  });
  render(<RemoteView />);
  fireEvent.click(screen.getByRole("button", { name: "New session" }));
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  expect(await screen.findByText("No, and here is why.")).toBeTruthy();
});

test("a Viewer is not offered a new session", () => {
  useRemoteHosts.setState({
    hosts: [{ hostId: HOST, name: "Studio", pairedAt: 0 }],
    links: { [HOST]: link({ mayStart: false, role: "viewer" }) },
  });
  render(<RemoteView />);
  expect(screen.queryByRole("button", { name: "New session" })).toBeNull();
});
