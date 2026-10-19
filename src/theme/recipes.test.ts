import { describe, expect, it } from "vitest";
import {
  button,
  card,
  chip,
  iconButton,
  inputBox,
  kbd,
  kvRow,
  overlayEmpty,
  overlayPanel,
  pill,
  resultLabel,
  resultList,
  resultRow,
  resultSub,
  row30,
  searchInput,
  searchRow,
  sectionLabel,
  shimmerText,
  statTile,
} from "./recipes.ts";
import { tokens } from "./tokens.ts";

/**
 * Recipes are the app's answer to "there is no shared Button" (ADR-0023).
 * What these tests pin is not the pixel values for their own sake — it is the
 * two properties that make a recipe worth having over a copied style object:
 *
 * 1. **Every colour resolves through a token**, never a literal. A recipe that
 *    hardcodes `#10141d` is a palette change that silently doesn't happen.
 * 2. **The row rhythm is 30 / 32 / 46.** Those three heights are the whole
 *    reason the design reads as one system, and they are exactly what drifts
 *    when a caller nudges a row by a pixel to fit its own content.
 */

/** Every colour-ish property a recipe might set. */
const COLOR_KEYS = [
  "background",
  "color",
  "border",
  "borderBottom",
  "--kr-fill",
  "--kr-fill-hover",
] as const;

/** A literal hex or a literal `rgb(…)` — i.e. a colour that bypassed the seam. */
const LITERAL_COLOR = /#[0-9a-f]{3,8}\b|\brgba?\(\s*\d/i;

function colorish(style: Record<string, unknown>): string[] {
  return COLOR_KEYS.map((key) => style[key]).filter(
    (value): value is string => typeof value === "string"
  );
}

const EVERY_RECIPE = {
  sectionLabel: sectionLabel(),
  row30: row30(),
  "row30(active)": row30({ active: true }),
  kvRow: kvRow(),
  "kvRow(last)": kvRow({ last: true }),
  iconButton: iconButton(),
  "button(primary)": button("primary"),
  "button(secondary)": button("secondary"),
  "button(ghost)": button("ghost"),
  "button(danger)": button("danger"),
  chip: chip(),
  kbd: kbd(),
  "pill(running)": pill("running"),
  "pill(waiting)": pill("waiting"),
  card: card(),
  inputBox: inputBox(),
  statTile: statTile(),
  overlayPanel: overlayPanel(),
  searchRow: searchRow(),
  searchInput: searchInput(),
  resultList: resultList(),
  resultRow: resultRow(false),
  "resultRow(active)": resultRow(true),
  resultLabel: resultLabel(),
  resultSub: resultSub(),
  overlayEmpty: overlayEmpty(),
  shimmerText: shimmerText(),
};

describe("style recipes", () => {
  it("resolves every colour through the theme seam, never a literal", () => {
    for (const [name, style] of Object.entries(EVERY_RECIPE)) {
      for (const value of colorish(style as Record<string, unknown>)) {
        expect(
          value,
          `${name} must not hardcode a colour: ${value}`
        ).not.toMatch(LITERAL_COLOR);
      }
    }
  });

  it("holds the 30 / 32 / 46 row rhythm", () => {
    expect(row30().height).toBe("30px");
    expect(inputBox().height).toBe("30px");
    expect(kvRow().height).toBe("32px");
    expect(pill("idle").height).toBe("22px");
    expect(iconButton().height).toBe("26px");
    expect(iconButton().width).toBe("26px");
  });

  it("never asks for a weight the UI face does not ship", () => {
    for (const [name, style] of Object.entries(EVERY_RECIPE)) {
      const weight = (style as { fontWeight?: number }).fontWeight;
      if (weight !== undefined) {
        expect([400, 500, 700], `${name} weight ${weight}`).toContain(weight);
      }
    }
  });
});

/**
 * Recipes whose hosts pair them with `.kr-hover-surface` / `.kr-hover-accent`.
 * These may not set `background`: an inline declaration outranks every class
 * rule without `!important`, and none of those rules carries one — so a recipe
 * that paints its own fill silently kills the hover it tells callers to add.
 * The resting fill rides `--kr-fill` instead, exactly as `.kr-row` already
 * takes `--kr-row-bg` from `SessionRow.rowFillVars`.
 */
const HOVER_CLASSED = {
  iconButton: iconButton(),
  "button(primary)": button("primary"),
  "button(secondary)": button("secondary"),
  "button(ghost)": button("ghost"),
  row30: row30(),
  "row30(active)": row30({ active: true }),
  "chip(pressable)": chip({}),
};

