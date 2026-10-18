import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fileDiffCounts } from "../state/changes.ts";
import type { FileDiff } from "../types.ts";

vi.mock("./highlighter.ts", () => ({
  highlightLines: vi.fn().mockReturnValue(new Promise(() => undefined)),
  // Synchronous cache peek; `undefined` keeps these tests on the async path.
  peekHighlight: vi.fn(),
  langForPath: () => "text",
}));

import { DiffFileCard } from "./DiffFileCard.tsx";

const BINARY_TAG_RE = /binary/i;
const EMPTY_TAG_RE = /empty/i;
const ADD_COUNT_RE = /^[+]\d/;
const DEL_COUNT_RE = /^[−-]\d/;
const OLD_PATH_RE = /old\.rs/;
const NEW_PATH_RE = /new\.rs/;
const COPY_PATH_BUTTON_RE = /copy path/i;
const EDIT_FILE_BUTTON_RE = /edit file/i;

function file(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    binary: false,
    hunks: [
      {
        header: "@@ -1,2 +1,3 @@",
        lines: [
          { kind: "context", text: "same" },
          { kind: "removed", text: "old" },
          { kind: "added", text: "new" },
          { kind: "added", text: "extra" },
        ],
      },
    ],
    oldPath: null,
    path: "src/a.ts",
    status: "modified",
    ...overrides,
  };
}

describe("fileDiffCounts", () => {
  it("sums additions and deletions across every hunk", () => {
    expect(fileDiffCounts(file())).toEqual({ additions: 2, deletions: 1 });
  });

  it("sums across multiple hunks", () => {
    const twoHunks = file({
      hunks: [
        {
          header: "@@ -1,1 +1,1 @@",
          lines: [{ kind: "added", text: "a" }],
        },
        {
          header: "@@ -5,1 +5,1 @@",
          lines: [
            { kind: "removed", text: "b" },
            { kind: "removed", text: "c" },
          ],
        },
      ],
    });
    expect(fileDiffCounts(twoHunks)).toEqual({ additions: 1, deletions: 2 });
  });
});

