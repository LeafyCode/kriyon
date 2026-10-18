/**
 * The shapes the BisBig restyle converges on (ADR-0023).
 *
 * This is deliberately **not** a component library. The theme seam (ADR-0007)
 * wants module-level `const style: CSSProperties = {…}` objects holding
 * `var(--kr-*)` references, so the thing worth sharing between forty files is
 * the *object*, not a component that wraps it: a recipe is a pure builder you
 * spread and override —
 *
 * ```ts
 * const rowStyle: CSSProperties = { ...row30(), paddingLeft: "26px" };
 * ```
 *
 * — which keeps every call site's props, testids and event handlers exactly
 * where they were. A shared `<Button>` would have meant rewriting all of them
 * for a change that is supposed to be a diff of values.
 *
 * Two rules hold the system together, and `recipes.test.ts` pins both:
 * every colour resolves through a token, and heights come from the 30 / 32 /
 * 46 row rhythm rather than from whatever fits a particular row's content.
 *
 * A third rule governs anything hoverable — see {@link fillVars}.
 */

import type { CSSProperties } from "react";
import type { SessionStatus } from "../types.ts";
import { statusMeta } from "./status.ts";
import { tokens } from "./tokens.ts";

/**
 * The `--kr-fill` / `--kr-fill-hover` pair `.kr-hover-surface` and
 * `.kr-hover-accent` paint from.
 *
 * A recipe whose host adds one of those classes may **not** set `background`
 * itself: an inline declaration outranks every class rule without
 * `!important`, and neither rule carries one — so painting the resting fill
 * inline silently kills the hover the recipe's own doc comment tells callers
 * to add. Publishing it as a custom property instead lets the class own
 * `background` for both states. This is the same move `SessionRow.rowFillVars`
 * already makes for `.kr-row`, generalised to buttons and rows.
 *
 * `hover` is omitted when the recipe has no opinion, so the class falls back
 * to its own wash; an active row passes its own fill to sit still under the
 * pointer rather than darken.
 */
function fillVars(fill: string, hover?: string): CSSProperties {
  return {
    "--kr-fill": fill,
    ...(hover === undefined ? {} : { "--kr-fill-hover": hover }),
  } as CSSProperties;
}

/**
 * A section heading — `PROJECTS`, `SESSION`, `USAGE`. Type only: each host
 * places it (the sidebar pads `22px 18px 6px`, the Details rail `0 0 6px`),
 * so baking padding in here would only make every caller override it.
 */
export function sectionLabel(): CSSProperties {
  return {
    color: tokens.color.ink.faint,
    fontFamily: tokens.font.sans,
    fontSize: "9.5px",
    fontWeight: 700,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
  };
}

/**
 * The 30px list/nav row: a sidebar session, a nav destination, a tree entry,
 * a menu item. `active` is the canvas's selected state — a 6% fill *and*
 * brighter, heavier ink, because on a plane this flat the fill alone is too
 * quiet to find.
 */
export function row30(options: { active?: boolean } = {}): CSSProperties {
  const active = options.active ?? false;
  return {
    alignItems: "center",
    ...(active
      ? fillVars(tokens.color.surface.s3, tokens.color.surface.s3)
      : fillVars("transparent")),
    borderRadius: tokens.radius.md,
    color: active ? tokens.color.ink.bright : tokens.color.ink.secondary,
    display: "flex",
    fontFamily: tokens.font.sans,
    fontSize: "12.5px",
    fontWeight: active ? 500 : 400,
    gap: "10px",
    height: "30px",
    padding: "0 10px",
  };
}

/**
 * The 32px label/value row the Details rail is built from. The hairline is
 * the separator between rows, so the last row in a group drops it — a
 * trailing rule reads as "the section continues" when it doesn't.
 */
export function kvRow(options: { last?: boolean } = {}): CSSProperties {
  return {
    alignItems: "center",
    borderBottom: options.last ? "none" : `1px solid ${tokens.color.line.soft}`,
    display: "flex",
    gap: "12px",
    height: "32px",
    justifyContent: "space-between",
  };
}

