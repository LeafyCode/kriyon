import { describe, expect, it } from "vitest";
import {
  compactAge,
  type DateBucket,
  dateBucket,
  relativeTime,
  shortTime,
} from "./pastSessionTime.ts";

// A fixed reference instant: 2026-06-18 12:00:00 local time.
const NOW = new Date(2026, 5, 18, 12, 0, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  it("reads 'just now' under a minute", () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe("just now");
    expect(relativeTime(NOW, NOW)).toBe("just now");
  });

  it("counts minutes and hours within the day", () => {
    expect(relativeTime(NOW - 5 * MINUTE, NOW)).toBe("5 minutes ago");
    expect(relativeTime(NOW - 3 * HOUR, NOW)).toBe("3 hours ago");
  });

  it("counts days up to a week", () => {
    expect(relativeTime(NOW - 2 * DAY, NOW)).toBe("2 days ago");
  });

  it("shows an absolute date once older than a week", () => {
    const old = NOW - 40 * DAY;
    expect(relativeTime(old, NOW)).toBe(new Date(old).toLocaleDateString());
  });

  it("never reads a future time as negative", () => {
    expect(relativeTime(NOW + 10 * MINUTE, NOW)).toBe("just now");
  });
});

describe("shortTime", () => {
  it("compresses recency into a two-or-three character label", () => {
    expect(shortTime(NOW - 20_000, NOW)).toBe("now");
    expect(shortTime(NOW - 5 * MINUTE, NOW)).toBe("5m");
    expect(shortTime(NOW - 3 * HOUR, NOW)).toBe("3h");
    expect(shortTime(NOW - 2 * DAY, NOW)).toBe("2d");
  });

  it("never renders impossible labels at bucket edges", () => {
    // Flooring keeps each label inside its unit — no "60m" or "24h".
    expect(shortTime(NOW - 59.5 * MINUTE, NOW)).toBe("59m");
    expect(shortTime(NOW - 23.7 * HOUR, NOW)).toBe("23h");
    expect(shortTime(NOW - 6.9 * DAY, NOW)).toBe("6d");
    expect(shortTime(NOW - 90 * MINUTE, NOW)).toBe("1h");
    expect(shortTime(NOW - 36 * HOUR, NOW)).toBe("1d");
  });

  it("falls back to a short month-day date after a week", () => {
    const old = NOW - 40 * DAY;
    expect(shortTime(old, NOW)).toBe(
      new Date(old).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
      })
    );
  });

  it("never reads a future time as negative", () => {
    expect(shortTime(NOW + 10 * MINUTE, NOW)).toBe("now");
  });
});

describe("dateBucket", () => {
  it("buckets by calendar day, not elapsed hours", () => {
    const cases: [number, DateBucket][] = [
      [NOW - HOUR, "Today"],
      [new Date(2026, 5, 18, 1, 0, 0).getTime(), "Today"], // 1am same date
      [new Date(2026, 5, 17, 23, 0, 0).getTime(), "Yesterday"], // 11pm prior date
      [NOW - 3 * DAY, "Previous 7 days"],
      [NOW - 10 * DAY, "Previous 30 days"],
      [NOW - 60 * DAY, "Older"],
    ];
    for (const [ms, expected] of cases) {
      expect(dateBucket(ms, NOW)).toBe(expected);
    }
  });
});

describe("compactAge", () => {
  it("stays relative past a week, where shortTime falls back to a date", () => {
    const cases: [number, string][] = [
      [NOW - 30_000, "now"],
      [NOW - 5 * MINUTE, "5m"],
      [NOW - 3 * HOUR, "3h"],
      [NOW - 2 * DAY, "2d"],
      [NOW - 11 * DAY, "11d"],
      [NOW - 29 * DAY, "29d"],
      [NOW - 30 * DAY, "1mo"],
      [NOW - 200 * DAY, "6mo"],
      [NOW - 400 * DAY, "1y"],
    ];
    for (const [ms, expected] of cases) {
      expect(compactAge(ms, NOW)).toBe(expected);
    }
  });

  it("never reads a future time as negative", () => {
    expect(compactAge(NOW + 10 * MINUTE, NOW)).toBe("now");
  });
});
