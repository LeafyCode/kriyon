import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, test, vi } from "vitest";

// Wrap the real fileDiffCounts with a call-counting spy, same pattern as
// highlighter.test.ts's factorySpy: proves genuine (non-)recomputation
// against real behavior rather than a mocked-away no-op.
vi.mock("../state/changes.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/changes.ts")>();
  return { ...actual, fileDiffCounts: vi.fn(actual.fileDiffCounts) };
});

import { fileDiffCounts } from "../state/changes.ts";
import {
  DEFAULT_LAYOUT,
  FILE_TREE_WIDTH_DEFAULT,
  useLayout,
} from "../state/layout.ts";
import type { FileDiff } from "../types.ts";
import { FileTreePane } from "./FileTreePane.tsx";

const BINARY_TAG_RE = /binary/i;
const EMPTY_TAG_RE = /empty/i;
const ADD_COUNT_RE = /^[+]\d/;
const DEL_COUNT_RE = /^[−-]\d/;
const OLD_PATH_RE = /old\.rs/;
const NEW_PATH_RE = /new\.rs/;
const EDIT_FILE_BUTTON_RE = /edit file/i;

function file(path: string, overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    binary: false,
    hunks: [
      {
        header: "@@ -1,1 +1,2 @@",
        lines: [
          { kind: "context", text: "same" },
          { kind: "added", text: "new" },
        ],
      },
    ],
    oldPath: null,
    path,
    status: "modified",
    ...overrides,
  };
}

