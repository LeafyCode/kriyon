import { create } from "zustand";
import { TOUR_STEPS } from "../tour/steps.ts";
import { type InspectorTab, useLayout } from "./layout.ts";

/**
 * The [App tour]: which step is on screen, or none. Not saved — only whether
 * it has been seen is (`layout.tourSeen`), so a quit mid-tour starts it over.
 */
interface TourState {
  /** Step back one; a no-op on the first step. */
  back: () => void;
  /** End the tour (done or skipped) and remember it was seen. */
  finish: () => void;
  /** Whether the saved layout, and so `tourSeen`, has been read. Until it
   *  has, a person who has seen the tour looks like one who has not. */
  layoutLoaded: boolean;
  /** Step forward one; past the last step, finish. */
  next: () => void;
  /** Called once hydration has read the saved layout. */
  noteLayoutLoaded: () => void;
  /** Start from the first step, on the session workspace the steps point at. */
  start: () => void;
  /** Start only for someone who has never finished or skipped it. */
  startIfUnseen: () => void;
  stepIndex: number | null;
}

/** The Details rail tab open before the tour, put back when it ends: the
 *  tab steps switch it to show each one. */
let tabBeforeTour: InspectorTab | null = null;

/** Show step `index`, opening the Details rail tab it is about, if any. */
function showStep(index: number): { stepIndex: number } {
  const tab = TOUR_STEPS[index]?.inspectorTab;
  if (tab) {
    useLayout.getState().setInspectorTab(tab);
  }
  return { stepIndex: index };
}

export const useTour = create<TourState>((set, get) => ({
  back: () => {
    const { stepIndex } = get();
    if (stepIndex !== null) {
      set(showStep(Math.max(0, stepIndex - 1)));
    }
  },
  finish: () => {
    set({ stepIndex: null });
    if (tabBeforeTour) {
      useLayout.getState().setInspectorTab(tabBeforeTour);
      tabBeforeTour = null;
    }
    useLayout.getState().setTourSeen(true);
  },
  layoutLoaded: false,
  next: () => {
    const { stepIndex } = get();
    if (stepIndex === null) {
      return;
    }
    if (stepIndex >= TOUR_STEPS.length - 1) {
      get().finish();
      return;
    }
    set(showStep(stepIndex + 1));
  },
  noteLayoutLoaded: () => set({ layoutLoaded: true }),
  start: () => {
    const layout = useLayout.getState();
    // Every stop is on the session workspace; Focus hides most of them.
    layout.setView("studio");
    if (get().stepIndex === null) {
      tabBeforeTour = layout.inspectorTab;
    }
    set(showStep(0));
  },
  startIfUnseen: () => {
    if (!useLayout.getState().layout.tourSeen) {
      get().start();
    }
  },
  stepIndex: null,
}));
