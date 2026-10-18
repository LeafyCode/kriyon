import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOM_WEIGHT_BUDGET,
  domWeightVerdict,
  installDomWeightWatch,
} from "./domWeight.ts";

describe("domWeightVerdict", () => {
  it("is ok while under budget, and stays ok at the budget itself", () => {
    expect(domWeightVerdict(0, false)).toBe("ok");
    expect(domWeightVerdict(DOM_WEIGHT_BUDGET, false)).toBe("ok");
  });

  it("warns on the first crossing", () => {
    expect(domWeightVerdict(DOM_WEIGHT_BUDGET + 1, false)).toBe("warn");
  });

  it("stays quiet while it remains over — one warning per crossing, not per check", () => {
    expect(domWeightVerdict(DOM_WEIGHT_BUDGET * 4, true)).toBe("over");
  });

  it("re-arms once the document drops back under budget", () => {
    expect(domWeightVerdict(10, true)).toBe("ok");
    expect(domWeightVerdict(DOM_WEIGHT_BUDGET + 1, false)).toBe("warn");
  });
});

describe("installDomWeightWatch", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  function fill(count: number): void {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i += 1) {
      frag.append(document.createElement("span"));
    }
    document.body.append(frag);
  }

  it("reports once when the document crosses the budget", () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const stop = installDomWeightWatch({ budget: 50, doc: document, report });

    vi.advanceTimersByTime(60_000);
    expect(report).not.toHaveBeenCalled();

    fill(80);
    vi.advanceTimersByTime(60_000);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toBeGreaterThan(50);

    // Still over, but already reported — no repeat every tick.
    vi.advanceTimersByTime(60_000 * 5);
    expect(report).toHaveBeenCalledTimes(1);

    stop();
  });

  it("stops checking once uninstalled", () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const stop = installDomWeightWatch({ budget: 50, doc: document, report });
    stop();

    fill(80);
    vi.advanceTimersByTime(60_000 * 5);

    expect(report).not.toHaveBeenCalled();
  });
});
