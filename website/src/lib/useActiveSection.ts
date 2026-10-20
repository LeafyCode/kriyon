import { useEffect, useState } from "react";

/** How far below the top of the viewport a section must start to count as
    current. Below the 64px where `scroll-padding-top` lands a jumped-to
    heading, so a section reached by a link always counts. */
const READ_LINE_PX = 96;

/**
 * The id of the section being read, for the nav to mark as current: the last
 * section whose top has passed the read line, or the last section once the
 * page is scrolled to the bottom (a short final section never reaches the
 * line). Starts at the first id so SSR and hydration agree.
 */
export function useActiveSection<Id extends string>(ids: readonly Id[]): Id {
  const [active, setActive] = useState(ids[0]);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const atBottom =
        window.scrollY > 0 &&
        window.innerHeight + window.scrollY >=
          document.documentElement.scrollHeight - 2;
      let [current] = ids;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= READ_LINE_PX) {
          current = id;
        }
      }
      setActive(atBottom ? (ids.at(-1) ?? current) : current);
    };
    const onScroll = () => {
      if (!frame) {
        frame = requestAnimationFrame(update);
      }
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [ids]);

  return active;
}
