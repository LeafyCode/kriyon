/**
 * How the phone's terminal page lays a computer's screen out: its fonts
 * and its width. Shared by the page (page.ts) and the script that builds it
 * (scripts/terminal-page.mjs), so both say the same.
 */

/**
 * The fallback font for the symbols no font on an Android phone has (Claude
 * Code's "⏵⏵", U+23F5, drew as boxes): Noto Sans Symbols 2's Miscellaneous
 * Technical block, assets/fonts/NotoSansSymbols2-Technical.woff (SIL Open
 * Font License, beside it). Made with fontTools from @fontsource's
 * noto-sans-symbols-2 5.3.0 "symbols" file:
 * `pyftsubset … --unicodes=U+2300-23FF --flavor=woff --layout-features=''
 * --no-hinting --desubroutinize`.
 */
export const SYMBOLS_FONT = "Kriyon Symbols";

/** The characters the fallback font has, and is used for. */
export const SYMBOLS_RANGE = "U+2300-23FF";

/** The terminal's fonts: the phone's own monospace first, then the symbols. */
export const TERMINAL_FONT = `Menlo, monospace, "${SYMBOLS_FONT}"`;

/**
 * The CSS width of the box the terminal sits in. The screen keeps the
 * computer's columns, so on a phone it is often wider than the view: the
 * box then takes the screen's width and the page scrolls sideways to its
 * last column. Otherwise the box fills the view.
 */
export function boxWidth(screenWidth: number, viewWidth: number): string {
  return screenWidth > viewWidth ? `${Math.ceil(screenWidth)}px` : "100%";
}

/** The fewest columns a computer takes for a session (ADR-0063). */
export const LEAST_COLS = 80;

/**
 * This phone's own terminal size: the cells that fit its view, in columns
 * and rows, at least {@link LEAST_COLS} columns (a narrower phone scrolls
 * sideways to the rest). `null` until a cell has been measured.
 */
export function fitSize(
  viewWidth: number,
  viewHeight: number,
  cellWidth: number,
  cellHeight: number
): { cols: number; rows: number } | null {
  if (cellWidth <= 0 || cellHeight <= 0) {
    return null;
  }
  return {
    cols: Math.max(LEAST_COLS, Math.floor(viewWidth / cellWidth)),
    rows: Math.max(1, Math.floor(viewHeight / cellHeight)),
  };
}
