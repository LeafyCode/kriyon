import type { RefObject } from "react";
import { useEffect, useRef } from "react";

/** Runs `onVisible` the first time the element scrolls into view, then stops watching. */
export function useOnceVisible(
  ref: RefObject<Element | null>,
  onVisible: () => void,
  threshold = 0.3
) {
  // A ref, not an effect-local `let`: "once" must survive the effect re-running
  // (a changed threshold or an unstable callback), not just one observer's life.
  const played = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (played.current || !entries.some((entry) => entry.isIntersecting)) {
          return;
        }
        played.current = true;
        io.disconnect();
        onVisible();
      },
      { threshold }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, onVisible, threshold]);
}
