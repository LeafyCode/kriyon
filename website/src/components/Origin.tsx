import { useCallback, useRef, useState } from "react";
import { LEAFYCODE_NAME, LEAFYCODE_URL } from "../lib/site.ts";
import { useOnceVisible } from "../lib/useOnceVisible.ts";
import { MakerCard } from "./MakerCard.tsx";

/** Lights in the drawing (the robot's orbs, the tower's crown), in % of it. */
const ORBS = [
  { left: 68.5, top: 70.2, delay: 0 },
  { left: 65.7, top: 60.5, delay: 0.6 },
  { left: 76.6, top: 56.7, delay: 1.1 },
  { left: 92.5, top: 33.4, delay: 0.3 },
  { left: 81.2, top: 74.1, delay: 1.6 },
] as const;

const ART_SIZES = "100vw";

/**
 * /made-in-sri-lanka: the landmarks drawing, painted in by a beam the first
 * time it scrolls into view, and the maker's credit.
 */
export function Origin() {
  const ref = useRef<HTMLElement>(null);
  const [painting, setPainting] = useState(false);
  useOnceVisible(
    ref,
    useCallback(() => setPainting(true), []),
    0.35
  );

  return (
    <section aria-labelledby="origin-title" className="origin" id="origin">
      <div className="origin-head">
        <h2 className="slash-title" id="origin-title">
          /made-in-sri-lanka
        </h2>
        <p className="lede">
          Kriyon is a{" "}
          <a href={LEAFYCODE_URL} rel="noreferrer" target="_blank">
            {LEAFYCODE_NAME}
          </a>{" "}
          project, built in Sri Lanka, in the open. Pull requests welcome from
          anywhere.
        </p>
      </div>

      <figure className="landmarks" data-painting={painting} ref={ref}>
        <img
          alt="Line drawing: Sigiriya rock with a glass lift, a train on the Nine Arches bridge, a robot holding a glowing orb, and the Lotus Tower"
          className="landmarks-pencil"
          decoding="async"
          height={821}
          loading="lazy"
          sizes={ART_SIZES}
          src="/art/landmarks-pencil-1600.webp"
          srcSet="/art/landmarks-pencil-960.webp 960w, /art/landmarks-pencil-1600.webp 1600w"
          width={1915}
        />
        <img
          alt=""
          className="landmarks-colour"
          decoding="async"
          height={821}
          loading="lazy"
          sizes={ART_SIZES}
          src="/art/landmarks-colour-1600.webp"
          srcSet="/art/landmarks-colour-960.webp 960w, /art/landmarks-colour-1600.webp 1600w"
          width={1915}
        />
        <span aria-hidden="true" className="landmarks-beam" />
        <span aria-hidden="true" className="landmarks-train" />
        {ORBS.map((o) => (
          <span
            aria-hidden="true"
            className="landmarks-orb"
            key={`${o.left},${o.top}`}
            style={{
              left: `${o.left}%`,
              top: `${o.top}%`,
              animationDelay: `${o.delay}s`,
            }}
          />
        ))}
        <figcaption className="landmarks-caption">
          FIG. 7 · SIGIRIYA · NINE ARCHES, ELLA · LOTUS TOWER, COLOMBO · AND A
          FEW AGENTS
        </figcaption>
      </figure>

      <MakerCard />
    </section>
  );
}
