import { expect, test } from "vitest";
import { folderDropId, projectDropAction } from "./folderDrop.ts";
import type { RailPlace } from "./railSections.ts";

const places = new Map<string, RailPlace>([
  ["a1", { folderId: "acme", kind: "folder" }],
  ["a2", { folderId: "acme", kind: "folder" }],
  ["l1", { kind: "loose" }],
  ["l2", { kind: "loose" }],
  ["pin", { kind: "pinned" }],
]);

const drop = (
  activeId: string,
  overId: string | null,
  mergeTargetId = null as string | null
) => projectDropAction({ activeId, mergeTargetId, overId, places });

test("a drop inside one section is a plain reorder", () => {
  expect(drop("l1", "l2")).toEqual({ kind: "reorder" });
  expect(drop("a1", "a2")).toEqual({ kind: "reorder" });
});

test("a drop on nothing, or on itself, does nothing", () => {
  expect(drop("l1", null)).toEqual({ kind: "none" });
  expect(drop("l1", "l1")).toEqual({ kind: "none" });
});

test("a drop on a folder header puts the project in that folder", () => {
  expect(drop("l1", folderDropId("side"))).toEqual({
    folderId: "side",
    kind: "join",
  });
});

test("a drop on a folder header it is already in does nothing", () => {
  expect(drop("a1", folderDropId("acme"))).toEqual({ kind: "none" });
});

test("a held hover over a loose project makes a new folder of the two", () => {
  expect(drop("l1", "l2", "l2")).toEqual({ kind: "merge", withId: "l2" });
});

test("a held hover over a project in a folder joins that folder", () => {
  expect(drop("l1", "a1", "a1")).toEqual({ folderId: "acme", kind: "join" });
});

test("a held hover inside the same folder is only a reorder", () => {
  expect(drop("a1", "a2", "a2")).toEqual({ kind: "reorder" });
});

test("dropping on a project in another section moves it there and reorders", () => {
  expect(drop("l1", "a1")).toEqual({
    folderId: "acme",
    kind: "move",
  });
  expect(drop("a1", "l1")).toEqual({ folderId: null, kind: "move" });
});

test("pinned projects only reorder: they never join or make folders", () => {
  expect(drop("pin", "l1", "l1")).toEqual({ kind: "none" });
  expect(drop("l1", "pin", "pin")).toEqual({ kind: "none" });
  expect(drop("pin", folderDropId("acme"))).toEqual({ kind: "none" });
});