describe("the hover seam", () => {
  it("never paints its own background, so the hover class can", () => {
    for (const [name, style] of Object.entries(HOVER_CLASSED)) {
      expect(
        "background" in style,
        `${name} must leave background to its hover class`
      ).toBe(false);
    }
  });

  it("publishes the resting fill as --kr-fill instead", () => {
    const vars = (style: object) => style as Record<string, string>;
    expect(vars(iconButton())["--kr-fill"]).toBe("transparent");
    expect(vars(button("primary"))["--kr-fill"]).toBe(tokens.color.accent);
    expect(vars(button("secondary"))["--kr-fill"]).toBe("transparent");
    expect(vars(row30())["--kr-fill"]).toBe("transparent");
    expect(vars(chip({}))["--kr-fill"]).toBe(tokens.color.chip);
    expect(vars(row30({ active: true }))["--kr-fill"]).toBe(
      tokens.color.surface.s3
    );
  });

  it("holds an active row's fill through hover instead of dimming it", () => {
    // An active row is LIGHTER than the neutral hover wash, so falling back to
    // the wash would darken the selected row under the pointer.
    const active = row30({ active: true }) as Record<string, string>;
    expect(active["--kr-fill-hover"]).toBe(tokens.color.surface.s3);
    // A resting row has no opinion and takes the class's own fallback.
    expect("--kr-fill-hover" in row30()).toBe(false);
  });

  it("leaves danger painting inline — it pairs with no hover class", () => {
    // ConfirmDialog's destructive button and PromptEditor's delete carry no
    // hover class, so an inline fill is correct there and nothing is shadowed.
    expect(button("danger").background).toBe(tokens.color.delSoft);
  });
});

describe("sectionLabel", () => {
  it("is the canvas's 9.5px tracked-out uppercase label", () => {
    expect(sectionLabel()).toMatchObject({
      color: tokens.color.ink.faint,
      fontSize: "9.5px",
      fontWeight: 700,
      letterSpacing: "0.14em",
      textTransform: "uppercase",
    });
  });

  it("carries no padding of its own — each host places it", () => {
    expect(sectionLabel()).not.toHaveProperty("padding");
  });
});

describe("row30", () => {
  it("is transparent until it is active", () => {
    // Published as `--kr-fill` rather than `background` — see "the hover seam".
    const fill = (options?: { active: boolean }) =>
      (row30(options) as Record<string, string>)["--kr-fill"];
    expect(fill()).toBe("transparent");
    expect(fill({ active: true })).toBe(tokens.color.surface.s3);
  });

  it("brightens its ink when active rather than only its fill", () => {
    expect(row30({ active: true }).color).toBe(tokens.color.ink.bright);
    expect(row30({ active: true }).fontWeight).toBe(500);
  });
});

describe("kvRow", () => {
  it("draws a hairline under every row but the last", () => {
    expect(kvRow().borderBottom).toBe(`1px solid ${tokens.color.line.soft}`);
    expect(kvRow({ last: true }).borderBottom).toBe("none");
  });
});

describe("button", () => {
  it("fills primary with the accent and puts onAccent ink on it", () => {
    expect(button("primary")).toMatchObject({
      // The fill rides `--kr-fill` so `.kr-hover-accent` can repaint it.
      "--kr-fill": tokens.color.accent,
      color: tokens.color.onAccent,
    });
  });

  it("gives secondary a border and no fill", () => {
    const style = button("secondary") as Record<string, string>;
    expect(style["--kr-fill"]).toBe("transparent");
    expect(style.border).toBe(`1px solid ${tokens.color.line.strong}`);
  });

  it("gives ghost neither", () => {
    const style = button("ghost") as Record<string, string>;
    expect(style["--kr-fill"]).toBe("transparent");
    expect(style.border).toBe("none");
  });

  it("makes danger read as destructive without shouting", () => {
    expect(button("danger")).toMatchObject({
      background: tokens.color.delSoft,
      color: tokens.color.del,
    });
  });

  it("comes in the two canvas heights", () => {
    expect(button("primary").height).toBe("28px");
    expect(button("primary", "sm").height).toBe("24px");
  });
});

describe("pill", () => {
  it("pairs each status's soft fill with its own ink", () => {
    expect(pill("waiting")).toMatchObject({
      background: tokens.color.status.waitingSoft,
      color: tokens.color.status.waitingInk,
    });
    expect(pill("running")).toMatchObject({
      background: tokens.color.status.runningSoft,
      color: tokens.color.status.runningInk,
    });
  });

  it("is a true pill, not a large radius", () => {
    expect(pill("idle").borderRadius).toBe(tokens.radius.pill);
  });
});

describe("card / statTile / inputBox", () => {
  it("builds a card from the raised fill and the card border", () => {
    expect(card()).toMatchObject({
      background: tokens.color.raised,
      border: `1px solid ${tokens.color.border}`,
      borderRadius: tokens.radius.lg,
    });
  });

  it("sinks a stat tile below the card rather than raising it", () => {
    expect(statTile().background).toBe(tokens.color.blockWell);
  });

  it("sinks an input into the input well", () => {
    expect(inputBox().background).toBe(tokens.color.inputWell);
    expect(inputBox().border).toBe(`1px solid ${tokens.color.line.base}`);
  });
});

