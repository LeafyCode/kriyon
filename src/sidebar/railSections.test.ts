import { expect, test } from "vitest";
import type { ProjectFolder } from "../state/projectFolders.ts";
import type { ProjectRow } from "../types.ts";
import { folderFocusTarget, railSections } from "./railSections.ts";

function project(id: string, extra: Partial<ProjectRow> = {}): ProjectRow {
  return {
    color: null,
    id,
    name: id,
    path: `/${id}`,
    setupCommand: null,
    ...extra,
  };
}

const folders: ProjectFolder[] = [
  { id: "f-side", name: "Side" },
  { id: "f-acme", name: "Acme" },
];

const ids = (rows: ProjectRow[]) => rows.map((row) => row.id);

test("with no folders and no pins every project is loose, in the given order", () => {
  const sections = railSections({
    filledFolderIds: new Set(["f-side", "f-acme"]),
    focusedFolderId: null,
    folders: [],
    inactiveIds: new Set(),
    projects: [project("b"), project("a")],
  });
  expect(ids(sections.loose)).toEqual(["b", "a"]);
  expect(sections.pinned).toEqual([]);
  expect(sections.folders).toEqual([]);
  expect(sections.focus).toBeNull();
});

test("pinned projects leave their folder and are never folded as inactive", () => {
  const sections = railSections({
    filledFolderIds: new Set(["f-side", "f-acme"]),
    focusedFolderId: null,
    folders,
    inactiveIds: new Set(["p"]),
    projects: [project("p", { folderId: "f-acme", pinnedAt: 5 }), project("q")],
  });
  expect(ids(sections.pinned)).toEqual(["p"]);
  expect(sections.folders).toEqual([]);
  expect(ids(sections.inactive)).toEqual([]);
});

test("folders keep only projects on the rail, sort by name, and an empty one is not drawn", () => {
  const sections = railSections({
    filledFolderIds: new Set(["f-side", "f-acme"]),
    focusedFolderId: null,
    folders,
    inactiveIds: new Set(["s1"]),
    projects: [
      project("a2", { folderId: "f-acme" }),
      project("s1", { folderId: "f-side" }),
      project("a1", { folderId: "f-acme" }),
      project("loose"),
    ],
  });
  expect(sections.folders.map((f) => [f.folder.id, ids(f.projects)])).toEqual([
    ["f-acme", ["a2", "a1"]],
  ]);
  expect(ids(sections.loose)).toEqual(["loose"]);
  expect(ids(sections.inactive)).toEqual(["s1"]);
});

test("a folder id no folder answers to reads as no folder", () => {
  const sections = railSections({
    filledFolderIds: new Set(["f-side", "f-acme"]),
    focusedFolderId: null,
    folders,
    inactiveIds: new Set(),
    projects: [project("x", { folderId: "gone" })],
  });
  expect(ids(sections.loose)).toEqual(["x"]);
});

test("focus shows only the focused folder and its own inactive projects", () => {
  const sections = railSections({
    filledFolderIds: new Set(["f-side", "f-acme"]),
    focusedFolderId: "f-acme",
    folders,
    inactiveIds: new Set(["a-old", "loose-old"]),
    projects: [
      project("a1", { folderId: "f-acme" }),
      project("a-old", { folderId: "f-acme" }),
      project("s1", { folderId: "f-side" }),
      project("loose"),
      project("loose-old"),
      project("pin", { pinnedAt: 1 }),
    ],
  });
  expect(sections.focus).toEqual({
    folder: { id: "f-acme", name: "Acme" },
    hiddenCount: 2,
  });
  expect(sections.folders.map((f) => f.folder.id)).toEqual(["f-acme"]);
  expect(ids(sections.loose)).toEqual([]);
  expect(ids(sections.inactive)).toEqual(["a-old"]);
  expect(ids(sections.pinned)).toEqual(["pin"]);
});

test("focus on a folder that no longer exists is ignored", () => {
  const sections = railSections({
    filledFolderIds: new Set(["f-side", "f-acme"]),
    focusedFolderId: "deleted",
    folders,
    inactiveIds: new Set(),
    projects: [project("loose")],
  });
  expect(sections.focus).toBeNull();
  expect(ids(sections.loose)).toEqual(["loose"]);
});

test("focus keeps the folder drawn even when none of its projects is on the rail", () => {
  const sections = railSections({
    filledFolderIds: new Set(["f-side", "f-acme"]),
    focusedFolderId: "f-side",
    folders,
    inactiveIds: new Set(),
    projects: [project("loose")],
  });
  expect(sections.folders.map((f) => [f.folder.id, ids(f.projects)])).toEqual([
    ["f-side", []],
  ]);
});

test("the focus chord turns focus off, or on for the active session's folder", () => {
  expect(folderFocusTarget("f-acme", "f-side", folders)).toBeNull();
  expect(folderFocusTarget(null, "f-side", folders)).toBe("f-side");
  expect(folderFocusTarget(null, null, folders)).toBeNull();
  expect(folderFocusTarget(null, "gone", folders)).toBeNull();
});

test("a folder no project has joined yet is drawn, so the person can fill it", () => {
  const sections = railSections({
    filledFolderIds: new Set(["f-side"]),
    focusedFolderId: null,
    folders,
    inactiveIds: new Set(),
    projects: [project("loose")],
  });
  expect(sections.folders.map((f) => [f.folder.id, ids(f.projects)])).toEqual([
    ["f-acme", []],
  ]);
});
