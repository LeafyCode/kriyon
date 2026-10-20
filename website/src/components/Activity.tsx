import { useState } from "react";
import { FILTERS, type Filter, rowsFor } from "../lib/demo.ts";
import { ManSection } from "./ManSection.tsx";

const STAGGER_MS = 70;

export function Activity() {
  const [filter, setFilter] = useState<Filter>("all");
  const rows = rowsFor(filter);

  return (
    <ManSection id="activity">
      <div className="man-head">
        <h3 className="slash-title">/what-claude-did</h3>
        <fieldset className="flags">
          <legend className="sr-only">Filter the record</legend>
          {FILTERS.map((f) => (
            <button
              aria-pressed={f.id === filter}
              className={f.id === "look" ? "flag flag-look" : "flag"}
              key={f.id}
              onClick={() => setFilter(f.id)}
              type="button"
            >
              {f.flag} · {rowsFor(f.id).length}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="record">
        <table className="record-table">
          <caption className="sr-only">
            What Claude did in the demo session, filtered by{" "}
            {FILTERS.find((f) => f.id === filter)?.flag}
          </caption>
          <thead>
            <tr>
              <th scope="col">
                <b>01</b> · TURN
              </th>
              <th scope="col">
                <b>02</b> · ACTION
              </th>
              <th scope="col">
                <b>03</b> · DETAIL
              </th>
              <th scope="col">
                <b>04</b> · RESULT
              </th>
            </tr>
          </thead>
          {/* Keyed by filter so the rows remount and stagger in again. */}
          <tbody key={filter}>
            {rows.map((r, i) => (
              <tr
                className={`record-row row-${r.tone}`}
                key={`${r.turn}${r.title}${r.detail}`}
                style={{ animationDelay: `${i * STAGGER_MS}ms` }}
              >
                <td className="record-turn">{r.turn}</td>
                <td className="record-title">{r.title}</td>
                <td className="record-detail">{r.detail}</td>
                <td className="record-result">{r.result}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="man-foot">
        <span>KEPT 30 DAYS · ONLY ON THIS MAC · EXPORT ANY TIME</span>
        <span>DEMO DATA</span>
      </div>
    </ManSection>
  );
}
