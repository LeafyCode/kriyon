import type { RefObject } from "react";
import { useEffect } from "react";
import { useReducedMotion } from "./motion.ts";

const STAGGER_MS = 90;

/**
 * Staggered scroll-in for every `[data-reveal]` element under `rootRef`.
 * Elements already in the viewport on mount are left untouched, so the
 * prerendered page is fully readable without JavaScript.
 */
export function useScrollReveals(rootRef: RefObject<HTMLElement | null>) {
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const root = rootRef.current;
    if (!root || reducedMotion) {
      return;
    }

    const belowFold = Array.from(
      root.querySelectorAll<HTMLElement>("[data-reveal]")
    ).filter(
      (el) => el.getBoundingClientRect().top >= window.innerHeight * 0.92
    );

    for (const el of belowFold) {
      el.style.transitionDelay = `${Number(el.dataset.reveal ?? 0) * STAGGER_MS}ms`;
      el.classList.add("reveal-pending");
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.remove("reveal-pending");
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.12 }
    );
    for (const el of belowFold) {
      io.observe(el);
    }

    return () => io.disconnect();
  }, [rootRef, reducedMotion]);
}
