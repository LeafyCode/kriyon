import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { useProjectFolders } from "../state/projectFolders.ts";
import { type UiSession, useSessions } from "../state/sessions.ts";
import type { ProjectRow } from "../types.ts";
import { Sidebar } from "./Sidebar.tsx";

vi.mock("../ipc/bridge.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc/bridge.ts")>();
  return {
    ...actual,
    repoStatus: vi.fn(() =>
      Promise.resolve({ ahead: 0, behind: 0, branch: "", dirtyCount: 0 })
    ),
    unmergedCommits: vi.fn(() => Promise.resolve(0)),
  };
});

vi.mock("../state/actions.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/actions.ts")>()),
  prewarmSession: vi.fn(() => Promise.resolve()),
}));

const EMPTY_HINT = /No open sessions/;
const MOVE_HINT = /Move to folder/;
const PARKED_HINT = /^Parked/;

function project(id: string, extra: Partial<ProjectRow> = {}): ProjectRow {
  return {
    color: null,
    id,
    name: `Project ${id}`,
    path: `/${id}`,
    setupCommand: null,
    ...extra,
  };
}

function session(
  id: string,
  projectId: string,
  extra: Partial<UiSession> = {}
): UiSession {
  return {
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "",
    id,
    projectId,
    status: "idle",
    summary: "",
    title: `Session ${id}`,
    titleLocked: false,
    worktreePath: null,
    ...extra,
  };
}

function seed(projects: ProjectRow[], sessions: UiSession[]): void {
  useSessions.setState({
    activeSessionId: null,
    activity: {},
    appendSeq: {},
    events: {},
    hooksOff: {},
    projects,
    sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
    touchedFiles: {},
    viewed: {},
  });
}

function renderSidebar(): void {
  render(
    <Sidebar
      onCloseSession={vi.fn()}
      onNewSession={vi.fn()}
      onShowAbout={vi.fn()}
    />
  );
}

beforeEach(() => {
  useLayout.setState({ layout: DEFAULT_LAYOUT });
  useProjectFolders.setState({ editingFolderId: null, folders: [] });
});

test("with no folders and no pins the rail has no Pinned section and no divider", () => {
  seed(
    [project("p1"), project("p2")],
    [session("a", "p1"), session("b", "p2")]
  );
  renderSidebar();
  expect(screen.queryByTestId("pinned-section")).toBeNull();
  expect(screen.queryByTestId("loose-divider")).toBeNull();
  expect(screen.getByTestId("project-header-p1")).toBeInTheDocument();
  expect(screen.getByTestId("project-header-p2")).toBeInTheDocument();
});

test("pinning a project from its menu moves it to Pinned", () => {
  seed(
    [project("p1"), project("p2")],
    [session("a", "p1"), session("b", "p2")]
  );
  renderSidebar();
  fireEvent.click(screen.getByLabelText("More actions for Project p1"));
  fireEvent.click(screen.getByTestId("pin-project-p1"));
  const pinned = screen.getByTestId("pinned-section");
  expect(within(pinned).getByTestId("project-header-p1")).toBeInTheDocument();
  expect(within(pinned).queryByTestId("project-header-p2")).toBeNull();
});

test("a pinned session shows once, in Pinned, with its project's name", () => {
  seed(
    [project("p1")],
    [session("a", "p1"), session("pin", "p1", { pinnedAt: 5 })]
  );
  renderSidebar();
  const pinned = screen.getByTestId("pinned-section");
  expect(within(pinned).getByText("Session pin")).toBeInTheDocument();
  expect(within(pinned).getByTestId("pinned-project-pin")).toHaveTextContent(
    "Project p1"
  );
  expect(screen.getAllByText("Session pin")).toHaveLength(1);
});

test("a project whose only session is pinned leaves the project list", () => {
  seed([project("p1")], [session("pin", "p1", { pinnedAt: 5 })]);
  renderSidebar();
  expect(screen.queryByTestId("project-header-p1")).toBeNull();
  expect(screen.queryByText(EMPTY_HINT)).toBeNull();
});

