import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Live reduced-motion preference. Starts `false` so the server render and the
 * first client render agree; the effect corrects it before paint. Subscribing
 * (rather than sampling once at mount) keeps the JS animations in step with the
 * CSS side, which follows the OS setting live via the `--play` custom property.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const sync = () => setReduced(mql.matches);
    sync();
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, []);

  return reduced;
}
