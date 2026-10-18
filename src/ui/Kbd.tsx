import type { ReactNode } from "react";
import { kbd } from "../theme/recipes.ts";

const kbdStyle = kbd();

/** A keycap chip for surfacing a keyboard shortcut, e.g. `<Kbd>⌘⇧P</Kbd>`. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd style={kbdStyle}>{children}</kbd>;
}
