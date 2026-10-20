import type { ReactNode } from "react";
import { type SectionId, sectionLabel } from "../lib/sections.ts";

interface ManSectionProps {
  children: ReactNode;
  /** Its id; the man-page name in the left rail comes from `SECTIONS`. */
  id: SectionId;
  /** Panel grey instead of the page white, to separate neighbours. */
  shaded?: boolean;
}

/** One man-page section: its name in a rail on the left, content beside it. */
export function ManSection({ children, id, shaded }: ManSectionProps) {
  return (
    <section
      aria-labelledby={`${id}-name`}
      className={shaded ? "man man-shaded" : "man"}
      id={id}
    >
      <h2 className="man-name" id={`${id}-name`}>
        {sectionLabel(id)}
      </h2>
      <div className="man-body" data-reveal="">
        {children}
      </div>
    </section>
  );
}
