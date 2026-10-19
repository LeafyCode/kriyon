/**
 * What the composer's footer shows as it narrows. The footer is one row:
 * attach, the Session chip, the usage readout, Save prompt and Prompts on the
 * left; hide, Stop and Send on the right. Stop and Send always show. The
 * left side gives parts up in a fixed order, least useful first, one step at
 * a time until it fits, so nothing wraps and nothing is pushed out of the
 * box. Whether it fits is measured from the real layout (`PromptBar`), never
 * estimated, so a change to a button's size can't throw it off.
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

/** The steps, in the order they are given up. */
export const FOOTER_STEPS: readonly (keyof FooterFit)[] = [
  "promptsKey",
  "session",
  "saveLabel",
  "usage",
  "promptsLabel",
];

/** What the footer shows once it has given up its first `steps` parts. */
export function fitAfter(steps: number): FooterFit {
  const fit = { ...FULL_FIT };
  for (const step of FOOTER_STEPS.slice(0, steps)) {
    fit[step] = false;
  }
  return fit;
}
