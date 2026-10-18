import { beforeEach, expect, test } from "vitest";
import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { commitProjectDrop, commitSessionDrop } from "./dragCommit.ts";

beforeEach(() => {
  useLayout.setState({ layout: DEFAULT_LAYOUT });
});

const drop = (activeId: string, overId: string | null) =>
  commitSessionDrop({
    activeId,
    collapsedDone: ["d1"],
    overId,
    projectId: "p1",
    projectName: "demo",
    rows: ["a", "b", "c"],
  });

test("commitSessionDrop writes the merged order and pins the project", () => {
  expect(drop("a", "c")).toBe(true);
  const { layout } = useLayout.getState();
  expect(layout.manualSessionOrder.p1).toEqual(["b", "c", "a", "d1"]);
  expect(layout.projectSortOverrides.p1).toBe("manual");
});

test("commitSessionDrop merges into the previously saved order", () => {
  // "x" was placed second earlier but is not visible now — it keeps its slot.
  useLayout.getState().setManualSessionOrder("p1", ["a", "x", "b", "c"]);
  expect(drop("c", "a")).toBe(true);
  expect(useLayout.getState().layout.manualSessionOrder.p1).toEqual([
    "c",
    "a",
    "x",
    "b",
    "d1",
  ]);
});

test("commitSessionDrop is a no-op without a drop target", () => {
  expect(drop("a", null)).toBe(false);
  expect(drop("a", "a")).toBe(false);
  const { layout } = useLayout.getState();
  expect(layout.manualSessionOrder).toEqual({});
  expect(layout.projectSortOverrides).toEqual({});
});

test("commitProjectDrop writes the reordered project ids", () => {
  expect(
    commitProjectDrop({ activeId: "p1", ids: ["p1", "p2", "p3"], overId: "p3" })
  ).toBe(true);
  expect(useLayout.getState().layout.manualProjectOrder).toEqual([
    "p2",
    "p3",
    "p1",
  ]);
});

test("commitProjectDrop merges a drop into the previously saved order", () => {
  // "hidden" was arranged earlier but has no open sessions now — it keeps its
  // slot after "pA" via the merge.
  useLayout.getState().setManualProjectOrder(["pA", "hidden", "pB"]);
  expect(
    commitProjectDrop({ activeId: "pB", ids: ["pA", "pB"], overId: "pA" })
  ).toBe(true);
  expect(useLayout.getState().layout.manualProjectOrder).toEqual([
    "pB",
    "pA",
    "hidden",
  ]);
});

test("commitProjectDrop is a no-op without a real drop target", () => {
  expect(
    commitProjectDrop({ activeId: "p1", ids: ["p1", "p2"], overId: null })
  ).toBe(false);
  expect(
    commitProjectDrop({ activeId: "p1", ids: ["p1", "p2"], overId: "p1" })
  ).toBe(false);
  expect(useLayout.getState().layout.manualProjectOrder).toEqual([]);
});
