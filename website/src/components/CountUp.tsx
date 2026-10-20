import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "../lib/motion.ts";
import { useOnceVisible } from "../lib/useOnceVisible.ts";

const DURATION_MS = 1100;

/**
 * Counts 0 → `to` with a cubic ease-out the first time it scrolls into view.
 * Prerenders (and keeps, under reduced motion or without JS) the final value.
 */
export function CountUp({ to }: { to: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const rafRef = useRef(0);
  const [value, setValue] = useState(to);
  const reducedMotion = useReducedMotion();

  const play = useCallback(() => {
    if (reducedMotion) {
      return;
    }
    setValue(0);
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / DURATION_MS);
      setValue(Math.round(to * (1 - (1 - p) ** 3)));
      if (p < 1) {
        rafRef.current = requestAnimationFrame(step);
      }
    };
    rafRef.current = requestAnimationFrame(step);
  }, [to, reducedMotion]);

  useOnceVisible(ref, play);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  return <span ref={ref}>{value}</span>;
}
