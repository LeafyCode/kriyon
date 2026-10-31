import type { CSSProperties } from "react";
import { type MascotId, useLayout } from "../state/layout.ts";
import { MASCOT_HUES, MASCOTS, Mascot } from "../structured/Mascot.tsx";
import { pickerOption } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";

const rowStyle: CSSProperties = {
  border: "none",
  display: "flex",
  flexWrap: "wrap",
  gap: tokens.space.sm,
  margin: 0,
  padding: 0,
};

function optionStyle(picked: boolean): CSSProperties {
  return {
    ...pickerOption(picked),
    alignItems: "center",
    display: "flex",
    flexDirection: "column",
    gap: tokens.space.xs,
    justifyContent: "center",
    minHeight: "76px",
    padding: "8px 10px",
    width: "76px",
  };
}

function swatchStyle(picked: boolean, color: string): CSSProperties {
  return {
    background: color,
    border: `2px solid ${picked ? tokens.color.ink.bright : "transparent"}`,
    borderRadius: tokens.radius.pill,
    cursor: "pointer",
    height: "22px",
    padding: 0,
    width: "22px",
  };
}

/** Settings' choice of [Mascot]: each one drawn (in the chosen hue), none at
 *  all, and the hue it is drawn in. */
export function MascotPicker() {
  const mascot = useLayout((state) => state.layout.mascot);
  const setMascot = useLayout((state) => state.setMascot);
  const hue = useLayout((state) => state.layout.mascotHue);
  const setHue = useLayout((state) => state.setMascotHue);
  const options: { id: MascotId; name: string }[] = [
    ...MASCOTS,
    { id: "none", name: "None" },
  ];
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: tokens.space.md }}
    >
      <fieldset aria-label="Mascot" style={rowStyle}>
        {options.map((option) => (
          <button
            aria-pressed={mascot === option.id}
            className="kr-focusable kr-hover-surface"
            key={option.id}
            onClick={() => setMascot(option.id)}
            style={optionStyle(mascot === option.id)}
            type="button"
          >
            {option.id === "none" ? (
              <span
                aria-hidden
                style={{ fontSize: "18px", lineHeight: "40px" }}
              >
                —
              </span>
            ) : (
              <Mascot busy={false} kind={option.id} size={40} />
            )}
            {option.name}
          </button>
        ))}
      </fieldset>
      {mascot === "none" ? null : (
        <fieldset aria-label="Mascot colour" style={rowStyle}>
          {MASCOT_HUES.map((option) => (
            <button
              aria-label={option.name}
              aria-pressed={hue === option.id}
              className="kr-focusable"
              key={option.id}
              onClick={() => setHue(option.id)}
              style={swatchStyle(
                hue === option.id,
                tokens.mascot.hues[option.id].shade1
              )}
              title={option.name}
              type="button"
            />
          ))}
        </fieldset>
      )}
    </div>
  );
}
