import { switchThumb, switchTrack } from "../theme/recipes.ts";

/** An on/off switch. Its accessible name is `ariaLabel`; a visible label
 *  beside it is the caller's. */
export function Switch({
  ariaLabel,
  checked,
  disabled = false,
  onChange,
}: {
  ariaLabel: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={ariaLabel}
      className="kr-focusable"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      style={{ ...switchTrack(checked), opacity: disabled ? 0.5 : 1 }}
      type="button"
    >
      <span style={switchThumb(checked)} />
    </button>
  );
}
