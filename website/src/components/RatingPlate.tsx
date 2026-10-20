import type { ReactNode } from "react";
import { APP_VERSION, LEAFYCODE_URL } from "../lib/site.ts";
import { LeafyMark } from "./LeafyCredit.tsx";

const [MAJOR_MINOR, PATCH] = (() => {
  const [major, minor, patch] = APP_VERSION.replace("v", "").split(".");
  return [`${major}.${minor}`, `.${patch}`];
})();

interface Cell {
  label: string;
  note: string;
  tone?: "blue" | "green" | "amber";
  unit?: string;
  value: ReactNode;
}

const CELLS: readonly Cell[] = [
  {
    label: "REV",
    value: MAJOR_MINOR,
    unit: PATCH,
    note: "FIRST STABLE RELEASE",
  },
  {
    label: "LICENCE",
    value: "Apache",
    unit: "2.0",
    note: "READ EVERY LINE",
    tone: "blue",
  },
  {
    label: "ACCOUNTS",
    value: "None",
    note: "USES YOUR OWN CLAUDE LOGIN",
    tone: "green",
  },
  {
    label: "RECORD",
    value: "30",
    unit: "days",
    note: "KEPT ONLY ON THIS MAC",
    tone: "amber",
  },
  {
    label: "PLATFORM",
    value: "macOS",
    unit: "13+",
    note: "WINDOWS: HELP WANTED",
  },
  {
    label: "MAKER",
    value: (
      <a
        className="plate-maker"
        href={LEAFYCODE_URL}
        rel="noreferrer"
        target="_blank"
      >
        <LeafyMark className="plate-maker-mark" />
        Leafy Code
      </a>
    ),
    note: "INTERNATIONAL · SRI LANKA",
    tone: "amber",
  },
];

/** The spec plate: what Kriyon is, in the format of a machine's nameplate. */
export function RatingPlate() {
  return (
    <section aria-label="Rating plate" className="plate-band">
      <div className="plate">
        <span aria-hidden="true" className="screw screw-tl" />
        <span aria-hidden="true" className="screw screw-tr" />
        <span aria-hidden="true" className="screw screw-bl" />
        <span aria-hidden="true" className="screw screw-br" />
        <div className="plate-head">
          <div className="plate-title">
            <span className="label">RATING PLATE · DO NOT REMOVE</span>
            <span className="plate-model">
              KRIYON <span className="plate-model-rev">K-1</span>
            </span>
          </div>
          <div className="plate-swatches">
            <span aria-hidden="true" className="swatch tone-bg-blue" />
            <span aria-hidden="true" className="swatch tone-bg-amber" />
            <span aria-hidden="true" className="swatch tone-bg-green" />
            <span className="plate-kind">DESKTOP CLIENT FOR claude(1)</span>
          </div>
        </div>
        <dl className="plate-cells">
          {CELLS.map((cell) => (
            <div className="plate-cell" key={cell.label}>
              <dt className="label">{cell.label}</dt>
              <dd
                className={
                  cell.tone ? `plate-value tone-${cell.tone}` : "plate-value"
                }
              >
                {cell.value}
                {cell.unit ? (
                  <span className="plate-unit">{cell.unit}</span>
                ) : null}
              </dd>
              <dd className="plate-note">{cell.note}</dd>
            </div>
          ))}
        </dl>
        <div className="plate-foot">
          <span aria-hidden="true" className="barcode" />
          <span className="plate-serial">
            SER. 2026-10-20 · GITHUB.COM/LEAFYCODE/KRIYON · APACHE-2.0
          </span>
        </div>
      </div>
    </section>
  );
}
