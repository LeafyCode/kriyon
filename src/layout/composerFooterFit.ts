/**
 * What the composer's footer shows at a given width. The footer is one row:
 * attach, the Session chip, the usage readout, Save prompt and Prompts on the
 * left; hide, Stop and Send on the right. Stop and Send always show. As the
 * row narrows, the rest steps down in a fixed order, least useful first, so
 * nothing wraps and nothing is pushed out of the box.
 */

export interface FooterFit {
  /** The ⌘⇧P hint beside Prompts. */
  promptsKey: boolean;
  /** "Prompts" spelled out; otherwise its icon. */
  promptsLabel: boolean;
  /** "Save prompt" spelled out; otherwise just its ✦. */
  saveLabel: boolean;
  /** The Session chip. */
  session: boolean;
  /** The usage readout (`330k · 33% ctx`). */
  usage: boolean;
}

export const FULL_FIT: FooterFit = {
  promptsKey: true,
  promptsLabel: true,
  saveLabel: true,
  session: true,
  usage: true,
};

// Widths in px, as drawn at the composer's type sizes, each with the gap
// before it. Generous: a step taken a little early beats a row that clips.
const GAP_LEFT = 9;
const GAP_RIGHT = 7;
const ICON_BUTTON = 26;
const SESSION_CHIP = 80 + GAP_LEFT;
const SAVE_LABEL = 66; // "Save prompt" beyond the bare ✦ button
const PROMPTS_LABEL = 54; // "Prompts" beyond the bare icon button
const PROMPTS_KEY = 38 + 6; // the ⌘⇧P keycap and its gap
const STOP = 74 + GAP_RIGHT;
const SEND = 70 + GAP_RIGHT;
/** Room kept between the two groups. */
const BETWEEN = 16;
/** One character of the 11px mono usage readout. */
const MONO_CHAR = 6.7;

/** The steps, in the order they are given up. */
const STEPS: readonly (keyof FooterFit)[] = [
  "promptsKey",
  "session",
  "saveLabel",
  "usage",
  "promptsLabel",
];

/**
 * What fits in a footer `width` px wide. `usage` is the readout's text (none
 * when there is no reading yet); `stop` is whether Stop is showing.
 */
export function footerFit(
  width: number,
  { stop, usage }: { stop: boolean; usage: string | null }
): FooterFit {
  // Always there: attach, the ✦ and Prompts buttons, hide, Send.
  const base =
    ICON_BUTTON +
    2 * (ICON_BUTTON + GAP_LEFT) +
    ICON_BUTTON +
    SEND +
    (stop ? STOP : 0) +
    BETWEEN;
  const cost: Record<keyof FooterFit, number> = {
    promptsKey: PROMPTS_KEY,
    promptsLabel: PROMPTS_LABEL,
    saveLabel: SAVE_LABEL,
    session: SESSION_CHIP,
    usage: usage ? Math.ceil(usage.length * MONO_CHAR) + GAP_LEFT : 0,
  };
  const fit = { ...FULL_FIT };
  let needed = base + STEPS.reduce((sum, step) => sum + cost[step], 0);
  for (const step of STEPS) {
    if (needed <= width) {
      break;
    }
    fit[step] = false;
    needed -= cost[step];
  }
  return fit;
}
