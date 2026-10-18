/**
 * The [Changes view]'s one inline banner shape (ADR-0023, plan §H).
 *
 * Every advisory row in this view used to be hand-rolled: seven near-copies
 * across [`FileViewer`]'s six guard/error/notice banners and
 * [`BudgetNotice`], each picking its own fill, its own hairline and its own
 * padding, which is why "the file changed on disk" and "this diff is
 * incomplete" never looked like the same kind of statement. They are: a
 * quiet, tinted strip that says the view is not showing you the whole
 * truth, and what to do about it.
 *
 * A style builder rather than a component, for the same reason
 * `src/theme/recipes.ts` is (ADR-0007): each banner keeps its own testid,
 * its own buttons and its own copy, and only the shape is shared.
 *
 * Two tones, and only two. **`warn`** is the overwhelmingly common one — a
 * state the view is in, not a failure: unsaved edits held behind a guard, a
 * file that moved on disk, a diff the working-tree budget cut short.
 * **`error`** is for something that actually went wrong and left the user's
 * intent unfulfilled — a save that failed. Anything quieter than a warn is
 * not a banner at all, it is a line of muted text.
 *
 * Both tones are drawn from the status tokens rather than literal alphas:
 * `wash` (8%) fills, `soft` (12%) draws the hairline, and the text sits on
 * the lifted ink stop that is legible on its own tint.
 */

import type { CSSProperties } from "react";
import { tokens } from "../theme/tokens.ts";

export type BannerTone = "warn" | "error";

const TONE: Record<
  BannerTone,
  { background: string; border: string; color: string }
> = {
  warn: {
    background: tokens.color.status.waitingWash,
    border: tokens.color.status.waitingSoft,
    color: tokens.color.status.waitingInk,
  },
  error: {
    background: tokens.color.status.errorWash,
    border: tokens.color.delSoft,
    color: tokens.color.del,
  },
};

/**
 * The strip itself: 34px on the row rhythm, `radius.md`, tinted fill, tinted
 * hairline. `minHeight`, not `height` — the sentence is what it is, and a
 * banner that clipped its own explanation would be worse than one that grew
 * a line. In the common case (one line, at the sizes below) the two are the
 * same 34px.
 */
export function banner(tone: BannerTone): CSSProperties {
  const { background, border, color } = TONE[tone];
  return {
    alignItems: "center",
    background,
    border: `1px solid ${border}`,
    borderRadius: tokens.radius.md,
    color,
    display: "flex",
    flex: "none",
    fontFamily: tokens.font.sans,
    fontSize: "11.5px",
    gap: tokens.space.sm,
    lineHeight: 1.45,
    margin: `${tokens.space.sm} ${tokens.space.md}`,
    minHeight: "34px",
    padding: `${tokens.space.xs} ${tokens.space.sm}`,
  };
}

/** The 6px dot that opens a banner — the same glyph a status pill uses, so
 * the tone is readable before the sentence is. */
export function bannerDot(tone: BannerTone): CSSProperties {
  return {
    background: TONE[tone].color,
    borderRadius: "50%",
    flex: "none",
    height: "6px",
    width: "6px",
  };
}