test("New folder… from the project menu makes a folder holding it and opens its name", () => {
  seed(
    [project("p1"), project("p2")],
    [session("a", "p1"), session("b", "p2")]
  );
  renderSidebar();
  fireEvent.click(screen.getByLabelText("More actions for Project p1"));
  fireEvent.click(screen.getByTestId("move-to-folder-p1"));
  fireEvent.click(screen.getByTestId("new-folder-for-p1"));

  const [folder] = useProjectFolders.getState().folders;
  expect(folder).toBeDefined();
  const id = folder?.id ?? "";
  const name = screen.getByTestId(`folder-name-${id}`);
  fireEvent.change(name, { target: { value: "Client work" } });
  fireEvent.keyDown(name, { key: "Enter" });

  const block = screen.getByTestId(`folder-${id}`);
  expect(within(block).getByText("Client work")).toBeInTheDocument();
  expect(within(block).getByTestId("project-header-p1")).toBeInTheDocument();
  expect(within(block).queryByTestId("project-header-p2")).toBeNull();
  expect(screen.getByTestId("loose-divider")).toBeInTheDocument();
});

test("a collapsed folder hides its projects but shows that one needs you", () => {
  useProjectFolders.setState({ folders: [{ id: "f1", name: "Acme" }] });
  seed(
    [project("p1", { folderId: "f1" })],
    [session("a", "p1", { status: "waiting" })]
  );
  renderSidebar();
  fireEvent.click(screen.getByTestId("folder-header-f1"));
  expect(screen.queryByTestId("project-header-p1")).toBeNull();
  expect(screen.getByTestId("folder-attention-f1")).toBeInTheDocument();
  expect(useLayout.getState().layout.collapsedFolderIds).toEqual(["f1"]);
});

test("the header's New folder button draws an empty folder with a hint", () => {
  seed([project("p1")], [session("a", "p1")]);
  renderSidebar();
  fireEvent.click(screen.getByTestId("new-folder"));
  const id = useProjectFolders.getState().folders[0]?.id ?? "";
  fireEvent.keyDown(screen.getByTestId(`folder-name-${id}`), { key: "Enter" });
  expect(screen.getByTestId(`folder-empty-${id}`)).toHaveTextContent(MOVE_HINT);
});

test("focus shows only the folder, names it, and leaving restores the rail", () => {
  useProjectFolders.setState({ folders: [{ id: "f1", name: "Acme" }] });
  seed(
    [project("p1", { folderId: "f1" }), project("p2")],
    [session("a", "p1"), session("b", "p2")]
  );
  renderSidebar();
  fireEvent.click(screen.getByLabelText("More actions for folder Acme"));
  fireEvent.click(screen.getByTestId("focus-folder-f1"));

  expect(screen.getByTestId("focus-banner")).toHaveTextContent("Acme");
  expect(screen.getByTestId("focus-banner")).toHaveTextContent("1 hidden");
  expect(screen.queryByTestId("project-header-p2")).toBeNull();

  fireEvent.click(screen.getByTestId("leave-focus"));
  expect(screen.queryByTestId("focus-banner")).toBeNull();
  expect(screen.getByTestId("project-header-p2")).toBeInTheDocument();
});

test("cmd+shift+F focuses the active session's folder, and again leaves", () => {
  useProjectFolders.setState({ folders: [{ id: "f1", name: "Acme" }] });
  seed(
    [project("p1", { folderId: "f1" }), project("p2")],
    [session("a", "p1"), session("b", "p2")]
  );
  useSessions.setState({ activeSessionId: "a" });
  renderSidebar();
  // Both modifiers: the app modifier is ⌘ on mac and Ctrl elsewhere.
  const chord = { ctrlKey: true, key: "F", metaKey: true, shiftKey: true };
  act(() => {
    fireEvent.keyDown(window, chord);
  });
  expect(useLayout.getState().layout.focusedFolderId).toBe("f1");
  act(() => {
    fireEvent.keyDown(window, chord);
  });
  expect(useLayout.getState().layout.focusedFolderId).toBeNull();
});

