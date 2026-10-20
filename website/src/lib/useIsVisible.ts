import type { RefObject } from "react";
import { useEffect, useState } from "react";

/**
 * Whether the element is currently on screen. Starts `false` — the server has
 * no viewport, and anything gated on this must be idle until proven visible.
 */
export function useIsVisible(
  ref: RefObject<Element | null>,
  threshold = 0.3
): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setVisible(entry.isIntersecting);
        }
      },
      { threshold }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, threshold]);

  return visible;
}
