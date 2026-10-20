/**
 * The [Warm pane] retention policy: which non-active [Session]s keep their
 * Raw-view xterm mounted (hidden) so returning to them never remounts and
 * blanks the terminal. Bounded LRU — the store used to keep *every* viewed
 * session mounted forever, so a long session accumulated live xterms until it
 * exhausted WKWebView's WebGL context budget (~16). This module is the pure
 * core (no store/React), so the policy is unit-testable in isolation.
 */

/**
 * Cap on the number of warm panes kept mounted besides the active one. Each
 * mounted xterm holds a WebGL context and WKWebView caps live contexts (~16,
 * see `Terminal.tsx`); staying well under that leaves headroom for the Project
 * terminals. Evicted panes only unmount their xterm — their [PTY daemon] lives
 * on, so a later return reattaches (no reboot, no lost background work).
 */
export const MAX_WARM_PANES = 6;

/**
 * Recompute the warm list when the active session changes. The list is
 * most-recently-left first. The `arrived` (now active) session leaves the warm
 * set; the just-left `departed` session is promoted to the front (deduped); and
 * the list is capped — anything past {@link MAX_WARM_PANES} is `evicted` (its
 * xterm unmounts). `departed` is null on the very first activation.
 */
export function nextWarmPanes(
  warm: string[],
  departed: string | null,
  arrived: string,
  cap: number = MAX_WARM_PANES
): { warm: string[]; evicted: string[] } {
  const withoutArrival = warm.filter((id) => id !== arrived);
  const promoted =
    departed && departed !== arrived
      ? [departed, ...withoutArrival.filter((id) => id !== departed)]
      : withoutArrival;
  if (promoted.length <= cap) {
    return { warm: promoted, evicted: [] };
  }
  return { warm: promoted.slice(0, cap), evicted: promoted.slice(cap) };
}

/**
 * Whether a session's pane should be mounted: it is the active tab, or a [Warm
 * pane]. The single derived predicate for the mount decision, so any new path
 * that sets the active tab mounts it correctly for free.
 */
export function sessionPaneMounts(
  activeSessionId: string | null,
  warm: string[],
  id: string
): boolean {
  return activeSessionId === id || warm.includes(id);
}
