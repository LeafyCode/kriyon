import { type ComponentType, useEffect, useRef, useState } from "react";
import { ShotImage } from "../components/ShotImage.tsx";
import { useReducedMotion } from "../lib/motion.ts";
import { STAGE_H, STAGE_W } from "./motion.ts";
import { SHOTS } from "./parts.tsx";
import {
  EndCard,
  MenuBar,
  NeedsYou,
  Opening,
  Palette,
  Prompts,
  type SceneProps,
  Sessions,
  Worktrees,
} from "./scenes.tsx";

interface Scene {
  component: ComponentType<SceneProps>;
  dur: number;
}

const END_CARD: Scene = { dur: 6, component: EndCard };

/* The film's cut list. */
const SCENES: Scene[] = [
  { dur: 7, component: Opening },
  { dur: 9, component: Sessions },
  { dur: 9, component: NeedsYou },
  { dur: 8, component: MenuBar },
  { dur: 8, component: Palette },
  { dur: 8, component: Prompts },
  { dur: 11, component: Worktrees },
  END_CARD,
];

const TOTAL = SCENES.reduce((sum, scene) => sum + scene.dur, 0);

/** Film length in seconds — the section label renders this. */
export const FILM_SECONDS = TOTAL;

/* Cap dt so returning from a background tab resumes instead of teleporting. */
const MAX_FRAME_DT_S = 0.1;

/** Maps a timeline position to the scene playing there and its 0..1 progress. */
export function sceneAt(time: number) {
  let start = 0;
  for (const scene of SCENES) {
    if (time < start + scene.dur) {
      return { scene, progress: (time - start) / scene.dur };
    }
    start += scene.dur;
  }
  // unreachable while time stays in [0, TOTAL); hold the final frame if not
  return { scene: SCENES.at(-1) as Scene, progress: 1 };
}

/**
 * Plays the product film on a fixed 1920×1080 stage scaled to its container.
 * The rAF clock runs only while the stage is on screen; the first sighting
 * also warms every screenshot so scene cuts never wait on a fetch. With
 * reduced motion it holds the end card as a still.
 */
export function FilmStage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [time, setTime] = useState(0);
  // The first frame is a full-size app capture. Rendering it in the SSR output
  // put it inside Chrome's lazy-load threshold, so it was fetched during the
  // initial page load and competed with the hero for the LCP.
  const [seen, setSeen] = useState(false);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const measure = () => setScale(container.clientWidth / STAGE_W);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Mount the stage a screenful early, so the first frame has landed by the
  // time it is actually looked at. Separate from the play/pause observer below,
  // which must stay tight to the viewport or the rAF clock runs off screen.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "800px 0px" }
    );
    io.observe(container);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    if (reducedMotion) {
      // hold the end card as a poster frame
      setTime(TOTAL - END_CARD.dur / 2);
      return;
    }

    let raf = 0;
    let last: number | null = null;
    let playing = false;
    let preloaded = false;
    const step = (now: number) => {
      if (last !== null) {
        const dt = Math.min((now - last) / 1000, MAX_FRAME_DT_S);
        setTime((t) => (t + dt) % TOTAL);
      }
      last = now;
      raf = requestAnimationFrame(step);
    };
    const play = () => {
      if (playing) {
        return;
      }
      playing = true;
      if (!preloaded) {
        preloaded = true;
        for (const shot of Object.values(SHOTS)) {
          new Image().src = shot.src;
        }
      }
      last = null;
      raf = requestAnimationFrame(step);
    };
    const pause = () => {
      if (!playing) {
        return;
      }
      playing = false;
      cancelAnimationFrame(raf);
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            play();
          } else {
            pause();
          }
        }
      },
      { threshold: 0.2 }
    );
    io.observe(container);

    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [reducedMotion]);

  const { scene, progress } = sceneAt(time);
  const SceneComponent = scene.component;

  return (
    <div className="film-stage" ref={containerRef}>
      <noscript>
        <ShotImage
          alt="Kriyon — a live Claude Code session"
          name="02-live-session"
          sizes="90vw"
        />
      </noscript>
      {/* decorative animation — the section copy carries the message */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: STAGE_W,
          height: STAGE_H,
          transformOrigin: "0 0",
          transform: `scale(${scale})`,
        }}
      >
        {seen ? <SceneComponent progress={progress} /> : null}
      </div>
    </div>
  );
}
