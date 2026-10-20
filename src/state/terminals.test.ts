import { beforeEach, describe, expect, it, vi } from "vitest";

const dispose = vi.fn();
vi.mock("../terminal/sessionHost.ts", () => ({
  disposeSession: (id: string) => dispose(id),
}));

import { useTerminals } from "./terminals.ts";

function reset() {
  useTerminals.setState({
    busyPanes: {},
    byProject: {},
    deadPanes: {},
    quitConfirm: null,
  });
  dispose.mockClear();
}

describe("useTerminals", () => {
  beforeEach(reset);

  it("openTab seeds one tab with one pane whose cwd is the project cwd", () => {
    const tabId = useTerminals.getState().openTab("proj", "/repo");
    const p = useTerminals.getState().byProject.proj;
    expect(p.tabs).toHaveLength(1);
    expect(p.activeTabId).toBe(tabId);
    expect(p.tabs[0].panes).toHaveLength(1);
    expect(p.tabs[0].panes[0].cwd).toBe("/repo");
    expect(p.tabs[0].activePaneId).toBe(p.tabs[0].panes[0].id);
    expect(p.tabs[0].direction).toBe("row");
    expect(p.tabs[0].title).toBe("Terminal 1");
  });

  it("a second openTab numbers Terminal 2 and becomes active", () => {
    useTerminals.getState().openTab("proj", "/repo");
    const t2 = useTerminals.getState().openTab("proj", "/repo");
    const p = useTerminals.getState().byProject.proj;
    expect(p.tabs).toHaveLength(2);
    expect(p.tabs[1].title).toBe("Terminal 2");
    expect(p.activeTabId).toBe(t2);
  });

  it("splitPane adds a pane to the tab and makes it active, preserving others", () => {
    const tabId = useTerminals.getState().openTab("proj", "/repo");
    const paneId = useTerminals.getState().splitPane("proj", tabId, "/repo");
    const [tab] = useTerminals.getState().byProject.proj.tabs;
    expect(tab.panes).toHaveLength(2);
    expect(tab.activePaneId).toBe(paneId);
  });

  it("closePane removes the pane, disposes its daemon, reassigns active", () => {
    const tabId = useTerminals.getState().openTab("proj", "/repo");
    const paneId = useTerminals.getState().splitPane("proj", tabId, "/repo");
    useTerminals.getState().closePane("proj", tabId, paneId);
    const [tab] = useTerminals.getState().byProject.proj.tabs;
    expect(tab.panes).toHaveLength(1);
    expect(tab.activePaneId).toBe(tab.panes[0].id);
    expect(dispose).toHaveBeenCalledWith(paneId);
  });

  it("splitPane keeps the existing panes' relative sizes and gives the new pane an equal share", () => {
    const tabId = useTerminals.getState().openTab("proj", "/repo");
    useTerminals.getState().splitPane("proj", tabId, "/repo"); // 2 panes
    useTerminals.getState().setLayout("proj", tabId, [70, 30]);
    useTerminals.getState().splitPane("proj", tabId, "/repo"); // 3 panes
    const { layout } = useTerminals.getState().byProject.proj.tabs[0];
    expect(layout).toHaveLength(3);
    const [a, b, c] = layout;
    // The two original panes keep their 70:30 ratio…
    expect(a / b).toBeCloseTo(70 / 30, 5);
    // …and the new pane gets an equal (1/3) slice; the whole still sums to 100.
    expect(c).toBeCloseTo(100 / 3, 5);
    expect(a + b + c).toBeCloseTo(100, 5);
  });

  it("splitPane leaves an un-dragged tab to auto-distribute (layout stays [])", () => {
    const tabId = useTerminals.getState().openTab("proj", "/repo");
    useTerminals.getState().splitPane("proj", tabId, "/repo");
    expect(useTerminals.getState().byProject.proj.tabs[0].layout).toEqual([]);
  });

  it("closePane re-normalizes the survivors instead of wiping their sizes", () => {
    const tabId = useTerminals.getState().openTab("proj", "/repo");
    useTerminals.getState().splitPane("proj", tabId, "/repo"); // 2
    useTerminals.getState().splitPane("proj", tabId, "/repo"); // 3
    useTerminals.getState().setLayout("proj", tabId, [50, 30, 20]);
    const middle = useTerminals.getState().byProject.proj.tabs[0].panes[1].id;
    useTerminals.getState().closePane("proj", tabId, middle);
    const { layout } = useTerminals.getState().byProject.proj.tabs[0];
    expect(layout).toHaveLength(2);
    const [a, b] = layout;
    // The survivors keep their 50:20 ratio, re-normalized to sum to 100.
    expect(a / b).toBeCloseTo(50 / 20, 5);
    expect(a + b).toBeCloseTo(100, 5);
  });

  it("closePane keeps [] for an un-dragged tab", () => {
    const tabId = useTerminals.getState().openTab("proj", "/repo");
    useTerminals.getState().splitPane("proj", tabId, "/repo"); // 2, never dragged
    const second = useTerminals.getState().byProject.proj.tabs[0].panes[1].id;
    useTerminals.getState().closePane("proj", tabId, second);
    expect(useTerminals.getState().byProject.proj.tabs[0].layout).toEqual([]);
  });

  it("closing the last pane of a tab closes the tab and disposes the pane", () => {
    const tabId = useTerminals.getState().openTab("proj", "/repo");
    const onlyPane = useTerminals.getState().byProject.proj.tabs[0].panes[0].id;
    useTerminals.getState().closePane("proj", tabId, onlyPane);
    expect(useTerminals.getState().byProject.proj.tabs).toHaveLength(0);
    expect(dispose).toHaveBeenCalledWith(onlyPane);
  });

  it("closeTab disposes every pane in the tab and reassigns active tab", () => {
    const t1 = useTerminals.getState().openTab("proj", "/repo");
    const paneT1 = useTerminals.getState().byProject.proj.tabs[0].panes[0].id;
    useTerminals.getState().splitPane("proj", t1, "/repo");
    const t2 = useTerminals.getState().openTab("proj", "/repo");
    useTerminals.getState().closeTab("proj", t2);
    const p = useTerminals.getState().byProject.proj;
    expect(p.tabs).toHaveLength(1);
    expect(p.activeTabId).toBe(t1);
    useTerminals.getState().closeTab("proj", t1);
    expect(dispose).toHaveBeenCalledWith(paneT1);
    expect(useTerminals.getState().byProject.proj.tabs).toHaveLength(0);
  });

  it("renameTab and setDirection mutate the tab", () => {
    const tabId = useTerminals.getState().openTab("proj", "/repo");
    useTerminals.getState().renameTab("proj", tabId, "dev");
    useTerminals.getState().setDirection("proj", tabId, "column");
    const [tab] = useTerminals.getState().byProject.proj.tabs;
    expect(tab.title).toBe("dev");
    expect(tab.direction).toBe("column");
  });

  it("livePaneCount counts panes across all projects", () => {
    const a = useTerminals.getState().openTab("a", "/a");
    useTerminals.getState().splitPane("a", a, "/a");
    useTerminals.getState().openTab("b", "/b");
    expect(useTerminals.getState().livePaneCount()).toBe(3);
  });

  it("projects are isolated", () => {
    useTerminals.getState().openTab("a", "/a");
    expect(useTerminals.getState().byProject.b).toBeUndefined();
  });

  it("setPaneBusy tracks busy panes and hasBusyPanes reflects it", () => {
    const tabId = useTerminals.getState().openTab("proj", "/repo");
    const pane = useTerminals.getState().byProject.proj.tabs[0].panes[0].id;
    expect(useTerminals.getState().hasBusyPanes()).toBe(false);
    useTerminals.getState().setPaneBusy(pane, true);
    expect(useTerminals.getState().isPaneBusy(pane)).toBe(true);
    expect(useTerminals.getState().isTabBusy("proj", tabId)).toBe(true);
    expect(useTerminals.getState().hasBusyPanes()).toBe(true);
    useTerminals.getState().setPaneBusy(pane, false);
    expect(useTerminals.getState().hasBusyPanes()).toBe(false);
  });

  it("setPaneBusy ignores ids that are not known panes (e.g. Claude sessions)", () => {
    useTerminals.getState().setPaneBusy("some-claude-session-id", true);
    expect(useTerminals.getState().hasBusyPanes()).toBe(false);
  });

  it("closing a pane clears its busy flag", () => {
    const tabId = useTerminals.getState().openTab("proj", "/repo");
    const paneId = useTerminals.getState().splitPane("proj", tabId, "/repo");
    useTerminals.getState().setPaneBusy(paneId, true);
    useTerminals.getState().closePane("proj", tabId, paneId);
    expect(useTerminals.getState().hasBusyPanes()).toBe(false);
  });

  it("setPaneExited marks a live pane dead and clears its busy flag", () => {
    const tabId = useTerminals.getState().openTab("proj", "/repo");
    const paneId = useTerminals.getState().byProject.proj.tabs[0].panes[0].id;
    useTerminals.getState().setPaneBusy(paneId, true);

    useTerminals.getState().setPaneExited(paneId);

    expect(useTerminals.getState().isPaneDead(paneId)).toBe(true);
    // A dead shell has no running process — the close-confirm must not ask.
    expect(useTerminals.getState().isPaneBusy(paneId)).toBe(false);
    expect(useTerminals.getState().isTabBusy("proj", tabId)).toBe(false);
  });

  it("setPaneExited ignores ids that are not known panes (e.g. Claude sessions)", () => {
    useTerminals.getState().setPaneExited("some-claude-session-id");
    expect(useTerminals.getState().deadPanes).toEqual({});
  });

  it("clearPaneExited resets the dead flag for a restart", () => {
    useTerminals.getState().openTab("proj", "/repo");
    const paneId = useTerminals.getState().byProject.proj.tabs[0].panes[0].id;
    useTerminals.getState().setPaneExited(paneId);

    useTerminals.getState().clearPaneExited(paneId);

    expect(useTerminals.getState().isPaneDead(paneId)).toBe(false);
  });

  it("closing a pane or tab clears its dead flag", () => {
    const tabId = useTerminals.getState().openTab("proj", "/repo");
    useTerminals.getState().splitPane("proj", tabId, "/repo");
    const [p1, p2] = useTerminals
      .getState()
      .byProject.proj.tabs[0].panes.map((p) => p.id);
    useTerminals.getState().setPaneExited(p1);
    useTerminals.getState().setPaneExited(p2);

    useTerminals.getState().closePane("proj", tabId, p1);
    expect(useTerminals.getState().isPaneDead(p1)).toBe(false);

    useTerminals.getState().closeTab("proj", tabId);
    expect(useTerminals.getState().deadPanes).toEqual({});
  });

  it("setQuitConfirm drives the quit-confirm dialog state", () => {
    expect(useTerminals.getState().quitConfirm).toBeNull();
    const stakes = {
      busyTerminals: true,
      commands: [],
      starting: 0,
      working: 0,
    };
    useTerminals.getState().setQuitConfirm(stakes);
    expect(useTerminals.getState().quitConfirm).toEqual(stakes);
    useTerminals.getState().setQuitConfirm(null);
    expect(useTerminals.getState().quitConfirm).toBeNull();
  });

  it("closing a tab clears busy flags for all its panes", () => {
    const tabId = useTerminals.getState().openTab("proj", "/repo");
    const p1 = useTerminals.getState().byProject.proj.tabs[0].panes[0].id;
    const p2 = useTerminals.getState().splitPane("proj", tabId, "/repo");
    useTerminals.getState().setPaneBusy(p1, true);
    useTerminals.getState().setPaneBusy(p2, true);
    useTerminals.getState().closeTab("proj", tabId);
    expect(useTerminals.getState().hasBusyPanes()).toBe(false);
  });
});
