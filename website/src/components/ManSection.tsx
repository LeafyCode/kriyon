import type { ReactNode } from "react";

interface ManSectionProps {
  children: ReactNode;
  id: string;
  /** The man-page section name in the left rail, e.g. SYNOPSIS. */
  name: string;
  /** Panel grey instead of the page white, to separate neighbours. */
  shaded?: boolean;
}

/** One man-page section: its name in a rail on the left, content beside it. */
export function ManSection({ children, id, name, shaded }: ManSectionProps) {
  return (
    <section
      aria-labelledby={`${id}-name`}
      className={shaded ? "man man-shaded" : "man"}
      id={id}
    >
      <h2 className="man-name" id={`${id}-name`}>
        {name}
      </h2>
      <div className="man-body" data-reveal="">
        {children}
      </div>
    </section>
  );
}