describe("the overlay family", () => {
  it("raises a panel on the overlay step, not on a card", () => {
    expect(overlayPanel()).toMatchObject({
      background: tokens.color.chrome.overlay,
      border: `1px solid ${tokens.color.border}`,
      borderRadius: tokens.radius.xl,
      boxShadow: tokens.shadow.pop,
    });
  });

  it("sizes nothing — each overlay states its own width and max height", () => {
    const panel = overlayPanel();
    expect(panel).not.toHaveProperty("width");
    expect(panel).not.toHaveProperty("maxHeight");
    expect(panel).not.toHaveProperty("padding");
  });

  it("puts the search row on the 46px header height", () => {
    expect(searchRow().height).toBe("46px");
    expect(searchRow().borderBottom).toBe(
      `1px solid ${tokens.color.line.base}`
    );
  });

  it("leaves the search input bare — the row around it is the well", () => {
    expect(searchInput().background).toBe("transparent");
    expect(searchInput().border).toBe("none");
  });

  it("highlights a result with a surface step, never the accent", () => {
    expect(resultRow(false).background).toBe("transparent");
    expect(resultRow(true).background).toBe(tokens.color.surface.s3);
  });

  it("lets a result row grow past its minimum rather than clipping", () => {
    expect(resultRow(false).minHeight).toBe("36px");
    expect(resultRow(false)).not.toHaveProperty("height");
  });
});

describe("chip / kbd", () => {
  it("keeps a chip and a kbd on the small radius", () => {
    expect(chip().borderRadius).toBe(tokens.radius.sm);
    expect(kbd().borderRadius).toBe(tokens.radius.sm);
  });

  it("sets a kbd in mono — it is type, not an icon", () => {
    expect(kbd().fontFamily).toBe(tokens.font.mono);
  });
});

/**
 * Every non-test `.tsx` in the app, as source text.
 *
 * CSS is stubbed under Vitest (a `*.css?raw` import resolves to `""`), so the
 * cascade itself can't be asserted here — but the call sites can, and they are
 * the half that drifts. `.tsx?raw` is not stubbed.
 */
const SOURCES = import.meta.glob("../**/*.tsx", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

/** A style that paints its own fill, and so needs no class to be visible. */
const PAINTS_INLINE = /\bbackground:/;

/** A host that already carries one of the classes that paint `--kr-fill`. */
const CARRIES_FILL_CLASS = /className=[^\n]*kr-(hover|row)/;

/** The recipes that publish `--kr-fill` instead of painting it. */
const FILL_RECIPES =
  /\b(row30|iconButton)\(|\bbutton\(\s*"(primary|secondary|ghost)"|\bchip\(\s*\{/;

/**
 * The style identifiers in one module that leave a published fill unpainted —
 * the recipe calls themselves plus anything spread from one, transitively,
 * since a call site almost always names the shape (`actionButtonStyle`)
 * rather than calling the recipe inline.
 *
 * A style that declares its own `background` is *not* one of these: an inline
 * fill paints, and shadows nothing as long as the host carries no hover class
 * — which is exactly the bargain `button("danger")` and the disabled Send
 * strike.
 */
function fillStyleNames(source: string): string[] {
  const names = new Set<string>();
  for (let pass = 0; pass < 4; pass += 1) {
    const known = [...names].join("|");
    // The terminator is a lookahead: consuming it would swallow the next
    // declaration's opening line and skip every other style in the file.
    const declaration =
      /(?:const|function)\s+(\w+)[^=;{]*(?:=|\{)([\s\S]{0,400}?)(?=\n(?:const|function|export|\/\*\*)|\n\}\n|$)/g;
    for (const [, name, body] of source.matchAll(declaration)) {
      if (names.has(name) || PAINTS_INLINE.test(body)) {
        continue;
      }
      const spreadsKnown =
        known.length > 0 && new RegExp(`\\.\\.\\.(?:${known})\\b`).test(body);
      if (FILL_RECIPES.test(body) || spreadsKnown) {
        names.add(name);
      }
    }
  }
  return [...names];
}

/**
 * The attribute text of one `<button …>` opening tag, starting at `from`.
 *
 * Not a regex: an `onClick={() => …}` contains a `>`, so `/<button.*?>/`
 * stops at the arrow and hides the `style` that follows it — which is exactly
 * where the interesting call sites live. Walking the braces is the only way to
 * find the tag's own closing angle.
 */
function buttonAttributes(source: string, from: number): string {
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    } else if (char === ">" && depth === 0) {
      return source.slice(from, i);
    }
  }
  return source.slice(from);
}

describe("the hover seam's call sites", () => {
  it("never leaves a published fill unpainted on a bare <button>", () => {
    const orphans: string[] = [];
    for (const [path, source] of Object.entries(SOURCES)) {
      if (path.includes(".test.")) {
        continue;
      }
      const styles = fillStyleNames(source);
      for (const match of source.matchAll(/<button\b/g)) {
        const index = match.index ?? 0;
        const attributes = buttonAttributes(source, index);
        const named = styles.find((name) =>
          new RegExp(`\\b${name}\\b`).test(attributes)
        );
        if (!(named || FILL_RECIPES.test(attributes))) {
          continue;
        }
        if (CARRIES_FILL_CLASS.test(attributes)) {
          continue;
        }
        const line = source.slice(0, index).split("\n").length;
        orphans.push(`${path}:${line} (${named ?? "inline recipe"})`);
      }
    }
    expect(orphans, orphans.join("\n")).toEqual([]);
  });
});
