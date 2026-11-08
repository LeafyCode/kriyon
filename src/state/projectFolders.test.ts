import { beforeEach, expect, test } from "vitest";
import { DEFAULT_LAYOUT, useLayout } from "./layout.ts";
import {
  cleanFolderName,
  createProjectFolder,
  deleteProjectFolder,
  parseProjectFolders,
  renameProjectFolder,
  useProjectFolders,
} from "./projectFolders.ts";
import { useSessions } from "./sessions.ts";

beforeEach(() => {
  useProjectFolders.setState({ folders: [] });
  useLayout.setState({ layout: { ...DEFAULT_LAYOUT } });
  useSessions.setState({
    projects: [
      { color: null, id: "p1", name: "one", path: "/one", setupCommand: null },
      { color: null, id: "p2", name: "two", path: "/two", setupCommand: null },
    ],
  });
});

const folderOf = (id: string) =>
  useSessions.getState().projects.find((p) => p.id === id)?.folderId ?? null;

test("a folder made from a project is born holding it", () => {
  const id = createProjectFolder("  Client\n work ", "p1");
  expect(useProjectFolders.getState().folders).toEqual([
    { id, name: "Client work" },
  ]);
  expect(folderOf("p1")).toBe(id);
  expect(folderOf("p2")).toBeNull();
});

test("an empty name falls back and a long one is cut", () => {
  expect(cleanFolderName("   ")).toBe("New folder");
  expect(cleanFolderName("x".repeat(200))).toHaveLength(60);
});

test("rename keeps the id and cleans the name", () => {
  const id = createProjectFolder("Old");
  renameProjectFolder(id, " New ");
  expect(useProjectFolders.getState().folders).toEqual([{ id, name: "New" }]);
});

test("deleting a folder returns its projects to the list and ends its focus", () => {
  const id = createProjectFolder("Acme", "p1");
  useSessions.getState().setProjectFolder("p2", id);
  useLayout.getState().setFocusedFolder(id);
  deleteProjectFolder(id);
  expect(useProjectFolders.getState().folders).toEqual([]);
  expect(folderOf("p1")).toBeNull();
  expect(folderOf("p2")).toBeNull();
  expect(useLayout.getState().layout.focusedFolderId).toBeNull();
});

test("parse drops malformed and duplicate entries but keeps the rest", () => {
  const json = JSON.stringify([
    { id: "a", name: "Acme" },
    { id: "a", name: "Dup" },
    { id: 3, name: "bad id" },
    { id: "b" },
    null,
    { id: "c", name: "" },
  ]);
  expect(parseProjectFolders(json)).toEqual([
    { id: "a", name: "Acme" },
    { id: "c", name: "New folder" },
  ]);
  expect(parseProjectFolders("{not json")).toEqual([]);
  expect(parseProjectFolders(JSON.stringify({ id: "a" }))).toEqual([]);
  expect(parseProjectFolders(null)).toEqual([]);
});

test("making a folder opens its name, and leaves focus on another folder so it shows", () => {
  useProjectFolders.setState({ folders: [{ id: "old", name: "Old" }] });
  useLayout.getState().setFocusedFolder("old");
  const id = createProjectFolder("New");
  expect(useProjectFolders.getState().editingFolderId).toBe(id);
  expect(useLayout.getState().layout.focusedFolderId).toBeNull();
});
