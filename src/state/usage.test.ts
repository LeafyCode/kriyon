import { describe, expect, test } from "vitest";
import type { UsageSnapshot } from "../types.ts";
import {
  formatResetAt,
  formatTokens,
  planLimitsView,
  sessionUsageView,
  usageTone,
} from "./usage.ts";

function snapshot(partial: Partial<UsageSnapshot>): UsageSnapshot {
  return {
    contextWindowSize: null,
    inputTokens: null,
    model: null,
    outputTokens: null,
    sessionId: null,
    usedPercentage: null,
    ...partial,
  };
}

describe("sessionUsageView", () => {
  test("context comes from Claude's own reading", () => {
    const view = sessionUsageView(
      snapshot({ inputTokens: 60_804, usedPercentage: 6.4 })
    );

    expect(view.ctxPct).toBe(6);
    expect(view.contextTokens).toBe(60_804);
    expect(view.label).toBe("60.8k · 6% ctx");
    expect(view.reading).toBe("60.8k · 6%");
  });

  test("without Claude's percentage there is no context figure — never a guess", () => {
    const view = sessionUsageView(snapshot({ inputTokens: 500 }));

    expect(view.ctxPct).toBeNull();
    expect(view.label).toBe("");
  });

  test("nothing known yet reads as nothing", () => {
    expect(sessionUsageView(undefined)).toEqual({
      contextTokens: null,
      ctxPct: null,
      label: "",
      reading: "—",
    });
  });

  test("clamps Claude's percentage to 0-100", () => {
    expect(sessionUsageView(snapshot({ usedPercentage: 140 })).ctxPct).toBe(
      100
    );
  });
});

describe("formatTokens", () => {
  test("compacts thousands and millions", () => {
    expect(formatTokens(920)).toBe("920");
    expect(formatTokens(4100)).toBe("4.1k");
    expect(formatTokens(523_920)).toBe("524k");
    expect(formatTokens(2_340_000)).toBe("2.34M");
    expect(formatTokens(999_600)).toBe("1.00M");
    expect(formatTokens(999_400)).toBe("999k");
  });
});

describe("formatResetAt", () => {
  // Local times, so the test reads the same in any time zone.
  const now = new Date(2026, 9, 11, 12, 59).getTime(); // Sun 11 Oct, 12:59
  const at = (d: Date) => d.getTime() / 1000;

  const clock = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  test("a reset later today is its clock time, in the user's locale", () => {
    const reset = new Date(2026, 9, 11, 14, 40);
    expect(formatResetAt(at(reset), now)).toBe(clock(reset));
  });

  test("a reset on another day leads with the weekday", () => {
    const reset = new Date(2026, 9, 12, 5, 30);
    const day = reset.toLocaleDateString(undefined, { weekday: "short" });
    expect(formatResetAt(at(reset), now)).toBe(`${day} ${clock(reset)}`);
  });
});

describe("usageTone", () => {
  test("a meter warns from 80% and is full once it reads 100%", () => {
    expect(usageTone(null)).toBe("normal");
    expect(usageTone(79)).toBe("normal");
    expect(usageTone(80)).toBe("high");
    expect(usageTone(99.6)).toBe("full");
    expect(usageTone(100)).toBe("full");
  });
});

describe("planLimitsView", () => {
  const now = new Date(2026, 9, 11, 12, 59).getTime();
  const todayAt240 = new Date(2026, 9, 11, 14, 40).getTime() / 1000;
  const mondayAt530 = new Date(2026, 9, 12, 5, 30).getTime() / 1000;
  const at = (usedPercentage: number, resetsAt = todayAt240) => ({
    resetsAt,
    usedPercentage,
  });

  test("each reported window reads ready to show, in a fixed order", () => {
    const view = planLimitsView(
      { fiveHour: at(9.4), sevenDay: at(36, mondayAt530) },
      now
    );
    expect(view.windows).toEqual([
      {
        id: "five-hour",
        label: "5-hour limit",
        percent: 9,
        resets: "2:40 PM",
        tone: "normal",
      },
      {
        id: "seven-day",
        label: "Weekly limit",
        percent: 36,
        resets: "Mon 5:30 AM",
        tone: "normal",
      },
    ]);
    expect(view.alert).toBeNull();
  });

  test("a window not reported is left out", () => {
    const view = planLimitsView({ fiveHour: null, sevenDay: at(20) }, now);
    expect(view.windows.map((w) => w.id)).toEqual(["seven-day"]);
    expect(
      planLimitsView({ fiveHour: null, sevenDay: null }, now).windows
    ).toEqual([]);
  });

  test("the alert names the limit closest to running out", () => {
    expect(
      planLimitsView({ fiveHour: at(42), sevenDay: at(86) }, now).alert
    ).toEqual({ text: "Weekly limit at 86%", tone: "high" });
    expect(
      planLimitsView({ fiveHour: at(100), sevenDay: at(86) }, now).alert
    ).toEqual({ text: "5-hour limit reached", tone: "full" });
  });
});
