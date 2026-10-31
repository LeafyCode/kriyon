import type { CSSProperties } from "react";
import { useLayout } from "../state/layout.ts";
import { THEMES, type Theme } from "../theme/themes/index.ts";
import { accentAlpha, tokens } from "../theme/tokens.ts";

const gridStyle: CSSProperties = {
  border: "none",
  display: "grid",
  gap: tokens.space.sm,
  gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))",
  margin: 0,
  padding: 0,
  width: "100%",
};

function optionStyle(picked: boolean): CSSProperties {
  return {
    background: picked ? accentAlpha(0.16) : tokens.color.blockWell,
    border: `1px solid ${picked ? tokens.color.accent : tokens.color.line.base}`,
    borderRadius: tokens.radius.lg,
    color: picked ? tokens.color.ink.bright : tokens.color.ink.secondary,
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    fontFamily: tokens.font.sans,
    fontSize: "11.5px",
    gap: "6px",
    padding: "6px",
    textAlign: "left",
  };
}

/**
 * A thumbnail of the theme drawn in its *own* colours, not the active
 * theme's — the point is to see what you would get before you pick it. That
 * is why this reads `theme.colors` directly instead of `tokens`.
 */
function Preview({ theme }: { theme: Theme }) {
  const { colors } = theme;
  const line = (width: string, color: string): CSSProperties => ({
    background: color,
    borderRadius: "2px",
    height: "3px",
    width,
  });
  return (
    <span
      aria-hidden
      style={{
        border: `1px solid ${colors.lineBase}`,
        borderRadius: tokens.radius.md,
        display: "flex",
        height: "44px",
        overflow: "hidden",
      }}
    >
      <span style={{ background: colors.chromeSidebar, width: "22%" }} />
      <span
        style={{
          background: colors.chromeWindow,
          display: "flex",
          flex: 1,
          flexDirection: "column",
          gap: "4px",
          padding: "7px 6px",
        }}
      >
        <span style={line("70%", colors.inkPrimary)} />
        <span style={line("50%", colors.inkMuted)} />
        <span style={{ display: "flex", gap: "3px" }}>
          <span style={line("30%", colors.syntaxKeyword)} />
          <span style={line("40%", colors.syntaxString)} />
        </span>
        <span style={line("26%", colors.accent)} />
      </span>
    </span>
  );
}

/** Settings' choice of [Theme]: one thumbnail per shipped theme. */
export function ThemePicker() {
  const themeId = useLayout((state) => state.layout.themeId);
  const setThemeId = useLayout((state) => state.setThemeId);
  return (
    <fieldset aria-label="Theme" style={gridStyle}>
      {THEMES.map((theme) => (
        <button
          aria-label={theme.label}
          aria-pressed={themeId === theme.id}
          className="kr-focusable kr-hover-surface"
          key={theme.id}
          onClick={() => setThemeId(theme.id)}
          style={optionStyle(themeId === theme.id)}
          type="button"
        >
          <Preview theme={theme} />
          {theme.label}
        </button>
      ))}
    </fieldset>
  );
}