describe("DiffFileCard", () => {
  it("shows the file path and additions/deletions counts", () => {
    render(<DiffFileCard collapsed={false} file={file()} onToggle={vi.fn()} />);

    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();
    expect(screen.getByText("−1")).toBeInTheDocument();
  });

  it("shows a NEW badge for added files", () => {
    render(
      <DiffFileCard
        collapsed={false}
        file={file({ status: "added" })}
        onToggle={vi.fn()}
      />
    );

    expect(screen.getByTestId("diff-file-new-badge")).toHaveTextContent("NEW");
  });

  it("shows no NEW badge for a modified file", () => {
    render(<DiffFileCard collapsed={false} file={file()} onToggle={vi.fn()} />);

    expect(screen.queryByTestId("diff-file-new-badge")).not.toBeInTheDocument();
  });

  it("hides hunks and shows a collapsed indicator when collapsed", () => {
    render(<DiffFileCard collapsed={true} file={file()} onToggle={vi.fn()} />);

    expect(screen.queryByTestId("diff-hunk")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("diff-file-collapsed-indicator")
    ).toHaveTextContent("collapsed ▸");
  });

  it("shows hunks when expanded", () => {
    render(<DiffFileCard collapsed={false} file={file()} onToggle={vi.fn()} />);

    expect(screen.getByTestId("diff-hunk")).toBeInTheDocument();
    expect(
      screen.queryByTestId("diff-file-collapsed-indicator")
    ).not.toBeInTheDocument();
  });

  it("calls onToggle when the header is clicked", () => {
    const onToggle = vi.fn();
    render(
      <DiffFileCard collapsed={false} file={file()} onToggle={onToggle} />
    );

    fireEvent.click(screen.getByTestId("diff-file-header"));

    // Called with the file's own path (not a bare click event): DiffFeed
    // passes one stable `(path) => …` callback to every card so the card can
    // be memoized, instead of a fresh per-card closure that re-renders the
    // whole feed on every scroll frame.
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith("src/a.ts");
  });

  it("renders a binary file with a binary tag and no line counts", () => {
    render(
      <DiffFileCard
        collapsed={false}
        file={file({ binary: true, hunks: [] })}
        onToggle={vi.fn()}
      />
    );

    expect(screen.getByText(BINARY_TAG_RE)).toBeInTheDocument();
    expect(screen.queryByText(ADD_COUNT_RE)).not.toBeInTheDocument();
    expect(screen.queryByText(DEL_COUNT_RE)).not.toBeInTheDocument();
  });

  it("renders a rename as old → new", () => {
    render(
      <DiffFileCard
        collapsed={false}
        file={file({
          hunks: [],
          oldPath: "src/old.rs",
          path: "src/new.rs",
          status: "renamed",
        })}
        onToggle={vi.fn()}
      />
    );

    expect(screen.getByText(OLD_PATH_RE)).toBeInTheDocument();
    expect(screen.getByText(NEW_PATH_RE)).toBeInTheDocument();
    expect(screen.queryByText(ADD_COUNT_RE)).not.toBeInTheDocument();
  });

  it("renders an empty added file with an empty tag and no line counts", () => {
    render(
      <DiffFileCard
        collapsed={false}
        file={file({ hunks: [], status: "added" })}
        onToggle={vi.fn()}
      />
    );

    expect(screen.getByText(EMPTY_TAG_RE)).toBeInTheDocument();
    expect(screen.queryByText(ADD_COUNT_RE)).not.toBeInTheDocument();
  });

  it('shows a "this session" badge, reachable by its aria-label, with no note role', () => {
    render(
      <DiffFileCard
        collapsed={false}
        file={file()}
        onToggle={vi.fn()}
        touchedBySession={true}
      />
    );

    const badge = screen.getByTestId("diff-file-touched-badge");
    expect(badge).toHaveAccessibleName("Touched this session");
    // The badge sits inside the header `<button>`; ARIA presentational
    // children strip any role a button's descendants declare, so a
    // `role="note"` here would never actually reach the a11y tree — only
    // the `aria-label` does (asserted above via `toHaveAccessibleName`).
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("shows no badge when the file wasn't touched this session", () => {
    render(<DiffFileCard collapsed={false} file={file()} onToggle={vi.fn()} />);

    expect(
      screen.queryByTestId("diff-file-touched-badge")
    ).not.toBeInTheDocument();
  });

  it("renders a rename that also has edits as old → new, with its counts", () => {
    // Git's `-M` emits `rename from`/`rename to` *with* hunks whenever
    // similarity < 100% (see the Rust parser's own rename test) — the
    // rename-then-edit case, which `fileKind` buckets as "content". The old
    // path has no deletion entry of its own anywhere in the changeset, so if
    // this header doesn't show it, it's gone.
    render(
      <DiffFileCard
        collapsed={false}
        file={file({
          oldPath: "src/old.rs",
          path: "src/new.rs",
          status: "renamed",
        })}
        onToggle={vi.fn()}
      />
    );

    expect(screen.getByText(OLD_PATH_RE)).toBeInTheDocument();
    expect(screen.getByText(NEW_PATH_RE)).toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();
    expect(screen.getByText("−1")).toBeInTheDocument();
  });

  it("copies the repo-relative path", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const realFile = file();

    render(
      <DiffFileCard collapsed={false} file={realFile} onToggle={vi.fn()} />
    );
    fireEvent.click(screen.getByRole("button", { name: COPY_PATH_BUTTON_RE }));

    expect(writeText).toHaveBeenCalledWith(realFile.path);
  });

  it("does not throw when the clipboard API is unavailable", () => {
    // `navigator.clipboard` is undefined outside a secure context, and the
    // property access happens *before* any promise exists to `.catch()` —
    // so the failure is synchronous and escapes the best-effort guard.
    Object.assign(navigator, { clipboard: undefined });

    render(<DiffFileCard collapsed={false} file={file()} onToggle={vi.fn()} />);

    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: COPY_PATH_BUTTON_RE }))
    ).not.toThrow();
  });

  it("shows no edit button when onEdit is not passed", () => {
    render(<DiffFileCard collapsed={false} file={file()} onToggle={vi.fn()} />);

    expect(
      screen.queryByRole("button", { name: EDIT_FILE_BUTTON_RE })
    ).not.toBeInTheDocument();
  });

  it("calls onEdit when the edit button is clicked, without toggling collapse", () => {
    const onEdit = vi.fn();
    const onToggle = vi.fn();
    render(
      <DiffFileCard
        collapsed={false}
        file={file()}
        onEdit={onEdit}
        onToggle={onToggle}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: EDIT_FILE_BUTTON_RE }));

    // Called with the file's own path (not a bare click event): like
    // `onToggle`, `onEdit` is path-taking so DiffFeed can pass one *stable*
    // callback to every card instead of a fresh per-card closure.
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith("src/a.ts");
    expect(onToggle).not.toHaveBeenCalled();
  });
});
