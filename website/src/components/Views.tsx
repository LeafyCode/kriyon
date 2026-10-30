import { type CSSProperties, useState } from "react";
import { VIEWS } from "../lib/demo.ts";
import { ManSection } from "./ManSection.tsx";
import { ShotImage } from "./ShotImage.tsx";

const DEFAULT_VIEW = "activity";

export function Views() {
  const [id, setId] = useState(DEFAULT_VIEW);
  const view = VIEWS.find((v) => v.id === id) ?? VIEWS[0];
  const portrait = view.shot === "menu-bar";

  return (
    <ManSection id="views" shaded>
      <div className="views">
        <div className="views-list">
          <h3 className="slash-title">/views</h3>
          <fieldset className="options">
            <legend className="sr-only">Pick a view</legend>
            {VIEWS.map((v) => (
              <button
                aria-pressed={v.id === id}
                className="option"
                key={v.id}
                onClick={() => setId(v.id)}
                type="button"
              >
                <span className="option-head">
                  <span>{v.flag}</span>
                  {v.isNew ? <span className="tone-amber">NEW</span> : null}
                </span>
                <span className="option-text">{v.text}</span>
              </button>
            ))}
          </fieldset>
        </div>
        <div aria-live="polite" className="views-stage">
          {/* Keyed by view so each pick drops a fresh card in. */}
          <figure
            className={`view-card view-${view.id}`}
            key={view.id}
            style={{ "--lean": `${view.lean}deg` } as CSSProperties}
          >
            <figcaption className="view-card-head">
              <span>KRIYON · {view.code}</span>
              <span>{view.flag}</span>
            </figcaption>
            <div className="view-card-shot">
              <ShotImage
                alt={view.alt}
                className={portrait ? "shot-img shot-portrait" : "shot-img"}
                name={view.shot}
                sizes={
                  portrait
                    ? "(min-width: 900px) 360px, 70vw"
                    : "(min-width: 1440px) 680px, (min-width: 900px) 48vw, 90vw"
                }
              />
            </div>
          </figure>
        </div>
      </div>
    </ManSection>
  );
}
