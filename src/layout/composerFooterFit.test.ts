import { describe, expect, it } from "vitest";
import { FULL_FIT, footerFit } from "./composerFooterFit.ts";

const usage = "330k · 33% ctx";

describe("footerFit", () => {
  it("shows everything when the row is wide", () => {
    expect(footerFit(900, { stop: true, usage })).toEqual(FULL_FIT);
  });

  it("gives things up least useful first as the row narrows", () => {
    const shown = (width: number) => {
      const fit = footerFit(width, { stop: true, usage });
      return Object.entries(fit)
        .filter(([, on]) => !on)
        .map(([step]) => step)
        .sort();
    };
    expect(shown(652)).toEqual([]);
    expect(shown(620)).toEqual(["promptsKey"]);
    expect(shown(530)).toEqual(["promptsKey", "session"].sort());
    // The composer in the bug report (a ~510px footer, Stop showing).
    expect(shown(510)).toEqual(["promptsKey", "saveLabel", "session"].sort());
    expect(shown(400)).toEqual(
      ["promptsKey", "saveLabel", "session", "usage"].sort()
    );
    expect(shown(300)).toEqual(
      ["promptsKey", "promptsLabel", "saveLabel", "session", "usage"].sort()
    );
  });

  it("needs less room without Stop", () => {
    const withStop = footerFit(580, { stop: true, usage });
    const without = footerFit(580, { stop: false, usage });
    expect(withStop.session).toBe(false);
    expect(without).toEqual(FULL_FIT);
  });

  it("counts a longer usage readout", () => {
    const short = footerFit(600, { stop: true, usage: "9k · 1% ctx" });
    const long = footerFit(600, {
      stop: true,
      usage: "1.2M · 100% ctx · $12.40",
    });
    expect(short.session).toBe(true);
    expect(long.session).toBe(false);
  });
});
