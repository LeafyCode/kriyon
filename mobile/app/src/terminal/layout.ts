/**
 * How the phone's terminal page draws a computer's screen: its fonts.
 * Shared by the page (page.ts) and the script that builds it
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
