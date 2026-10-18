import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({
  listFiles: vi.fn(),
  listSlashCommands: vi.fn(),
}));

import { listFiles, listSlashCommands } from "../ipc/bridge.ts";
import { useCompletions } from "../state/completions.ts";
import { useCompletion } from "./useCompletion.ts";

const catalog = {
  commands: [
    {
      name: "commit",
      description: "Create a git commit",
      argumentHint: "[msg]",
      source: "custom" as const,
    },
    {
      name: "clear",
      description: "Clear history",
      argumentHint: null,
      source: "builtin" as const,
    },
  ],
  agents: ["Explore"],
  claudeVersion: "2.1.202",
  degraded: false,
};

describe("useCompletion", () => {
  beforeEach(() => {
    useCompletions.setState({ byCwd: { "/repo": catalog }, loading: {} });
    vi.mocked(listFiles)
      .mockReset()
      .mockResolvedValue([{ path: "src/main.rs", isDir: false }]);
    vi.mocked(listSlashCommands).mockReset().mockResolvedValue(catalog);
  });

  it("offers filtered slash commands", () => {
    const { result } = renderHook(() =>
      useCompletion({ cwd: "/repo", value: "/com", caret: 4 })
    );
    expect(result.current.view.open).toBe(true);
    expect(result.current.view.kind).toBe("slash");
    expect(result.current.view.rows[0].primary).toBe("/commit");
    expect(result.current.itemAt(0)?.insert).toBe("/commit "); // arg-hint → trailing space
  });

  it("tags a command the caller answers itself", () => {
    const { result } = renderHook(() =>
      useCompletion({
        cwd: "/repo",
        value: "/c",
        caret: 2,
        tagFor: (command) => (command === "/clear" ? "Opens here" : undefined),
      })
    );
    const byName = Object.fromEntries(
      result.current.view.rows.map((row) => [row.primary, row.tag])
    );
    expect(byName).toEqual({ "/clear": "Opens here", "/commit": undefined });
  });

  it("appends a trailing space even for a no-argument-hint slash command", () => {
    const { result } = renderHook(() =>
      useCompletion({ cwd: "/repo", value: "/cl", caret: 3 })
    );
    expect(result.current.view.rows[0].primary).toBe("/clear");
    // No argumentHint, but the insert must still end with a space so the
    // caret lands on whitespace and the popover closes after accepting.
    expect(result.current.itemAt(0)?.insert).toBe("/clear ");
  });

  it("wraps selection with move", () => {
    const { result } = renderHook(() =>
      useCompletion({ cwd: "/repo", value: "/c", caret: 2 })
    );
    const count = result.current.view.rows.length;
    act(() => result.current.move(-1));
    expect(result.current.view.activeIndex).toBe(count - 1);
  });

  it("offers file mentions from the backend", async () => {
    const { result } = renderHook(() =>
      useCompletion({ cwd: "/repo", value: "@src/ma", caret: 7 })
    );
    await waitFor(() =>
      expect(
        result.current.view.rows.some((r) => r.primary === "@src/main.rs")
      ).toBe(true)
    );
    const item = result.current.view.items.find(
      (i) => i.insert === "@src/main.rs "
    );
    expect(item).toBeTruthy();
  });

  it("surfaces bash mode without opening a popover", () => {
    const { result } = renderHook(() =>
      useCompletion({ cwd: "/repo", value: "!ls", caret: 3 })
    );
    expect(result.current.view.open).toBe(false);
    expect(result.current.view.mode).toBe("bash");
  });

  it("surfaces memory mode without opening a popover", () => {
    const { result } = renderHook(() =>
      useCompletion({ cwd: "/repo", value: "#note", caret: 5 })
    );
    expect(result.current.view.open).toBe(false);
    expect(result.current.view.mode).toBe("memory");
  });

  it("offers a matching agent, before files, for an @ mention", () => {
    const { result } = renderHook(() =>
      useCompletion({ cwd: "/repo", value: "@Expl", caret: 5 })
    );
    expect(result.current.view.kind).toBe("mention");
    expect(result.current.view.rows[0].primary).toBe("@agent-Explore");
    expect(result.current.itemAt(0)?.insert).toBe("@agent-Explore ");
  });

  it("does not throw and shows no file rows when the mention fetch rejects", async () => {
    vi.mocked(listFiles).mockReset().mockRejectedValue(new Error("gone"));
    const { result } = renderHook(() =>
      useCompletion({ cwd: "/repo", value: "@src", caret: 4 })
    );
    // The catch branch clears files; only (non-file) rows may remain.
    await waitFor(() =>
      expect(
        result.current.view.rows.some((r) => r.primary.startsWith("@src"))
      ).toBe(false)
    );
  });

  it("self-warms the catalog on mount for an uncached cwd", () => {
    renderHook(() => useCompletion({ cwd: "/uncached", value: "", caret: 0 }));
    expect(listSlashCommands).toHaveBeenCalledWith("/uncached");
  });

  it("does not refetch when the cwd is already cached", () => {
    renderHook(() => useCompletion({ cwd: "/repo", value: "", caret: 0 }));
    expect(listSlashCommands).not.toHaveBeenCalled();
  });

  it("caps the row list so a bare trigger can't render the whole catalog", () => {
    // An empty query matches everything, so a bare `/` used to render every
    // command on disk — 344 rows on a real machine, each measuring an
    // ellipsized description that can run past a thousand characters. The list
    // is ranked, so the cut only drops the tail nobody scrolls to.
    useCompletions.setState({
      byCwd: {
        "/big": {
          ...catalog,
          commands: Array.from({ length: 400 }, (_, i) => ({
            name: `cmd-${i}`,
            description: "x".repeat(600),
            argumentHint: null,
            source: "custom" as const,
          })),
        },
      },
      loading: {},
    });

    const { result } = renderHook(() =>
      useCompletion({ cwd: "/big", value: "/", caret: 1 })
    );

    expect(result.current.view.rows.length).toBe(40);
    // Rows and items stay in lockstep — picking row N must insert item N.
    expect(result.current.view.items.length).toBe(
      result.current.view.rows.length
    );
  });
});