describe("FileTreePane", () => {
  it("groups changed files by directory, sorted alphabetically", () => {
    const files = [
      file("src/z.ts"),
      file("src/changes/DiffFeed.tsx"),
      file("a.ts"),
    ];
    render(
      <FileTreePane
        files={files}
        onJumpToFile={vi.fn()}
        onTabChange={vi.fn()}
        tab="changes"
      />
    );

    const groups = screen.getAllByTestId("file-tree-dir-group");
    // Root ("") sorts first, then "src", then "src/changes".
    expect(within(groups[0]).getByText("a.ts")).toBeInTheDocument();
    expect(within(groups[1]).getByText("z.ts")).toBeInTheDocument();
    expect(within(groups[2]).getByText("DiffFeed.tsx")).toBeInTheDocument();
    expect(within(groups[2]).getByText("src/changes")).toBeInTheDocument();
  });

  it("orders files within a directory alphabetically", () => {
    const files = [file("src/z.ts"), file("src/a.ts")];
    render(
      <FileTreePane
        files={files}
        onJumpToFile={vi.fn()}
        onTabChange={vi.fn()}
        tab="changes"
      />
    );

    const rows = screen.getAllByTestId("file-tree-file-row");
    expect(within(rows[0]).getByText("a.ts")).toBeInTheDocument();
    expect(within(rows[1]).getByText("z.ts")).toBeInTheDocument();
  });

  it("shows +/- counts per file row", () => {
    render(
      <FileTreePane
        files={[file("a.ts")]}
        onJumpToFile={vi.fn()}
        onTabChange={vi.fn()}
        tab="changes"
      />
    );

    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByText("−0")).toBeInTheDocument();
  });

  it("calls onJumpToFile with the file's path when a row is clicked", () => {
    const onJumpToFile = vi.fn();
    render(
      <FileTreePane
        files={[file("src/changes/DiffFeed.tsx")]}
        onJumpToFile={onJumpToFile}
        onTabChange={vi.fn()}
        tab="changes"
      />
    );

    fireEvent.click(screen.getByText("DiffFeed.tsx"));

    expect(onJumpToFile).toHaveBeenCalledWith("src/changes/DiffFeed.tsx");
  });

  it("opens a changed file when its row is clicked, given onOpenFile", () => {
    const onOpenFile = vi.fn();
    const onJumpToFile = vi.fn();
    render(
      <FileTreePane
        files={[file("src/a.ts")]}
        onJumpToFile={onJumpToFile}
        onOpenFile={onOpenFile}
        onTabChange={vi.fn()}
        tab="changes"
      />
    );

    fireEvent.click(screen.getByText("a.ts"));

    expect(onOpenFile).toHaveBeenCalledWith("src/a.ts");
    expect(onJumpToFile).not.toHaveBeenCalled();
  });

  it("jumps to a deleted file's diff instead — there is no file to open", () => {
    const onOpenFile = vi.fn();
    const onJumpToFile = vi.fn();
    render(
      <FileTreePane
        files={[file("src/gone.ts", { hunks: [], status: "deleted" })]}
        onJumpToFile={onJumpToFile}
        onOpenFile={onOpenFile}
        onTabChange={vi.fn()}
        tab="changes"
      />
    );

    fireEvent.click(screen.getByText("gone.ts"));

    expect(onJumpToFile).toHaveBeenCalledWith("src/gone.ts");
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("marks the open file's row, and offers no separate edit button", () => {
    render(
      <FileTreePane
        files={[file("src/a.ts"), file("src/b.ts")]}
        onJumpToFile={vi.fn()}
        onOpenFile={vi.fn()}
        onTabChange={vi.fn()}
        selectedPath="src/b.ts"
        tab="changes"
      />
    );
    const rows = screen.getAllByTestId("file-tree-file-row");
    expect(rows[1]).toHaveAttribute("aria-current", "true");
    expect(rows[0]).not.toHaveAttribute("aria-current");
    expect(
      screen.queryByRole("button", { name: EDIT_FILE_BUTTON_RE })
    ).not.toBeInTheDocument();
  });

  it("marks a row whose file has unsaved edits", () => {
    render(
      <FileTreePane
        dirtyPaths={new Set(["src/a.ts"])}
        files={[file("src/a.ts"), file("src/b.ts")]}
        onJumpToFile={vi.fn()}
        onTabChange={vi.fn()}
        tab="changes"
      />
    );

    const rows = screen.getAllByTestId("file-tree-file-row");
    expect(within(rows[0]).getByTestId("tree-dirty-dot")).toBeInTheDocument();
    expect(
      within(rows[1]).queryByTestId("tree-dirty-dot")
    ).not.toBeInTheDocument();
  });

  test("the all-files tab is enabled and reports the switch", () => {
    const onTabChange = vi.fn();
    render(
      <FileTreePane
        files={[]}
        onJumpToFile={() => undefined}
        onTabChange={onTabChange}
        tab="changes"
      />
    );

    const allTab = screen.getByTestId("file-tree-tab-all");
    expect(allTab.hasAttribute("disabled")).toBe(false);

    fireEvent.click(allTab);

    expect(onTabChange).toHaveBeenCalledWith("all");
  });

  it("calls onTabChange with 'changes' when the Changes tab is clicked", () => {
    const onTabChange = vi.fn();
    render(
      <FileTreePane
        files={[]}
        onJumpToFile={vi.fn()}
        onTabChange={onTabChange}
        tab="all"
      />
    );

    fireEvent.click(screen.getByTestId("file-tree-tab-changes"));

    expect(onTabChange).toHaveBeenCalledWith("changes");
  });

  it("labels a binary file with a binary tag instead of +0 −0", () => {
    render(
      <FileTreePane
        files={[file("assets/logo.png", { binary: true, hunks: [] })]}
        onJumpToFile={vi.fn()}
        onTabChange={vi.fn()}
        tab="changes"
      />
    );

    expect(screen.getByText(BINARY_TAG_RE)).toBeInTheDocument();
    expect(screen.queryByText(ADD_COUNT_RE)).not.toBeInTheDocument();
    expect(screen.queryByText(DEL_COUNT_RE)).not.toBeInTheDocument();
  });

  it("labels an empty added file with an empty tag instead of +0 −0", () => {
    render(
      <FileTreePane
        files={[file("src/new.ts", { hunks: [], status: "added" })]}
        onJumpToFile={vi.fn()}
        onTabChange={vi.fn()}
        tab="changes"
      />
    );

    expect(screen.getByText(EMPTY_TAG_RE)).toBeInTheDocument();
    expect(screen.queryByText(ADD_COUNT_RE)).not.toBeInTheDocument();
  });

  it("renders a pure rename as old → new instead of +0 −0", () => {
    render(
      <FileTreePane
        files={[
          file("src/new.rs", {
            hunks: [],
            oldPath: "src/old.rs",
            status: "renamed",
          }),
        ]}
        onJumpToFile={vi.fn()}
        onTabChange={vi.fn()}
        tab="changes"
      />
    );

    expect(screen.getByText(OLD_PATH_RE)).toBeInTheDocument();
    expect(screen.getByText(NEW_PATH_RE)).toBeInTheDocument();
    expect(screen.queryByText(ADD_COUNT_RE)).not.toBeInTheDocument();
  });

  it("keeps the counts on a rename that also has edits, and still shows the old path", () => {
    render(
      <FileTreePane
        files={[
          file("src/new.rs", { oldPath: "src/old.rs", status: "renamed" }),
        ]}
        onJumpToFile={vi.fn()}
        onTabChange={vi.fn()}
        tab="changes"
      />
    );

    expect(screen.getByText(OLD_PATH_RE)).toBeInTheDocument();
    expect(screen.getByText("+1")).toBeInTheDocument();
  });

  it("renders no unchanged-files footer — the only source available in Phase 1 can't produce an honest count", () => {
    render(
      <FileTreePane
        files={[file("a.ts")]}
        onJumpToFile={vi.fn()}
        onTabChange={vi.fn()}
        tab="changes"
      />
    );
    expect(screen.queryByTestId("file-tree-footer")).not.toBeInTheDocument();
  });

  it("does not recompute directory grouping or per-file counts on a re-render with the same files reference", () => {
    // Mirrors ChangesView re-rendering FileTreePane for an unrelated reason
    // (e.g. DiffFeed's activeFile ticking on scroll) while `files` itself
    // hasn't changed — the exact scroll-jank cause this guards against.
    vi.mocked(fileDiffCounts).mockClear();
    const files = [file("a.ts"), file("b.ts"), file("src/c.ts")];
    const { rerender } = render(
      <FileTreePane
        files={files}
        onJumpToFile={vi.fn()}
        onTabChange={vi.fn()}
        tab="changes"
      />
    );
    const callsAfterMount = vi.mocked(fileDiffCounts).mock.calls.length;
    expect(callsAfterMount).toBeGreaterThan(0);

    rerender(
      <FileTreePane
        files={files}
        onJumpToFile={vi.fn()}
        onTabChange={vi.fn()}
        tab="changes"
      />
    );

    expect(vi.mocked(fileDiffCounts).mock.calls.length).toBe(callsAfterMount);
  });

  it("does recompute once the files reference actually changes", () => {
    vi.mocked(fileDiffCounts).mockClear();
    const files = [file("a.ts")];
    const { rerender } = render(
      <FileTreePane
        files={files}
        onJumpToFile={vi.fn()}
        onTabChange={vi.fn()}
        tab="changes"
      />
    );
    const callsAfterMount = vi.mocked(fileDiffCounts).mock.calls.length;

    rerender(
      <FileTreePane
        files={[file("a.ts")]}
        onJumpToFile={vi.fn()}
        onTabChange={vi.fn()}
        tab="changes"
      />
    );

    expect(vi.mocked(fileDiffCounts).mock.calls.length).toBeGreaterThan(
      callsAfterMount
    );
  });
});

test("dragging the column edge resizes the file tree and remembers it", () => {
  useLayout.setState({ layout: DEFAULT_LAYOUT });
  render(
    <FileTreePane
      files={[]}
      onJumpToFile={vi.fn()}
      onTabChange={vi.fn()}
      tab="changes"
    />
  );
  const pane = screen.getByTestId("file-tree-pane");
  expect(pane).toHaveStyle({ width: `${FILE_TREE_WIDTH_DEFAULT}px` });

  const handle = screen.getByTestId("file-tree-resize");
  fireEvent.mouseDown(handle, { clientX: 300 });
  fireEvent.mouseMove(window, { clientX: 340 });
  fireEvent.mouseUp(window);

  expect(useLayout.getState().layout.fileTreeWidth).toBe(
    FILE_TREE_WIDTH_DEFAULT + 40
  );
  expect(pane).toHaveStyle({ width: `${FILE_TREE_WIDTH_DEFAULT + 40}px` });

  fireEvent.doubleClick(handle);
  expect(useLayout.getState().layout.fileTreeWidth).toBe(
    FILE_TREE_WIDTH_DEFAULT
  );
});

test("each changed file shows how it changed", () => {
  render(
    <FileTreePane
      files={[{ ...file("src/new.ts"), status: "added" }, file("src/old.ts")]}
      onJumpToFile={vi.fn()}
      onTabChange={vi.fn()}
      tab="changes"
    />
  );
  const rows = screen.getAllByTestId("file-tree-file-row");
  expect(rows[0]).toHaveAttribute("data-git", "added");
  expect(rows[1]).toHaveAttribute("data-git", "modified");
});

test("the column offers three scopes: AI changes, All changes, Files", () => {
  render(
    <FileTreePane
      files={[]}
      onJumpToFile={vi.fn()}
      onTabChange={vi.fn()}
      tab="changes"
    />
  );
  expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
    "AI changes",
    "All changes",
    "Files",
  ]);
});

test("All changes lists its files in the same list as AI changes", () => {
  render(
    <FileTreePane
      files={[file("src/mine.ts")]}
      onJumpToFile={vi.fn()}
      onTabChange={vi.fn()}
      tab="uncommitted"
    />
  );
  expect(screen.getByTestId("file-tree-pane-changes")).not.toHaveStyle({
    display: "none",
  });
  expect(screen.getByText("mine.ts")).toBeInTheDocument();
});
