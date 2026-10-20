import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { FileDiff } from "../types.ts";
import { ChangedFilesList } from "./ChangedFilesList.tsx";

const BINARY_TAG_RE = /binary/i;
const EMPTY_TAG_RE = /empty/i;
const ADD_COUNT_RE = /^[+]\d/;
const OLD_PATH_RE = /old\.rs/;
const NEW_PATH_RE = /new\.rs/;
const COPY_PATH_BUTTON_RE = /copy path/i;

function file(
  path: string,
  status: FileDiff["status"] = "modified",
  overrides: Partial<FileDiff> = {}
): FileDiff {
  return {
    binary: false,
    hunks: [
      {
        header: "@@ -1,1 +1,2 @@",
        lines: [
          { kind: "context", text: "keep" },
          { kind: "added", text: "new" },
        ],
      },
    ],
    oldPath: null,
    path,
    status,
    ...overrides,
  };
}

test("lists each changed file with its counts", () => {
  render(
    <ChangedFilesList files={[file("src/a.ts")]} onOpen={() => undefined} />
  );

  expect(screen.getByText("a.ts")).toBeTruthy();
  expect(screen.getByText("+1")).toBeTruthy();
  expect(screen.getByText("−0")).toBeTruthy();
});

test("marks an added file as NEW", () => {
  render(
    <ChangedFilesList
      files={[file("src/new.ts", "added")]}
      onOpen={() => undefined}
    />
  );

  expect(screen.getByText("NEW")).toBeTruthy();
});

test("clicking a row reports the full path", () => {
  const onOpen = vi.fn();
  render(<ChangedFilesList files={[file("src/deep/a.ts")]} onOpen={onOpen} />);

  fireEvent.click(screen.getByText("a.ts"));

  expect(onOpen).toHaveBeenCalledWith("src/deep/a.ts");
});

test("renders nothing when there are no changed files", () => {
  const { container } = render(
    <ChangedFilesList files={[]} onOpen={() => undefined} />
  );

  expect(container.firstChild).toBeNull();
});

test("renders a binary file with a binary tag and no line counts", () => {
  render(
    <ChangedFilesList
      files={[file("src/img.png", "modified", { binary: true, hunks: [] })]}
      onOpen={() => undefined}
    />
  );

  expect(screen.getByText(BINARY_TAG_RE)).toBeTruthy();
  expect(screen.queryByText(ADD_COUNT_RE)).toBeNull();
});

test("renders a rename as old → new", () => {
  render(
    <ChangedFilesList
      files={[
        file("src/new.rs", "renamed", {
          hunks: [],
          oldPath: "src/old.rs",
        }),
      ]}
      onOpen={() => undefined}
    />
  );

  expect(screen.getByText(OLD_PATH_RE)).toBeTruthy();
  expect(screen.getByText(NEW_PATH_RE)).toBeTruthy();
});

test("renders an empty added file with an empty tag and no line counts", () => {
  render(
    <ChangedFilesList
      files={[file("src/new.ts", "added", { hunks: [] })]}
      onOpen={() => undefined}
    />
  );

  expect(screen.getByText(EMPTY_TAG_RE)).toBeTruthy();
  expect(screen.queryByText(ADD_COUNT_RE)).toBeNull();
});

test("copies the repo-relative path", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });

  render(
    <ChangedFilesList files={[file("src/a.ts")]} onOpen={() => undefined} />
  );
  fireEvent.click(screen.getByRole("button", { name: COPY_PATH_BUTTON_RE }));

  expect(writeText).toHaveBeenCalledWith("src/a.ts");
});

test("renders a rename that also has edits as old → new, with its counts", () => {
  // Git's `-M` emits a rename *with* hunks whenever similarity < 100% — the
  // rename-then-edit case, which `fileKind` buckets as "content". The old
  // path has no deletion entry of its own in the changeset, so this row is
  // the only place it can still be seen.
  render(
    <ChangedFilesList
      files={[file("src/new.rs", "renamed", { oldPath: "src/old.rs" })]}
      onOpen={() => undefined}
    />
  );

  expect(screen.getByText(OLD_PATH_RE)).toBeTruthy();
  expect(screen.getByText(NEW_PATH_RE)).toBeTruthy();
  expect(screen.getByText("+1")).toBeTruthy();
});

test("does not throw when the clipboard API is unavailable", () => {
  // `navigator.clipboard` is undefined outside a secure context, and the
  // property access happens *before* any promise exists to `.catch()` — so
  // the failure is synchronous and escapes the best-effort guard.
  Object.assign(navigator, { clipboard: undefined });

  render(
    <ChangedFilesList files={[file("src/a.ts")]} onOpen={() => undefined} />
  );

  expect(() =>
    fireEvent.click(screen.getByRole("button", { name: COPY_PATH_BUTTON_RE }))
  ).not.toThrow();
});
