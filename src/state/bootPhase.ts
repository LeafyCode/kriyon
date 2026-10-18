/**
 * The [Boot phase]: where a [Session] is in launching `claude`, distinct from
 * its live-turn {@link SessionStatus}. This module is the pure core — a single
 * reducer over the phase — with no store or React dependency, so every
 * transition is unit-testable in isolation. The imperative shell (the store's
 * phase record, the coordinator's single safety-net timer) drives it.
 */

/** Where a session is in the launch lifecycle. */
export type BootPhase = "idle" | "booting" | "resumeFailed" | "live";

/**
 * What can move a session's {@link BootPhase}:
 * - `launch` — a launch or in-place restart began.
 * - `started` — a real `SessionStart` fired; claude is up (clears any failure).
 * - `statusUpdate` — a live status arrived; clears a still-showing overlay but
 *   never a detected failure.
 * - `timeout` — the boot safety net elapsed; force-clears a stuck overlay only.
 * - `resumeFailed` — the resume watchdog saw claude exit on an expired resume.
 * - `dismissFailed` — the user dismissed the recovery prompt without restarting.
 */
export type BootEvent =
  | "launch"
  | "started"
  | "statusUpdate"
  | "timeout"
  | "resumeFailed"
  | "dismissFailed";

/**
 * The one transition function for the [Boot phase]. Pure: same inputs, same
 * output, no side effects. Events that don't apply to the current phase leave it
 * unchanged, so callers can fire them unconditionally.
 */
export function nextBootPhase(phase: BootPhase, event: BootEvent): BootPhase {
  switch (event) {
    case "launch":
      return "booting";
    case "started":
      return "live";
    case "statusUpdate":
    case "timeout":
      // Clear a still-showing loading overlay, but never override a detected
      // failure or a resting phase.
      return phase === "booting" ? "live" : phase;
    case "resumeFailed":
      // Only a launch in flight can fail; a stray signal once live is ignored.
      return phase === "booting" ? "resumeFailed" : phase;
    case "dismissFailed":
      return phase === "resumeFailed" ? "idle" : phase;
    default:
      return phase;
  }
}
