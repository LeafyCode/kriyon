import { describe, expect, it } from "vitest";
import { type BootPhase, nextBootPhase } from "./bootPhase.ts";

describe("nextBootPhase", () => {
  it("launches from idle into booting", () => {
    expect(nextBootPhase("idle", "launch")).toBe("booting");
  });

  it("a real start makes any phase live", () => {
    const phases: BootPhase[] = ["idle", "booting", "resumeFailed", "live"];
    for (const phase of phases) {
      expect(nextBootPhase(phase, "started")).toBe("live");
    }
  });

  it("a status update clears the loading overlay but only while booting", () => {
    expect(nextBootPhase("booting", "statusUpdate")).toBe("live");
    // A status update must NOT clear a detected resume failure.
    expect(nextBootPhase("resumeFailed", "statusUpdate")).toBe("resumeFailed");
    expect(nextBootPhase("idle", "statusUpdate")).toBe("idle");
    expect(nextBootPhase("live", "statusUpdate")).toBe("live");
  });

  it("the timeout safety net only force-clears a still-booting overlay", () => {
    expect(nextBootPhase("booting", "timeout")).toBe("live");
    // Must never override a detected failure or a resting phase.
    expect(nextBootPhase("resumeFailed", "timeout")).toBe("resumeFailed");
    expect(nextBootPhase("live", "timeout")).toBe("live");
    expect(nextBootPhase("idle", "timeout")).toBe("idle");
  });

  it("a detected resume failure only fires while booting", () => {
    expect(nextBootPhase("booting", "resumeFailed")).toBe("resumeFailed");
    // A stray failure signal after the session is live is ignored.
    expect(nextBootPhase("live", "resumeFailed")).toBe("live");
    expect(nextBootPhase("idle", "resumeFailed")).toBe("idle");
  });

  it("dismissing the recovery prompt settles back to idle", () => {
    expect(nextBootPhase("resumeFailed", "dismissFailed")).toBe("idle");
    // Dismiss is a no-op from any other phase.
    expect(nextBootPhase("booting", "dismissFailed")).toBe("booting");
    expect(nextBootPhase("live", "dismissFailed")).toBe("live");
  });

  it("relaunching from a failed resume goes straight back to booting", () => {
    expect(nextBootPhase("resumeFailed", "launch")).toBe("booting");
  });
});
