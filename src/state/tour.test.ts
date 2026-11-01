import { beforeEach, describe, expect, test } from "vitest";
import { TOUR_STEPS } from "../tour/steps.ts";
import { DEFAULT_LAYOUT, useLayout } from "./layout.ts";
import { useTour } from "./tour.ts";

const EDIT_YOURSELF = /edit[^.]*yourself/i;

beforeEach(() => {
  useLayout.setState({ layout: DEFAULT_LAYOUT });
  useTour.setState({ stepIndex: null });
});

describe("app tour", () => {
  test("starts on the first step and shows the session workspace", () => {
    useLayout.getState().setView("settings");
    useTour.getState().start();
    expect(useTour.getState().stepIndex).toBe(0);
    expect(useLayout.getState().layout.view).toBe("studio");
  });

  test("next and back walk the steps without leaving them", () => {
    const tour = useTour.getState();
    tour.start();
    tour.back();
    expect(useTour.getState().stepIndex).toBe(0);
    tour.next();
    tour.next();
    tour.back();
    expect(useTour.getState().stepIndex).toBe(1);
  });

  test("next on the last step ends the tour and remembers it was seen", () => {
    const tour = useTour.getState();
    tour.start();
    for (const _ of TOUR_STEPS) {
      tour.next();
    }
    expect(useTour.getState().stepIndex).toBeNull();
    expect(useLayout.getState().layout.tourSeen).toBe(true);
  });

  test("skipping ends the tour and remembers it was seen", () => {
    useTour.getState().start();
    useTour.getState().finish();
    expect(useTour.getState().stepIndex).toBeNull();
    expect(useLayout.getState().layout.tourSeen).toBe(true);
  });

  test("the first run starts the tour for someone who has not seen it", () => {
    useTour.getState().startIfUnseen();
    expect(useTour.getState().stepIndex).toBe(0);
  });

  test("the first run leaves someone who has seen it alone", () => {
    useLayout.setState({ layout: { ...DEFAULT_LAYOUT, tourSeen: true } });
    useTour.getState().startIfUnseen();
    expect(useTour.getState().stepIndex).toBeNull();
  });

  test("an existing person can still start it by hand", () => {
    useLayout.setState({ layout: { ...DEFAULT_LAYOUT, tourSeen: true } });
    useTour.getState().start();
    expect(useTour.getState().stepIndex).toBe(0);
  });
});

test("the layout starts out not loaded, and says so once it is", () => {
  useTour.setState({ layoutLoaded: false });
  useTour.getState().noteLayoutLoaded();
  expect(useTour.getState().layoutLoaded).toBe(true);
});

describe("the Details rail steps", () => {
  const indexOf = (tab: string) =>
    TOUR_STEPS.findIndex((step) => step.inspectorTab === tab);

  beforeEach(() => {
    useLayout.setState({ inspectorTab: "details" });
  });

  test("the tour has a step for each of Details, Activity and Notes", () => {
    expect(indexOf("details")).toBeGreaterThan(-1);
    expect(indexOf("activity")).toBe(indexOf("details") + 1);
    expect(indexOf("notes")).toBe(indexOf("activity") + 1);
  });

  test("walking onto a tab's step opens that tab", () => {
    const tour = useTour.getState();
    tour.start();
    while ((useTour.getState().stepIndex ?? 0) < indexOf("activity")) {
      tour.next();
    }
    expect(useLayout.getState().inspectorTab).toBe("activity");
    tour.next();
    expect(useLayout.getState().inspectorTab).toBe("notes");
    tour.back();
    expect(useLayout.getState().inspectorTab).toBe("activity");
  });

  test("ending the tour puts back the tab that was open before it", () => {
    useLayout.setState({ inspectorTab: "notes" });
    const tour = useTour.getState();
    tour.start();
    while ((useTour.getState().stepIndex ?? 0) < indexOf("activity")) {
      tour.next();
    }
    tour.finish();
    expect(useLayout.getState().inspectorTab).toBe("notes");
  });
});

test("the view-tabs step says Files is where you edit files yourself", () => {
  const step = TOUR_STEPS.find((s) => s.id === "view-tabs");
  expect(step?.body).toMatch(EDIT_YOURSELF);
});
