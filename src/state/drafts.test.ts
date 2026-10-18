import { beforeEach, describe, expect, it } from "vitest";
import { useDrafts } from "./drafts.ts";
import { DEFAULT_LAYOUT, useLayout } from "./layout.ts";

describe("useDrafts", () => {
  beforeEach(() => {
    useDrafts.setState({ drafts: {}, insertRequest: null });
  });

  it("keeps one draft per session", () => {
    useDrafts.getState().setDraft("s1", "hello");
    useDrafts.getState().setDraft("s2", "other");
    expect(useDrafts.getState().drafts).toEqual({ s1: "hello", s2: "other" });
  });

  it("requestInsert targets a session and bumps seq so repeats re-fire", () => {
    useDrafts.getState().requestInsert("s1", "snippet");
    const first = useDrafts.getState().insertRequest;
    expect(first).toMatchObject({ sessionId: "s1", text: "snippet" });
    useDrafts.getState().requestInsert("s1", "snippet");
    const second = useDrafts.getState().insertRequest;
    expect(second?.seq).not.toBe(first?.seq);
  });

  it("clearInsertRequest resets the request", () => {
    useDrafts.getState().requestInsert("s1", "x");
    useDrafts.getState().clearInsertRequest();
    expect(useDrafts.getState().insertRequest).toBeNull();
  });

  it("requestInsert posts and nothing else — it never moves the layout", () => {
    useLayout.setState({ layout: DEFAULT_LAYOUT });
    useLayout.getState().setTranscriptView("raw");
    useLayout.getState().setTranscriptView("changes");

    useDrafts.getState().requestInsert("s1", "snippet");

    // Revealing a hidden composer belongs to the composer, not to the mailbox:
    // this action fires from the Prompts tab and the Command Center too, where
    // moving the session view is a side effect the user never sees.
    expect(useLayout.getState().layout.transcriptView).toBe("changes");
    expect(useDrafts.getState().insertRequest).toMatchObject({
      sessionId: "s1",
    });
  });
});
