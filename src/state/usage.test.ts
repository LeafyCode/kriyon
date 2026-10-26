import { describe, expect, it, test } from "vitest";
import type { UsageSnapshot } from "../types.ts";
import {
  formatResetAt,
  formatTokens,
  limitPace,
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

describe("limitPace", () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const now = 1_800_000_000_000;
  const resetsIn = (ms: number) => Math.round((now + ms) / 1000);

  it("projects when a window runs out at the recent rate, before it resets", () => {
    // 10 points in the last 30 minutes, 40 left: about 2 hours.
    const pace = limitPace(
      [
        { atMs: now - 30 * MIN, usedPercentage: 50 },
        { atMs: now - 5 * MIN, usedPercentage: 60 },
      ],
      { resetsAt: resetsIn(3 * 24 * HOUR), usedPercentage: 60 },
      now
    );
    expect(pace?.runsOutInMs).toBe(2 * HOUR);
  });

  it("stays quiet when the window resets before it would run out", () => {
    const pace = limitPace(
      [{ atMs: now - 30 * MIN, usedPercentage: 50 }],
      { resetsAt: resetsIn(HOUR), usedPercentage: 60 },
      now
    );
    expect(pace).toBeNull();
  });

  it("needs ten minutes of readings and a rise of a point before it guesses", () => {
    const window = { resetsAt: resetsIn(24 * HOUR), usedPercentage: 60 };
    expect(
      limitPace([{ atMs: now - 5 * MIN, usedPercentage: 50 }], window, now)
    ).toBeNull();
    expect(
      limitPace([{ atMs: now - 30 * MIN, usedPercentage: 59.5 }], window, now)
    ).toBeNull();
  });

  it("reads the rate over the last hour only", () => {
    const pace = limitPace(
      [
        { atMs: now - 5 * HOUR, usedPercentage: 0 },
        { atMs: now - 60 * MIN, usedPercentage: 55 },
      ],
      { resetsAt: resetsIn(24 * HOUR), usedPercentage: 60 },
      now
    );
    // 5 points an hour from the last hour's first reading, 40 left: 8 hours.
    expect(pace?.runsOutInMs).toBe(8 * HOUR);
  });
});

describe("planLimitsView pace", () => {
  const now = 1_800_000_000_000;
  it("warns how soon the weekly limit runs out at this rate", () => {
    const view = planLimitsView(
      {
        fiveHour: null,
        sevenDay: {
          resetsAt: Math.round((now + 3 * 86_400_000) / 1000),
          usedPercentage: 60,
        },
      },
      now,
      {
        fiveHour: [],
        sevenDay: [{ atMs: now - 30 * 60_000, usedPercentage: 50 }],
      }
    );
    expect(view.pace).toEqual({
      text: "Weekly limit runs out in about 2h at this rate",
      tone: "high",
    });
  });

  it("has no pace warning without readings over time", () => {
    const view = planLimitsView(
      { fiveHour: null, sevenDay: { resetsAt: 1, usedPercentage: 60 } },
      now
    );
    expect(view.pace).toBeNull();
  });
});
