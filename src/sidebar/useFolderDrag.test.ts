import type { DragEndEvent, DragOverEvent } from "@dnd-kit/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { useProjectFolders } from "../state/projectFolders.ts";
import { useSessions } from "../state/sessions.ts";
import type { ProjectRow } from "../types.ts";
import { folderDropId, MERGE_DWELL_MS, railPlaces } from "./folderDrop.ts";
import { useFolderDrag } from "./useFolderDrag.ts";

function project(id: string, folderId: string | null = null): ProjectRow {
  return {
    color: null,
    folderId,
    id,
    name: id,
    path: `/${id}`,
    setupCommand: null,
  };
}

const projects = [project("l1"), project("l2"), project("a1", "acme")];

beforeEach(() => {
  vi.useFakeTimers();
  useLayout.setState({ layout: DEFAULT_LAYOUT });
  useProjectFolders.setState({
    editingFolderId: null,
    folders: [{ id: "acme", name: "Acme" }],
  });
  useSessions.setState({ projects });
});

afterEach(() => {
  vi.useRealTimers();
});

const folderOf = (id: string) =>
  useSessions.getState().projects.find((p) => p.id === id)?.folderId ?? null;

// Only the ids the hook reads; dnd-kit's events carry far more.
const over = (activeId: string, overId: string) =>
  ({
    active: { id: activeId },
    over: { id: overId },
  }) as unknown as DragOverEvent;
const end = (activeId: string, overId: string) =>
  ({
    active: { id: activeId },
    over: { id: overId },
  }) as unknown as DragEndEvent;

function setup() {
  return renderHook(() =>
    useFolderDrag(
      projects.map((p) => p.id),
      railPlaces(
        useSessions.getState().projects,
        useProjectFolders.getState().folders
      )
    )
  );
}

test("dropping on a folder header puts the project in it", () => {
  const { result } = setup();
  act(() => result.current.onDragEnd(end("l1", folderDropId("acme"))));
  expect(folderOf("l1")).toBe("acme");
});

test("resting on a loose project marks it, and dropping makes a folder of both", () => {
  const { result } = setup();
  act(() => result.current.onDragOver(over("l1", "l2")));
  expect(result.current.merge).toBeNull();
  act(() => {
    vi.advanceTimersByTime(MERGE_DWELL_MS);
  });
  expect(result.current.merge).toEqual({
    hint: "Drop to make a folder",
    targetId: "l2",
  });
  act(() => result.current.onDragEnd(end("l1", "l2")));
  const made = useProjectFolders
    .getState()
    .folders.find((folder) => folder.id !== "acme");
  expect(made).toBeDefined();
  expect(folderOf("l1")).toBe(made?.id);
  expect(folderOf("l2")).toBe(made?.id);
  expect(useProjectFolders.getState().editingFolderId).toBe(made?.id);
  expect(result.current.merge).toBeNull();
});

test("a quick pass over a project only reorders: no folder is made", () => {
  const { result } = setup();
  act(() => result.current.onDragOver(over("l1", "l2")));
  act(() => {
    vi.advanceTimersByTime(MERGE_DWELL_MS - 100);
  });
  act(() => result.current.onDragEnd(end("l1", "l2")));
  expect(useProjectFolders.getState().folders).toHaveLength(1);
  expect(folderOf("l1")).toBeNull();
  expect(useLayout.getState().layout.manualProjectOrder).toEqual([
    "l2",
    "l1",
    "a1",
  ]);
});

test("resting on a project in a folder offers to join it", () => {
  const { result } = setup();
  act(() => result.current.onDragOver(over("l1", "a1")));
  act(() => {
    vi.advanceTimersByTime(MERGE_DWELL_MS);
  });
  expect(result.current.merge?.hint).toBe("Drop to add to Acme");
  act(() => result.current.onDragEnd(end("l1", "a1")));
  expect(folderOf("l1")).toBe("acme");
});

test("moving on to another project restarts the clock", () => {
  const { result } = setup();
  act(() => result.current.onDragOver(over("l1", "l2")));
  act(() => {
    vi.advanceTimersByTime(MERGE_DWELL_MS - 100);
  });
  act(() => result.current.onDragOver(over("l1", "a1")));
  act(() => {
    vi.advanceTimersByTime(200);
  });
  expect(result.current.merge).toBeNull();
});

test("dropping a folder's project among loose ones takes it out of the folder", () => {
  const { result } = setup();
  act(() => result.current.onDragEnd(end("a1", "l1")));
  expect(folderOf("a1")).toBeNull();
});
