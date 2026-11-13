import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { HostLink, HostSession } from "../ipc/bridge.ts";
import { useRemoteHosts } from "../state/remoteHosts.ts";
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

function session(over: Partial<HostSession> = {}): HostSession {
  return {
    dialogOpen: false,
    id: "s1",
    lastChangeMs: 0,
    mine: false,
    needsYou: true,
    standing: "awaiting_input",
    status: "waiting",
    title: "Fix login",
    ...over,
  };
}

function link(over: Partial<HostLink> = {}): HostLink {
  return {
    hostId: HOST,
    name: "Studio",
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
    state: "connected",
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
    links: { [HOST]: link({ state: "lost" }) },
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
  const startSession = vi.fn(() => Promise.resolve("new-one"));
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

test("a refused start says why", async () => {
  useRemoteHosts.setState({
    hosts: [{ hostId: HOST, name: "Studio", pairedAt: 0 }],
    links: { [HOST]: link() },
    startSession: vi.fn(() => {
      useRemoteHosts.setState({ startError: "No, and here is why." });
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
    links: { [HOST]: link({ role: "viewer" }) },
  });
  render(<RemoteView />);
  expect(screen.queryByRole("button", { name: "New session" })).toBeNull();
});