test("deleting a folder returns its projects to the plain list", () => {
  useProjectFolders.setState({ folders: [{ id: "f1", name: "Acme" }] });
  seed([project("p1", { folderId: "f1" })], [session("a", "p1")]);
  renderSidebar();
  fireEvent.click(screen.getByLabelText("More actions for folder Acme"));
  fireEvent.click(screen.getByTestId("delete-folder-f1"));
  expect(screen.queryByTestId("folder-f1")).toBeNull();
  expect(screen.getByTestId("project-header-p1")).toBeInTheDocument();
});

test("Parked stays open when the last open project is parked", () => {
  seed(
    [project("p1"), project("p2")],
    [session("a", "p1"), session("b", "p2", { parkedAt: 3 })]
  );
  renderSidebar();
  const toggle = () =>
    within(screen.getByTestId("parked-group")).getByRole("button", {
      name: PARKED_HINT,
    });
  fireEvent.click(toggle());
  expect(toggle()).toHaveAttribute("aria-expanded", "true");
  act(() => {
    useSessions.setState((state) => ({
      sessions: {
        ...state.sessions,
        a: { ...session("a", "p1"), parkedAt: 4 },
      },
    }));
  });
  expect(toggle()).toHaveAttribute("aria-expanded", "true");
});

test("a pinned project's menu does not offer Move to folder", () => {
  seed([project("p1", { pinnedAt: 5 })], [session("a", "p1")]);
  renderSidebar();
  fireEvent.click(screen.getByLabelText("More actions for Project p1"));
  expect(screen.queryByTestId("move-to-folder-p1")).toBeNull();
});

test("New folder while a folder is focused leaves focus and shows the name field", () => {
  useProjectFolders.setState({ folders: [{ id: "f1", name: "Acme" }] });
  seed([project("p1", { folderId: "f1" })], [session("a", "p1")]);
  useLayout.getState().setFocusedFolder("f1");
  renderSidebar();
  fireEvent.click(screen.getByTestId("new-folder"));
  const made = useProjectFolders
    .getState()
    .folders.find((folder) => folder.id !== "f1");
  expect(screen.getByTestId(`folder-name-${made?.id}`)).toBeInTheDocument();
  expect(screen.queryByTestId("focus-banner")).toBeNull();
});

test("searching a project's name keeps its pinned sessions", () => {
  seed(
    [project("p1", { name: "Billing" })],
    [session("pin", "p1", { pinnedAt: 5, title: "Fix login" })]
  );
  renderSidebar();
  fireEvent.change(screen.getByLabelText("Filter sessions"), {
    target: { value: "billing" },
  });
  expect(screen.getByText("Fix login")).toBeInTheDocument();
});

test("the focus chord does nothing when another handler already took the keypress", () => {
  useProjectFolders.setState({ folders: [{ id: "f1", name: "Acme" }] });
  seed([project("p1", { folderId: "f1" })], [session("a", "p1")]);
  useSessions.setState({ activeSessionId: "a" });
  renderSidebar();
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    key: "F",
    metaKey: true,
    shiftKey: true,
  });
  event.preventDefault();
  act(() => {
    window.dispatchEvent(event);
  });
  expect(useLayout.getState().layout.focusedFolderId).toBeNull();
});

test("double-click renames the focused folder too", () => {
  useProjectFolders.setState({ folders: [{ id: "f1", name: "Acme" }] });
  seed([project("p1", { folderId: "f1" })], [session("a", "p1")]);
  useLayout.getState().setFocusedFolder("f1");
  renderSidebar();
  fireEvent.doubleClick(screen.getByTestId("folder-header-f1"));
  expect(screen.getByTestId("folder-name-f1")).toBeInTheDocument();
});

test("pinning a folder's only project keeps the folder on the rail", () => {
  useProjectFolders.setState({ folders: [{ id: "f1", name: "Acme" }] });
  seed([project("p1", { folderId: "f1" })], [session("a", "p1")]);
  renderSidebar();
  fireEvent.click(screen.getByLabelText("More actions for Project p1"));
  fireEvent.click(screen.getByTestId("pin-project-p1"));
  expect(screen.getByTestId("folder-f1")).toBeInTheDocument();
});
