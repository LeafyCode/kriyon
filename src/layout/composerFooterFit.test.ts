import { describe, expect, it } from "vitest";
import { FOOTER_STEPS, FULL_FIT, fitAfter } from "./composerFooterFit.ts";

const off = (steps: number) =>
  Object.entries(fitAfter(steps))
    .filter(([, on]) => !on)
    .map(([part]) => part);

describe("fitAfter", () => {
  it("shows everything before any step is taken", () => {
    expect(fitAfter(0)).toEqual(FULL_FIT);
  });

  it("gives parts up least useful first", () => {
    expect(off(1)).toEqual(["promptsKey"]);
    expect(off(2).sort()).toEqual(["promptsKey", "session"]);
    expect(off(3).sort()).toEqual(["promptsKey", "saveLabel", "session"]);
    expect(off(4).sort()).toEqual([
      "promptsKey",
      "saveLabel",
      "session",
      "usage",
    ]);
    expect(off(FOOTER_STEPS.length).sort()).toEqual([...FOOTER_STEPS].sort());
  });

  it("has nothing more to give past the last step", () => {
    expect(fitAfter(FOOTER_STEPS.length + 3)).toEqual(
      fitAfter(FOOTER_STEPS.length)
    );
  });
});
