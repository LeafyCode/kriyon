import type { CSSProperties } from "react";
import { switchThumb, switchTrack } from "../theme/recipes.ts";

/**
 * An on/off switch. Name it with `ariaLabel`, or give it a visible `label`:
 * the switch and that text are then wrapped in one `<label>`, so the text
 * names the switch and clicking it toggles too. `labelStyle` lays that out.
 */
/** How a switch is named: an `aria-label`, or a visible label beside it. */
type SwitchName =
  | { ariaLabel: string; label?: never; labelStyle?: never }
  | { ariaLabel?: never; label: string; labelStyle?: CSSProperties };

export function Switch({
  ariaLabel,
  checked,
  label,
  labelStyle,
  onChange,
  testId,
}: SwitchName & {
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId?: string;
}) {
  const track = {
    "aria-checked": checked,
    "aria-label": ariaLabel,
    className: "kr-focusable",
    "data-testid": testId,
    onClick: () => onChange(!checked),
    role: "switch",
    style: switchTrack(checked),
    type: "button",
  } as const;
  const thumb = <span style={switchThumb(checked)} />;
  if (label === undefined) {
    return <button {...track}>{thumb}</button>;
  }
  return (
    <label style={labelStyle}>
      <button {...track}>{thumb}</button>
      <span>{label}</span>
    </label>
  );
}
