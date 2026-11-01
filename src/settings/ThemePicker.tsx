import { type CSSProperties, useState } from "react";
import { useLayout } from "../state/layout.ts";
import { pickerOption, sectionLabel } from "../theme/recipes.ts";
import {
  COMMUNITY_THEMES,
  KRIYON_THEMES,
  type Theme,
} from "../theme/themes/index.ts";
import { tokens } from "../theme/tokens.ts";
import { Segmented } from "../ui/Segmented.tsx";

type AppearanceFilter = "all" | "dark" | "light";

const FILTER_OPTIONS = [
  { label: "All", value: "all" },
  { label: "Dark", value: "dark" },
  { label: "Light", value: "light" },
] as const;

const wrapStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.lg,
};

const headerStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: tokens.space.md,
};

const titleStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  fontSize: "14px",
  fontWeight: 500,
  margin: 0,
};

const countStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "12px",
};

const fieldsetStyle: CSSProperties = {
  border: "none",
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.lg,
  margin: 0,
  minWidth: 0,
  padding: 0,
};

const familyLabelStyle: CSSProperties = {
  ...sectionLabel(),
  marginBottom: tokens.space.sm,
};

const gridStyle: CSSProperties = {
  display: "grid",
  gap: tokens.space.md,
  gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
};

function optionStyle(picked: boolean): CSSProperties {
  return {
    ...pickerOption(picked),
    display: "flex",
    flexDirection: "column",
    gap: tokens.space.sm,
    padding: tokens.space.sm,
    textAlign: "left",
  };
}

const nameRowStyle: CSSProperties = {
  alignItems: "baseline",
  display: "flex",
  fontSize: "12.5px",
  fontWeight: 500,
  gap: tokens.space.sm,
  padding: "0 2px",
};

const modeStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "11px",
  fontWeight: 400,
  marginLeft: "auto",
};

/**
 * A thumbnail of the theme drawn in its *own* colours, not the active
 * theme's — the point is to see what you would get before you pick it. That
 * is why this reads `theme.colors` directly instead of `tokens`.
 */
function Preview({ theme }: { theme: Theme }) {
  const { colors } = theme;
  const line = (width: string, color: string): CSSProperties => ({
    background: color,
    borderRadius: tokens.radius.sm,
    flex: "none",
    height: "4px",
    width,
  });
  return (
    <span
      aria-hidden
      style={{
        border: `1px solid ${colors.lineBase}`,
        borderRadius: tokens.radius.md,
        display: "flex",
        height: "64px",
        overflow: "hidden",
      }}
    >
      <span
        style={{
          background: colors.chromeSidebar,
          display: "flex",
          flexDirection: "column",
          gap: "5px",
          padding: "8px 6px",
          width: "26%",
        }}
      >
        <span style={line("80%", colors.inkMuted)} />
        <span style={line("60%", colors.accent)} />
        <span style={line("70%", colors.inkMuted)} />
      </span>
      <span
        style={{
          background: colors.chromeWindow,
          display: "flex",
          flex: 1,
          flexDirection: "column",
          gap: "6px",
          padding: tokens.space.sm,
        }}
      >
        <span style={line("72%", colors.inkPrimary)} />
        <span style={line("52%", colors.inkMuted)} />
        <span style={{ display: "flex", gap: "5px" }}>
          <span style={line("28%", colors.syntaxKeyword)} />
          <span style={line("40%", colors.syntaxString)} />
        </span>
        <span
          style={{
            ...line("34%", colors.accent),
            height: "8px",
            marginTop: "auto",
          }}
        />
      </span>
    </span>
  );
}

function ThemeFamily({
  label,
  themes,
}: {
  label: string;
  themes: readonly Theme[];
}) {
  const themeId = useLayout((state) => state.layout.themeId);
  const setThemeId = useLayout((state) => state.setThemeId);
  if (themes.length === 0) {
    return null;
  }
  return (
    <div>
      <div style={familyLabelStyle}>{label}</div>
      <div style={gridStyle}>
        {themes.map((theme) => (
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
            <span style={nameRowStyle}>
              {theme.label}
              <span style={modeStyle}>
                {theme.appearance === "dark" ? "Dark" : "Light"}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Settings' choice of [Theme]: Kriyon's own and the community palettes, each a
 * thumbnail, with a filter to see only dark or only light ones.
 */
export function ThemePicker() {
  const [filter, setFilter] = useState<AppearanceFilter>("all");
  const keep = (theme: Theme) =>
    filter === "all" || theme.appearance === filter;
  const kriyon = KRIYON_THEMES.filter(keep);
  const community = COMMUNITY_THEMES.filter(keep);
  const count = kriyon.length + community.length;
  return (
    <div style={wrapStyle}>
      <div style={headerStyle}>
        <h3 style={titleStyle}>Theme</h3>
        <span style={countStyle}>
          {count} {count === 1 ? "theme" : "themes"}
        </span>
        <span style={{ marginLeft: "auto" }}>
          <Segmented
            ariaLabel="Show themes"
            onChange={setFilter}
            options={FILTER_OPTIONS}
            value={filter}
          />
        </span>
      </div>
      <fieldset aria-label="Theme" style={fieldsetStyle}>
        <ThemeFamily label="Kriyon" themes={kriyon} />
        <ThemeFamily label="Community palettes" themes={community} />
      </fieldset>
    </div>
  );
}
