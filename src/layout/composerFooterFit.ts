/**
 * What the composer's footer shows as it narrows. The footer is one row:
 * attach, the Session chip, the usage readout, Save prompt and Prompts on the
 * left; hide, Stop and Send on the right. Stop and Send always show. The
 * left side gives parts up in a fixed order, least useful first, one step at
 * a time until it fits, so nothing wraps and nothing is pushed out of the
 * box. Whether it fits is measured from the real layout
 * ({@link useFooterFit}), never estimated, so a change to a button's size
 * can't throw it off.
 */

import { type RefObject, useLayoutEffect, useState } from "react";

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

/**
 * How much of the footer's tools fits, measured: after each layout, while
 * the tools' content is wider than their box, give up one more step. The
 * steps run in layout effects, so only the settled footer is painted.
 *
 * It starts again from everything whenever the box the tools sit in (their
 * parent) changes width, or `drawnFrom` changes: pass the props the tools
 * are drawn from, which are a new object on every render the parent makes
 * and the same one on the renders the steps make.
 */
export function useFooterFit(
  toolsRef: RefObject<HTMLElement | null>,
  drawnFrom: object
): FooterFit {
  const width = useBoxWidth(toolsRef);
  const [fitted, setFitted] = useState({ drawnFrom, steps: 0, width });
  const current =
    fitted.drawnFrom === drawnFrom && fitted.width === width
      ? fitted
      : { drawnFrom, steps: 0, width };
  if (current !== fitted) {
    setFitted(current);
  }
  useLayoutEffect(() => {
    const tools = toolsRef.current;
    if (
      tools &&
      current.steps < FOOTER_STEPS.length &&
      tools.scrollWidth > tools.clientWidth + ROUNDING_PX
    ) {
      setFitted({ ...current, steps: current.steps + 1 });
    }
  });
  return fitAfter(current.steps);
}

/** scrollWidth and clientWidth round a fractional width apart by up to 1px
 *  with nothing overflowing; that is not a reason to give a part up. */
const ROUNDING_PX = 1;

/**
 * The width of the box `ref`'s element sits in, as it resizes; `null` until
 * it is laid out. The element's own ref is attached before this component's
 * layout effects run; a parent element's ref would not be yet.
 */
function useBoxWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const box = ref.current?.parentElement;
    if (!box) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      let next = 0;
      for (const entry of entries) {
        next = entry.contentRect.width;
      }
      // A box not laid out yet (or a test's DOM) measures 0: not a width.
      setWidth(next > 0 ? next : null);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