/** A 26×26 bare icon button. Pair with `className="kr-hover-surface"`. */
export function iconButton(): CSSProperties {
  return {
    alignItems: "center",
    ...fillVars("transparent"),
    border: "none",
    borderRadius: tokens.radius.md,
    color: tokens.color.ink.muted,
    cursor: "pointer",
    display: "flex",
    flex: "none",
    height: "26px",
    justifyContent: "center",
    padding: 0,
    width: "26px",
  };
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_FILL: Record<
  ButtonVariant,
  { border: string; color: string; fill: string }
> = {
  primary: {
    border: "none",
    color: tokens.color.onAccent,
    fill: tokens.color.accent,
  },
  secondary: {
    border: `1px solid ${tokens.color.line.strong}`,
    color: tokens.color.ink.secondary,
    fill: "transparent",
  },
  ghost: {
    border: "none",
    color: tokens.color.ink.muted,
    fill: "transparent",
  },
  // Tinted rather than filled: a destructive button that is a solid block of
  // red is the loudest thing on a flat, quiet screen, and it is usually the
  // one the user does *not* want.
  danger: {
    border: "none",
    color: tokens.color.del,
    fill: tokens.color.delSoft,
  },
};

/**
 * A button. `md` (28px) is the default — composer, dialogs, empty states;
 * `sm` (24px) is the inline one that sits inside a row.
 *
 * A `primary` button also wants `className="kr-hover-accent"`, and the others
 * `"kr-hover-surface"` — an inline style cannot express `:hover`.
 */
export function button(
  variant: ButtonVariant,
  size: "sm" | "md" = "md"
): CSSProperties {
  const { border, color, fill } = BUTTON_FILL[variant];
  return {
    alignItems: "center",
    border,
    color,
    // `danger` is the one variant no call site pairs with a hover class — the
    // ConfirmDialog's destructive button and PromptEditor's delete both carry
    // none — so it paints its own fill and shadows nothing. Every other
    // variant publishes it for the class instead; see {@link fillVars}.
    ...(variant === "danger" ? { background: fill } : fillVars(fill)),
    borderRadius: tokens.radius.md,
    cursor: "pointer",
    display: "inline-flex",
    flex: "none",
    fontFamily: tokens.font.sans,
    fontSize: size === "sm" ? "12px" : "12.5px",
    fontWeight: 500,
    gap: "6px",
    height: size === "sm" ? "24px" : "28px",
    justifyContent: "center",
    padding: size === "sm" ? "0 10px" : "0 14px",
    whiteSpace: "nowrap",
  };
}

/** A 24px labelled chip — the composer's `Session ▾`, a worktree branch. */
export function chip(): CSSProperties {
  return {
    alignItems: "center",
    background: tokens.color.chip,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    color: tokens.color.ink.secondary,
    display: "inline-flex",
    flex: "none",
    fontFamily: tokens.font.sans,
    fontSize: "12px",
    gap: "6px",
    height: "24px",
    padding: "0 9px",
  };
}

/**
 * A keycap — `⌘K`, `↵`, `esc`. Outlined rather than filled, and in mono,
 * because a shortcut is type the user reads, not an icon.
 */
export function kbd(): CSSProperties {
  return {
    background: "transparent",
    border: `1px solid ${tokens.color.line.strong}`,
    borderRadius: tokens.radius.sm,
    color: tokens.color.ink.muted,
    flex: "none",
    fontFamily: tokens.font.mono,
    fontSize: "10px",
    lineHeight: "16px",
    padding: "0 5px",
  };
}

/**
 * A 22px status pill — the session header's Running / Waiting for you / Idle.
 * The fill and the ink come from {@link statusMeta}, which is also what the
 * sidebar's dots read, so a pill can never disagree with the row that led to
 * it. The 6px dot inside it is `statusDotStyle(status, 6)`.
 */
export function pill(status: SessionStatus): CSSProperties {
  const meta = statusMeta(status);
  return {
    alignItems: "center",
    background: meta.soft,
    borderRadius: tokens.radius.pill,
    color: meta.ink,
    display: "inline-flex",
    flex: "none",
    fontFamily: tokens.font.sans,
    fontSize: "11.5px",
    fontWeight: 500,
    gap: "6px",
    height: "22px",
    padding: "0 9px",
  };
}

/** A card: the composer, a diff file, a settings group, a dialog panel. */
export function card(): CSSProperties {
  return {
    background: tokens.color.raised,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.lg,
  };
}

/**
 * A 30px input well — the sidebar search box, the Prompts filter, every
 * `<input>` / `<select>` / `<textarea>` in a dialog. A *well*, not a card: it
 * sits below the plane so it reads as something to type into.
 *
 * It sets no `display`, because most of its callers are form elements where
 * `display: flex` is wrong (it breaks the control's own baseline and padding).
 * A caller that is a *frame* around several children — an icon, an input and a
 * kbd chip — adds `display: "flex"` itself.
 */
export function inputBox(): CSSProperties {
  return {
    alignItems: "center",
    background: tokens.color.inputWell,
    border: `1px solid ${tokens.color.line.base}`,
    borderRadius: tokens.radius.md,
    gap: "8px",
    height: "30px",
    padding: "0 10px",
  };
}

/**
 * The floating panel every overlay is drawn on — the palette, the prompt
 * picker and editor, the spawn dialog, About. One of the few surfaces that
 * still earns a shadow: it is genuinely above the plane rather than a step
 * within it.
 *
 * It states no size. Five callers want five different widths and max heights,
 * and a default here would only be five overrides — so the recipe carries the
 * fill, the frame and the entrance, and each overlay says how big it is.
 */
export function overlayPanel(): CSSProperties {
  return {
    animation: "kr-pop-in 0.16s ease both",
    background: tokens.color.chrome.overlay,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.xl,
    boxShadow: tokens.shadow.pop,
    color: tokens.color.text,
    display: "flex",
    flexDirection: "column",
    fontFamily: tokens.font.sans,
    position: "relative",
  };
}

/**
 * A search-and-results overlay's own 46px header — the same height every
 * column header in the app uses, hairlined off from the list below it.
 */
export function searchRow(): CSSProperties {
  return {
    alignItems: "center",
    borderBottom: `1px solid ${tokens.color.line.base}`,
    display: "flex",
    flex: "none",
    gap: "10px",
    height: "46px",
    padding: "0 16px",
  };
}

/**
 * The `<input>` inside a {@link searchRow}. Deliberately *not* {@link inputBox}:
 * the row is already the well, and a second frame inside it would read as a
 * box within a box.
 */
export function searchInput(): CSSProperties {
  return {
    background: "transparent",
    border: "none",
    color: tokens.color.ink.bright,
    flex: 1,
    fontFamily: tokens.font.sans,
    fontSize: "13px",
    outline: "none",
  };
}

/** The scrolling result list under a {@link searchRow}. */
export function resultList(): CSSProperties {
  return {
    overflowY: "auto",
    padding: "6px",
  };
}

/**
 * One result row. A *minimum* height rather than a fixed one — a row with a
 * second line (a session's project, a prompt's tags) has to grow, and the
 * rhythm it belongs to is the list's, not the 30px nav row's.
 *
 * The highlight is a surface step, not an accent wash: the accent is reserved
 * for what the app *does*, not for where the cursor is.
 */
export function resultRow(active: boolean): CSSProperties {
  return {
    alignItems: "center",
    background: active ? tokens.color.surface.s3 : "transparent",
    border: "none",
    borderRadius: tokens.radius.md,
    cursor: "pointer",
    display: "flex",
    gap: "10px",
    minHeight: "36px",
    padding: "0 10px",
    textAlign: "left",
    width: "100%",
  };
}

/** A result's primary line, truncated rather than wrapped. */
export function resultLabel(): CSSProperties {
  return {
    color: tokens.color.ink.primary,
    fontSize: "12.5px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
}

/** A result's second line — a project name, a folder. */
export function resultSub(): CSSProperties {
  return {
    color: tokens.color.ink.muted,
    fontSize: "11px",
  };
}

/** "No matches" where a result list would be. */
export function overlayEmpty(): CSSProperties {
  return {
    color: tokens.color.ink.muted,
    fontSize: "12.5px",
    padding: "24px",
    textAlign: "center",
  };
}

/** A number tile — the Details rail's tokens / this-session pair. */
export function statTile(): CSSProperties {
  return {
    background: tokens.color.blockWell,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.lg,
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    padding: "10px 12px",
  };
}
