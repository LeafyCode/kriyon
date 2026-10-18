/**
 * Watches [DOM weight] — how many elements the one Kriyon document is holding
 * at once — and says so, loudly, in dev when it gets big enough to matter.
 *
 * This exists because the thing that actually froze the UI was document *size*,
 * not pane *count*. macOS WebKit walks document text to build autocorrect
 * candidates on every rendering update and on every edit command (see
 * `ui/strayCaret.ts` for the measured stack), and the walk is quadratic in the
 * text it covers. A real install reached 380,970 elements / 15.1M characters
 * across 93 mounted session panes and stalled for 8.6 seconds on a keystroke.
 *
 * The fix bounded mounted panes to the [Warm pane] LRU, which brought that to
 * 8,066 elements. But `MAX_WARM_PANES` is a count, and the failure mode is a
 * size: seven panes each holding a long transcript and a large diff feed can
 * reach the same total that 93 small ones did. The pane-count tests would stay
 * green through all of it. This watch is what notices instead.
 *
 * Dev-only, and deliberately cheap: `getElementsByTagName("*").length` reads a
 * live collection's size rather than serializing anything, so it costs nothing
 * like the scan it is warning about.
 */

/**
 * Element count past which the document is heavy enough that a whole-document
 * WebKit pass is worth knowing about. Well above the ~8k a healthy warm set
 * measured at, well below the ~381k that froze the app — it should fire on a
 * real regression, never on ordinary use.
 */
export const DOM_WEIGHT_BUDGET = 60_000;

/** How often the watch samples. Long: this is a slow-moving leak, not an
 * event, and a dev-only timer should stay out of the way. */
const SAMPLE_MS = 60_000;

/** What a sample means, given whether the last sample was already over.
 * `"warn"` is the one crossing worth reporting — `"over"` is the same
 * condition already reported, so it stays quiet instead of logging every
 * minute for as long as the app is open. */
export type DomWeightVerdict = "ok" | "over" | "warn";

/** Pure decision: budget comparison plus the already-reported hysteresis, so
 * the interesting part is testable without a document or a timer. */
export function domWeightVerdict(
  elementCount: number,
  alreadyOver: boolean,
  budget: number = DOM_WEIGHT_BUDGET
): DomWeightVerdict {
  if (elementCount <= budget) {
    return "ok";
  }
  return alreadyOver ? "over" : "warn";
}

/**
 * Start sampling. Returns an uninstall function (the `install*` idiom the
 * other app-level listeners use). `report` is injected so tests don't depend
 * on the console, and `budget`/`doc` so they don't need 60,000 elements.
 */
export function installDomWeightWatch({
  budget = DOM_WEIGHT_BUDGET,
  doc = document,
  report = defaultReport,
}: {
  budget?: number;
  doc?: Document;
  report?: (elementCount: number, budget: number) => void;
} = {}): () => void {
  let over = false;
  const timer = setInterval(() => {
    const count = doc.getElementsByTagName("*").length;
    const verdict = domWeightVerdict(count, over, budget);
    over = verdict !== "ok";
    if (verdict === "warn") {
      report(count, budget);
    }
  }, SAMPLE_MS);
  return () => {
    clearInterval(timer);
  };
}

function defaultReport(elementCount: number, budget: number): void {
  // biome-ignore lint/suspicious/noConsole: a silent DOM-weight regression is the 8.6s freeze coming back.
  console.warn(
    `[kriyon] DOM weight ${elementCount} elements is past the ${budget} budget. ` +
      "A whole-document WebKit pass (editor state, spellcheck, find) is quadratic " +
      "in this — see src/ui/strayCaret.ts. Check what is mounted that shouldn't be."
  );
}
