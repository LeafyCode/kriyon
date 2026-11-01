import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { useTour } from "../state/tour.ts";
import { AppTour } from "./AppTour.tsx";
import { TOUR_STEPS } from "./steps.ts";

const last = TOUR_STEPS.length - 1;

beforeEach(() => {
  useLayout.setState({ layout: DEFAULT_LAYOUT });
  useTour.setState({ layoutLoaded: false, stepIndex: null });
});

afterEach(() => {
  vi.useRealTimers();
});

function stepAt(index: number) {
  act(() => useTour.setState({ stepIndex: index }));
}

describe("AppTour", () => {
  test("draws nothing while no tour is running", () => {
    render(<AppTour />);
    expect(screen.queryByTestId("app-tour")).toBeNull();
  });

  test("shows the step's title, text and where it is in the tour", () => {
    render(<AppTour />);
    stepAt(0);
    expect(
      screen.getByRole("dialog", { name: TOUR_STEPS[0]?.title })
    ).toBeTruthy();
    expect(screen.getByText(TOUR_STEPS[0]?.body ?? "")).toBeTruthy();
    expect(screen.getByText(`1 of ${TOUR_STEPS.length}`)).toBeTruthy();
  });

  test("Next and Back walk the steps", () => {
    render(<AppTour />);
    stepAt(0);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(TOUR_STEPS[1]?.title ?? "")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText(TOUR_STEPS[0]?.title ?? "")).toBeTruthy();
  });

  test("there is no Back on the first step", () => {
    render(<AppTour />);
    stepAt(0);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  test("the arrow keys walk the steps", () => {
    render(<AppTour />);
    stepAt(0);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(useTour.getState().stepIndex).toBe(1);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(useTour.getState().stepIndex).toBe(0);
  });

  test("Escape skips the tour and it does not come back on its own", () => {
    render(<AppTour />);
    stepAt(2);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("app-tour")).toBeNull();
    expect(useLayout.getState().layout.tourSeen).toBe(true);
  });

  test("Skip tour ends it", () => {
    render(<AppTour />);
    stepAt(1);
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    expect(useTour.getState().stepIndex).toBeNull();
    expect(useLayout.getState().layout.tourSeen).toBe(true);
  });

  test("the last step ends with Done", () => {
    render(<AppTour />);
    stepAt(last);
    expect(screen.queryByRole("button", { name: "Skip tour" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(useTour.getState().stepIndex).toBeNull();
  });

  test("lights up the step's target when it is on screen", () => {
    const index = TOUR_STEPS.findIndex((step) => step.target === "sidebar");
    const target = document.createElement("aside");
    target.dataset.tour = "sidebar";
    target.getBoundingClientRect = () =>
      ({ height: 600, left: 0, top: 0, width: 278 }) as DOMRect;
    document.body.append(target);
    render(<AppTour />);
    stepAt(index);
    expect(
      screen.getByTestId("tour-spotlight").getAttribute("data-found")
    ).toBe("true");
    target.remove();
  });

  test("a step whose target is not on screen shows in the middle", () => {
    const index = TOUR_STEPS.findIndex((step) => step.target === "composer");
    render(<AppTour />);
    stepAt(index);
    expect(
      screen.getByTestId("tour-spotlight").getAttribute("data-found")
    ).toBe("false");
    expect(screen.getByRole("dialog").getAttribute("data-side")).toBe("center");
  });

  test("starts on its own for a new person once the layout has loaded", () => {
    vi.useFakeTimers();
    render(<AppTour />);
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByTestId("app-tour")).toBeNull();
    act(() => useTour.getState().noteLayoutLoaded());
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByTestId("app-tour")).toBeTruthy();
  });

  test("does not start on its own for someone who has seen it", () => {
    vi.useFakeTimers();
    useLayout.setState({ layout: { ...DEFAULT_LAYOUT, tourSeen: true } });
    render(<AppTour />);
    act(() => useTour.getState().noteLayoutLoaded());
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByTestId("app-tour")).toBeNull();
  });

  test("the welcome card opens with its picture; the other steps have none", () => {
    render(<AppTour />);
    stepAt(0);
    expect(screen.getByTestId("tour-hero")).toBeTruthy();
    stepAt(1);
    expect(screen.queryByTestId("tour-hero")).toBeNull();
  });

  test("Tab stays inside the card", () => {
    render(<AppTour />);
    stepAt(1);
    const skip = screen.getByRole("button", { name: "Skip tour" });
    const next = screen.getByRole("button", { name: "Next" });
    next.focus();
    fireEvent.keyDown(next, { key: "Tab" });
    expect(document.activeElement).toBe(skip);
    fireEvent.keyDown(skip, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(next);
  });

  test("focus goes back to where it was when the tour ends", () => {
    const before = document.createElement("textarea");
    document.body.append(before);
    before.focus();
    render(<AppTour />);
    stepAt(0);
    expect(document.activeElement).not.toBe(before);
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  test("app shortcuts do not fire under the tour", () => {
    const shortcut = vi.fn();
    window.addEventListener("keydown", shortcut);
    render(<AppTour />);
    stepAt(1);
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    fireEvent.keyDown(document.body, { key: ",", metaKey: true });
    fireEvent.keyDown(document.body, {
      key: "k",
      metaKey: true,
      shiftKey: true,
    });
    expect(shortcut).not.toHaveBeenCalled();
    act(() => useTour.getState().finish());
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    expect(shortcut).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", shortcut);
  });

  test("arrow keys pressed on an element underneath still reach the tour first", () => {
    const shortcut = vi.fn();
    window.addEventListener("keydown", shortcut);
    render(<AppTour />);
    stepAt(0);
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(useTour.getState().stepIndex).toBe(1);
    expect(shortcut).not.toHaveBeenCalled();
    window.removeEventListener("keydown", shortcut);
  });

  test("ending the tour leaves focus with a dialog that opened during it", () => {
    const before = document.createElement("textarea");
    document.body.append(before);
    before.focus();
    render(<AppTour />);
    stepAt(0);
    // About Kriyon, opened from the app menu mid-tour, takes focus.
    const dialogButton = document.createElement("button");
    document.body.append(dialogButton);
    dialogButton.focus();
    act(() => useTour.getState().finish());
    expect(document.activeElement).toBe(dialogButton);
    before.remove();
    dialogButton.remove();
  });
});
