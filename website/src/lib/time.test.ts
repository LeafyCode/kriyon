import { describe, expect, it } from "vitest";
import { formatSecs, pad } from "./time.ts";

describe("formatSecs", () => {
  it("formats zero, sub-minute, minute boundary, and long waits", () => {
    expect(formatSecs(0)).toBe("00:00");
    expect(formatSecs(59)).toBe("00:59");
    expect(formatSecs(60)).toBe("01:00");
    expect(formatSecs(252)).toBe("04:12");
    expect(formatSecs(700)).toBe("11:40");
  });
});

describe("pad", () => {
  it("zero-pads single digits only", () => {
    expect(pad(7)).toBe("07");
    expect(pad(42)).toBe("42");
  });
});
